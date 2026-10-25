'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const recorded = require('../test/fixtures/missing-context-review.json');
const {gradeReport, locations, packetFor, applyCompleteness} = require('./acceptance-grading.cjs');
const {localReview} = require('./local-review.cjs');
const {validateReport} = require('./acceptance.cjs');
const {JEV_MODEL} = require('./review-provider.cjs');

function facts() {
  const report = structuredClone(recorded.report);
  for (const proof of report.evidence) delete proof.quote;
  for (const unit of report.units) {
    delete unit.paths;
    for (const group of ['fit', 'need', 'excess']) for (const value of Object.values(unit[group])) {
      delete value.min; delete value.max;
    }
  }
  return report;
}

test('the captured live false approval now includes an independent contract-versus-inventory question', () => {
  assert.equal(recorded.recorded_transport_only, true);
  assert.equal(recorded.live_qualification_claim, false);
  assert.equal(recorded.original_decision, 'auto_approve');
  assert.equal(validateReport(recorded.report, recorded.snapshot).decision, 'auto_approve');
  const audit = locations(recorded.report).find(item => item.id === 'review_completeness');
  const packet = packetFor(audit, recorded.report, recorded.snapshot);
  assert.equal(packet.context.claimed_gate, 'satisfied');
  assert.ok(packet.context.coverage.dependencies.some(item => item.path === 'src/storage-policy.js' && item.state === 'excluded'));
  assert.ok(!packet.context.available_sources.some(item => item.path === 'src/storage-policy.js'));
  assert.match(audit.obligation, /every explicit trusted inspection requirement/);
});

test('CI uses the typed completeness judgment to block the captured report without changing product or defect scores', async () => {
  const before = ['DEEPSEEK_API_KEY', 'TYPESAFE_API_KEY'].map(name => process.env[name]);
  process.env.DEEPSEEK_API_KEY = 'transport-fixture-only'; process.env.TYPESAFE_API_KEY = 'transport-fixture-only';
  try {
    const packets = [];
    const graded = await gradeReport({report: recorded.report, snapshot: recorded.snapshot, provider: 'routed', model: 'deepseek-flash',
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body), typed = url.includes('typesafe');
        const packet = typed ? body : JSON.parse(body.messages[1].content); packets.push(packet);
        const answers = Object.fromEntries(Object.keys(packet.questions).map(id => {
          const choice = id === 'review_completeness' || id.includes('_excess_') ? 'level0' : 'level4';
          return [id, typed ? {type: 'choice', choice, confidence: 1,
            probabilities: Object.fromEntries(Object.keys(packet.questions[id].criteria).map(key => [key, key === choice ? 1 : 0]))} : choice];
        }));
        return {ok: true, json: async () => typed ? {model: JEV_MODEL, answers} :
          {choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers})}}]}};
      }});
    const packet = packets.find(item => Object.hasOwn(item.questions, 'review_completeness'));
    assert.ok(packet.state.accepted_contract.some(item => item.content.includes('src/storage-policy.js')));
    assert.equal(graded.grading.decisions.find(item => item.id === 'review_completeness').provider, 'typesafe');
    assert.equal(validateReport(graded.report, recorded.snapshot).decision, 'review_incomplete');
    assert.deepEqual(graded.report.units, recorded.report.units);
    assert.deepEqual(graded.report.findings, recorded.report.findings);
  } finally {
    ['DEEPSEEK_API_KEY', 'TYPESAFE_API_KEY'].forEach((name, i) => {if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i];});
  }
});

test('the canonical local route enforces the same independent completeness answer without API credentials', async () => {
  const result = await localReview({snapshot: recorded.snapshot, ask: async task => {
    if (task.phase === 'investigation') return {value: {kind: 'report', report: facts(), request_sources: []}, provenance: {fixture_only: true}};
    const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
    assert.ok(packet.accepted_contract.some(item => item.content.includes('src/storage-policy.js')));
    assert.ok(packet.questions.review_completeness.evidence.context.coverage);
    return {value: {answers: Object.fromEntries(Object.keys(task.schema.properties.answers.properties).map(id =>
      [id, id === 'review_completeness' ? 'unknown' : id.includes('_excess_') ? 'level0' : 'level4']))}, provenance: {fixture_only: true}};
  }});
  assert.equal(result.decision, 'review_incomplete');
  assert.ok(result.reviews.every(view => view.report.gates.find(item => item.name === 'review_completeness').state === 'unresolved'));
});

test('completeness grading never upgrades a missing or violated inspector gate and requires an exact complete condition', () => {
  const report = structuredClone(recorded.report), gate = report.gates.find(item => item.name === 'review_completeness');
  applyCompleteness(report, []); assert.equal(gate.state, 'satisfied');
  applyCompleteness(report, [{id: 'review_completeness', target: {min: 1, max: 1}}]); assert.equal(gate.state, 'satisfied');
  for (const state of ['unresolved', 'violated']) {
    gate.state = state;
    applyCompleteness(report, [{id: 'review_completeness', target: {min: 0, max: 1}}]); assert.equal(gate.state, state);
    applyCompleteness(report, [{id: 'review_completeness', target: {min: 1, max: 1}}]); assert.equal(gate.state, state);
  }
  gate.state = 'satisfied'; applyCompleteness(report, [{id: 'review_completeness', target: {min: 0.75, max: 1}}]);
  assert.equal(gate.state, 'unresolved');
});
