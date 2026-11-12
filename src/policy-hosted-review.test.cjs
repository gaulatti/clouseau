'use strict';
// Policy behavior under the protected hosted_review setting. Kept apart from policy.test.cjs so a change here does not resend that file as review evidence.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createPolicy, intentText} = require('./policy.cjs');
const {assess, gate, scopeReason, assessmentResult, purposeConfirmation, maintainerConfirmed, technicalRun,
  assertProtection, needsDeployment, VERIFY_STEPS} = createPolicy(require('../test/fixtures/config.json'));

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const repo = {owner: 'gaulatti', repo: 'colombo'};
const context = {repo, runId: 123, eventName: 'pull_request_target', payload: {pull_request: {number: 8}}};
const file = {filename: 'src/naming.rs', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+fixed'};
const small = {number: 8, node_id: 'PR_8', state: 'open', draft: false, changed_files: 1, additions: 1,
  deletions: 1, title: 'fix: restore naming', body: 'Existing naming breaks; restore the documented behavior.',
  head: {sha: SHA, ref: 'fix/naming', repo: {id: 42}}, base: {sha: BASE, ref: 'main'},
  auto_merge: {enabled_by: {login: 'github-actions[bot]'}}};
const automatic = {number: 8, head_sha: SHA, base_sha: BASE, decision: 'auto_approve', reason: 'Restores the existing naming contract.'};
const assessmentJson = () => ({head_sha: SHA, decision: 'auto_approve', kind: 'bugfix',
  fits_repository: true, scope_supported: true, intent_supported: true, changes_review_controls: false, test_integrity_supported: true, has_concerns: false, reason: automatic.reason});
const bot = {login: 'github-actions[bot]', type: 'Bot'};
const human = {login: 'maintainer', type: 'User'};

function fixture(overrides = {}) {
  const writes = [];
  let fetches = 0;
  const pr = structuredClone(small);
  const state = {pr, files: [file], comments: [], reviews: [], permission: 'write',
    run: {id: 22, head_sha: SHA, head_branch: pr.head.ref, head_repository: {id: 42}, pull_requests: [],
      event: 'pull_request', status: 'completed', conclusion: 'success', html_url: 'https://github.com/gaulatti/colombo/actions/runs/22'},
    jobs: [{name: 'verify', conclusion: 'success', steps: VERIFY_STEPS.map(name => ({name, conclusion: 'success'}))}],
    ...overrides};
  const endpoint = (name, implementation) => Object.assign(async args => implementation(args), {endpointName: name});
  const write = (name, result = {data: {}}) => endpoint(name, async args => {writes.push({name, args}); return result;});
  const github = {request: async () => ({data: [
    {type: 'required_status_checks', parameters: {strict_required_status_checks_policy: true,
      required_status_checks: ['verify', 'approval-policy'].map(context => ({context, integration_id: 15368}))}},
    {type: 'pull_request', parameters: {required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true}},
    {type: 'deletion'}, {type: 'non_fast_forward'},
  ]}), rest: {
    pulls: {
      get: endpoint('getPr', async () => {fetches++; return {data: structuredClone(state.pr)};}),
      listFiles: endpoint('files', () => ({data: state.files})),
      listReviews: endpoint('reviews', () => ({data: state.reviews})),
      createReview: write('review'),
      requestReviewers: write('requestReview'),
    },
    repos: {
      get: endpoint('repo', () => ({data: {allow_auto_merge: true}})),
      getBranch: endpoint('branch', () => ({data: {protected: true, commit: {sha: BASE}}})),
      getCollaboratorPermissionLevel: endpoint('permission', () => ({data: {permission: state.permission}})),
      getContent: endpoint('content', () => ({data: {content: Buffer.from('original source').toString('base64'), encoding: 'base64'}})),
      listCommits: endpoint('history', () => ({data: [{sha: BASE, commit: {message: 'feat: establish naming contract'}}]})),
    },
    issues: {listComments: endpoint('comments', () => ({data: state.comments})), createComment: write('comment'),
      addAssignees: write('assign')},
    checks: {create: write('createCheck', {data: {id: 1}}), update: write('updateCheck')},
    actions: {
      listWorkflowRuns: endpoint('runs', () => ({data: {workflow_runs: state.run ? [state.run] : []}})),
      listJobsForWorkflowRun: endpoint('jobs', () => ({data: state.jobs})),
      createWorkflowDispatch: write('dispatch'),
    },
  }, graphql: async (query, args) => {
    if (query.startsWith('mutation')) {
      const disarm = query.includes('disablePullRequestAutoMerge');
      writes.push({name: disarm ? 'disarm' : 'arm', args}); state.pr.auto_merge = disarm ? null : {}; return {};
    }
    return {repository: {pullRequest: {closingIssuesReferences: {nodes: [{number: 1, title: 'Fix naming', body: 'Restore contract'}], pageInfo: {hasNextPage: false}}}}};
  }};
  github.paginate = async (method, args) => (await method(args)).data;
  const core = {info: () => {}, summary: {
    addRaw(text) {writes.push({name: 'summary', text}); return this;},
    async write() {},
  }};
  const run = options => gate({github, context, core, assessment: automatic, wait: async () => {}, maxPolls: 1, mergePolls: 1, ...options});
  return {github, state, writes, run, fetches: () => fetches};
}

function reassessmentFixture() {
  const f = nativeFixture();
  f.state.run.event = 'pull_request_target';
  f.github.rest.actions.getWorkflowRun = async args => {
    assert.equal(args.run_id, 22); return {data: f.state.run};
  };
  return f;
}

function nativeFixture(overrides) {
  const f = fixture(overrides);
  const request = f.github.request;
  f.github.request = async (route, args) => {
    if (route.startsWith('POST')) {f.writes.push({name: 'rerun', args}); return {};}
    const result = await request(route, args);
    result.data[0].parameters.required_status_checks[1].context = 'approve-and-merge';
    return result;
  };
  return f;
}

const commentTrigger = () => ({...context, eventName: 'issue_comment', payload: {
  issue: {number: 8, pull_request: {}}, comment: {user: human, body: `/approve-intent ${SHA}`},
}});

test('an exact-head /hosted-review comment from a maintainer reruns the trusted review; any other form, head or author does not', async () => {
  const policy = createPolicy(require('../test/fixtures/config.json'));
  const f = reassessmentFixture(); const c = commentTrigger(); c.payload.comment.body = `/hosted-review ${SHA}`;
  await policy.requestReassessment({github: f.github, context: c, core: {info() {}}, wait: async () => {}});
  assert.deepEqual(f.writes.filter(w => w.name === 'rerun').map(w => w.args.run_id), [22]);
  for (const mutate of [
    (g, d) => {d.payload.comment.body = `/hosted-review ${BASE}`;},
    (g, d) => {d.payload.comment.body = `/hosted-review ${SHA} now`;},
    (g, d) => {d.payload.comment.body = '/hosted-review';},
    g => {g.state.permission = 'read';},
    (g, d) => {d.payload.comment.user = bot;},
  ]) {
    const g = reassessmentFixture(); const d = commentTrigger(); d.payload.comment.body = `/hosted-review ${SHA}`; mutate(g, d);
    await assert.rejects(policy.requestReassessment({github: g.github, context: d, core: {info() {}}, wait: async () => {}}));
    assert.equal(g.writes.length, 0);
  }
});
