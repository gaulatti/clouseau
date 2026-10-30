'use strict';

// Issue 134: the first pull_request_target run saw `Required verification steps did not all succeed` although the
// pull_request verification run was green. The decision must rest only on the final state of the LATEST attempt.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createPolicy} = require('./policy.cjs');
const {body, NEXT_STEPS} = require('./incomplete.cjs');

const config = require('../test/fixtures/config.json');
const policy = createPolicy(config);
const repo = {owner: 'example', repo: 'gateway'};
const SHA = 'a'.repeat(40);
const pr = {number: 3, head: {sha: SHA, ref: 'f', repo: {id: 1}}};
const steps = (conclusion = 'success') => config.verification.steps.map(name => ({name, status: 'completed', conclusion}));
const job = (extra = {}) => ({id: 1, name: config.verification.job, status: 'completed', conclusion: 'success', run_attempt: 1, steps: steps(), ...extra});
const run = (extra = {}) => ({id: 9, head_sha: SHA, status: 'completed', conclusion: 'success', run_attempt: 1, event: 'pull_request',
  pull_requests: [{number: 3}], html_url: 'https://github.com/example/gateway/actions/runs/9', ...extra});

// `snapshots` is the sequence of job lists the API returns on successive reads.
function api(snapshots, runExtra) {
  let reads = 0;
  return {reads: () => reads, github: {
    paginate: async () => snapshots[Math.min(reads++, snapshots.length - 1)],
    rest: {actions: {listWorkflowRuns: async () => ({headers: {}, data: {workflow_runs: [run(runExtra)]}}), listJobsForWorkflowRun: async () => []}},
  }};
}
const check = async (snapshots, runExtra, options = {}) => {
  const waits = []; const a = api(snapshots, runExtra);
  const result = await policy.technicalRun(a.github, repo, pr, {wait: async ms => waits.push(ms), ...options});
  return {result, waits, reads: a.reads()};
};

test('a snapshot taken while the verify job or its steps are still finalizing is re-read, never a failure', async () => {
  const inProgress = [job({status: 'in_progress', conclusion: null})];
  const stepsPending = [job({steps: config.verification.steps.map(name => ({name, status: 'in_progress', conclusion: null}))})];
  const eventual = await check([inProgress, stepsPending, [job()]]);
  assert.equal(eventual.result.url !== undefined && !eventual.result.failure, true);
  assert.deepEqual(eventual.waits, [2000, 4000], 'bounded exponential re-reads');
  assert.equal(eventual.reads, 3);
  // Never final within the re-reads: still pending, still not a failure.
  for (const snapshot of [inProgress, stepsPending, [], [job({steps: []})], [job({steps: undefined})], [job({status: 'queued', conclusion: null})]]) {
    const stuck = await check([snapshot]);
    assert.deepEqual({pending: stuck.result.pending, state: stuck.result.state, failure: stuck.result.failure}, {pending: true, state: 'finalizing', failure: undefined});
    assert.deepEqual(stuck.waits, [2000, 4000, 8000]); assert.equal(stuck.reads, 4);
  }
  // A job list from a newer attempt than the run record is a stale record, not a failure.
  const ahead = await check([[job({run_attempt: 2})]], {run_attempt: 1});
  assert.equal(ahead.result.state, 'finalizing'); assert.match(ahead.result.detail, /attempt 2, ahead of the run record/);
  assert.match((await check([inProgress])).result.detail, /job "verify" is in_progress|"\w+" is in_progress/);
  assert.match((await check([stepsPending])).result.detail, /required step ".+" has no final conclusion yet/);
});

test('only the latest attempt counts: a cancelled earlier attempt cannot fail a green re-run', async () => {
  const cancelledFirst = [job({run_attempt: 1, conclusion: 'cancelled', steps: steps('cancelled')}), job({run_attempt: 2})];
  const rerun = await check([cancelledFirst], {run_attempt: 2});
  assert.equal(rerun.result.failure, undefined); assert.ok(rerun.result.url);
  const receipt = await check([cancelledFirst], {run_attempt: 2}, {receipt: true});
  assert.equal(receipt.result.attempt, 2); assert.equal(receipt.result.job.conclusion, 'success');
  assert.deepEqual(receipt.result.job.steps.map(step => step.conclusion), config.verification.steps.map(() => 'success'));
  const reversed = await check([[...cancelledFirst].reverse()], {run_attempt: 2});
  assert.ok(reversed.result.url, 'job order in the list does not matter');
  const unversioned = await check([[{...job(), run_attempt: undefined}, {...job({conclusion: 'cancelled', steps: steps('cancelled')}), run_attempt: undefined}]]);
  assert.ok(unversioned.result.failure || unversioned.result.url, 'a list without attempt numbers is still evaluated');
});

test('a final failure names exactly the run, job or step that failed', async () => {
  const named = config.verification.steps;
  const skipped = job({steps: steps().map((step, index) => index === 1 ? {...step, conclusion: 'skipped'} : step)});
  assert.equal((await check([[skipped]])).result.failure, `Required verification step "${named[1]}" concluded skipped`);
  const failedStep = job({steps: steps().map((step, index) => index === 0 ? {...step, conclusion: 'failure'} : step)});
  assert.equal((await check([[failedStep]])).result.failure, `Required verification step "${named[0]}" concluded failure`);
  assert.equal((await check([[job({conclusion: 'failure'})]])).result.failure, `Verification job "${config.verification.job}" concluded failure`);
  assert.equal((await check([[{...job(), name: 'other'}]])).result.failure, `Verification job "${config.verification.job}" was not found in run 9 attempt 1`);
  assert.equal((await check([[job()]], {conclusion: 'failure'})).result.failure, 'PR verification concluded failure');
  for (const outcome of [await check([[skipped]]), await check([[failedStep]])]) assert.deepEqual(outcome.waits, [], 'a definite conclusion is not re-read');
  const odd = job({steps: steps().map((step, index) => index === 0 ? {...step, conclusion: 'mystery'} : step)});
  assert.equal((await check([[odd]])).result.state, 'finalizing', 'an unknown conclusion is not final');
});

test('the wait step publishes a precise incomplete assessment for a real failure and never fails on a transient snapshot', async () => {
  const outputs = {}; const info = [];
  const core = {info: line => info.push(line), setOutput: (name, value) => {outputs[name] = value;}};
  const context = {repo, eventName: 'pull_request_target', payload: {pull_request: {number: 3, head: {sha: SHA}}}};
  const prData = {number: 3, state: 'open', draft: false, head: {sha: SHA, ref: 'f', repo: {id: 1}}, base: {ref: 'main'}};
  const make = snapshots => {
    const a = api(snapshots);
    a.github.rest.pulls = {get: async () => ({data: prData})};
    return a.github;
  };
  const failed = job({steps: steps().map((step, index) => index === 1 ? {...step, conclusion: 'failure'} : step)});
  await assert.rejects(policy.awaitVerification({github: make([[failed]]), context, core, expectedHead: SHA, wait: async () => {}}), /concluded failure/);
  const assessment = JSON.parse(outputs.assessment);
  assert.deepEqual({decision: assessment.decision, cause: assessment.cause, number: assessment.number, head: assessment.head_sha},
    {decision: 'review_incomplete', cause: 'verification_failed', number: 3, head: SHA});
  assert.match(assessment.reason, /^Required verification step ".+" concluded failure$/);
  const notice = body({...assessment}, 'https://github.com/example/gateway/actions/runs/1');
  assert.ok(notice.includes(`**Reason:** ${assessment.reason}`) && notice.includes(NEXT_STEPS.verification_failed));
  // A transient snapshot that never settles ends pending within the grace and is reassessed, not failed.
  const pending = await policy.awaitVerification({github: make([[]]), context, core, expectedHead: SHA, wait: async () => {}, queuedGraceSeconds: 0});
  assert.equal(pending.pending, true); assert.equal(pending.state, 'finalizing'); assert.equal(outputs.verified, 'false');
});
