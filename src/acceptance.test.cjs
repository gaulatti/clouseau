'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {digest, findingScore, validateReport, RULES} = require('./acceptance.cjs');
const {factor, fixture, finding} = require('../test/fixtures/acceptance.cjs');

test('a change with no findings and satisfied gates is approved on its own evidence', () => {
  const {report, snapshot} = fixture();
  const result = validateReport(report, snapshot);
  assert.equal(result.decision, 'auto_approve');
  assert.deepEqual(result.findings, []);
  assert.equal(digest({a: 1}), digest({a: 1}));
  assert.notEqual(digest({a: 1}), digest({a: 2}));
  report.units[0].kind = 'mechanism';
  report.gates[2].state = 'inapplicable';
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve');
});

test('only a violated gate stops approval; an unresolved gate is advisory', () => {
  const {report, snapshot} = fixture();
  report.gates[0].state = 'violated';
  assert.equal(validateReport(report, snapshot).decision, 'repair_required');
  report.gates[0].state = 'unresolved';
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve');
  report.gates.find(gate => gate.name === 'test_integrity').state = 'violated';
  assert.equal(validateReport(report, snapshot).decision, 'blocked_integrity');
});

test('the nine-factor defect score preserves necessity and all five consequence amplifiers', () => {
  const item = finding();
  item.factors.necessity = factor(0.5); item.factors.severity = factor(0.5);
  item.factors.reach = factor(0.5); item.factors.propagation = factor(0.5);
  assert.equal(findingScore(item), 90);
  item.factors.activation = factor(0);
  assert.equal(findingScore(item), 50, 'inactive consequences cannot cancel an established obligation');
  item.factors.necessity = factor(0.7);
  assert.equal(findingScore(item), RULES.defect_threshold);
  item.factors.confidence = factor(0.5);
  assert.equal(findingScore(item), 35);
});

test('a finding blocks only when its single score reaches the threshold', () => {
  const {report, snapshot} = fixture();
  const item = finding(); report.findings.push(item);
  assert.equal(validateReport(report, snapshot).decision, 'repair_required');
  item.factors.confidence = factor(0.5);
  const result = validateReport(report, snapshot);
  assert.equal(result.decision, 'auto_approve');
  assert.equal(result.findings[0].score, 50);
  item.factors.confidence = factor(1); item.factors.activation = factor(0); item.factors.necessity = factor(0.5);
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve');
  assert.equal(validateReport(report, snapshot).findings[0].disposition, 'nonblocking');
});

test('blast radius damps optional opportunity only and xG never creates a merge veto', () => {
  const {report, snapshot} = fixture();
  const item = finding(); report.findings.push(item);
  item.factors.necessity = factor(0.6); item.factors.activation = factor(0);
  for (const key of Object.keys(item.opportunity)) item.opportunity[key] = true;
  let result = validateReport(report, snapshot);
  assert.equal(result.findings[0].priority, 80);
  assert.equal(result.decision, 'auto_approve');
  item.blast_radius = 2;
  result = validateReport(report, snapshot);
  assert.equal(result.findings[0].priority, 65);
  item.factors.necessity = factor(1);
  assert.equal(validateReport(report, snapshot).decision, 'repair_required');
  assert.equal(validateReport(report, snapshot).findings[0].priority, 100);
});

test('prior findings close only with valid current-revision counterevidence', () => {
  const {report, snapshot} = fixture();
  snapshot.prior_findings = [{id: 'prior-cause'}];
  report.resolutions = [{id: 'prior-cause', state: 'corrected', reason: 'Current source rejects the invalid request.', evidence: ['source']}];
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve');
  for (const mutate of [
    r => {r.resolutions = null;}, r => {r.resolutions[0].id = 'unknown';},
    r => {r.resolutions[0].state = 'waived';}, r => {r.resolutions[0].evidence = ['contract'];},
    r => {r.resolutions.push(r.resolutions[0]);}, r => {r.accounting[0].evidence = ['contract'];},
  ]) {
    const bad = structuredClone(report); mutate(bad);
    assert.throws(() => validateReport(bad, snapshot), /Invalid acceptance/);
  }
  snapshot.sources.head.path = 'src/previous-name.rs';
  report.findings = [finding()];
  assert.equal(validateReport(report, snapshot).decision, 'repair_required', 'rename aliases preserve changed-path evidence');
});

test('all boundaries are strict and no evidence, accounting, or empty-plan escape exists', () => {
  const invalid = [
    r => {r.extra = true;}, r => {r.version = 1;}, r => {r.snapshot = 'stale';}, r => {r.summary = '';},
    r => {r.evidence = [];}, r => {r.evidence = null;}, r => {r.evidence.push(r.evidence[0]);},
    r => {r.evidence[0].source = 'invented';}, r => {r.evidence[0].start = 0;},
    r => {r.evidence[0].start = 0.5;}, r => {r.evidence[0].end = 50;}, r => {r.evidence[0].end = 3;},
    r => {r.evidence[0].quote = 'not in source';}, r => {r.evidence[0].quote = ' ';},
    r => {r.units = [];}, r => {r.units.push(r.units[0]);}, r => {r.units[0].kind = 'anything';},
    r => {r.units[0].paths = [];}, r => {r.units[0].paths = ['outside.rs'];},
    r => {r.findings = [finding()]; r.findings[0].factors.severity.value = -1;}, r => {r.findings = [finding()]; r.findings[0].factors.severity.value = 2;},
    r => {r.findings = [finding()]; r.findings[0].factors.severity.value = 1.1;}, r => {r.findings = [finding()]; r.findings[0].factors.severity.value = NaN;},
    r => {r.findings = [finding()]; r.findings[0].factors.severity.evidence = [];}, r => {r.findings = [finding()]; r.findings[0].factors.severity.evidence = ['unknown'];},
    r => {r.findings = [finding()]; r.findings[0].factors.severity.evidence = ['source', 'source'];}, r => {r.findings = [finding()]; r.findings[0].factors.severity.reason = '';},
    r => {r.findings = null;},
    r => {r.findings = [finding(), finding()];}, r => {r.findings = [{...finding(), path: 'outside.rs'}];},
    r => {r.findings = [{...finding(), trigger: ''}];}, r => {r.findings = [{...finding(), blast_radius: 0}];},
    r => {r.findings = [{...finding(), evidence: ['contract']}];},
    r => {r.findings = [{...finding(), blast_radius: Infinity}];},
    r => {r.findings = [{...finding(), opportunity: {mechanical: 1, beneficial: true, within_scope: true, verified: true}}];},
    r => {r.findings = [{...finding(), repair_paths: []}];}, r => {r.findings = [{...finding(), repair_paths: ['elsewhere.rs']}];},
    r => {r.gates = [];}, r => {r.gates[0] = r.gates[1];}, r => {r.gates[0].name = 'unknown';},
    r => {r.gates[0].state = 'pass';}, r => {r.accounting = [];},
    r => {r.gates[0].state = 'inapplicable';},
    r => {r.accounting[0].path = 'elsewhere.rs';}, r => {r.accounting[0].units = [];},
    r => {r.accounting[0].units = ['invented'];}, r => {r.decisions = [];},
  ];
  for (const mutate of invalid) {
    const {report, snapshot} = fixture(); mutate(report);
    assert.throws(() => validateReport(report, snapshot), /Invalid acceptance evidence/, mutate.toString());
  }
  const {report, snapshot} = fixture();
  for (const value of [null, [], 'text', {}]) assert.throws(() => validateReport(value, snapshot));
  report.evidence[1] = {id: 'source', source: 'head', start: 3, end: 3, quote: ' '};
  assert.throws(() => validateReport(report, snapshot), /citation does not match/);
});
