import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parse} from 'yaml';

const read = path => parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));

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
