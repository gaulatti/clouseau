'use strict';
// This repository's verification contract at the gate: `verify` holds the four receipt-covered steps the configuration requires
// and the engine's self-tests, which run whatever a receipt says. Kept apart from policy.test.cjs so a change here does not
// resend that file as review evidence.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createPolicy} = require('./policy.cjs');

const repo = {owner: 'gaulatti', repo: 'clouseau'};
const HEAD = 'a'.repeat(40);
const pr = {number: 8, head: {sha: HEAD, ref: 'ci/split', repo: {id: 42}}};
const config = require('../.github/clouseau.json');
const SELF_TESTS = ['Check review-semantics declarations against the verified tree', 'Build coverage contract fixtures',
  'Accept complete application coverage', 'Reject a missing branch', 'Verify rejection is enforced',
  'Accept complete multi-artifact application coverage', 'Reject an uncovered multi-artifact component', 'Verify multi-artifact rejection is enforced'];

// The fixture configuration with this repository's verification contract (the repository's own needs its frozen engine
// identity), and the receipt decision the gate makes itself (`attested`), as the assessment supplies it.
const policy = attested => createPolicy({...require('../test/fixtures/config.json'), verification: config.verification}, {attested});
async function technical(decide, {covered = 'success', selfTest = 'success'} = {}) {
  const failed = selfTest !== 'success';
  const steps = [...config.verification.steps.map(name => ({name, conclusion: covered})), ...SELF_TESTS.map(name => ({name, conclusion: selfTest}))];
  const job = {name: 'verify', conclusion: failed ? 'failure' : 'success', run_attempt: 1, steps,
    html_url: 'https://github.com/gaulatti/clouseau/actions/runs/22/job/23'};
  const decisions = [];
  const github = {
    paginate: async (method, args) => (await method(args)).data,
    rest: {actions: {
      listWorkflowRuns: async () => ({data: {workflow_runs: [{id: 22, run_attempt: 1, head_sha: HEAD, head_branch: 'ci/split', head_repository: {id: 42},
        pull_requests: [{number: 8}], event: 'pull_request', status: 'completed', conclusion: failed ? 'failure' : 'success'}]}}),
      listJobsForWorkflowRun: async () => ({data: [job]}),
    }},
  };
  const result = await policy(async () => {decisions.push('attested'); return decide;}).technicalRun(github, repo, pr, {wait: async () => {}});
  return {...result, decisions};
}

test('the configuration requires exactly the four receipt-covered steps of verify', () => {
  assert.deepEqual(config.verification, {job: 'verify', steps: ['Enforce 100% line and branch coverage', 'Test approval policy',
    'Test distributable action without Git metadata', 'Test workflow security']});
});

test('no receipt: every step ran, and the gate passes without consulting a receipt', async () => {
  const passed = await technical(false);
  assert.equal(passed.failure, undefined); assert.equal(passed.pending, undefined);
  assert.deepEqual(passed.decisions, []);
});

test('a valid attesting receipt: the four covered steps skipped, the self-tests ran, and the gate accepts it', async () => {
  for (const decide of [true, {attests: true}]) {
    const attested = await technical(decide, {covered: 'skipped'});
    assert.equal(attested.failure, undefined); assert.equal(attested.pending, undefined);
    assert.deepEqual(attested.decisions, ['attested']);
  }
});

test('the four skipped without a valid attesting receipt: the gate fails and names the first skipped step', async () => {
  for (const decide of [false, null, {attests: false, rejected: 'expired', detail: {expires_at: '2026-11-12T00:00:00.000Z'}}]) {
    const refused = await technical(decide, {covered: 'skipped'});
    assert.match(refused.failure, /^Required verification step "Enforce 100% line and branch coverage" concluded skipped/, JSON.stringify(decide));
  }
});

test('a failed self-test fails the gate whatever a receipt says, though no configuration lists it', async () => {
  const failed = await technical(true, {covered: 'skipped', selfTest: 'failure'});
  assert.match(failed.failure, /^PR verification concluded failure: job "verify" step "Check review-semantics declarations against the verified tree"/);
  assert.deepEqual(failed.decisions, [], 'a failed run is decided before any receipt');
});
