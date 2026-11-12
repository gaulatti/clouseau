'use strict';
// The gate's technical check covers the whole verification run, not only `verification.job`: a job the configuration does not
// name (this repository's `self-tests`) still blocks approval when it fails. Kept apart from policy.test.cjs so a change here
// does not resend that file as review evidence.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createPolicy} = require('./policy.cjs');

const repo = {owner: 'gaulatti', repo: 'clouseau'};
const HEAD = 'a'.repeat(40);
const pr = {number: 8, head: {sha: HEAD, ref: 'ci/split', repo: {id: 42}}};
const config = require('../.github/clouseau.json');
// The fixture configuration with this repository's verification contract (the repository's own needs its frozen engine identity).
const policy = createPolicy({...require('../test/fixtures/config.json'), verification: config.verification});

function run(conclusion, jobs) {
  const github = {
    paginate: async (method, args) => (await method(args)).data,
    rest: {actions: {
      listWorkflowRuns: async () => ({data: {workflow_runs: [{id: 22, run_attempt: 1, head_sha: HEAD, head_branch: 'ci/split', head_repository: {id: 42},
        pull_requests: [{number: 8}], event: 'pull_request', status: 'completed', conclusion}]}}),
      listJobsForWorkflowRun: async () => ({data: jobs}),
    }},
  };
  return policy.technicalRun(github, repo, pr, {wait: async () => {}});
}
const passed = steps => ({name: 'verify', conclusion: 'success', run_attempt: 1, steps: steps.map(name => ({name, conclusion: 'success'}))});

test('this repository requires only the receipt-covered steps of verify; a failed self-tests job still fails the technical check', async () => {
  assert.deepEqual(config.verification, {job: 'verify', steps: ['Enforce 100% line and branch coverage', 'Test approval policy',
    'Test distributable action without Git metadata', 'Test workflow security']});
  const verify = passed(config.verification.steps);
  const selfTests = {name: 'self-tests', conclusion: 'failure', html_url: 'https://github.com/gaulatti/clouseau/actions/runs/22/job/23',
    steps: [{name: 'Verify rejection is enforced', conclusion: 'failure'}]};
  const failed = await run('failure', [verify, selfTests]);
  assert.match(failed.failure, /^PR verification concluded failure: job "self-tests" step "Verify rejection is enforced"/);
  // A failed declaration check is the same failure.
  const stale = await run('failure', [verify, {...selfTests, steps: [{name: 'Check review-semantics declarations against the verified tree', conclusion: 'failure'}]}]);
  assert.match(stale.failure, /job "self-tests" step "Check review-semantics declarations against the verified tree"/);
  // Both jobs passing is a pass.
  const ok = await run('success', [verify, {name: 'self-tests', conclusion: 'success', steps: []}]);
  assert.equal(ok.failure, undefined); assert.equal(ok.pending, undefined);
});
