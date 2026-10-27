'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {digest, productScore, findingScore, validateReport, RULES} = require('./acceptance.cjs');
const {factor, fixture, finding} = require('../test/fixtures/acceptance.cjs');

test('accepted maintenance has a complete, source-bound product justification', () => {
  const {report, snapshot} = fixture();
  assert.deepEqual(productScore(report.units[0], 'min'), {fit: 100, need: 100, proportionality: 100, acceptance: 100});
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve');
  assert.equal(digest({a: 1}), digest({a: 1}));
  assert.notEqual(digest({a: 1}), digest({a: 2}));
  report.units[0].kind = 'mechanism';
  report.gates[2].state = 'inapplicable';
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve');
});

test('unit scores are computed from point factors and are informational only', () => {
  const {report, snapshot} = fixture();
  report.units[0].excess.abstraction = factor(0.5);
  report.units[0].alternative = 'Call the existing validator directly; no plugin framework is needed.';
  assert.equal(validateReport(report, snapshot).units[0].acceptance, 50);
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve', 'only findings and gates decide approval');
  report.units[0].excess.abstraction = factor(0);
  const need = report.units[0].need;
  need.binding = factor(0); need.value = factor(0.5); need.unmetness = factor(0.5); need.timeliness = factor(0);
  assert.equal(productScore(report.units[0]).need, 40);
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve');
});

test('purpose exclusions and owner authority are never compensated by product scores', () => {
  const {report, snapshot} = fixture();
  report.gates[0].state = 'violated';
  assert.equal(validateReport(report, snapshot).decision, 'repair_required');
  report.gates[0].state = 'unresolved';
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve');
  report.gates[0].state = 'satisfied';
  report.units[0].fit.outcome = factor(0);
  report.decisions.push({kind: 'purpose', question: 'Should this upload gateway also compose music?', options: ['Keep the upload purpose', 'Accept a new product purpose'], evidence: ['contract']});
  assert.equal(validateReport(report, snapshot).decision, 'owner_decision');
  for (const state of ['unresolved', 'violated']) {
    report.gates[0].state = state;
    assert.equal(validateReport(report, snapshot).decision, 'owner_decision');
  }
  report.gates[2].state = 'violated';
  assert.equal(validateReport(report, snapshot).decision, 'repair_required');
});

test('missing narrower alternatives hold approval without erasing an independent integrity veto', () => {
  const {report, snapshot} = fixture();
  for (const value of [0.25, 1]) {
    report.units[0].excess.abstraction = factor(value);
    const scored = validateReport(report, snapshot);
    assert.equal(scored.decision, 'review_incomplete');
    assert.equal(scored.units[0].proportionality, 100 * (1 - value));
    report.gates.find(gate => gate.name === 'test_integrity').state = 'violated';
    assert.equal(validateReport(report, snapshot).decision, 'blocked_integrity');
    report.gates.find(gate => gate.name === 'test_integrity').state = 'satisfied';
  }
});

test('a proposed purpose question cannot delegate unnecessary internal machinery to the owner', () => {
  const {report, snapshot} = fixture();
  report.decisions.push({kind: 'purpose', question: 'Should uploads use a plugin framework?',
    options: ['Authorize the plugin framework', 'Preserve the direct implementation'], evidence: ['source']});
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve', 'an unsupported question alone cannot block accepted work');
  report.units[0].excess.abstraction = factor(0.75);
  report.units[0].alternative = 'Retain direct validation and the new real rejection tests.';
  const mechanism = structuredClone(report.units[0]);
  mechanism.id = 'plugin-framework'; mechanism.kind = 'mechanism';
  mechanism.fit.outcome = factor(0);
  report.units.push(mechanism); report.accounting[0].units.push(mechanism.id);
  report.gates[0].state = 'violated';
  assert.equal(validateReport(report, snapshot).decision, 'repair_required');
  report.gates[0].state = 'unresolved';
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve', 'unresolved authority still requires investigation');
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

test('test integrity violations block despite owner confirmation or strong product value', () => {
  const {report, snapshot} = fixture();
  report.gates.find(item => item.name === 'test_integrity').state = 'violated';
  report.decisions.push({kind: 'authority', question: 'Accept this scope?', options: ['Accept', 'Reject'], evidence: ['contract']});
  assert.equal(validateReport(report, snapshot).decision, 'blocked_integrity');
});

test('prior findings close only with valid current-revision counterevidence and cannot borrow runtime receipts as binding requirements', () => {
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
  snapshot.sources.contract.kind = 'verification';
  assert.throws(() => validateReport(report, snapshot), /trusted contract authority/);
  snapshot.sources.contract.kind = 'contract';
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
    r => {r.units[0].fit.domain.value = -1;}, r => {r.units[0].fit.domain.value = 2;},
    r => {r.units[0].fit.domain.value = 1.1;}, r => {r.units[0].fit.domain.value = NaN;},
    r => {r.units[0].fit.domain.evidence = [];}, r => {r.units[0].fit.domain.evidence = ['unknown'];},
    r => {r.units[0].fit.domain.evidence = ['source', 'source'];}, r => {r.units[0].fit.domain.reason = '';},
    r => {r.units[0].need.binding.evidence = ['source'];}, r => {r.units[0].alternative = null;},
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
    r => {r.accounting[0].units = ['invented'];}, r => {r.decisions = null;},
    r => {r.decisions = [{kind: 'technical', question: 'Read my code?', options: ['Yes', 'No'], evidence: ['source']}];},
    r => {r.decisions = [{kind: 'purpose', question: 'Accept?', options: ['Yes'], evidence: ['source']}];},
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
