'use strict';

// gaulatti/clouseau#244: an owner's /approve-intent started request-reassessment, GitHub answered one call with HTTP 503,
// and the job died with an unhandled HttpError: nothing retried it (the github-script client runs with `retries: 0`) and
// nothing told the owner. A transient failure is now retried, and one that persists is reported on the pull request.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createPolicy} = require('./policy.cjs');

const config = require('../test/fixtures/config.json');
const repo = {owner: 'example', repo: 'gateway'};
const SHA = 'a'.repeat(40);
const RERUN = 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun';
const unavailable = () => Object.assign(new Error('Service Unavailable'), {status: 503});
const comment = {...{repo}, eventName: 'issue_comment', payload: {issue: {number: 3, pull_request: {}},
  comment: {id: 501, user: {login: 'gaulatti', type: 'User'}, body: `/approve-intent ${SHA}`}}};

function world({pull = () => ({data: {number: 3, state: 'open', draft: false, head: {sha: SHA, ref: 'f', repo: {id: 1}}, base: {sha: 'b'.repeat(40), ref: 'main'}}}),
  rerun = () => ({}), runStatus = () => 'completed', comment: post = () => ({data: {id: 1}})} = {}) {
  const calls = {pulls: 0, reruns: [], comments: [], waits: [], info: [], landed: []};
  const github = {
    paginate: async (method, args) => (await method(args)).data,
    rest: {
      pulls: {get: async () => {calls.pulls++; return pull(calls.pulls);}},
      repos: {getCollaboratorPermissionLevel: async () => ({data: {permission: 'admin'}})},
      actions: {
        listWorkflowRuns: async () => ({data: {workflow_runs: [{id: 40, event: 'pull_request_target', head_sha: SHA, pull_requests: [{number: 3}]}]}}),
        getWorkflowRun: async () => ({data: {status: runStatus(calls.reruns.length), conclusion: 'failure'}}),
      },
      // A notice lands unless `post` throws; `post` may land it and still throw (GitHub answering 5xx after the write).
      issues: {createComment: async args => {calls.comments.push(args); const result = await post(calls.comments.length, () => calls.landed.push(args.body));
        calls.landed.push(args.body); return result;},
      listComments: async () => ({data: calls.landed.map(body => ({user: {login: 'github-actions[bot]'}, body}))})},
    },
    request: async (route, args) => {assert.equal(route, RERUN); calls.reruns.push(args.run_id); return rerun(calls.reruns.length);},
  };
  const run = (context = comment) => createPolicy(config).requestReassessment({github, context,
    core: {info: line => calls.info.push(line)}, wait: async ms => {calls.waits.push(ms);}});
  return {calls, run, pull};
}

test('a transient 503 is retried with backoff and the reassessment is requested', async () => {
  const ready = world();
  const w = world({pull: count => {if (count <= 2) throw unavailable(); return ready.pull();}});
  await w.run();
  assert.equal(w.calls.pulls, 3);
  assert.deepEqual(w.calls.reruns, [40]);
  assert.ok(w.calls.waits.includes(2000) && w.calls.waits.includes(6000), 'the shared transient backoff');
  assert.deepEqual(w.calls.comments, [], 'a request that succeeded posts nothing');
});

test('a rerun that GitHub reported as failed but that landed is not requested twice', async () => {
  const w = world({rerun: count => {if (count === 1) throw unavailable(); return {};}, runStatus: reruns => reruns ? 'queued' : 'completed'});
  await w.run();
  assert.deepEqual(w.calls.reruns, [40], 'the retry saw the run already rerunning');
  const again = world({rerun: count => {if (count === 1) throw unavailable(); return {};}});
  await again.run();
  assert.deepEqual(again.calls.reruns, [40, 40], 'a rerun that did not land is requested again');
});

test('a persistent transient failure is never silent: the pull request is told the request was received and how to recover', async () => {
  const w = world({pull: () => {throw unavailable();}});
  await assert.rejects(w.run(), /^Error: Reassessment could not be requested: GitHub kept failing transiently \(4 attempts\)\./);
  assert.deepEqual(w.calls.reruns, []);
  assert.equal(w.calls.comments.length, 1);
  const [notice] = w.calls.comments;
  assert.equal(notice.issue_number, 3);
  assert.ok(notice.body.startsWith('<!-- clouseau-reassessment-unrequested:comment-501 -->\n'));
  assert.match(notice.body, new RegExp(`\\(\`/approve-intent ${SHA}\`\\) was received`));
  assert.match(notice.body, /\*\*Re-run all jobs\*\* \(not "Re-run failed jobs"/);
  // A dispatch that names the pull request is told the same way.
  const dispatched = world({pull: () => {throw unavailable();}});
  process.env.PR_NUMBER = '3';
  try {await assert.rejects(dispatched.run({repo, eventName: 'workflow_dispatch', payload: {inputs: {pull_request: '3'}}, actor: 'gaulatti'}));}
  finally {delete process.env.PR_NUMBER;}
  assert.equal(dispatched.calls.comments[0].issue_number, 3);
  assert.match(dispatched.calls.comments[0].body, /\(`the dispatched reassessment`\) was received/);
});

test('a notice that cannot be posted is logged and never hides the failure; nothing is posted without a requesting pull request', async () => {
  const w = world({pull: () => {throw unavailable();}, comment: () => {throw Object.assign(new Error('Resource not accessible by integration'), {status: 403});}});
  await assert.rejects(w.run(), /could not be requested/);
  assert.ok(w.calls.info.some(line => /notice could not be posted on PR 3 \(HTTP 403\).*issues: write and pull-requests: write/.test(line)));
  const offline = world({pull: () => {throw unavailable();}, comment: () => {throw new Error('socket hang up');}});
  await assert.rejects(offline.run(), /could not be requested/);
  assert.ok(offline.calls.info.some(line => /notice could not be posted on PR 3 \(HTTP unknown\)/.test(line)));
  const verification = world({pull: () => {throw unavailable();}});
  await assert.rejects(verification.run({repo, eventName: 'workflow_run', payload: {workflow_run: {event: 'pull_request',
    path: `.github/workflows/${config.workflow}`, head_sha: SHA, pull_requests: [{number: 3}]}}}), /could not be requested/);
  assert.deepEqual(verification.calls.comments, [], 'a verification completion asked nothing of a person');
  const nameless = world({pull: () => {throw unavailable();}});
  process.env.PR_NUMBER = 'x';
  try {await assert.rejects(nameless.run({repo, eventName: 'workflow_dispatch', payload: {inputs: {pull_request: 'x'}}, actor: 'gaulatti'}));}
  finally {delete process.env.PR_NUMBER;}
  assert.deepEqual(nameless.calls.comments, []);
});

test('a deterministic failure still fails at once, without retry or notice', async () => {
  const w = world({pull: () => {throw Object.assign(new Error('Not Found'), {status: 404});}});
  await assert.rejects(w.run(), /Not Found/);
  assert.equal(w.calls.pulls, 1); assert.deepEqual(w.calls.comments, []);
});

test('a notice that GitHub reported as failed but that landed is not posted twice; one that did not land is retried', async () => {
  const landed = world({pull: () => {throw unavailable();}, comment: (count, land) => {if (count === 1) {land(); throw unavailable();} return {data: {id: 2}};}});
  await assert.rejects(landed.run(), /could not be requested/);
  assert.equal(landed.calls.comments.length, 1, 'the retry found the notice and did not post again');
  assert.equal(landed.calls.landed.length, 1);
  const lost = world({pull: () => {throw unavailable();}, comment: count => {if (count === 1) throw unavailable(); return {data: {id: 2}};}});
  await assert.rejects(lost.run(), /could not be requested/);
  assert.equal(lost.calls.comments.length, 2); assert.equal(lost.calls.landed.length, 1);
  // A dispatch's notice is keyed by its run.
  const dispatched = world({pull: () => {throw unavailable();}});
  process.env.PR_NUMBER = '3';
  try {await assert.rejects(dispatched.run({repo, runId: 77, eventName: 'workflow_dispatch', payload: {inputs: {pull_request: '3'}}, actor: 'gaulatti'}));}
  finally {delete process.env.PR_NUMBER;}
  assert.ok(dispatched.calls.comments[0].body.startsWith('<!-- clouseau-reassessment-unrequested:run-77 -->\n'));
});

test('a rerun retried by the rate-limit wait after landing is not requested twice', async () => {
  // A rate limit that asks for more than the transient window is waited out by the outer rate-limit layer, which starts the
  // transient retry over: the landed check must still run.
  const long = () => Object.assign(new Error('secondary rate limit'), {status: 403, response: {headers: {'retry-after': '90'}}});
  const w = world({rerun: count => {if (count === 1) throw long(); return {};}, runStatus: reruns => reruns ? 'queued' : 'completed'});
  await w.run();
  assert.deepEqual(w.calls.reruns, [40], 'the second attempt saw the run already rerunning');
});
