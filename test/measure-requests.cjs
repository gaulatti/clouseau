'use strict';

// Counts the REST requests (HTTP 304 answers are free) that one PR's lifecycle costs against an engine checkout:
// the verification wait, the importer scan, the reassessment and a base reconciliation among 40 approved PRs.
// `node test/measure-requests.cjs [engine-root]` prints the counts, so a change can be compared with an older
// checkout; src/request-budget.test.cjs bounds them.
const path = require('node:path');
async function measure(engineRoot) {
const root = path.resolve(engineRoot);
const {createPolicy} = require(path.join(root, 'src/policy.cjs'));
const {collectSnapshot} = require(path.join(root, 'src/acceptance-sources.cjs'));
const {reconcileBase} = require(path.join(root, 'src/base-reconcile.cjs'));
const config = require(path.join(root, 'test/fixtures/config.json'));
const SHA = 'a'.repeat(40), BASE = 'b'.repeat(40), TIP = 'c'.repeat(40);
const counts = {};
let current = '';
const count = (name, free = false) => { if (!free) counts[current] = (counts[current] || 0) + 1; };
const wait = async () => {};
const core = {info() {}, setOutput() {}};
const prData = {number: 3, state: 'open', draft: false, head: {sha: SHA, ref: 'f', repo: {id: 1}}, base: {sha: BASE, ref: 'main'}};
const withEtag = (name, produce) => async args => {
  if (args.headers?.['if-none-match'] === '"e"') { count(name, true); throw Object.assign(new Error('Not Modified'), {status: 304}); }
  count(name); return {headers: {etag: '"e"'}, data: produce(args)};
};

async function wait_() {
  current = 'wait (queued for the default 900 s grace)';
  let polls = 0;
  const github = {paginate: async () => [], rest: {pulls: {get: withEtag('pulls.get', () => prData)}, actions: {
    listWorkflowRuns: withEtag('runs', () => ({workflow_runs: [{id: 9, head_sha: SHA, status: 'queued', conclusion: null, pull_requests: [{number: 3}], html_url: 'u'}]}))}}};
  await createPolicy(config).awaitVerification({github, context: {repo: {owner: 'o', repo: 'r'}, eventName: 'pull_request_target', payload: {pull_request: {number: 3, head: {sha: SHA}, base: {sha: BASE}}}}, core, expectedHead: SHA, wait});
}

async function scan_() {
  current = 'importer scan (60 tests + 200 stories, importer is test #40)';
  const tests = Array.from({length: 60}, (_, i) => ({type: 'blob', path: `tests/unit/t${String(i).padStart(2, '0')}.test.ts`, size: 100}));
  const stories = Array.from({length: 200}, (_, i) => ({type: 'blob', path: `src/c/s${i}.stories.tsx`, size: 100}));
  const github = {rest: {git: {getTree: async () => { count('tree'); return {data: {truncated: false, tree: [...tests, ...stories]}}; }},
    repos: {getContent: async args => {
      count('getContent');
      const text = args.path === 'tests/unit/t40.test.ts' ? "import {a} from '../../src/utils/helper';\n" : 'x\n';
      return {data: {content: Buffer.from(text).toString('base64'), encoding: 'base64', size: text.length}};
    }, listCommits: async () => { count('listCommits'); return {data: []}; }}},
    graphql: async () => ({repository: {pullRequest: {closingIssuesReferences: {nodes: [], pageInfo: {hasNextPage: false}}}}})};
  await collectSnapshot({github, repo: {owner: 'o', repo: 'r'}, config: {repository_policy: 'p.md', readme: 'README.md'}, technical: {},
    pr: {number: 3, changed_files: 1, title: 't', body: 'b', base: {sha: BASE}, head: {sha: SHA, repo: {owner: {login: 'o'}, name: 'r'}}},
    files: [{filename: 'src/utils/helper.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b'}]});
}

async function reassess_() {
  current = 'reassessment (review still running for 6 checks)';
  let checks = 0;
  const github = {rest: {
    pulls: {get: withEtag('pulls.get', () => prData)},
    actions: {listWorkflowRuns: withEtag('runs', () => ({workflow_runs: [{id: 40, event: 'pull_request_target', head_sha: SHA, pull_requests: [{number: 3}]}]})),
      getWorkflowRun: async args => {
        if (args.headers?.['if-none-match'] === '"w"' && checks < 6) { checks++; count('getWorkflowRun', true); throw Object.assign(new Error('Not Modified'), {status: 304}); }
        count('getWorkflowRun'); checks++;
        return {headers: {etag: '"w"'}, data: {status: checks >= 6 ? 'completed' : 'in_progress', conclusion: 'failure'}};
      }}},
    request: async () => { count('rerun'); }};
  const waits = [];
  await createPolicy(config).requestReassessment({github, core, wait: async ms => waits.push(ms),
    context: {repo: {owner: 'o', repo: 'r'}, eventName: 'workflow_run', payload: {workflow_run: {event: 'pull_request', path: `.github/workflows/${config.workflow}`, head_sha: SHA, pull_requests: [{number: 3}]}}}});
}

async function reconcile_() {
  current = 'reconcile (40 open approved PRs, one merged, all behind)';
  const pulls = Array.from({length: 40}, (_, i) => ({number: i + 10, draft: false, auto_merge: {enabled_by: {login: 'github-actions[bot]'}}, head: {sha: String(i).padStart(40, '1'), repo: {full_name: 'o/r'}}, base: {ref: 'main', sha: BASE}}));
  const github = {rest: {
    pulls: {list: async () => { count('pulls.list'); return {data: pulls}; }, listReviews: async () => { count('listReviews'); return {data: []}; }, get: async () => { count('pulls.get'); return {data: {merged: true, base: {ref: 'main'}}}; }},
    repos: {compareCommits: async () => { count('compareCommits'); return {data: {behind_by: 1, merge_base_commit: {sha: BASE}}}; }, getBranch: async () => { count('getBranch'); return {data: {commit: {sha: TIP}}}; }},
    issues: {listComments: async () => { count('listComments'); return {data: []}; }, createComment: async () => { count('createComment'); }, updateComment: async () => { count('updateComment'); }}},
    paginate: async (method, args) => (await method(args)).data};
  await reconcileBase({github, updateGithub: null, core, baseBranch: 'main',
    context: {repo: {owner: 'o', repo: 'r'}, eventName: 'workflow_run', payload: {workflow_run: {event: 'pull_request_target', head_sha: SHA, pull_requests: [{number: 3}]}}}});
}

  for (const scenario of [wait_, scan_, reassess_, reconcile_]) { try { await scenario(); } catch (error) { counts[current + ' ERROR'] = error.message; } }
  return counts;
}

module.exports = {measure};
if (require.main === module) measure(process.argv[2] || path.join(__dirname, '..')).then(counts => console.log(JSON.stringify(counts, null, 1)));
