'use strict';

// Bleecker PR #453 (three files, branch far behind a busy base): GET /pulls/453 answered
// "The request could not be processed because too many files changed" and the wait died silently.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readPull, TOO_MANY} = require('./pull-read.cjs');
const {createPolicy} = require('./policy.cjs');
const {classify, apiErrorReason, body, NEXT_STEPS} = require('./incomplete.cjs');
const {RateLimitHold} = require('./verification-wait.cjs');

const config = require('../test/fixtures/config.json');
const repo = {owner: 'gaulatti', repo: 'bleecker'};
const SHA = 'a'.repeat(40), BASE = 'b'.repeat(40);
const tooMany = () => Object.assign(new Error('The request could not be processed because too many files changed'), {status: 422,
  request: {method: 'GET', url: 'https://api.github.com/repos/gaulatti/bleecker/pulls/453?access_token=SECRET'}});
const listed = {number: 453, state: 'open', draft: false, merged_at: null, head: {sha: SHA, ref: 'f', repo: {id: 1}}, base: {sha: BASE, ref: 'main'}, user: {login: 'c'}};
const pulls = (extra = {}) => ({get: async () => { throw tooMany(); }, list: async ({page}) => ({data: page === 1 ? [{number: 1}, listed] : []}), listFiles: () => {}, ...extra});
const paginate = async (method, args) => method === undefined ? [] : [{filename: 'a'}, {filename: 'b'}, {filename: 'c'}];

test('a PR whose diff statistics GitHub cannot compute is read from the list endpoint, with its own files counted from the files endpoint', async () => {
  assert.ok(TOO_MANY.test('The request could not be processed because too many files changed'));
  const github = {rest: {pulls: pulls()}, paginate};
  const {data} = await readPull(github, repo, 453);
  assert.equal(data.number, 453); assert.equal(data.head.sha, SHA); assert.equal(data.changed_files, 3, 'the PR\'s own three files, never a base-vs-head tree');
  assert.equal(data.merged, false);
  const merged = await readPull({rest: {pulls: pulls({list: async () => ({data: [{...listed, merged_at: '2026-10-31T00:00:00Z'}]})})}, paginate}, repo, 453);
  assert.equal(merged.data.merged, true);
  // Found on the second page; absent everywhere rethrows the original error; other errors are never swallowed.
  const second = pulls({list: async ({page}) => ({data: page === 1 ? Array.from({length: 100}, (_, i) => ({number: 1000 + i})) : [listed]})});
  assert.equal((await readPull({rest: {pulls: second}, paginate}, repo, 453)).data.number, 453);
  let pages = 0;
  await assert.rejects(readPull({rest: {pulls: pulls({list: async () => { pages++; return {data: Array.from({length: 100}, (_, i) => ({number: 2000 + i}))}; }})}, paginate}, repo, 453), /too many files changed/);
  assert.equal(pages, 10, 'bounded');
  await assert.rejects(readPull({rest: {pulls: pulls({list: async () => ({data: []})})}, paginate}, repo, 453), /too many files changed/);
  const other = Object.assign(new Error('Not Found'), {status: 404});
  await assert.rejects(readPull({rest: {pulls: {get: async () => { throw other; }}}}, repo, 453), error => error === other);
  const plain = await readPull({rest: {pulls: {get: async args => ({data: {number: args.pull_number, extra: args.headers}})}}}, repo, 7, {headers: {'if-none-match': 'x'}});
  assert.deepEqual(plain.data, {number: 7, extra: {'if-none-match': 'x'}});
});

function sink() {
  const outputs = {};
  return {outputs, info: [], core: {info() {}, setOutput: (name, value) => {outputs[name] = value;}}};
}
const context = {repo, eventName: 'pull_request_target', payload: {pull_request: {number: 453, head: {sha: SHA}, base: {sha: BASE}}}};
const runs = () => ({listWorkflowRuns: async () => ({headers: {}, data: {workflow_runs: [{id: 9, head_sha: SHA, status: 'completed', conclusion: 'success', pull_requests: [{number: 453}], html_url: 'u'}]}}),
  listJobsForWorkflowRun: async () => ({data: [{name: config.verification.job, status: 'completed', conclusion: 'success', run_attempt: 1,
    steps: config.verification.steps.map(name => ({name, status: 'completed', conclusion: 'success'}))}]})});

test('the wait survives the too-many-files response and still reaches the verified state', async () => {
  const policy = createPolicy(config); const s = sink();
  const github = {rest: {pulls: pulls(), actions: runs()}, paginate: async (method, args) => (typeof method === 'function' ? (await method(args)).data ?? [] : [])};
  github.paginate = async (method, args) => method === github.rest.pulls.listFiles ? [{filename: 'a'}] : (await method(args)).data;
  const result = await policy.awaitVerification({github, context, core: s.core, expectedHead: SHA, wait: async () => {}});
  assert.ok(result.url); assert.equal(s.outputs.verified, 'true');
});

test('any HTTP error in the wait is a visible hold naming status and endpoint, never a silent crash', async () => {
  const policy = createPolicy(config);
  for (const status of [422, 500, 403, 404]) {
    const s = sink();
    const failing = Object.assign(new Error('Something broke @owner'), {status, request: {method: 'get', url: 'https://api.github.com/repos/gaulatti/bleecker/pulls/453?token=SECRET'}});
    const result = await policy.awaitVerification({github: {rest: {pulls: {get: async () => { throw failing; }}}}, context, core: s.core, expectedHead: SHA, wait: async () => {}});
    assert.deepEqual({pending: result.pending, state: result.state, status: result.status}, {pending: true, state: 'api_error', status});
    assert.equal(s.outputs.verified, 'false');
    const assessment = JSON.parse(s.outputs.assessment);
    assert.deepEqual({decision: assessment.decision, cause: assessment.cause, head: assessment.head_sha, base: assessment.base_sha}, {decision: 'review_incomplete', cause: 'github_api_error', head: SHA, base: BASE});
    assert.equal(assessment.reason, `GitHub API request failed: HTTP ${status} GET gaulatti/bleecker/pulls/453 (Something broke owner).`);
    assert.ok(!/SECRET|token|api\.github\.com/.test(assessment.reason), 'no credential, query or host');
    const notice = body({number: 453, head_sha: SHA, ...assessment}, 'https://github.com/gaulatti/bleecker/actions/runs/1');
    assert.ok(notice.includes(`HTTP ${status} GET gaulatti/bleecker/pulls/453`) && notice.includes(NEXT_STEPS.github_api_error));
  }
  // The step's own control-flow errors (no status) still fail closed; a rate limit keeps its own hold.
  const s = sink();
  const closed = {rest: {pulls: {get: async () => ({data: {number: 453, state: 'closed', draft: false, head: {sha: SHA}, base: {sha: BASE}}})}}};
  await assert.rejects(policy.awaitVerification({github: closed, context, core: s.core, expectedHead: SHA, wait: async () => {}}), /closed, became draft, or changed/);
  assert.ok(new RateLimitHold(Date.now()) instanceof Error);
});

test('classification and endpoint rendering tolerate odd errors', () => {
  assert.equal(classify(Object.assign(new Error('x'), {status: 422, request: {method: 'POST', url: 'https://api.github.com/repos/a/b/pulls?x=1'}})).reason,
    'GitHub API request failed: HTTP 422 POST a/b/pulls (x).');
  assert.equal(apiErrorReason({status: 500, message: ''}), 'GitHub API request failed: HTTP 500 GET an unknown endpoint.');
  assert.equal(apiErrorReason({status: 500, message: 'm', request: {url: 'not a url'}}), 'GitHub API request failed: HTTP 500 GET an unknown endpoint (m).');
  assert.equal(classify({status: 304}).cause, 'evidence_incomplete', 'a non-error status is not an API failure');
});
