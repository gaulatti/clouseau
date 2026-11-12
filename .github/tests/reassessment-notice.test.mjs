import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parse} from 'yaml';

// A reassessment that cannot be requested must be able to say so on the pull request, and the gate must be able to tell
// an assessment made before an owner confirmation (src/stale-assessment.cjs).
const read = path => parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));

test('request-reassessment may comment on the pull request, and nothing more than that is added', () => {
  for (const path of ['examples/consumer-ci.yml', '.github/workflows/ci.yml']) {
    const job = read(path).jobs['request-reassessment'];
    assert.deepEqual(job.permissions, {contents: 'read', 'pull-requests': 'write', issues: 'write', actions: 'write'}, path);
    // It still runs only trusted main and the frozen engine, never pull request code.
    const checkouts = job.steps.filter(step => String(step.uses).startsWith('actions/checkout@'));
    assert.equal(checkouts[0].with.ref, 'main', path);
    assert.equal(checkouts[1].with.repository, 'gaulatti/clouseau', path);
    assert.ok(checkouts.every(step => step.with['persist-credentials'] === false), path);
  }
});

test('the packaged assess step stamps assessed_at before the assessment reads anything, and emits it', () => {
  const step = read('action.yml').runs.steps.find(item => item.id === 'assess');
  const script = step.with.script;
  const stamp = script.indexOf('const assessedAt = new Date().toISOString();');
  assert.ok(stamp > 0 && stamp < script.indexOf('await assess('), 'stamped before the assessment runs');
  assert.ok(script.indexOf('assessment = {...assessment, assessed_at: assessedAt};') < script.indexOf("core.setOutput('assessment'"));
});
