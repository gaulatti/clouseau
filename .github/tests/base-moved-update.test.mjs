import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parse} from 'yaml';

// The protected local_review.base_moved "update" needs the gate to receive the update-token, the same way reconcile-base does.
const read = file => parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
const template = read('examples/consumer-ci.yml');
const action = read('action.yml');
const step = (job, operation) => job.steps.find(item => item.with?.operation === operation);

test('the template passes the repair secret to the gate step of approve-and-merge as update-token', () => {
  const gate = step(template.jobs['approve-and-merge'], 'gate');
  const repair = step(template.jobs['apply-repair'], 'repair');
  assert.equal(gate.with['update-token'], '${{ secrets.CLOUSEAU_REPAIR_TOKEN }}');
  assert.equal(gate.with['update-token'], repair.with['repair-token'], 'one secret serves both inputs');
  // Only the gate step receives it: no other step of the template is handed the update credential.
  const holders = Object.values(template.jobs).flatMap(job => job.steps ?? []).filter(item => item.with && 'update-token' in item.with);
  assert.deepEqual(holders, [gate]);
});

test('the action hands update-token to the gate as an independent client, as reconcile-base does', () => {
  const gate = action.runs.steps.find(item => item.if === "inputs.operation == 'gate'");
  const reconcile = action.runs.steps.find(item => item.if === "inputs.operation == 'reconcile-base'");
  for (const item of [gate, reconcile]) {
    assert.equal(item.env.CLOUSEAU_UPDATE_TOKEN, '${{ inputs.update-token }}');
    assert.ok(item.with.script.includes("const updateGithub = process.env.CLOUSEAU_UPDATE_TOKEN ? new github.constructor({auth: process.env.CLOUSEAU_UPDATE_TOKEN}) : null;"));
  }
  assert.match(gate.with.script, /await policy\.gate\(\{github, context, core, nativeGate: process\.env\.CLOUSEAU_NATIVE_GATE === 'true', updateGithub\}\);/);
  assert.match(reconcile.with.script, /baseMoved: config\.local_review\?\.base_moved/);
  assert.equal(action.inputs['update-token'].default, '');
});
