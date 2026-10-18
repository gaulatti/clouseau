'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {clean, score, priorState, reconcile, render, MARKER} = require('./acceptance-ledger.cjs');
const {validateReport} = require('./acceptance.cjs');
const {fixture, finding, factor} = require('../test/fixtures/acceptance.cjs');

function setup(includeFinding = true) {
  const {report, snapshot} = fixture();
  if (includeFinding) report.findings.push(finding());
  const reviews = ['examiner', 'challenger'].map(role => ({role, report: structuredClone(report), scores: validateReport(report, snapshot)}));
  return {snapshot, result: {decision: reviews[0].scores.decision, reviews}};
}

test('rendered acceptance records expose every factor and preserve exact decision values separately from display rounding', () => {
  const {result, snapshot} = setup();
  const state = reconcile(result, snapshot);
  const body = render(result, snapshot, state);
  assert.ok(body.includes('Fit | Need | Proportionality'));
  for (const name of ['confidence', 'recurrence', 'generalization', 'binding', 'operating_model']) assert.ok(body.includes(name));
  assert.match(body, /missing-rejection|Invalid input reaches durable acceptance/);
  assert.equal(clean('<script>@name|`\nline'), '&lt;script&gt;name&#124;&#96; line');
  assert.equal(score(12.345, 12.345), '12.35'); assert.equal(score(12, 13), '12.00–13.00');
  assert.equal(state.findings.length, 1, 'identical causal roots from independent roles share one history identity');
  assert.equal(state.findings[0].state, 'confirmed');
  const parsed = priorState([{id: 4, user: {login: 'github-actions[bot]'}, body}], snapshot.repository, snapshot.number);
  assert.equal(parsed.comment, 4); assert.equal(parsed.findings[0].id, state.findings[0].id);
  const safe = setup(false);
  assert.ok(render(safe.result, safe.snapshot, reconcile(safe.result, safe.snapshot)).includes('No admitted technical findings'));
});

test('a disappeared or merely downgraded prior blocker remains outstanding without explicit independent source dispositions', () => {
  const {result, snapshot} = setup();
  const previous = reconcile(result, snapshot).findings;
  const empty = setup(false).result;
  const missing = reconcile(empty, snapshot, previous);
  assert.equal(missing.findings[0].state, 'outstanding'); assert.deepEqual(missing.unresolved, [previous[0].id]);
  assert.match(render(empty, snapshot, missing), /Outstanding prior blockers/);
  for (const review of result.reviews) {
    review.report.findings[0].id = previous[0].id;
    review.report.findings[0].factors.necessity = factor(0.25);
    review.report.findings[0].factors.activation = factor(0);
    review.scores = validateReport(review.report, snapshot);
  }
  assert.equal(reconcile(result, snapshot, previous).findings[0].state, 'outstanding');
  for (const review of empty.reviews) review.report.resolutions = [{id: previous[0].id, state: 'corrected', reason: 'The current source restores rejection.', evidence: ['source']}];
  let state = reconcile(empty, snapshot, previous);
  assert.equal(state.findings[0].state, 'corrected'); assert.equal(state.findings[0].blocking, false);
  empty.reviews[1].report.resolutions[0].state = 'dismissed';
  assert.equal(reconcile(empty, snapshot, previous).findings[0].state, 'dismissed');
});

test('one independent blocker survives and an optional declined observation creates no follow-up obligation', () => {
  const {result, snapshot} = setup();
  const old = reconcile(result, snapshot).findings;
  for (const review of result.reviews) review.report.findings[0].id = old[0].id;
  assert.equal(reconcile(result, snapshot, old).unresolved.length, 0);
  assert.equal(reconcile(result, snapshot, old).findings[0].blocking, true);
  result.reviews[0].scores.findings[0].disposition = 'nonblocking';
  assert.equal(reconcile(result, snapshot).findings[0].blocking, true);
  result.reviews[1].scores.findings[0].disposition = 'investigate';
  assert.equal(reconcile(result, snapshot).findings[0].state, 'investigating');
  const advisory = {...old[0], blocking: false, state: 'advisory_closed'};
  const empty = setup(false).result;
  assert.equal(reconcile(empty, snapshot, [advisory]).unresolved.length, 0);
  assert.equal(reconcile(empty, snapshot, [advisory]).findings[0].state, 'advisory_closed');
});

test('only the review bot ledger with matching repository and PR identity is accepted', () => {
  const {result, snapshot} = setup();
  assert.deepEqual(priorState([], snapshot.repository, snapshot.number), {comment: null, findings: []});
  assert.deepEqual(priorState([{user: {login: 'contributor'}, body: MARKER}], snapshot.repository, snapshot.number), {comment: null, findings: []});
  const state = reconcile(result, snapshot);
  const value = {version: 2, repository: snapshot.repository, number: snapshot.number, head_sha: snapshot.head_sha, findings: state.findings};
  const comment = body => [{id: 1, user: {login: 'github-actions[bot]'}, body}];
  assert.throws(() => priorState(comment(MARKER), snapshot.repository, snapshot.number), /incomplete/);
  assert.throws(() => priorState(comment(`${MARKER}\n<!-- clouseau-state:${'A'.repeat(60004)} -->`), snapshot.repository, snapshot.number), /incomplete/);
  for (const mutate of [
    v => {v.version = 1;}, v => {v.repository = 'other/repo';}, v => {v.number = 9;}, v => {v.head_sha = 'stale';}, v => {v.findings = {};},
    v => {v.findings[0].id = 'invented';}, v => {v.findings[0].blocking = 'yes';}, v => {v.findings[0].state = 'unknown';},
    v => {v.findings[0].title = '';}, v => {v.findings[0].path = '';}, v => {v.findings[0].cause = '';}, v => {v.findings[0].obligation = '';},
  ]) {
    const changed = structuredClone(value); mutate(changed);
    const body = `${MARKER}\n<!-- clouseau-state:${Buffer.from(JSON.stringify(changed)).toString('base64')} -->`;
    assert.throws(() => priorState(comment(body), snapshot.repository, snapshot.number), /identity validation/);
  }
});

test('oversized ledgers fail visibly rather than truncating findings or evidence', () => {
  const {result, snapshot} = setup();
  result.reviews[0].report.summary = 'Complete evidence '.repeat(4000);
  assert.throws(() => render(result, snapshot, reconcile(result, snapshot)), /comment budget/);
});
