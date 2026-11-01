'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {chunkedFixture, hooks, planOf, PARAMS} = require('../test/chunked-fixture.cjs');
const {fixture} = require('../test/local-review-fixture.cjs');
const {issueReceipt, verifyReceipt, reviewDecision} = require('./local-receipt.cjs');
const {ChunkedRecordError, RECORD_LIMIT, parseParams, snapshotDigest, elideQuotes, rehydrateQuotes, SCHEME} = require('./chunked-record.cjs');
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
  // The earlier bounds still load from protected configuration and bound nothing.
  assert.deepEqual(parseParams({...PARAMS, cap: 1, max_units: 1}), PARAMS);
  for (const bad of [null, 'x', {}, {...PARAMS, extra: 1}, {...PARAMS, C: 0}, {...PARAMS, S: 1.5}, {...PARAMS, cap: 0}, {...PARAMS, max_units: -1}]) {
    assert.throws(() => parseParams(bad), /protected chunk parameters/);
  }
  const f = await chunkedFixture();
  rejects(f.record, {params: {...PARAMS, C: 1}, hooks}, /partition parameters differ from the protected configuration/);
  const forged = clone(f.record); forged.partition.params.C = 1;
  rejects(forged, f.chunked, /partition parameters differ from the protected configuration/);
  assert.equal(reviewDecision(f.record, {chunked: {params: {...PARAMS, cap: 1, max_units: 1}, hooks}}).decision, 'auto_approve');
});

test('combined evidence has no size cap: the snapshot digest is recomputed whatever its size', async () => {
  const f = await chunkedFixture();
  assert.equal(snapshotDigest(f.snapshot), f.snapshot.digest);
  const large = clone(f.snapshot);
  large.sources.padding = {path: 'padding', ref: 'x', authority: 'untrusted', kind: 'source', content: 'x'.repeat(5000000)};
  assert.equal(snapshotDigest(large), digest((({digest: _, ...value}) => value)(large)));
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
    rejects(record, f.chunked, /partition has no units/);
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

test('a file split into segments is owned once per segment, each segment exactly once', async () => {
  const f = await chunkedFixture();
  const edit = change => {const record = clone(f.record); change(record.partition); return record;};
  const split = (first, second) => plan => {
    plan.units[0].parts = {'README.md': first}; plan.units[1].owned.push('README.md'); plan.units[1].parts = {'README.md': second};
  };
  // A complete split passes the ownership check and is stopped later, by the recomputed view digest.
  rejects(edit(split({index: 0, count: 2}, {index: 1, count: 2})), f.chunked, /view digest of unit u1 differs/);
  rejects(edit(split({index: 0, count: 2}, {index: 0, count: 2})), f.chunked, /"README.md" is not covered by each of its segments exactly once/);
  rejects(edit(split({index: 0, count: 2}, {index: 1, count: 3})), f.chunked, /not covered by each of its segments exactly once/);
  rejects(edit(split({index: 0, count: 3}, {index: 1, count: 3})), f.chunked, /not covered by each of its segments exactly once/);
  rejects(edit(plan => {plan.units[0].parts = {'README.md': {index: 0, count: 2}};}), f.chunked, /"README.md" is not covered by each of its segments exactly once/);
  rejects(edit(plan => {plan.units[1].owned.push('README.md'); plan.units[1].parts = {'README.md': {index: 1, count: 2}};}), f.chunked, /duplicate ownership/);
  for (const parts of ['x', [], {'src/other.js': {index: 0, count: 1}}, {'README.md': {index: 1, count: 1}}, {'README.md': {index: 0.5, count: 1}}, {'README.md': null}]) {
    rejects(edit(plan => {plan.units[0].parts = parts;}), f.chunked, /names a malformed segment/);
  }
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

test('a record above the single-receipt limit is signed as a multi-part receipt and verifies', async () => {
  const f = await chunkedFixture();
  assert.equal(issueReceipt(f.issue).parts, undefined, 'a record that fits one receipt is signed as before');
  f.record.padding = 'x'.repeat(RECORD_LIMIT);
  const bundle = issueReceipt(f.issue);
  assert.ok(bundle.parts.length >= 2);
  assert.equal(bundle.payload.record.scheme, 'clouseau-receipt-parts/1');
  assert.equal(bundle.payload.record_digest, digest(f.record));
  const verified = verifyReceipt(bundle, f.expected);
  assert.equal(verified.decision, 'auto_approve');
  assert.equal(digest(verified.record), digest(f.record));
  // The classification of a chunked record problem stays visible, with its own next step.
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

test('a file added whole is stored compactly and still verifies', async () => {
  const {patchOf} = require('./acceptance.cjs');
  const compact = snapshot => {
    const file = snapshot.files.find(item => item.path === 'README.md');
    const lines = snapshot.sources[file.head_source].content.split('\n'); if (lines.at(-1) === '') lines.pop();
    Object.assign(file, {status: 'added', patch: `@@ -0,0 +1,${lines.length} @@\n`, patch_body: 'head_source'});
    delete file.base_source;
  };
  const f = await chunkedFixture({mutate: compact});
  const file = f.snapshot.files.find(item => item.path === 'README.md');
  assert.ok(patchOf(f.snapshot, file).length > file.patch.length);
  assert.ok(f.views.some(view => view.files.some(item => item.patch_body === 'head_source')));
  assert.equal(verifyReceipt(issueReceipt(f.issue), f.expected).decision, 'auto_approve');
  assert.ok(!JSON.stringify(f.record).includes(patchOf(f.snapshot, file).slice(file.patch.length, file.patch.length + 40).replaceAll('\n', '\\n')));
});
