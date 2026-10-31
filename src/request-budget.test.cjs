'use strict';

// Issue 132 residual: with 40+ open PRs the shared installation budget (1000-5000 requests an hour) ran out.
// These bounds keep one PR's lifecycle cheap. Measured before this change (same scenarios, previous engine):
// wait 12, importer scan 206, reassessment 9. (The reconcile scenario, 162 before, is bounded with its own change.)

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {measure} = require('../test/measure-requests.cjs');

test('one PR lifecycle stays inside a bounded request budget', async () => {
  const counts = await measure(require('node:path').join(__dirname, '..'));
  const byName = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key.split(' ')[0], value]));
  assert.ok(!Object.keys(counts).some(key => key.endsWith('ERROR')), JSON.stringify(counts));
  assert.ok(byName.wait <= 3, `the wait polls are conditional: ${byName.wait} requests`);
  assert.ok(byName.importer <= 60, `the importer scan is lazy and bounded: ${byName.importer} requests`);
  assert.ok(byName.reassessment <= 4, `the reassessment waits with growing gaps: ${byName.reassessment} requests`);
});
