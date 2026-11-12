'use strict';
// The optional signed review reuse claim (local-receipt.cjs): present only when a review ran under outcome keying.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {fixture} = require('../test/local-review-fixture.cjs');
const {issueReceipt, verifyReceipt} = require('./local-receipt.cjs');
const {digest} = require('./acceptance.cjs');

test('a receipt carries the reuse claim only when given, verifies with it, and has today\'s fields without it', async () => {
  const f = await fixture();
  const plain = issueReceipt(f.issue);
  assert.equal(Object.hasOwn(plain.payload, 'review_reuse'), false);
  const claimed = issueReceipt({...f.issue, reviewReuse: {mode: 'outcome', reused: 5, fresh: 0}});
  assert.deepEqual(claimed.payload.review_reuse, {mode: 'outcome', reused: 5, fresh: 0});
  assert.equal(verifyReceipt(claimed, f.expected).decision, 'auto_approve');
  assert.equal(verifyReceipt(plain, f.expected).decision, 'auto_approve');
});

test('only the documented shape of the claim is issued or accepted', async () => {
  const f = await fixture();
  for (const bad of [null, {}, {mode: 'exact', reused: 1, fresh: 1}, {mode: 'outcome', reused: -1, fresh: 0}, {mode: 'outcome', reused: 1.5, fresh: 0},
    {mode: 'outcome', reused: 1}, {mode: 'outcome', reused: 1, fresh: 0, extra: 1}]) {
    assert.throws(() => issueReceipt({...f.issue, reviewReuse: bad}), /invalid review reuse claim/, JSON.stringify(bad));
  }
  // A claim edited after signing, or a malformed one signed by a valid key, is refused before anything else is read.
  const signed = issueReceipt({...f.issue, reviewReuse: {mode: 'outcome', reused: 5, fresh: 0}});
  const edited = {...signed, payload: {...signed.payload, review_reuse: {mode: 'outcome', reused: 0, fresh: 5}}};
  assert.throws(() => verifyReceipt(edited, f.expected), /signature/);
  const malformed = {...signed.payload, review_reuse: {mode: 'outcome', reused: 'all', fresh: 0}};
  const resigned = {payload: malformed, signature: crypto.sign(null, Buffer.from(`${malformed.type}\0${digest(malformed)}`), crypto.createPrivateKey(f.issue.privateKey)).toString('base64url')};
  assert.throws(() => verifyReceipt(resigned, f.expected), /unknown receipt type or fields/);
});
