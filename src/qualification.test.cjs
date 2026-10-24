'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {CASES, prepareCase} = require('../test/acceptance-cases.cjs');
const {casePassed, protocolFingerprint, equivalentInputs, factualReplay} = require('../test/evaluate-acceptance.cjs');
const {fixture, finding} = require('../test/fixtures/acceptance.cjs');
const {validateReport} = require('./acceptance.cjs');

test('the frozen corpus contains reasoned clean, defect, drift, excess, integrity, dismissed and missing-evidence cases', async () => {
  assert.equal(new Set(CASES.map(item => item.name)).size, CASES.length);
  assert.deepEqual([...new Set(CASES.map(item => item.category))].sort(), ['clean-change', 'dismissed-allegation', 'incomplete-evidence', 'known-defect', 'overengineering', 'scope-drift', 'test-integrity']);
  for (const scenario of CASES) {
    assert.ok(scenario.rationale && scenario.expected.length);
    const prepared = await prepareCase(scenario);
    const execution = JSON.parse(prepared.snapshot.sources.verification.content);
    assert.equal(execution.runtime.exit_code, 0, scenario.name);
    if (scenario.unavailableSource) await assert.rejects(prepared.github.rest.repos.getContent({path: scenario.unavailableSource, ref: prepared.snapshot.head_sha}), error => error.code === 'QUALIFICATION_MISSING_SOURCE' && error.path === scenario.unavailableSource);
    if (scenario.name === 'false-allegation') assert.equal(prepared.snapshot.prior_findings[0].state, 'dismissed');
    if (scenario.name === 'zero-body-regression') {
      const source = Object.values(prepared.snapshot.sources).find(item => item.path === 'src/upload.js' && item.ref === prepared.snapshot.head_sha).content;
      const accept = new Function(source.replace('export function', 'function') + '\nreturn acceptUpload;')();
      assert.deepEqual(accept('tenant', 0, 10, () => {}), {accepted: true, bytes: 0}, 'known-defect reference is executable, not a verdict label');
    }
  }
});

test('qualification requires the expected defect evidence, not just any blocking verdict', () => {
  const f = fixture(); const report = f.report; const scenario = CASES.find(item => item.requiredFindingPath);
  const result = {decision: 'repair_required', reviews: [{report, scores: validateReport(report, f.snapshot)}]};
  assert.equal(casePassed(scenario, result), false);
  report.findings = [finding()]; result.reviews[0].scores = validateReport(report, f.snapshot);
  assert.equal(casePassed({...scenario, requiredFindingPath: 'src/upload.rs'}, result), true);
  result.decision = 'auto_approve'; assert.equal(casePassed(scenario, result), false);
  const missing = CASES.find(item => item.unavailableSource);
  result.decision = 'review_incomplete'; report.coverage = {dependencies: []};
  assert.equal(casePassed(missing, result), false);
  report.coverage.dependencies.push({path: missing.unavailableSource, state: 'missing'});
  assert.equal(casePassed(missing, result), true);
});

test('recorded replay binds policy and evidence and cannot masquerade as live provider judgment', () => {
  const root = path.join(__dirname, '..');
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const fingerprint = protocolFingerprint(read);
  assert.notEqual(protocolFingerprint(file => read(file) + (file === 'src/acceptance-ledger.cjs' ? '\n// history changed' : '')), fingerprint);
  assert.throws(() => protocolFingerprint(file => file === 'src/review-provider.cjs' ? '' : read(file)), /Cannot bind/);
  assert.equal(equivalentInputs({digest: 'old', sources: {verification: 'old', source: 'same'}}, {digest: 'new', sources: {verification: 'new', source: 'same'}}), true);
  assert.equal(equivalentInputs({sources: {source: 'old'}}, {sources: {source: 'changed'}}), false);
  assert.deepEqual(factualReplay({observations: []}, {}), []);
  assert.throws(() => factualReplay({observations: [{round: 0, role: 'examiner', transport: {raw: '{}'}, usage: []}]}, {examiner: 'model'}), /untruncated/);
});
