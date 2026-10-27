'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {locations, packetFor, grade, gradeReport} = require('./acceptance-grading.cjs');
const {RUBRICS} = require('./acceptance-rubrics.cjs');
const {FACTORS, validateReport} = require('./acceptance.cjs');
const {JEV_MODEL} = require('./review-provider.cjs');
const {fixture, finding} = require('../test/fixtures/acceptance.cjs');

function credentials(run) {return async () => {
  const names = ['DEEPSEEK_API_KEY', 'TYPESAFE_API_KEY']; const old = names.map(name => process.env[name]);
  names.forEach(name => {process.env[name] = 'fictional-only';});
  try {await run();} finally {names.forEach((name, i) => {if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i];});}
};}

const withFinding = () => {const f = fixture(); f.report.findings.push(finding()); return f;};
const deepseekAnswer = answers => ({ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers})}}]})});
const deepseek = pick => async (_, options) => {
  const packet = JSON.parse(JSON.parse(options.body).messages[1].content);
  return deepseekAnswer(Object.fromEntries(Object.keys(packet.questions).map(id => [id, pick(id)])));
};
const choice = (packet, id, level, confidence = 1) => ({type: 'choice', choice: level, confidence,
  probabilities: Object.fromEntries(Object.keys(packet.questions[id].criteria).map(key => [key, key === level ? 1 : 0]))});

test('every formula input has its own five descriptive semantic anchors', () => {
  for (const [group, names] of Object.entries(FACTORS)) {
    assert.deepEqual(Object.keys(RUBRICS[group]), names);
    for (const levels of Object.values(RUBRICS[group])) {
      assert.equal(levels.length, 5); assert.equal(new Set(levels).size, 5);
      assert.ok(levels.every(level => typeof level === 'string' && level.length > 10));
    }
  }
  const {report, snapshot} = withFinding();
  const values = locations(report);
  assert.equal(values.length, 9, 'only the nine defect factors are graded');
  const causal = values.find(item => item.id === 'f0_confidence');
  causal.target.evidence = ['contract'];
  const proof = packetFor(causal, report, snapshot);
  assert.equal(proof.context.cause, report.findings[0].cause);
  assert.ok(proof.evidence.some(item => item.path === 'src/upload.rs'), 'causal source proof accompanies every defect factor even if its observation cites only a contract');
  assert.equal(locations(fixture().report).length, 0, 'a change without findings has nothing to grade');
});

test('a grade is one value, an unestablished condition is level0 and only unresolved distributions are ambiguous', () => {
  assert.deepEqual(grade('level3'), {value: 0.75, ambiguous: false});
  assert.deepEqual(grade('unknown'), {value: 0, ambiguous: false});
  assert.throws(() => grade('pass'), /Invalid/);
  for (const answer of [
    {choice: 'unknown', confidence: 1, probabilities: {}},
    {choice: 'level4', confidence: 0.5, probabilities: {unknown: 0}},
    {choice: 'level4', confidence: 1, probabilities: {unknown: 0.1}},
  ]) assert.deepEqual(grade(answer), {value: 0, ambiguous: true});
  assert.equal(grade({choice: 'level4', confidence: 0.95, probabilities: {level4: 0.97, level3: 0.03, unknown: 0}}).ambiguous, true);
  assert.deepEqual(grade({choice: 'level4', confidence: 1, probabilities: {level4: 1, unknown: 0}}), {value: 1, ambiguous: false});
  assert.throws(() => grade({choice: 'level4', confidence: 1, probabilities: {level4: 0.001, unknown: 0}}), /no supported/);
});

test('the DeepSeek-only grader and Jev consume the same atomic evidence without doing arithmetic', credentials(async () => {
  const f = withFinding();
  for (const provider of ['deepseek', 'typesafe', 'routed']) {
    const requests = [];
    const result = await gradeReport({...f, provider, model: 'deepseek-flash', fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      const typed = provider === 'typesafe';
      const packet = typed ? body : JSON.parse(body.messages[1].content);
      requests.push(packet);
      const answers = Object.fromEntries(Object.keys(packet.questions).map(id => [id, typed ? choice(packet, id, 'level4') : 'level4']));
      return {ok: true, status: 200, json: async () => typed ? {model: JEV_MODEL, answers} :
        {choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers})}}]}};
    }});
    assert.equal(requests.length, 1, 'the nine defect questions fit one packet');
    assert.ok(requests.every(packet => Object.values(packet.questions).every(question => question.type === 'choice')));
    assert.equal(validateReport(result.report, f.snapshot).decision, 'repair_required');
    assert.equal(validateReport(result.report, f.snapshot).findings[0].score, 100);
    assert.equal(result.usage.length, 1);
    assert.notEqual(result.report, f.report);
  }
}));

test('partial causal proof lowers the single finding score instead of leaving a range', credentials(async () => {
  const f = withFinding();
  const result = await gradeReport({...f, provider: 'deepseek', model: 'deepseek-flash', fetchImpl:
    deepseek(id => id === 'f0_confidence' ? 'level2' : 'level4')});
  assert.equal(result.report.findings[0].factors.confidence.value, 0.5);
  const scored = validateReport(result.report, f.snapshot);
  assert.equal(scored.findings[0].score, 50);
  assert.equal(scored.decision, 'auto_approve');
}));

test('an unknown answer counts as level0 and an ambiguous Jev answer goes to one reasoning request', credentials(async () => {
  const f = withFinding(); const requests = [];
  const result = await gradeReport({...f, provider: 'typesafe', model: 'deepseek-flash', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes('typesafe')) {
      requests.push('typed');
      const answers = Object.fromEntries(Object.keys(body.questions).map(id => [id,
        id === 'f0_severity' ? choice(body, id, 'level0') : choice(body, id, 'level4', id === 'f0_necessity' ? 0.62 : 1)]));
      return {ok: true, json: async () => ({model: JEV_MODEL, answers})};
    }
    const packet = JSON.parse(body.messages[1].content); requests.push(Object.keys(packet.questions));
    return deepseekAnswer(Object.fromEntries(Object.keys(packet.questions).map(id => [id, 'unknown'])));
  }});
  assert.deepEqual(requests, ['typed', ['f0_necessity']], 'only the unresolved factor is regraded, and never the settled negative');
  assert.deepEqual(result.grading.escalated, ['f0_necessity']);
  assert.equal(result.report.findings[0].factors.severity.value, 0, 'a settled negative is preserved');
  assert.equal(result.report.findings[0].factors.necessity.value, 0, 'unknown counts as level0');
  assert.equal(result.grading.decisions.length, 10);
  assert.equal(validateReport(result.report, f.snapshot).decision, 'auto_approve');
}));

test('unknown providers and incomplete factor results cannot become an acceptance record', credentials(async () => {
  const f = withFinding();
  await assert.rejects(gradeReport({...f, provider: 'unknown'}), /Unknown/);
  for (const value of [{}, {answers: {}}, {answers: {invented: 'level4'}}]) {
    await assert.rejects(gradeReport({...f, provider: 'deepseek', model: 'deepseek-flash', fetchImpl: async () =>
      ({ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(value)}}]})})}), /Incomplete/);
  }
}));

test('typed packets split by serialized size without losing contracts, evidence or settled grades', credentials(async () => {
  const f = withFinding();
  f.snapshot.sources.head.content = 'literal citation ' + 'x'.repeat(18000);
  const packets = [];
  const result = await gradeReport({...f, provider: 'typesafe', model: 'deepseek-flash', fetchImpl: async (url, options) => {
    assert.ok(url.includes('typesafe'), 'definite answers require no reasoning rerun');
    const packet = JSON.parse(options.body); packets.push(packet);
    assert.ok(JSON.stringify({state: packet.state, questions: packet.questions}).length <= 100000);
    assert.equal(packet.state.accepted_contract[0].content, f.snapshot.sources.contract.content);
    for (const [id, factor] of Object.entries(packet.state.factors)) {
      const expected = packetFor(locations(f.report).find(item => item.id === id), f.report, f.snapshot);
      assert.deepEqual(factor, expected, 'splitting cannot trim or rewrite evidence');
    }
    const answers = Object.fromEntries(Object.keys(packet.questions).map(id => [id, choice(packet, id, id === 'f0_activation' ? 'level0' : 'level4')]));
    return {ok: true, json: async () => ({model: JEV_MODEL, answers})};
  }});
  assert.ok(packets.length > 1, 'question count alone previously allowed oversized packets');
  const ids = packets.flatMap(packet => Object.keys(packet.questions));
  assert.deepEqual([...ids].sort(), locations(f.report).map(item => item.id).sort());
  assert.equal(new Set(ids).size, ids.length, 'each atomic judgment runs exactly once');
  assert.equal(result.report.findings[0].factors.activation.value, 0, 'a negative survives partitioning');
  assert.equal(result.usage.length, packets.length);
}));

test('one indivisible oversized factor fails before any provider call', credentials(async () => {
  const f = withFinding(); f.snapshot.sources.contract.content = 'x'.repeat(100001);
  let calls = 0;
  await assert.rejects(gradeReport({...f, provider: 'typesafe', fetchImpl: async () => {calls++;}}), /bounded atomic-question packet/);
  assert.equal(calls, 0);
}));
