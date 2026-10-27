'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {locations, packetFor, grade, authorityBounds, gradeReport} = require('./acceptance-grading.cjs');
const {RUBRICS} = require('./acceptance-rubrics.cjs');
const {FACTORS, validateReport} = require('./acceptance.cjs');
const {JEV_MODEL} = require('./review-provider.cjs');
const {fixture, finding} = require('../test/fixtures/acceptance.cjs');

function credentials(run) {return async () => {
  const names = ['DEEPSEEK_API_KEY', 'TYPESAFE_API_KEY']; const old = names.map(name => process.env[name]);
  names.forEach(name => {process.env[name] = 'fictional-only';});
  try {await run();} finally {names.forEach((name, i) => {if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i];});}
};}

test('every formula input has its own five descriptive semantic anchors', () => {
  for (const [group, names] of Object.entries(FACTORS)) {
    assert.deepEqual(Object.keys(RUBRICS[group]), names);
    for (const levels of Object.values(RUBRICS[group])) {
      assert.equal(levels.length, 5); assert.equal(new Set(levels).size, 5);
      assert.ok(levels.every(level => typeof level === 'string' && level.length > 10));
    }
  }
  const {report, snapshot} = fixture(); report.findings.push(finding());
  const values = locations(report);
  assert.equal(values.length, 25);
  const packet = packetFor(values[0], report, snapshot);
  assert.equal(packet.subject, 'Validate before acceptance');
  assert.equal(packet.evidence[0].text, 'validate(input)?;\naccept_durably(input)');
  assert.equal(packet.evidence[0].authority, 'untrusted');
  assert.equal(packet.context.kind, 'capability');
  const causal = values.find(item => item.id === 'f0_confidence');
  causal.target.evidence = ['contract'];
  const proof = packetFor(causal, report, snapshot);
  assert.equal(proof.context.cause, report.findings[0].cause);
  assert.ok(proof.evidence.some(item => item.path === 'src/upload.rs'), 'causal source proof accompanies every defect factor even if its observation cites only a contract');
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

test('source authority is a controller fact, so untrusted requests and runtime receipts cannot acquire positive binding grades', credentials(async () => {
  for (const [authority, kind] of [['untrusted', 'contract'], ['trusted', 'verification'], ['untrusted', 'source']]) {
    const f = fixture(); Object.assign(f.snapshot.sources.contract, {authority, kind});
    const result = await gradeReport({...f, provider: 'deepseek', model: 'deepseek-flash', fetchImpl: async (_, options) => {
      const packet = JSON.parse(JSON.parse(options.body).messages[1].content);
      assert.ok(!Object.hasOwn(packet.questions, 'u0_need_binding'), 'a model cannot promote known non-contract authority');
      return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers:
        Object.fromEntries(Object.keys(packet.questions).map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))})}}]})};
    }});
    assert.equal(result.report.units[0].need.binding.value, 0);
    assert.match(result.report.units[0].need.binding.reason, /no trusted contract authority/);
    assert.equal(result.grading.decisions.find(item => item.id === 'u0_need_binding').provider, 'controller');
    assert.equal(validateReport(result.report, f.snapshot).decision, 'auto_approve', 'demonstrated need can pass through the unchanged non-binding formula');
  }
}));

test('authority constraints preserve negative product judgments and correct only impossible binding credit', credentials(async () => {
  const f = fixture(); f.report.units[0].need.binding.evidence = ['source'];
  f.report.units[0].need.binding.value = 0.5;
  const before = structuredClone(f.report);
  assert.equal(authorityBounds(f.report, f.snapshot).length, 1);
  assert.equal(f.report.units[0].need.binding.value, 0);
  for (const group of ['fit', 'excess']) assert.deepEqual(f.report.units[0][group], before.units[0][group]);
  const result = await gradeReport({...f, provider: 'deepseek', model: 'deepseek-flash', fetchImpl: async (_, options) => {
    const packet = JSON.parse(JSON.parse(options.body).messages[1].content);
    return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers:
      Object.fromEntries(Object.keys(packet.questions).map(id => [id,
        id === 'u0_need_evidence' ? 'level1' : id.includes('_excess_') ? 'level0' : 'level4']))})}}]})};
  }});
  assert.equal(validateReport(result.report, f.snapshot).units[0].need, 25);
  assert.equal(validateReport(result.report, f.snapshot).decision, 'auto_approve', 'unit scores are informational');
}));

test('the DeepSeek-only grader and Jev consume the same atomic evidence without doing arithmetic', credentials(async () => {
  const f = fixture();
  for (const provider of ['deepseek', 'typesafe']) {
    const requests = [];
    const result = await gradeReport({...f, provider, model: 'deepseek-flash', fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      const packet = provider === 'typesafe' ? body : JSON.parse(body.messages[1].content);
      requests.push(packet);
      const answers = Object.fromEntries(Object.keys(packet.questions).map(id => {
        const choice = id.includes('_excess_') ? 'level0' : 'level4';
        return [id, provider === 'deepseek' ? choice : {type: 'choice', choice,
          probabilities: Object.fromEntries(Object.keys(packet.questions[id].criteria).map(key => [key, key === choice ? 1 : 0])), confidence: 1}];
      }));
      return {ok: true, status: 200, json: async () => provider === 'typesafe' ? {model: JEV_MODEL, answers} :
        {choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers})}}]}};
    }});
    assert.equal(requests.length, provider === 'typesafe' ? 2 : 1, 'typed-model packets hold at most twelve atomic questions');
    assert.ok(requests.every(packet => Object.values(packet.questions).every(question => question.type === 'choice')));
    assert.ok(requests.every(packet => packet.state.acceptance_policy.includes('within that outcome')),
      'the grader receives the same inherited-supporting-work policy as investigators');
    assert.equal(validateReport(result.report, f.snapshot).decision, 'auto_approve');
    assert.equal(result.usage.length, requests.length);
    assert.notEqual(result.report, f.report);
  }
}));

test('partial causal proof lowers the single finding score instead of leaving a range', credentials(async () => {
  const f = fixture(); f.report.findings.push(finding());
  const result = await gradeReport({...f, provider: 'deepseek', model: 'deepseek-flash', fetchImpl: async (_, options) => {
    const packet = JSON.parse(JSON.parse(options.body).messages[1].content);
    const answers = Object.fromEntries(Object.keys(packet.questions).map(id => [id,
      id.includes('_excess_') ? 'level0' : id === 'f0_confidence' ? 'level2' : 'level4']));
    return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers})}}]})};
  }});
  assert.equal(result.report.findings[0].factors.confidence.value, 0.5);
  const scored = validateReport(result.report, f.snapshot);
  assert.equal(scored.findings[0].score, 50);
  assert.equal(scored.decision, 'auto_approve');
}));

test('task routing delegates only supported typed factors and combines unresolved factors with one reasoning request', credentials(async () => {
  const f = fixture(); f.report.findings.push(finding());
  f.report.units[0].alternative = 'Keep the existing direct validator and regression tests.';
  const requests = [];
  const result = await gradeReport({...f, provider: 'routed', model: 'deepseek-flash', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); const typed = url.includes('typesafe');
    const packet = typed ? body : JSON.parse(body.messages[1].content);
    const ids = Object.keys(packet.questions); requests.push({typed, ids});
    if (typed) {
      assert.deepEqual(ids, ['u0_fit_domain', 'u0_excess_abstraction', 'u0_excess_authority']);
      const answers = Object.fromEntries(ids.map(id => {
        const choice = id === 'u0_excess_authority' ? 'unknown' : 'level4';
        return [id, {type: 'choice', choice, confidence: 1,
          probabilities: Object.fromEntries(Object.keys(packet.questions[id].criteria).map(key => [key, key === choice ? 1 : 0]))}];
      }));
      return {ok: true, json: async () => ({model: JEV_MODEL, answers})};
    }
    assert.ok(ids.includes('u0_excess_authority') && ids.includes('u0_need_binding') && ids.includes('f0_confidence'));
    assert.ok(!ids.includes('u0_excess_abstraction') && !ids.includes('u0_fit_domain'), 'settled delegated answers are never regraded');
    return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers:
      Object.fromEntries(ids.map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))})}}]})};
  }});
  assert.equal(requests.length, 2, 'typed work and reasoning work run once each, without a duplicated baseline');
  assert.deepEqual(result.grading.escalated, ['u0_excess_authority']);
  assert.equal(result.report.units[0].excess.abstraction.value, 1, 'a settled negative is preserved');
  assert.equal(validateReport(result.report, f.snapshot).decision, 'repair_required');
}));

test('hybrid grading sends only unresolved factors to reasoning and never resamples a definite negative', credentials(async () => {
  const f = fixture(); const escalations = [];
  const result = await gradeReport({...f, provider: 'typesafe', model: 'deepseek-flash', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes('typesafe')) {
      const answers = Object.fromEntries(Object.keys(body.questions).map(id => {
        const choice = id === 'u0_fit_outcome' ? 'level0' : id.includes('_excess_') ? 'level0' : 'level4';
        return [id, {type: 'choice', choice, confidence: id === 'u0_need_value' ? 0.62 : 1,
          probabilities: Object.fromEntries(Object.keys(body.questions[id].criteria).map(key => [key, key === choice ? 1 : 0]))}];
      }));
      return {ok: true, json: async () => ({model: JEV_MODEL, answers})};
    }
    const packet = JSON.parse(body.messages[1].content); escalations.push(packet);
    return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content:
      JSON.stringify({answers: Object.fromEntries(Object.keys(packet.questions).map(id => [id, 'level4']))})}}]})};
  }});
  assert.deepEqual(result.grading.escalated, ['u0_need_value']);
  assert.deepEqual(Object.keys(escalations[0].questions), ['u0_need_value']);
  assert.equal(result.report.units[0].fit.outcome.value, 0, 'a decisive low grade cannot be sent to another model until it passes');
  assert.equal(result.report.units[0].need.value.value, 1);
  assert.equal(result.grading.decisions.length, 17);
  assert.ok(!JSON.stringify(escalations).includes('probabilities'), 'the reasoning grader is blind to the other model answer');
}));

test('unknown providers and incomplete factor results cannot become an acceptance record', credentials(async () => {
  const f = fixture();
  await assert.rejects(gradeReport({...f, provider: 'unknown'}), /Unknown/);
  for (const value of [{}, {answers: {}}, {answers: {invented: 'level4'}}]) {
    await assert.rejects(gradeReport({...f, provider: 'deepseek', model: 'deepseek-flash', fetchImpl: async () =>
      ({ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(value)}}]})})}), /Incomplete/);
  }
}));


test('typed packets split by serialized size without losing contracts, evidence or settled grades', credentials(async () => {
  const f = fixture();
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
    const answers = Object.fromEntries(Object.keys(packet.questions).map(id => {
      const choice = id === 'u0_fit_domain' || id.includes('_excess_') ? 'level0' : 'level4';
      return [id, {type: 'choice', choice, confidence: 1,
        probabilities: Object.fromEntries(Object.keys(packet.questions[id].criteria).map(key => [key, key === choice ? 1 : 0]))}];
    }));
    return {ok: true, json: async () => ({model: JEV_MODEL, answers})};
  }});
  assert.ok(packets.length > 2, 'question count alone previously allowed oversized packets');
  const ids = packets.flatMap(packet => Object.keys(packet.questions));
  assert.deepEqual([...ids].sort(), locations(f.report).map(item => item.id).sort());
  assert.equal(new Set(ids).size, ids.length, 'each atomic judgment runs exactly once');
  assert.equal(result.report.units[0].fit.domain.value, 0, 'a negative survives partitioning');
  assert.equal(result.usage.length, packets.length);
}));

test('one indivisible oversized factor fails before any provider call', credentials(async () => {
  const f = fixture(); f.snapshot.sources.contract.content = 'x'.repeat(100001);
  let calls = 0;
  await assert.rejects(gradeReport({...f, provider: 'routed', fetchImpl: async () => {calls++;}}), /bounded atomic-question packet/);
  assert.equal(calls, 0);
}));
