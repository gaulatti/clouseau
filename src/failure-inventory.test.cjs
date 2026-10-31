'use strict';

// Inventory of every place the acceptance pipeline can throw during review. Each path must end as an
// explicit fail-closed hold (review_incomplete) whose visible notice names the specific missing or
// failing item, never as an aborted assessment with the generic text.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {classify, body, GENERIC, NEXT_STEPS} = require('./incomplete.cjs');
const {requestJSON} = require('./review-provider.cjs');
const {validateReport} = require('./acceptance.cjs');
const {materialize, modelTemplate, inspect} = require('./acceptance-review.cjs');
const {collectSnapshot, refresh} = require('./acceptance-sources.cjs');
const {fixture, finding} = require('../test/fixtures/acceptance.cjs');

const messages = [{role: 'user', content: 'x'}];
const reply = value => ({ok: true, status: 200, json: async () => value});
const wait = async () => {};
async function capture(run) {
  const old = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fictional';
  try {await run(); } catch (error) {return error;} finally {if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;}
  throw new Error('expected a failure');
}
function sources() {
  const github = {rest: {git: {getTree: async () => ({data: {truncated: false, tree: []}})}, repos: {
    getContent: async () => ({data: {content: Buffer.from('x\n').toString('base64'), encoding: 'base64', size: 2}}),
    listCommits: async () => ({data: []})}}, graphql: async () => ({repository: {pullRequest: {closingIssuesReferences: {nodes: [], pageInfo: {hasNextPage: false}}}}})};
  return {github, repo: {owner: 'o', repo: 'r'}, config: {repository_policy: 'p.md', readme: 'README.md'}, technical: {},
    pr: {number: 1, changed_files: 1, title: 't', body: 'b', base: {sha: 'b'.repeat(40)}, head: {sha: 'a'.repeat(40), repo: {owner: {login: 'o'}, name: 'r'}}},
    files: [{filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b'}]};
}

test('every failure path of the AI step ends in a classified hold that names the specific item', async () => {
  const bad = calls => ({fetchImpl: async () => reply({choices: [{finish_reason: 'tool_calls', message: {tool_calls: calls}}]}), schemas: {acceptance_report: {}}, thinking: false});
  const f = fixture();
  const stale = structuredClone(f.report); stale.snapshot = 'stale';
  const noAnchor = (() => {const g = fixture(); return g;})();
  const budget = sources(); budget.pr.body = 'z'.repeat(1000000);
  const unreadable = sources(); unreadable.github.rest.repos.getContent = async () => ({data: {content: 'AAAA', encoding: 'base64', size: 400000}});
  const patchless = sources(); delete patchless.files[0].patch;
  const tree = sources(); tree.github.rest.git.getTree = async () => ({data: {truncated: true, tree: []}});
  const lockfile = sources(); lockfile.files[0] = {filename: 'Cargo.lock', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b'};
  lockfile.github.rest.repos.getContent = async args => ({data: args.path === 'Cargo.lock' ? {content: Buffer.from('version = 1\n').toString('base64'), encoding: 'base64', size: 400000} : {content: Buffer.from('x\n').toString('base64'), encoding: 'base64', size: 2}});
  const exhausted = fixture(); exhausted.snapshot.head_sha = 'head';
  const paths = fixture();
  const cases = [
    ['invalid tool call', () => requestJSON({model: 'deepseek-flash', messages, wait, ...bad([])}), 'review_output_invalid', /invalid tool call or malformed JSON/],
    ['malformed JSON', () => requestJSON({model: 'deepseek-flash', messages, wait, fetchImpl: async () => reply({choices: [{finish_reason: 'stop', message: {content: '{"x":'}}]})}), 'review_output_invalid', /3 consecutive attempts/],
    ['unfinished answer', () => requestJSON({model: 'deepseek-flash', messages, wait, fetchImpl: async () => reply({choices: [{finish_reason: 'other'}]})}), 'provider_incomplete', /token budget/],
    ['invalid evidence', async () => validateReport(stale, f.snapshot), 'review_output_invalid', /stale identity or missing summary/],
    ['unbindable finding', async () => { const facts = modelTemplate(noAnchor.snapshot); facts.findings.push({}); return materialize(facts, noAnchor.snapshot); }, 'review_output_invalid', /cannot bind/],
    ['unit paths', async () => { const facts = modelTemplate(paths.snapshot); facts.units[0].paths = []; return materialize(facts, paths.snapshot); }, 'review_output_invalid', /cannot bind/],
    ['evidence budget', () => collectSnapshot(budget).then(snapshot => refresh({...snapshot, claims: {description: 'z'.repeat(1000000)}})), 'evidence_budget', /900 KB/],
    ['unreadable changed file', () => collectSnapshot(unreadable), 'changed_file_unreadable', /src\/app\.ts|README\.md|p\.md/],
    ['unsummarizable lockfile', () => collectSnapshot(lockfile), 'lockfile_unsummarizable', /Cargo\.lock cannot be summarized \(its text is larger than 1000000 bytes|Cargo\.lock cannot be summarized/],
    ['missing patch', () => collectSnapshot(patchless), 'changed_files_incomplete', /patch for every changed file/],
    ['tree truncated', () => collectSnapshot(tree), 'tree_truncated', /repository tree/],
    ['source investigation exhausted', () => inspect({...exhausted, role: 'examiner', model: 'deepseek-flash', wait, fetchImpl: async () => reply({choices: [{finish_reason: 'tool_calls',
      message: {tool_calls: [{function: {name: 'source_request', arguments: JSON.stringify({request_sources: ['a'], extra: true})}}]}}]})}), 'investigation_exhausted', /bounded investigation/],
  ];
  for (const [name, run, cause, reason] of cases) {
    const error = await capture(run);
    const classified = classify(error);
    assert.equal(classified.cause, cause, `${name}: ${error.message}`);
    assert.match(classified.reason, reason, name);
    assert.notEqual(classified.reason, GENERIC, name);
    const notice = body({number: 1, head_sha: 'a'.repeat(40), ...classified}, 'https://github.com/o/r/actions/runs/1');
    assert.ok(notice.includes(`**Reason:** ${classified.reason.replaceAll('@', '').replace(/\s+/g, ' ').slice(0, 500)}`), `${name}: the visible comment names the item`);
    assert.ok(notice.includes(NEXT_STEPS[cause]), `${name}: and a specific next step`);
  }
  const named = classify(await capture(() => collectSnapshot(unreadable)));
  assert.match(named.reason, /Changed file \S+ cannot be read as complete text/);
});
