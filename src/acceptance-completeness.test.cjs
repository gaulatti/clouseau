'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture, finding} = require('../test/fixtures/acceptance.cjs');
const {validateReport, digest} = require('./acceptance.cjs');
const {template, modelTemplate, materialize} = require('./acceptance-review.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const {reconcile, render, priorState} = require('./acceptance-ledger.cjs');

function complete() {
  const f = fixture(); f.snapshot.review_manifest_version = 1; refresh(f.snapshot); f.report.snapshot = f.snapshot.digest;
  f.report.coverage = {sources: [
    {source: 'contract', state: 'inspected', reason: 'Checked the accepted upload boundary.', evidence: ['contract']},
    {source: 'head', state: 'inspected', reason: 'Inspected validation and durable acceptance.', evidence: ['source']},
  ], dependencies: []};
  f.report.reopenings = [];
  return f;
}
function result(f) {
  return {decision: 'auto_approve', reviews: ['examiner', 'challenger'].map(role => ({role, report: structuredClone(f.report), scores: validateReport(f.report, f.snapshot)}))};
}
function advance(f, content) {
  f.snapshot.head_sha = digest(content).slice(0, 40); f.snapshot.sources.head.ref = f.snapshot.head_sha;
  f.snapshot.sources.head.content = content; refresh(f.snapshot); f.report.snapshot = f.snapshot.digest;
  f.report.evidence.find(item => item.id === 'source').quote = content.split('\n')[0];
}

test('a material missing dependency cannot be hidden behind green tests or a satisfied completeness gate', () => {
  const f = complete();
  f.report.coverage.dependencies.push({path: 'src/store.rs', state: 'missing', reason: 'Durable acknowledgement depends on this implementation.', evidence: []});
  assert.throws(() => validateReport(f.report, f.snapshot), /missing material source/);
  f.report.gates.find(gate => gate.name === 'review_completeness').state = 'unresolved';
  assert.equal(validateReport(f.report, f.snapshot).decision, 'review_incomplete');
  f.snapshot.sources.store = {path: 'src/store.rs', kind: 'source', ref: f.snapshot.head_sha, content: 'persist_then_ack();'};
  f.report.evidence.push({id: 'store', source: 'store', start: 1, end: 1, quote: 'persist_then_ack();'});
  f.report.coverage.sources.push({source: 'store', state: 'inspected', reason: 'Storage persists before acknowledgement.', evidence: ['store']});
  Object.assign(f.report.coverage.dependencies[0], {state: 'inspected', evidence: ['store']});
  f.report.gates.find(gate => gate.name === 'review_completeness').state = 'satisfied';
  refresh(f.snapshot); f.report.snapshot = f.snapshot.digest;
  assert.equal(validateReport(f.report, f.snapshot).decision, 'auto_approve');
  f.snapshot.sources.store.ref = 'b'.repeat(40); refresh(f.snapshot); f.report.snapshot = f.snapshot.digest;
  assert.throws(() => validateReport(f.report, f.snapshot), /direct immutable evidence/);
});

test('all supplied context is inventoried and exclusions require reasons and real citations', () => {
  const f = complete();
  for (const mutate of [
    r => r.coverage.sources.pop(), r => r.coverage.sources.push(r.coverage.sources[0]),
    r => {r.coverage.sources[0].source = 'invented';}, r => {r.coverage.sources[0].state = 'invented';},
    r => {r.coverage.sources[0].reason = '';}, r => {r.coverage.sources[0].evidence = ['source'];},
    r => {r.coverage.sources[1].state = 'excluded';}, r => {r.coverage.sources[0].evidence = [];},
    r => {r.coverage.sources[0].state = 'missing';}, r => {delete r.coverage;},
  ]) {const report = structuredClone(f.report); mutate(report); assert.throws(() => validateReport(report, f.snapshot));}
  f.report.coverage.sources[0].state = 'excluded';
  assert.equal(validateReport(f.report, f.snapshot).decision, 'auto_approve');
  f.report.coverage.sources[0].state = 'missing'; f.report.coverage.sources[0].evidence = [];
  f.report.gates.find(gate => gate.name === 'review_completeness').state = 'unresolved';
  assert.equal(validateReport(f.report, f.snapshot).decision, 'review_incomplete');
});

test('dependency exclusions are explicit and material paths cannot be invented or repeated', () => {
  const f = complete();
  f.report.coverage.dependencies = [{path: 'generated/catalog.json', state: 'excluded', reason: 'The changed path never reads this generated catalog.', evidence: ['source']}];
  assert.equal(validateReport(f.report, f.snapshot).decision, 'auto_approve');
  for (const path of ['', '/private/key', '../key', 'src/./key', '.git/config', 'a//b', 'a\\b', 12]) {
    f.report.coverage.dependencies[0].path = path;
    assert.throws(() => validateReport(f.report, f.snapshot), /dependency path/);
  }
  f.report.coverage.dependencies[0].path = 'generated/catalog.json';
  f.report.coverage.dependencies.push(f.report.coverage.dependencies[0]);
  assert.throws(() => validateReport(f.report, f.snapshot), /dependency inventory/);
  f.report.coverage.dependencies = null;
  assert.throws(() => validateReport(f.report, f.snapshot), /dependency inventory/);
});

test('the actual model template and materializer preserve the complete immutable source inventory', () => {
  const f = complete();
  f.snapshot.sources.blank = {content: '\n', path: 'empty.txt'}; refresh(f.snapshot);
  const sample = template(f.snapshot);
  assert.equal(sample.coverage.sources.length, 3);
  assert.equal(sample.coverage.sources.at(-1).state, 'excluded');
  const facts = modelTemplate(f.snapshot);
  const report = materialize(facts, f.snapshot);
  assert.equal(report.coverage.sources.length, 3);
  assert.equal(report.coverage.sources[0].source, 'contract');
  assert.ok(report.coverage.sources[1].evidence.length);
  // A real new review is fail-closed until its observed gates and grades exist.
  assert.equal(validateReport(report, f.snapshot).decision, 'review_incomplete');
  f.snapshot.sources.added = {content: 'supporting source', path: 'helper.rs', ref: f.snapshot.head_sha}; refresh(f.snapshot);
  assert.equal(template(f.snapshot).coverage.sources.find(item => item.source === 'added').state, 'inspected');
  const empty = structuredClone(report); empty.coverage.sources[2].state = 'excluded';
  f.snapshot.sources.blank.path = 'src/blank.rs'; f.snapshot.files.push({path: 'src/blank.rs', head_source: 'blank'});
  // Empty changed source remains explicitly excludable; nonempty changed source does not.
  const fresh = template(f.snapshot); assert.equal(fresh.coverage.sources.find(item => item.source === 'blank').state, 'excluded');
});

test('finding history survives repair, unrelated pushes, paraphrases, rename, and an evidenced regression', () => {
  const f = complete();
  advance(f, 'accept_durably(input)\n// validation missing\n');
  f.report.findings = [finding()];
  let state = reconcile(result(f), f.snapshot);
  const id = state.findings[0].id;
  assert.equal(state.findings[0].events.length, 1);
  f.snapshot.prior_findings = state.findings;
  advance(f, 'validate(input)?;\naccept_durably(input)\n');
  f.report.findings = []; f.report.resolutions = [{id, state: 'corrected', reason: 'Rejection is restored before storage.', evidence: ['source']}];
  state = reconcile(result(f), f.snapshot, state.findings);
  assert.equal(state.findings[0].state, 'corrected');
  assert.equal(state.findings[0].events.length, 2);
  const closed = structuredClone(state.findings);
  f.snapshot.prior_findings = closed;
  advance(f, 'validate(input)?;\naccept_durably(input)\n// unrelated comment\n'); f.report.resolutions = [];
  state = reconcile(result(f), f.snapshot, closed);
  assert.equal(state.findings[0].state, 'corrected');
  assert.equal(state.findings[0].events.length, 2);
  f.report.findings = [{...finding(), id: 'another-model-id', title: 'A paraphrased accusation', cause: 'Different words for the same rejected claim.'}];
  state = reconcile(result(f), f.snapshot, closed);
  assert.deepEqual(state.unresolved, [id]); assert.equal(state.findings[0].state, 'corrected');
  f.report.reopenings = [{id, reason: 'The validation allegedly disappeared.', evidence: ['source']}];
  state = reconcile(result(f), f.snapshot, closed);
  assert.deepEqual(state.unresolved, [id], 'a reason without changed evidence cannot reverse the accepted repair');
  // Restore the actual defect. Its bytes match the original defect, but differ
  // from the closure evidence, so this is a valid evidenced reopening.
  advance(f, 'accept_durably(input)\n// validation missing\n');
  state = reconcile(result(f), f.snapshot, closed);
  assert.deepEqual(state.unresolved, []); assert.equal(state.findings[0].blocking, true);
  assert.equal(state.findings[0].events.length, 3);
  assert.equal(state.findings[0].events[2].reason, f.report.reopenings[0].reason);
  // Rename a still-open path: identity follows the base path, not its title.
  f.snapshot.files[0].base_source = 'old'; f.snapshot.sources.old = {...f.snapshot.sources.head, path: 'src/upload.rs'};
  f.snapshot.paths = ['src/renamed.rs']; f.snapshot.files[0].path = 'src/renamed.rs'; f.snapshot.sources.head.path = 'src/renamed.rs';
  f.snapshot.prior_findings = state.findings; f.report.findings[0].id = 'renamed-model-id'; f.report.reopenings = [];
  f.report.evidence.push({id: 'old-proof', source: 'old', start: 1, end: 1, quote: 'accept_durably(input)'});
  f.report.coverage.sources.push({source: 'old', state: 'inspected', reason: 'Checked the pre-rename source.', evidence: ['old-proof']});
  const raw = resultForRename(f); const renamed = reconcile(raw, f.snapshot, state.findings);
  assert.equal(renamed.findings[0].id, id); assert.equal(renamed.findings[0].path, 'src/renamed.rs');
  const body = render(raw, f.snapshot, renamed);
  assert.match(body, /History/);
  assert.equal(priorState([{id: 9, user: {login: 'github-actions[bot]'}, body}], f.snapshot.repository, f.snapshot.number).findings[0].events.length, 4);
});
function resultForRename(f) {
  f.report.findings[0].path = 'src/renamed.rs'; f.report.findings[0].repair_paths = ['src/renamed.rs'];
  f.report.accounting[0].path = 'src/renamed.rs'; f.report.units[0].paths = ['src/renamed.rs'];
  refresh(f.snapshot); f.report.snapshot = f.snapshot.digest;
  return result(f);
}

test('a dismissed claim stays dismissed and unsupported reopening metadata fails closed', () => {
  const f = complete(); f.report.findings = [finding()];
  const previous = reconcile(result(f), f.snapshot).findings;
  const id = previous[0].id; f.snapshot.prior_findings = previous;
  f.report.findings = []; f.report.resolutions = [{id, state: 'dismissed', reason: 'Current source already rejects invalid input.', evidence: ['source']}];
  let state = reconcile(result(f), f.snapshot, previous);
  assert.equal(state.findings[0].state, 'dismissed');
  f.snapshot.prior_findings = state.findings; f.report.resolutions = [];
  assert.equal(reconcile(result(f), f.snapshot, state.findings).findings[0].state, 'dismissed');
  for (const reopenings of [null, [{id: 'invented', reason: 'A claim', evidence: ['source']}],
    [{id, reason: '', evidence: ['source']}], [{id, reason: 'A change', evidence: ['contract']}],
    [{id, reason: 'A change', evidence: ['source']}, {id, reason: 'Duplicate', evidence: ['source']}]]) {
    f.report.reopenings = reopenings; assert.throws(() => validateReport(f.report, f.snapshot));
  }
  f.report.reopenings = [];
  state.findings[0].events = Array.from({length: 32}, () => ({state: 'confirmed'})); state.findings[0].state = 'confirmed'; state.findings[0].blocking = true;
  f.report.resolutions = [{id, state: 'corrected', reason: 'Now restored.', evidence: ['source']}];
  assert.throws(() => reconcile(result(f), f.snapshot, state.findings), /history exceeds/);
});


test('product obligations keep their history identity and legacy closures without evidence cannot be reopened', () => {
  const f = complete();
  f.report.units[0].fit.outcome.min = 0; f.report.units[0].fit.outcome.max = 0;
  let state = reconcile(result(f), f.snapshot);
  assert.equal(state.findings[0].kind, 'product');
  assert.equal(state.findings[0].basis.length, 1);
  f.report.units[0].id = state.findings[0].id;
  f.report.accounting[0].units = [state.findings[0].id];
  assert.equal(reconcile(result(f), f.snapshot, state.findings).findings[0].id, state.findings[0].id);
  const g = complete(); g.report.findings = [finding()];
  const prior = reconcile(result(g), g.snapshot).findings;
  prior[0].blocking = false; prior[0].state = 'dismissed'; delete prior[0].basis;
  g.report.findings[0].id = prior[0].id; g.snapshot.prior_findings = prior;
  state = reconcile(result(g), g.snapshot, prior);
  assert.deepEqual(state.unresolved, [prior[0].id]);
  prior[0].basis = ['different'];
  g.report.reopenings = [{id: prior[0].id, reason: 'A changed source now supports the claim.', evidence: ['source']}];
  state = reconcile(result(g), g.snapshot, prior);
  assert.equal(state.findings[0].state, 'confirmed');
});


test('a newly generated verification receipt cannot reopen a closed source allegation', () => {
  const f = complete(); f.report.findings = [finding()];
  const previous = reconcile(result(f), f.snapshot).findings;
  previous[0].blocking = false; previous[0].state = 'dismissed';
  f.snapshot.prior_findings = previous;
  f.snapshot.sources.verification = {kind: 'verification', authority: 'trusted', path: 'verification', ref: f.snapshot.head_sha, content: 'A fresh successful test run.'};
  f.report.evidence.push({id: 'run', source: 'verification', start: 1, end: 1, quote: 'A fresh successful test run.'});
  f.report.coverage.sources.push({source: 'verification', state: 'inspected', reason: 'Verified the execution receipt.', evidence: ['run']});
  f.report.reopenings = [{id: previous[0].id, reason: 'Another CI run completed.', evidence: ['run']}];
  refresh(f.snapshot); f.report.snapshot = f.snapshot.digest;
  assert.throws(() => validateReport(f.report, f.snapshot), /repository evidence/);
  f.report.reopenings[0].evidence.push('source');
  assert.equal(validateReport(f.report, f.snapshot).decision, 'repair_required');
});
