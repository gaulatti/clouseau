'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {CASES, prepareCase} = require('../test/acceptance-cases.cjs');
const {casePassed, defectPacket, matchKnownDefect, recoverGraded, protocolFingerprint, equivalentInputs, factualReplay} = require('../test/evaluate-acceptance.cjs');
const {fixture, finding} = require('../test/fixtures/acceptance.cjs');
const {validateReport, digest} = require('./acceptance.cjs');

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

test('qualification requires causal adjudication of the reference defect, not any blocker on the same file', () => {
  const f = fixture(); const report = f.report; const scenario = CASES.find(item => item.requiredFinding);
  const result = {decision: 'repair_required', reviews: [{report, scores: validateReport(report, f.snapshot)}]};
  assert.equal(casePassed(scenario, result), false);
  report.findings = [finding()]; result.reviews[0].scores = validateReport(report, f.snapshot);
  const actual = {...scenario, requiredFinding: {...scenario.requiredFinding, path: 'src/upload.rs'}};
  const binding = digest(defectPacket(actual, result));
  result.known_defect_match = {binding, answer: {choice: 'different', probabilities: {matched: 0, different: 1, uncertain: 0}}};
  assert.equal(casePassed(actual, result), false, 'a same-file blocker with a different cause does not qualify');
  result.known_defect_match.answer = {choice: 'matched', probabilities: {matched: 0.9, different: 0, uncertain: 0.1}};
  assert.equal(casePassed(actual, result), true);
  result.decision = 'blocked_integrity'; assert.equal(casePassed(actual, result), true, 'integrity takes priority without removing the required actual defect finding');
  report.findings[0].cause = 'A different regression';
  assert.equal(casePassed(actual, result), false, 'adjudication cannot be reused for a different finding');
  result.decision = 'auto_approve'; assert.equal(casePassed(scenario, result), false);
  const missing = CASES.find(item => item.unavailableSource);
  result.decision = 'review_incomplete'; report.coverage = {dependencies: []};
  assert.equal(casePassed(missing, result), false);
  report.coverage.dependencies.push({path: missing.unavailableSource, state: 'missing'});
  assert.equal(casePassed(missing, result), true);
  report.coverage.dependencies = [];
  const gate = report.gates.find(item => item.name === 'review_completeness'); gate.state = 'unresolved';
  result.reviews[0].grading = {decisions: [{id: 'review_completeness', value: 0}]};
  assert.equal(casePassed(missing, result), true, 'independent completeness grading can fail closed despite an inspector omitting or excluding the dependency');
  result.reviews[0].grading.decisions[0].value = 1;
  assert.equal(casePassed(missing, result), false, 'an unrelated incomplete verdict does not qualify the required completeness audit');
});

test('known-defect matching sends the frozen reference and literal causal findings to a bounded separate adjudicator', async () => {
  const f = fixture(); f.report.findings = [finding()];
  const result = {snapshot: f.snapshot.digest, reviews: [{report: f.report, scores: validateReport(f.report, f.snapshot)}]};
  const scenario = {...CASES.find(item => item.requiredFinding), requiredFinding: {path: 'src/upload.rs', trigger: 'zero bytes', cause: 'removed lower bound', consequence: 'empty upload persisted'}};
  const old = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'qualification-test-only';
  try {
    const matched = await matchKnownDefect(scenario, result, {fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      const body = JSON.parse(request.body), state = body.state;
      assert.equal(typeof state, 'object');
      assert.equal(body.questions.match.type, 'choice');
      assert.equal(typeof body.questions.match.instructions, 'string');
      assert.equal(Object.hasOwn(body.questions.match, 'question'), false);
      assert.deepEqual(state.reference, scenario.requiredFinding);
      assert.equal(state.candidates[0].finding.cause, finding().cause);
      assert.ok(state.candidates[0].evidence.length);
      return {ok: true, json: async () => ({model: body.model, answers: {match: {type: 'choice', choice: 'matched', confidence: 0.95,
        probabilities: {matched: 0.95, different: 0.03, uncertain: 0.02}}}})};
    }});
    assert.equal(matched.binding, digest(defectPacket(scenario, result)));
    assert.equal(matched.answer.choice, 'matched');
  } finally {if (old === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = old;}
});

test('recorded replay binds policy and evidence and cannot masquerade as live provider judgment', () => {
  const root = path.join(__dirname, '..');
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const fingerprint = protocolFingerprint(read);
  assert.equal(protocolFingerprint(file => read(file) + (file === 'test/evaluate-acceptance.cjs' ? '\n// transport repair' : ''), true), protocolFingerprint(read, true));
  assert.notEqual(protocolFingerprint(file => read(file) + (file === 'src/acceptance-grading.cjs' ? '\n// review changed' : ''), true), protocolFingerprint(read, true));
  assert.notEqual(protocolFingerprint(file => read(file) + (file === 'test/evaluate-acceptance.cjs' ? '\n// transport repair' : '')), fingerprint);
  assert.notEqual(protocolFingerprint(file => read(file) + (file === 'src/acceptance-ledger.cjs' ? '\n// history changed' : '')), fingerprint);
  assert.throws(() => protocolFingerprint(file => file === 'src/review-provider.cjs' ? '' : read(file)), /Cannot bind/);
  assert.equal(equivalentInputs({digest: 'old', sources: {verification: 'old', source: 'same'}}, {digest: 'new', sources: {verification: 'new', source: 'same'}}), true);
  assert.equal(equivalentInputs({sources: {source: 'old'}}, {sources: {source: 'changed'}}), false);
  assert.deepEqual(factualReplay({observations: []}, {}), []);
  assert.throws(() => factualReplay({observations: [{round: 0, role: 'examiner', transport: {raw: '{}'}, usage: []}]}, {examiner: 'model'}), /untruncated/);
  assert.throws(() => recoverGraded({observations: []}, {digest: 'missing'}, 'routed'), /unique recorded grade/);
});
