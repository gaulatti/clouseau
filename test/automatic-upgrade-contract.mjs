import assert from 'node:assert/strict';

// Consumers pass their parsed real workflow and GitHub's expression evaluator.
export function assertFrozenWorkflow(workflow, evaluate) {
  const resolver = workflow.jobs['resolve-clouseau'];
  assert.ok(resolver, 'one isolated resolver job is required');
  assert.deepEqual(resolver.permissions, {contents: 'read'});
  assert.equal(resolver.steps.length, 1);
  assert.match(resolver.steps[0].uses, /^gaulatti\/clouseau\/scripts\/resolve@[a-f0-9]{40}$/);
  assert.equal(resolver.steps[0].with, undefined, 'contributors cannot configure a source');
  assert.equal(resolver.outputs.sha, '${{ steps.engine.outputs.sha }}');
  assert.equal(resolver.outputs.digest, '${{ steps.engine.outputs.digest }}');
  const original = {sha: 'a'.repeat(40), digest: 'c'.repeat(64)};
  const next = {sha: 'b'.repeat(40), digest: 'd'.repeat(64)};
  let count = 0;
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const checkouts = job.steps?.filter(step => step.with?.repository === 'gaulatti/clouseau' || step.with?.path === '.clouseau-ci') || [];
    const checkout = checkouts[0];
    const actions = job.steps?.filter(step => step.uses === './.clouseau-ci') || [];
    if (!checkout && !actions.length) continue;
    count++;
    assert.ok(checkout, name);
    assert.equal(checkouts.length, 1, `${name} cannot overwrite the frozen engine`);
    assert.equal(checkout.with.repository, 'gaulatti/clouseau', `${name} uses the authorized repository`);
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    assert.ok(needs.includes('resolve-clouseau'), `${name} directly consumes the one selection`);
    assert.equal(checkout.with.ref, "${{ needs.resolve-clouseau.outputs.sha || '0000000000000000000000000000000000000000' }}");
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(checkout.with.path, '.clouseau-ci');
    assert.ok(!JSON.stringify(job).includes('gaulatti/clouseau@'), `${name} cannot mix pinned engines`);
    for (const [selected, currentMain] of [[original, next], [next, next]]) {
      const context = {needs: {'resolve-clouseau': {result: 'success', outputs: selected}},
        github: {event_name: 'pull_request_target', event: {pull_request: {body: currentMain.sha, head: {sha: currentMain.sha}}}}};
      assert.equal(evaluate(checkout.with.ref, context).coerceString(), selected.sha, name);
      assert.equal(evaluate(job.env.CLOUSEAU_ENGINE_SHA, context).coerceString(), selected.sha, name);
      assert.equal(evaluate(job.env.CLOUSEAU_ENGINE_DIGEST, context).coerceString(), selected.digest, name);
    }
    const failure = {needs: {'resolve-clouseau': {result: 'failure', outputs: {}}}, github: {event_name: 'pull_request_target'}};
    assert.equal(evaluate(checkout.with.ref, failure).coerceString(), '0'.repeat(40), `${name} has no stale fallback`);
    for (const action of actions) assert.ok(job.steps.indexOf(checkout) < job.steps.indexOf(action), name);
  }
  assert.ok(count >= 2, 'multiple engine stages must be checked');
}

// A consumer's review job must not poll for verification inline: the loop holds
// a runner while the verification job it waits on can be queued behind it. The
// engine's await-verification operation applies the shared progress bound, and
// every later engine step in that job must run only after it reports success.
export function assertBoundedVerificationWait(workflow) {
  let waits = 0;
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const steps = job.steps || [];
    for (const step of steps) {
      assert.ok(!/technicalRun\s*\(/.test(step.with?.script || ''), `${name} polls for verification inline; use operation: await-verification`);
    }
    const index = steps.findIndex(step => step.uses === './.clouseau-ci' && step.with?.operation === 'await-verification');
    if (index < 0) continue;
    waits++;
    const wait = steps[index];
    assert.ok(wait.id, `${name} must identify its await-verification step`);
    // A finally failed verification is published by the wait step as an incomplete assessment; the job must
    // expose it, or the write-capable job has nothing to post the visible notice from.
    assert.ok(String(job.outputs?.assessment ?? '').includes(`steps.${wait.id}.outputs.assessment`),
      `${name} must expose steps.${wait.id}.outputs.assessment in its assessment output so a failed verification gets a visible notice`);
    for (const later of steps.slice(index + 1).filter(step => step.uses === './.clouseau-ci' && ['assess', 'verify-local'].includes(step.with?.operation))) {
      assert.match(String(later.if), new RegExp(`steps\\.${wait.id}\\.outputs\\.verified == 'true'`), `${name} must skip assessment until verification succeeded`);
    }
  }
  return waits;
}

// A review that ended pending (verification not started within the queue grace)
// holds no runner, so completion of the PR verification run must reassess it.
export function assertReassessmentOnVerification(workflow, ownName = workflow.name) {
  const trigger = workflow.on?.workflow_run;
  assert.ok(trigger, 'the workflow must trigger on completed PR verification runs');
  assert.ok(trigger.workflows?.length > 0 && trigger.types?.includes('completed'), 'workflow_run must name the verification workflow and the completed type');
  // GitHub never starts a workflow from its own completion: the watched workflow must be a different file.
  assert.ok(!trigger.workflows.includes(ownName), 'workflow_run must watch a different workflow than the one containing it');
  const jobs = Object.entries(workflow.jobs).filter(([, job]) => job.steps?.some(step =>
    step.uses === './.clouseau-ci' && step.with?.operation === 'request-reassessment'));
  assert.ok(jobs.some(([, job]) => String(job.if).includes("github.event_name == 'workflow_run'") &&
    String(job.if).includes("github.event.workflow_run.event == 'pull_request'") && job.permissions?.actions === 'write'),
  'a request-reassessment job must run for workflow_run events with actions write');
  return jobs.length;
}

// A sibling merge moves the base under every approved PR and nothing else re-runs their gates, so the
// base move must reconcile them. A merge made by the bot with GITHUB_TOKEN raises no push event (GitHub
// starts no workflow from events caused by GITHUB_TOKEN), so the unattended path needs a trigger that does
// fire: a workflow_run of the review workflow, in a SEPARATE workflow file (a workflow never starts from
// its own completion). A push trigger remains for human merges. At least one of the two must be present.
export function assertBaseReconciliation(workflow, base = 'main', ownName = workflow.name) {
  const push = workflow.on?.push && [workflow.on.push.branches].flat().includes(base);
  const run = workflow.on?.workflow_run;
  assert.ok(workflow.on?.push || run, 'the workflow must trigger on pushes to the base branch or on completed review runs');
  if (workflow.on?.push) assert.ok(push, `push must include the ${base} branch`);
  if (run) {
    assert.ok(run.workflows?.length > 0 && run.types?.includes('completed'), 'workflow_run must name the review workflow and the completed type');
    assert.ok(!run.workflows.includes(ownName), 'workflow_run must watch a different workflow than the one containing it');
  }
  const jobs = Object.entries(workflow.jobs).filter(([, job]) => job.steps?.some(step =>
    step.uses === './.clouseau-ci' && step.with?.operation === 'reconcile-base'));
  assert.ok(jobs.length > 0, 'a reconcile-base job must exist');
  for (const [, job] of jobs) {
    const condition = String(job.if);
    const pushOnly = push && condition.includes("github.event_name == 'push'") && condition.includes(`refs/heads/${base}`);
    const afterReview = run && condition.includes("github.event_name == 'workflow_run'") && condition.includes("github.event.workflow_run.event == 'pull_request_target'");
    assert.ok(pushOnly || afterReview, 'reconcile-base must run only for pushes to the base branch or completed pull_request_target review runs');
    assert.equal(job.permissions?.issues, 'write', 'reconcile-base posts the notice, so it needs issues write');
    assert.ok(!['write'].includes(job.permissions?.contents) && !['write'].includes(job.permissions?.actions),
      'reconcile-base needs no contents or actions write: a GITHUB_TOKEN push cannot start verification');
    assert.ok(job.concurrency && job.concurrency['cancel-in-progress'] === false, 'reconcile-base runs must queue, not cancel');
  }
  return jobs.length;
}
