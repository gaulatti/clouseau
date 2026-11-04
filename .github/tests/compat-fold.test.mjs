import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parse} from 'yaml';

// The compatibility fold is the only workflow that pushes to main. These assertions pin the properties that keep it
// safe: it never sees pull request code or a secret, it can only write contents, it refuses every ref but protected
// main, and the fold itself runs without the token. See docs/receipt-compatibility.md.
const text = readFileSync(new URL('../workflows/compat-fold.yml', import.meta.url), 'utf8');
const workflow = parse(text);
const job = workflow.jobs.fold;
const script = job.steps.find(step => step.name === 'Fold, verify and push one commit').run;

test('the fold runs only for protected main of this repository, never for pull request events', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'schedule', 'workflow_dispatch', 'workflow_run']);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.deepEqual(workflow.on.push.paths, ['compat/declarations/**']);
  assert.deepEqual(workflow.on.workflow_run.workflows, ['Clouseau CI']);
  assert.match(job.if, /github\.repository == 'gaulatti\/clouseau'/);
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(job.if, /github\.event\.workflow_run\.event == 'pull_request_target'/);
  assert.deepEqual(Object.keys(workflow.jobs), ['fold']);
});

test('the only permission is contents: write on the one job, and no secret other than the job token is referenced', () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(job.permissions, {contents: 'write'});
  assert.ok(!/secrets\./.test(text));
  assert.equal(job.steps.length, 2);
  assert.match(job.steps[0].uses, /^actions\/checkout@[a-f0-9]{40}$/);
  assert.deepEqual(job.steps[0].with, {ref: 'main', 'persist-credentials': false});
  assert.deepEqual(job.steps[1].env, {GH_TOKEN: '${{ github.token }}'});
  assert.equal(job.concurrency['cancel-in-progress'], false);
});

test('the fold and its checks run without the token, and the push is a plain push to main', () => {
  for (const command of ['scripts/review-compatibility fold', 'scripts/review-compatibility check', '--test src/review-semantics.test.cjs']) {
    assert.match(script, new RegExp(`env -u GH_TOKEN node [^\\n]*${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), command);
  }
  const pushes = script.match(/git [^\n]*\bpush\b[^\n]*/g);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /push --quiet origin HEAD:refs\/heads\/main/);
  assert.ok(!/--force|--force-with-lease|\+HEAD|--no-verify|reset --hard (?!origin\/main)/.test(script));
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /::error::The fold changed files outside/);
});
