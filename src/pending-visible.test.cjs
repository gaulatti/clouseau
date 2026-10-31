'use strict';

// Lab9: a pull_request_target run ended with no Clouseau comment after ~126 s. The wait had not stalled (the
// 900 s default grace was never reached): it ended on a GitHub API rate-limit hold that published nothing,
// and the reassessment that followed failed on the same limit as an unhandled HttpError.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createPolicy} = require('./policy.cjs');
const {pendingBody, postPending, resolvePending, PENDING} = require('./incomplete.cjs');

const config = require('../test/fixtures/config.json');
const repo = {owner: 'example', repo: 'gateway'};
const SHA = 'a'.repeat(40), BASE = 'b'.repeat(40);
const context = {repo, eventName: 'pull_request_target', payload: {pull_request: {number: 3, head: {sha: SHA}, base: {sha: BASE}}}};
const prData = {number: 3, state: 'open', draft: false, head: {sha: SHA, ref: 'f', repo: {id: 1}}, base: {sha: BASE, ref: 'main'}};
const limit = () => Object.assign(new Error('API rate limit exceeded for installation'), {status: 403,
  response: {headers: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 2000)}}});
function sink() {
  const outputs = {}; const info = [];
  return {outputs, info, core: {info: line => info.push(line), setOutput: (name, value) => {outputs[name] = value;}}};
}
const queued = () => ({rest: {pulls: {get: async () => ({data: prData})}, actions: {
  listWorkflowRuns: async () => ({headers: {}, data: {workflow_runs: [{id: 9, head_sha: SHA, status: 'queued', conclusion: null, pull_requests: [{number: 3}], html_url: 'u'}]}}),
}}});

test('with the default config a queued verification is waited on for the whole 900 s grace, not ~126 s', async () => {
  const policy = createPolicy(config);
  const s = sink(); let total = 0; const delays = [];
  const result = await policy.awaitVerification({github: queued(), context, core: s.core, expectedHead: SHA, wait: async ms => {total += ms; delays.push(ms);}});
  assert.equal(result.pending, true);
  assert.ok(total >= 900000, `waited ${total / 1000} s`);
  assert.ok(delays.slice(0, 3).reduce((a, b) => a + b, 0) < 126000 + 100000);
  assert.ok(total > 126000, 'the old poll-count constant (8 x 15 s) is gone');
  assert.equal(s.outputs.verified, 'false');
  const assessment = JSON.parse(s.outputs.assessment);
  assert.deepEqual({decision: assessment.decision, verification: assessment.verification, head: assessment.head_sha, base: assessment.base_sha, number: assessment.number},
    {decision: 'pending_technical', verification: 'queued', head: SHA, base: BASE, number: 3});
  assert.match(assessment.reason, /reassessed automatically/);
});

test('a rate-limit hold during the wait is published as a visible incomplete assessment, never silent', async () => {
  const policy = createPolicy(config);
  const s = sink(); let polls = 0;
  const github = {rest: {pulls: {get: async () => {if (++polls > 8) throw limit(); return {data: prData};}}, actions: queued().rest.actions}};
  const result = await policy.awaitVerification({github, context, core: s.core, expectedHead: SHA, wait: async () => {}});
  assert.equal(result.state, 'rate_limited'); assert.equal(s.outputs.verified, 'false');
  const assessment = JSON.parse(s.outputs.assessment);
  assert.deepEqual({decision: assessment.decision, cause: assessment.cause, head: assessment.head_sha, base: assessment.base_sha},
    {decision: 'review_incomplete', cause: 'github_rate_limit', head: SHA, base: BASE});
  assert.match(assessment.reason, /^Held: GitHub API rate limit, will retry after /);
  assert.match(assessment.retry_after, /^\d{4}-/);
  // Before the PR was ever read, the identity still comes from the event payload; a dispatch has none.
  const first = sink();
  await policy.awaitVerification({github: {rest: {pulls: {get: async () => {throw limit();}}}}, context, core: first.core, wait: async () => {}});
  assert.equal(JSON.parse(first.outputs.assessment).head_sha, SHA);
  const dispatch = sink(); const previous = process.env.PR_NUMBER; process.env.PR_NUMBER = '3';
  try {
    await policy.awaitVerification({github: {rest: {pulls: {get: async () => {throw limit();}}}}, context: {repo, eventName: 'workflow_dispatch', payload: {}}, core: dispatch.core, wait: async () => {}});
  } finally {if (previous === undefined) delete process.env.PR_NUMBER; else process.env.PR_NUMBER = previous;}
  const bare = JSON.parse(dispatch.outputs.assessment);
  assert.deepEqual({head: bare.head_sha, base: bare.base_sha, cause: bare.cause}, {head: '', base: '', cause: 'github_rate_limit'}, 'a dispatch carries no PR identity before the PR is read');
});

test('the pending comment is short, idempotent, and replaced by a resolution once a decision exists', async () => {
  const comments = []; const created = []; const updated = [];
  const github = {paginate: async () => comments, rest: {issues: {listComments: () => {}, createComment: async args => {created.push(args); comments.push({id: 7, user: {login: 'github-actions[bot]'}, body: args.body});},
    updateComment: async args => {updated.push(args); comments[0].body = args.body;}}}};
  const ctx = {repo, runId: 5};
  const assessment = {number: 3, head_sha: SHA, decision: 'pending_technical', verification: 'queued', reason: 'Waiting @owner for verification'};
  await postPending({github, context: ctx, assessment});
  await postPending({github, context: ctx, assessment: {...assessment, verification: 'running'}});
  assert.equal(created.length, 1); assert.equal(updated.length, 1, 'one comment per PR, updated in place');
  assert.ok(comments[0].body.startsWith(`${PENDING}\n`) && comments[0].body.includes('state: running') && !comments[0].body.includes('@owner'));
  assert.ok(pendingBody({head_sha: SHA}, 'u').includes('state: unknown'));
  assert.ok(pendingBody({head_sha: SHA, verification: 'queued'}, 'u').includes('automatically when verification completes'));
  await resolvePending({github, context: ctx, number: 3});
  assert.match(comments[0].body, /Resolved: verification finished/);
  const edits = updated.length;
  await resolvePending({github, context: ctx, number: 3});
  assert.equal(updated.length, edits, 'an already resolved comment is left alone');
  const none = {paginate: async () => [], rest: {issues: {updateComment: async () => assert.fail('nothing to resolve')}}};
  await resolvePending({github: none, context: ctx, number: 3});
});

test('reassessment retries rate-limited calls and, if the budget stays exhausted, fails with an explicit re-run time', async () => {
  const policy = createPolicy(config);
  const finished = {event: 'pull_request', path: `.github/workflows/${config.workflow}`, head_sha: SHA, pull_requests: [{number: 3}]};
  const ctx = {repo, eventName: 'workflow_run', payload: {workflow_run: finished}};
  let gets = 0; const waits = []; const requests = [];
  const github = {rest: {
    pulls: {get: async () => {if (++gets <= 2) throw Object.assign(new Error('secondary rate limit'), {status: 403, response: {headers: {'retry-after': '1'}}}); return {data: prData};}},
    actions: {listWorkflowRuns: async () => ({data: {workflow_runs: [{id: 40, event: 'pull_request_target', head_sha: SHA, pull_requests: [{number: 3}]}]}}),
      getWorkflowRun: async () => ({data: {status: 'completed', conclusion: 'failure'}})}},
  request: async (route, args) => requests.push([route, args.run_id])};
  const info = [];
  await policy.requestReassessment({github, context: ctx, core: {info: line => info.push(line)}, wait: async ms => waits.push(ms)});
  assert.deepEqual(requests, [['POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun', 40]]);
  assert.equal(gets, 3); assert.ok(waits.some(ms => ms >= 1000));
  const spent = {rest: {pulls: {get: async () => {throw limit();}}}};
  await assert.rejects(policy.requestReassessment({github: spent, context: ctx, core: {info() {}}, wait: async () => assert.fail('no sleeping for the reset')}),
    /^Error: Reassessment held: Held: GitHub API rate limit, will retry after .* Re-run this job after that time/s);
  const other = {rest: {pulls: {get: async () => {throw new Error('boom');}}}};
  await assert.rejects(policy.requestReassessment({github: other, context: ctx, core: {info() {}}, wait: async () => {}}), /boom/);
});
