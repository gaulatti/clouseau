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
    const checkout = job.steps?.find(step => step.with?.repository === 'gaulatti/clouseau');
    const actions = job.steps?.filter(step => step.uses === './.clouseau-ci') || [];
    if (!checkout && !actions.length) continue;
    count++;
    assert.ok(checkout, name);
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    assert.ok(needs.includes('resolve-clouseau'), `${name} directly consumes the one selection`);
    assert.equal(checkout.with.ref, '${{ needs.resolve-clouseau.outputs.sha }}');
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
    assert.equal(evaluate(checkout.with.ref, failure).coerceString(), '', `${name} has no stale fallback`);
    for (const action of actions) assert.ok(job.steps.indexOf(checkout) < job.steps.indexOf(action), name);
  }
  assert.ok(count >= 2, 'multiple engine stages must be checked');
}
