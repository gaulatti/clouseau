'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pageSchema, inspectPaged} = require('./paged-review.cjs');
const {pageFunctions} = require('./paged-provider.cjs');
const {compactSchema} = require('./review-schema.cjs');
const {pagedFixture, responder} = require('../test/paged-review-fixture.cjs');

test('patch entry numbers cannot masquerade as provisional source proofs in the actual bounded response schema', async () => {
  const f = await pagedFixture();
  const initial = pageSchema(f.snapshot, null, []);
  assert.deepEqual(initial.properties.concerns.enum, [[]]);
  const allowed = ['proof-3-1', 'proof-4-41'];
  const restricted = pageSchema(f.snapshot, null, allowed);
  const evidence = restricted.properties.concerns.items.properties.evidence.items;
  assert.deepEqual(evidence.enum, allowed);
  // Captured public CI failure: patch entry147 was converted to proof-147-1.
  assert.equal(evidence.enum.includes('proof-147-1'), false);
  const compact = compactSchema(restricted);
  assert.ok(JSON.stringify(compact).includes('proof-4-41'));
  for (const tool of Object.values(pageFunctions(initial))) {
    assert.equal(Object.hasOwn(tool.properties, 'concerns'), false);
    assert.equal(/"(?:maxItems|minItems|maxLength|minLength)"/.test(JSON.stringify(tool)), false);
  }
  assert.equal(Object.hasOwn(pageFunctions(initial), 'page_request_with_concerns'), false);
});

test('real driver frames allow concerns only from supplied source proof IDs while preserving earlier concerns as raw history', async () => {
  const f = await pagedFixture(); let sourceFrame = false, nonSourceFrame = false;
  const model = responder(f, (value, {task, packet}) => {
    assert.match(task.prompt, /inventory entry number is a page selector/);
    const concerns = task.schema.properties.concerns;
    if (packet.proofs.length) {
      sourceFrame = true;
      assert.deepEqual(concerns.items.properties.evidence.items.enum, packet.proofs.map(proof => proof.id));
    } else {
      nonSourceFrame = true; assert.deepEqual(concerns.enum, [[]]);
    }
    return value;
  });
  const result = await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask});
  assert.equal(sourceFrame, true); assert.equal(nonSourceFrame, true);
  assert.equal(result.page_progress.length, model.packets.length);
});
