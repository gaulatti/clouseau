'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {chunkedFixture, hooks, planOf, PARAMS} = require('../test/chunked-fixture.cjs');
const {fixture} = require('../test/local-review-fixture.cjs');
const {issueReceipt, verifyReceipt, reviewDecision} = require('./local-receipt.cjs');
const {ChunkedRecordError, RECORD_LIMIT, parseParams, snapshotDigest, assertRecordSize, elideQuotes, rehydrateQuotes, SCHEME} = require('./chunked-record.cjs');
const {classify, body, NEXT_STEPS} = require('./incomplete.cjs');
const {digest} = require('./acceptance.cjs');

const clone = value => structuredClone(value);
function rejects(record, chunked, pattern, cause = 'chunked_record_invalid') {
  assert.throws(() => reviewDecision(record, {chunked}), error => {
    assert.ok(error instanceof ChunkedRecordError, error.stack);
    assert.equal(error.code, 'CHUNKED_RECORD'); assert.equal(error.cause_code, cause);
    assert.match(error.message, pattern); return true;
  });
}
// Re-derive the pieces a forger would also have to keep consistent.
const reseal = record => {
  record.result.execution_digest = digest(record.result.usage);
  return record;
};

test('a chunked record is signed and verified through the one derivation, from thin unit reports', async () => {
  for (const finding of [false, true]) {
    const f = await chunkedFixture({finding});
    const stored = f.record.result.reviews[0].unit_reports[0].report;
    assert.ok(stored.evidence.every(entry => !Object.hasOwn(entry, 'quote')), 'stored reports carry no quotes');
    const bundle = issueReceipt(f.issue);
    const verified = verifyReceipt(bundle, f.expected);
    assert.equal(verified.decision, 'auto_approve');
    assert.deepEqual(verified.reviews.map(review => review.role), ['examiner', 'challenger']);
    assert.ok(verified.reviews[0].report.evidence.every(entry => typeof entry.quote === 'string' && entry.quote.length > 0));
    assert.equal(verified.reviews[0].report.findings.length, finding ? 1 : 0);
    assert.equal(bundle.payload.record_digest, digest(f.record));
  }
});

test('a record without a partition verifies exactly as before, with or without chunked options', async () => {
  const f = await fixture();
  const bundle = issueReceipt(f.issue);
  const plain = verifyReceipt(bundle, f.expected);
  const withOptions = verifyReceipt(bundle, {...f.expected, chunked: {params: PARAMS, hooks}});
  assert.deepEqual(withOptions, plain);
  assert.equal(plain.decision, 'auto_approve');
  assert.equal(bundle.payload.record_digest, digest(f.record));
  assert.deepEqual(reviewDecision(f.record), reviewDecision(f.record, {chunked: null}));
});

test('a partitioned record is refused when the verifier is not enabled for chunked records', async () => {
  const f = await chunkedFixture();
  for (const chunked of [null, {params: PARAMS}, {params: PARAMS, hooks: {...hooks, merge: undefined}}]) {
    rejects(f.record, chunked, /not enabled for chunked records/);
  }
  rejects(f.record, {hooks}, /protected chunk parameters/);
  assert.throws(() => issueReceipt({...f.issue, chunked: null}), /not enabled for chunked records/);
  assert.throws(() => verifyReceipt(issueReceipt(f.issue), {...f.expected, chunked: null}), /not enabled for chunked records/);
});

test('protected parameters are validated and are the only source of the partition parameters', async () => {
  assert.deepEqual(parseParams(PARAMS), PARAMS);
  for (const bad of [null, 'x', {}, {...PARAMS, extra: 1}, {...PARAMS, C: 0}, {...PARAMS, S: 1.5}, {...PARAMS, cap: 3000001}, {...PARAMS, max_units: -1}]) {
    assert.throws(() => parseParams(bad), /protected chunk parameters/);
  }
  const f = await chunkedFixture();
  rejects(f.record, {params: {...PARAMS, C: 1}, hooks}, /partition parameters differ from the protected configuration/);
  const forged = clone(f.record); forged.partition.params.C = 1;
  rejects(forged, f.chunked, /partition parameters differ from the protected configuration/);
  rejects(f.record, {params: {...PARAMS, max_units: 1}, hooks}, /more than the protected 1 units/);
  rejects(f.record, {params: {...PARAMS, cap: PARAMS.cap + 1}, hooks}, /partition parameters differ/);
});

test('combined evidence above the protected snapshot cap is refused', async () => {
  const f = await chunkedFixture();
  assert.throws(() => snapshotDigest(f.snapshot, 1000), error => error.cause_code === 'chunked_record_invalid' && /snapshot cap/.test(error.message));
  assert.equal(snapshotDigest(f.snapshot, 2400000), f.snapshot.digest);
  const tiny = {...PARAMS, cap: 500};
  const tinyPlan = planOf(f.snapshot, tiny, [['README.md'], ['src/upload.test.js']]);
  const sized = clone(f.record); sized.partition = tinyPlan;
  rejects(sized, {params: tiny, hooks: {...hooks, partition: () => tinyPlan}}, /exceeds the protected snapshot cap/);
});

test('an altered or non-partition-shaped plan is refused', async () => {
  const f = await chunkedFixture();
  for (const partition of [null, 'plan', {...f.plan, scheme: 'clouseau-partition/2'}, {...f.plan, extra: true}]) {
    const record = clone(f.record); record.partition = partition;
    rejects(record, f.chunked, /unknown or malformed partition scheme/);
  }
  assert.equal(f.plan.scheme, SCHEME);
  for (const units of [[], 'units']) {
    const record = clone(f.record); record.partition.units = units;
    rejects(record, f.chunked, /no units or more than/);
  }
  const forged = clone(f.record); forged.partition.plan_digest = 'f'.repeat(64);
  rejects(forged, f.chunked, /forged partition/);
  const merged = clone(f.record);
  merged.partition = planOf(f.snapshot, PARAMS, [['README.md', 'src/upload.test.js']]);
  merged.result.reviews.forEach(review => {review.unit_reports = review.unit_reports.slice(0, 1);});
  rejects(merged, f.chunked, /forged partition/);
  const seams = clone(f.record); seams.seams = [{kind: 'import', a: {path: 'README.md', unit: 'u0'}}];
  rejects(seams, f.chunked, /seams differ/);
  const absent = clone(f.record); delete absent.seams;
  rejects(absent, f.chunked, /seams differ/);
});

test('every changed path must be owned by exactly one unit with known context', async () => {
  const f = await chunkedFixture();
  const edit = change => {const record = clone(f.record); change(record.partition); return record;};
  rejects(edit(plan => {plan.units[1].owned.push('README.md');}), f.chunked, /duplicate ownership: "README.md" is owned by units u0 and u1/);
  rejects(edit(plan => {plan.units[1].owned = [];}), f.chunked, /has no owned paths/);
  rejects(edit(plan => {plan.units[1].owned = 'src/upload.test.js';}), f.chunked, /has no owned paths/);
  rejects(edit(plan => {delete plan.units[1].context_ids;}), f.chunked, /has no owned paths/);
  rejects(edit(plan => {plan.units[1].owned = ['src/other.js'];}), f.chunked, /owns "src\/other.js", which is not a changed path/);
  rejects(edit(plan => {plan.units.pop();}), f.chunked, /changed path "src\/upload.test.js" is owned by no unit/);
  rejects(edit(plan => {plan.units[1].id = 'u0';}), f.chunked, /unit id "u0" is missing or repeated/);
  rejects(edit(plan => {plan.units[1] = null;}), f.chunked, /unit id "undefined" is missing or repeated/);
  rejects(edit(plan => {plan.units[0].context_ids = ['no-such-source'];}), f.chunked, /unknown or repeated context sources/);
  const source = Object.keys(f.snapshot.sources)[0];
  rejects(edit(plan => {plan.units[0].context_ids = [source, source];}), f.chunked, /unknown or repeated context sources/);
});

test('an altered unit view digest is refused before anything is trusted', async () => {
  const f = await chunkedFixture();
  const record = clone(f.record); record.partition.units[1].view_digest = 'f'.repeat(64);
  rejects(record, f.chunked, /view digest of unit u1 differs from the recomputed unit view/);
});

test('unit reports must cover each unit once, be bound to their own view and validate against it', async () => {
  const f = await chunkedFixture();
  const edit = (change, index = 0) => {const record = clone(f.record); change(record.result.reviews[index]); return record;};
  rejects(edit(review => {review.unit_reports.pop();}), f.chunked, /examiner has no report for unit u1/);
  rejects(edit(review => {review.unit_reports.pop();}, 1), f.chunked, /challenger has no report for unit u1/);
  rejects(edit(review => {review.unit_reports.push(clone(review.unit_reports[0]));}), f.chunked, /more than one report for unit u0/);
  rejects(edit(review => {review.unit_reports.push({unit: 'u9', report: {}});}), f.chunked, /report for unknown unit "u9"/);
  rejects(edit(review => {review.unit_reports.push(null);}), f.chunked, /report for unknown unit "undefined"/);
  rejects(edit(review => {review.unit_reports = 'none';}), f.chunked, /examiner has no unit reports/);
  rejects(edit(review => {
    const [first, second] = review.unit_reports; [first.report, second.report] = [second.report, first.report];
  }), f.chunked, /report for unit u0 is not bound to that unit's view \(swapped or stale report\)/);
  rejects(edit(review => {delete review.unit_reports[0].report;}), f.chunked, /not bound to that unit's view/);
  rejects(edit(review => {review.unit_reports[0].report.summary = '';}), f.chunked, /report for unit u0 failed validation: Invalid acceptance evidence/);
  rejects(edit(review => {review.unit_reports[0].report.evidence[0].source = 'no-such-source';}), f.chunked, /evidence entry "[^"]+" cites no known source lines/);
  rejects(edit(review => {review.unit_reports[0].report.evidence[0].extra = 1;}), f.chunked, /thin evidence entry "[^"]+" has unexpected fields/);
  rejects(edit(review => {review.unit_reports[0].report.evidence = 'none';}), f.chunked, /report has no evidence register/);
  rejects(edit(review => {review.unit_reports[0].report.evidence[0].quote = 'not the source';}), f.chunked, /failed validation: Invalid acceptance evidence/);
});

test('a stored merged report or score is refused, and the merge is always recomputed', async () => {
  const f = await chunkedFixture();
  const verified = reviewDecision(f.record, {chunked: f.chunked});
  for (const field of ['report', 'scores']) {
    const record = clone(f.record); record.result.reviews[0][field] = clone(verified.reviews[0][field]);
    rejects(record, f.chunked, /merged report is derived and must not be stored/);
  }
  let merges = 0;
  reviewDecision(f.record, {chunked: {...f.chunked, hooks: {...hooks, merge: input => {merges++; return hooks.merge(input);}}}});
  assert.equal(merges, 2);
  const unmergeable = {...hooks, merge: input => ({...hooks.merge(input), summary: ''})};
  rejects(f.record, {...f.chunked, hooks: unmergeable}, /examiner merged report failed validation/);
  const noIntegration = clone(f.record); delete noIntegration.result.reviews[1].integration;
  rejects(noIntegration, f.chunked, /challenger has no integration entries/);
});

test('grades attach to the merged findings exactly once and must match their recorded answer', async () => {
  const f = await chunkedFixture({finding: true});
  const edit = change => {const record = clone(f.record); change(record.result.reviews[0].grading); return record;};
  assert.ok(f.record.result.reviews[0].grading.decisions.length > 0);
  rejects(edit(grading => {grading.decisions.pop();}), f.chunked, /examiner grading does not cover exactly the merged findings/);
  rejects(edit(grading => {grading.decisions.push(grading.decisions[0]);}), f.chunked, /examiner grading does not cover exactly/);
  rejects(edit(grading => {grading.decisions[0].id = 'f9_unknown';}), f.chunked, /examiner grading does not cover exactly/);
  const noGrading = clone(f.record); delete noGrading.result.reviews[0].grading;
  rejects(noGrading, f.chunked, /examiner grading does not cover exactly/);
  const record = clone(f.record); record.result.reviews[0].grading.decisions[0].value = 1;
  rejects(record, f.chunked, /examiner grade f0_\w+ differs from its recorded answer/);
  const badAnswer = clone(f.record); badAnswer.result.reviews[0].grading.decisions[0].answer = 'level9';
  rejects(badAnswer, f.chunked, /examiner grade f0_\w+ failed validation: Invalid semantic rubric answer/);
  // A change with no findings has no grading round.
  const none = await chunkedFixture();
  delete none.record.result.reviews[0].grading; delete none.record.result.reviews[1].drafts;
  assert.equal(reviewDecision(none.record, {chunked: none.chunked}).decision, 'auto_approve');
});

test('every unit and the integration pass must have recorded harness executions', async () => {
  const f = await chunkedFixture({finding: true});
  const without = predicate => {
    const record = clone(f.record); record.result.usage = record.result.usage.filter(item => !predicate(item)); return reseal(record);
  };
  rejects(without(item => item.role === 'challenger' && item.unit === 'u1'), f.chunked, /challenger has no recorded investigation of unit u1/);
  rejects(without(item => item.role === 'examiner' && item.phase === 'integration'), f.chunked, /examiner has no recorded integration pass/);
  rejects(without(item => item.role === 'examiner' && item.phase === 'grading'), f.chunked, /examiner has no recorded grading round/);
  const tagged = clone(f.record); tagged.result.usage[0].unit = 'u7'; reseal(tagged);
  rejects(tagged, f.chunked, /tagged with an unknown unit/);
  const generic = clone(f.record); generic.result.usage = generic.result.usage.slice(0, 1);
  assert.throws(() => reviewDecision(generic, {chunked: f.chunked}), /complete independent harness execution records required/);
});

test('signed evidence, review binding and the decision still come from the unchanged derivation', async () => {
  const f = await chunkedFixture();
  const altered = clone(f.record); altered.snapshot.number = 1;
  assert.throws(() => reviewDecision(altered, {chunked: f.chunked}), /altered evidence snapshot/);
  const claimed = clone(f.record); claimed.result.decision = 'repair_required';
  assert.throws(() => reviewDecision(claimed, {chunked: f.chunked}), /claimed decision differs from calculated decision/);
  assert.throws(() => reviewDecision({partition: f.plan}, {chunked: f.chunked}), /./);
});

test('the signer and the verifier refuse an oversize record with an explicit record_too_large hold', async () => {
  const f = await chunkedFixture();
  assert.ok(assertRecordSize(f.record) < RECORD_LIMIT);
  assert.throws(() => assertRecordSize(f.record, 100), error => error.cause_code === 'record_too_large' && /above the 100 byte signing limit/.test(error.message));
  f.record.padding = 'x'.repeat(RECORD_LIMIT);
  rejects(f.record, f.chunked, /record_too_large: the record is \d+ bytes, above the 2850000 byte signing limit/, 'record_too_large');
  assert.throws(() => issueReceipt(f.issue), error => error.code === 'CHUNKED_RECORD' && error.cause_code === 'record_too_large');
  // The refusal is classified into a visible, specific hold with its own next step.
  const classified = classify(new ChunkedRecordError('record_too_large', 'record_too_large: the record is 3000000 bytes'));
  assert.equal(classified.cause, 'record_too_large');
  const notice = body({number: 1, head_sha: 'a'.repeat(40), ...classified}, 'https://github.com/o/r/actions/runs/1');
  assert.ok(notice.includes('record_too_large: the record is 3000000 bytes') && notice.includes(NEXT_STEPS.record_too_large));
  const other = classify(new ChunkedRecordError('chunked_record_invalid', 'duplicate ownership'));
  assert.ok(body({number: 1, head_sha: 'a'.repeat(40), ...other}, 'https://github.com/o/r/actions/runs/1').includes(NEXT_STEPS.chunked_record_invalid));
});

test('quote elision is lossless and only drops what the controller can regenerate', async () => {
  const f = await chunkedFixture();
  const view = f.views[0];
  const full = clone(f.record.result.reviews[0].unit_reports[0].report);
  const rehydrated = rehydrateQuotes(full, view);
  const thin = elideQuotes(rehydrated, view);
  assert.ok(thin.evidence.every(entry => !Object.hasOwn(entry, 'quote')));
  assert.deepEqual(rehydrateQuotes(thin, view), rehydrated);
  assert.ok(JSON.stringify(thin).length < JSON.stringify(rehydrated).length);
  // A shorter or forged quote and a malformed citation stay as they were, so validation still sees them.
  const kept = clone(rehydrated);
  const [first, second, third] = kept.evidence;
  first.quote = first.quote.slice(0, 3); second.quote = 'forged';
  third.source = 'no-such-source';
  const elided = elideQuotes(kept, view);
  assert.deepEqual(elided.evidence.slice(0, 3), [first, second, third]);
  assert.deepEqual(rehydrateQuotes({evidence: [first]}, view).evidence, [first]);
  const malformed = [null, {id: 7}, {id: 'a', source: Object.keys(view.sources)[0], start: 0, end: 1}, {id: 'a', source: Object.keys(view.sources)[0], start: 2, end: 1},
    {id: 'a', source: Object.keys(view.sources)[0], start: 1.5, end: 2}, {id: 'a', source: Object.keys(view.sources)[0], start: 1, end: 9999},
    {id: 'a', source: Object.keys(view.sources)[0], start: 1, end: 'x'}];
  for (const entry of malformed) {
    assert.deepEqual(elideQuotes({evidence: [entry]}, view).evidence, [entry]);
    assert.throws(() => rehydrateQuotes({evidence: [entry]}, view), /cites no known source lines/);
  }
});

test('thin drafts of a unit and of the merged review are rehydrated before validation', async () => {
  const f = await chunkedFixture();
  const record = clone(f.record);
  for (const review of record.result.reviews) {
    review.unit_reports.forEach((item, index) => {item.drafts = [clone(item.report)]; void index;});
    review.drafts = [clone(review.unit_reports[0].report)];
  }
  const verified = reviewDecision(record, {chunked: f.chunked});
  assert.equal(verified.decision, 'auto_approve');
  assert.equal(verified.reviews[0].drafts.length, 1);
  assert.ok(verified.reviews[0].drafts[0].evidence.every(entry => typeof entry.quote === 'string'));
});
