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

// One HTTP 5xx used to end a step: the actions/github-script client defaults to `retries: 0`. Every github-script step either
// installs the engine's read retry as its first statement (packaged steps: writes keep their own landed-check handling) or,
// inline in a workflow where it only reads, sets `retries`.
const INSTALL = "require(require('node:path').join(process.env.CLOUSEAU_ROOT, 'src/github-retry.cjs')).install(github, {report: core.info});";
test('no github-script step can die on one transient GitHub failure', () => {
  const steps = [];
  const action = read('action.yml');
  for (const step of action.runs.steps) steps.push(['action.yml', step]);
  for (const path of ['examples/consumer-ci.yml', '.github/workflows/ci.yml']) {
    for (const job of Object.values(read(path).jobs)) for (const step of job.steps ?? []) steps.push([path, step]);
  }
  const scripts = steps.filter(([, step]) => String(step.uses ?? '').startsWith('actions/github-script@'));
  assert.deepEqual(Object.fromEntries(['action.yml', 'examples/consumer-ci.yml', '.github/workflows/ci.yml'].map(path =>
    [path, scripts.filter(([where]) => where === path).length])), {'action.yml': 13, 'examples/consumer-ci.yml': 5, '.github/workflows/ci.yml': 3});
  for (const [path, step] of scripts) {
    const label = `${path}: ${step.name ?? step.id}`;
    if (path === 'action.yml') {
      assert.equal(step.with.script.split('\n')[0], INSTALL, label);
      assert.equal(step.env?.CLOUSEAU_ROOT, '${{ github.action_path }}', label);
      assert.equal(step.with.retries, undefined, `${label}: the plugin would also repeat writes`);
    } else {
      assert.equal(step.with.retries, 3, label);
      assert.ok(!/\bgithub\.(rest\.\w+\.(create|update|delete|merge|enable|disable|add|remove|set)\w*|request\(\s*'(POST|PUT|PATCH|DELETE)|graphql\()/.test(step.with.script),
        `${label} only reads`);
    }
  }
});
