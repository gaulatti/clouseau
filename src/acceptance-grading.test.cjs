'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {locations, packetFor, bounds, gradeReport} = require('./acceptance-grading.cjs');
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

test('typed grading uncertainty is preserved and confidence never substitutes for proof', () => {
  assert.deepEqual(bounds('level3'), {min: 0.75, max: 0.75});
  assert.deepEqual(bounds('unknown'), {min: 0, max: 1});
  assert.throws(() => bounds('pass'), /Invalid/);
  for (const answer of [
    {choice: 'unknown', confidence: 1, probabilities: {}},
    {choice: 'level4', confidence: 0.5, probabilities: {unknown: 0}},
    {choice: 'level4', confidence: 1, probabilities: {unknown: 0.1}},
  ]) assert.deepEqual(bounds(answer), {min: 0, max: 1});
  assert.deepEqual(bounds({choice: 'level4', confidence: 0.95, probabilities: {level4: 0.97, level3: 0.03, unknown: 0}}), {min: 0.75, max: 1});
  assert.throws(() => bounds({choice: 'level4', confidence: 1, probabilities: {level4: 0.001, unknown: 0}}), /no supported/);
});

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
    assert.equal(validateReport(result.report, f.snapshot).decision, 'auto_approve');
    assert.equal(result.usage.length, requests.length);
    assert.notEqual(result.report, f.report);
  }
}));

test('partial causal proof remains a potentially blocking upper bound after grading', credentials(async () => {
  const f = fixture(); f.report.findings.push(finding());
  const result = await gradeReport({...f, provider: 'deepseek', model: 'deepseek-flash', fetchImpl: async (_, options) => {
    const packet = JSON.parse(JSON.parse(options.body).messages[1].content);
    const answers = Object.fromEntries(Object.keys(packet.questions).map(id => [id,
      id.includes('_excess_') ? 'level0' : id === 'f0_confidence' ? 'level2' : 'level4']));
    return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers})}}]})};
  }});
  assert.deepEqual([result.report.findings[0].factors.confidence.min, result.report.findings[0].factors.confidence.max], [0.5, 1]);
  assert.equal(validateReport(result.report, f.snapshot).decision, 'review_incomplete');
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
  assert.equal(result.report.units[0].fit.outcome.max, 0, 'a decisive low grade cannot be sent to another model until it passes');
  assert.equal(result.report.units[0].need.value.min, 1);
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
