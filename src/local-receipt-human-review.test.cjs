'use strict';
// Receipt signing and verification under the protected local_review.human_review setting. Kept apart from local-receipt.test.cjs so a change here does not resend that file as review evidence.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('../test/local-review-fixture.cjs');
const {issueReceipt, verifyReceipt, validateTrust, reviewDecision, marker, loadReceipt, verifySources,
  screenReceipt, screenSources, attestable} = require('./local-receipt.cjs');
const {ChunkedRecordError} = require('./chunked-record.cjs');
const {digest} = require('./acceptance.cjs');
const {hostedFiles} = require('../test/hosted-files.cjs');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A review whose recalculated decision is `decision`, by violating one gate of the given kind in the examiner's report.
const withDecision = (record, gateName) => {
  const changed = structuredClone(record);
  const gate = changed.result.reviews[0].report.gates.find(item => gateName === 'integrity' ? item.name === 'test_integrity' : item.name !== 'test_integrity');
  gate.state = 'violated';
  for (const decision of ['repair_required', 'blocked_integrity', 'review_incomplete']) {
    changed.result.decision = decision;
    try {reviewDecision(changed); return changed;} catch { /* try the next decision */ }
  }
  throw new Error('no consistent decision');
};

test('human_review "signed": a review that requires a human is signed only with the opt-in, and is never acceptable as a pass', async () => {
  const f = await fixture();
  assert.doesNotThrow(() => validateTrust({...f.trust, human_review: 'signed'}));
  for (const value of ['on', '', true, null]) assert.throws(() => validateTrust({...f.trust, human_review: value}), /human_review must be "signed"/);
  const findings = withDecision(f.record, 'other');
  assert.equal(findings.result.decision, 'repair_required');
  const integrity = withDecision(f.record, 'integrity');
  assert.equal(integrity.result.decision, 'blocked_integrity');
  // Without the opt-in nothing but a pass is signed; with it, findings are, an integrity violation never is.
  assert.throws(() => issueReceipt({...f.issue, record: findings}), /only a passing review can be signed/);
  assert.throws(() => issueReceipt({...f.issue, record: integrity, humanReview: true}), /only a passing review can be signed/);
  const incomplete = structuredClone(f.record); incomplete.result.decision = 'review_incomplete';
  assert.throws(() => issueReceipt({...f.issue, record: incomplete, humanReview: true}), /calculated|only a passing/);
  const signed = issueReceipt({...f.issue, record: findings, humanReview: true});
  // Every verifier that did not ask for it refuses the signed non-pass exactly as it refuses any failing review.
  assert.throws(() => verifyReceipt(signed, f.expected), error => error.reason === 'not_passing');
  assert.throws(() => verifyReceipt(signed, {...f.expected, humanReview: 'yes'}), error => error.reason === 'not_passing');
  assert.throws(() => verifyReceipt(signed, {...f.expected, reviewerSha: '0'.repeat(40), humanReview: false}), error => error.reason === 'not_passing' || error.reason === 'engine');
  // Only the caller that asked for it receives it, marked as requiring a human; a pass never carries that mark.
  const held = verifyReceipt(signed, {...f.expected, humanReview: true});
  assert.equal(held.decision, 'repair_required'); assert.equal(held.human_review, true);
  const pass = verifyReceipt(issueReceipt(f.issue), {...f.expected, humanReview: true});
  assert.equal(pass.decision, 'auto_approve'); assert.equal(Object.hasOwn(pass, 'human_review'), false);
  // screenReceipt, which receiptAttests and the refresh standing use, refuses it unless asked.
  const fresh = issueReceipt({...f.issue, record: findings, humanReview: true, now: Date.now()});
  const ref = 'c'.repeat(40);
  const repo = {owner: f.expected.repository.split('/')[0], repo: f.expected.repository.split('/')[1]};
  const github = {rest: {repos: {getContent: async () => ({data: {encoding: 'base64', size: 10, content: Buffer.from(JSON.stringify(fresh)).toString('base64')}})}}};
  const pr = {body: `<!-- clouseau-local-review:v1 ${ref} -->`, user: {login: f.expected.author}, head: {sha: f.expected.headSha}, base: {sha: f.expected.baseSha}};
  const screen = extra => screenReceipt({github, repo, pr, engine: null, trust: f.expected.trust, configDigest: f.expected.configDigest, policyDigest: f.expected.policyDigest, ...extra});
  assert.deepEqual(await screen({}), {ref: null, rejected: 'not_passing', detail: {}});
  assert.equal((await screen({humanReview: true})).verified.human_review, true);
});
