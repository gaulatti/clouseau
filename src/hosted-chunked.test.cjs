'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const hosted = require('./hosted-chunked.cjs');
const {validateConfig} = require('./config.cjs');
const {CONFIG} = require('../test/hosted-large-pr.cjs');

test('problem names what is wrong with the protected object', () => {
  for (const value of [null, 'on', [], 3]) assert.equal(hosted.problem(value), 'must be an object');
  assert.equal(hosted.problem({}), 'enabled must be a boolean');
  assert.equal(hosted.problem({enabled: 'yes'}), 'enabled must be a boolean');
  for (const name of ['max_units', 'max_input_tokens']) {
    for (const bad of [0, -1, 1.5, '3', null]) assert.equal(hosted.problem({enabled: true, [name]: bad}), `${name} must be a positive integer`);
  }
  assert.match(hosted.problem({enabled: true, concurrency: 99}), /no larger than the defaults/);
  assert.match(hosted.problem({enabled: true, unknown: 1}), /unknown or malformed/);
  assert.match(hosted.problem({enabled: true, params: {C: 450001, S: 1}}), /params/);
  assert.equal(hosted.problem({enabled: false}), null);
  assert.equal(hosted.problem({enabled: true, max_units: 10 ** 9, max_input_tokens: 10 ** 12, force: true, concurrency: 2}), null);
});

test('settings are off unless a maintainer enables them, and an invalid object never degrades to off', () => {
  assert.equal(hosted.settings(undefined), null);
  assert.equal(hosted.settings({}), null);
  assert.equal(hosted.settings({chunked_hosted: {enabled: false}}), null);
  assert.throws(() => hosted.settings({chunked_hosted: {enabled: 'true'}}), /Invalid protected hosted chunked review configuration: enabled must be a boolean/);
  const defaults = hosted.settings({chunked_hosted: {enabled: true}});
  assert.equal(defaults.max_units, hosted.CAPS.max_units);
  assert.equal(defaults.max_input_tokens, hosted.CAPS.max_input_tokens);
  assert.equal(defaults.force, false);
  assert.deepEqual(defaults.params, {C: 450000, S: 100000});
  const custom = hosted.settings({chunked_hosted: {enabled: true, max_units: 3, max_input_tokens: 9, force: true, concurrency: 1, params: {C: 10, S: 5}}});
  assert.equal(custom.max_units, 3); assert.equal(custom.max_input_tokens, 9); assert.equal(custom.force, true);
  assert.equal(custom.concurrency, 1); assert.deepEqual(custom.params, {C: 10, S: 5});
});

test('the verifier options carry the protected parameters and the recompute hooks, or nothing', () => {
  assert.equal(hosted.verifierOptions({}), null);
  const options = hosted.verifierOptions({chunked_hosted: {enabled: true, params: {C: 1000, S: 500}}});
  assert.deepEqual(options.params, {C: 1000, S: 500});
  for (const name of ['partition', 'unitView', 'seams', 'merge']) assert.equal(typeof options.hooks[name], 'function');
});

test('only the two single-snapshot size limits start a chunked review', () => {
  assert.equal(hosted.oversize(new Error('Complete review evidence exceeds the source budget')), true);
  assert.equal(hosted.oversize(Object.assign(new Error('x'), {unavailable: true, reason: 'size'})), true);
  assert.equal(hosted.oversize(Object.assign(new Error('x'), {unavailable: true, reason: 'text'})), false);
  assert.equal(hosted.oversize(new Error('Changed-file evidence is incomplete')), false);
});

test('the preflight holds before any call and states the estimate', () => {
  const plan = {units: [{cost: 4000}, {cost: 4000}]};
  assert.equal(hosted.preflight(plan, {max_units: 2, max_input_tokens: 4000}), 4000);
  assert.throws(() => hosted.preflight(plan, {max_units: 1, max_input_tokens: 4000}), error =>
    error.code === 'HOSTED_CHUNKED_HELD' && error.cause_code === 'chunked_unit_cap' && /2 review units.*max_units = 1.*4000 input tokens/.test(error.message));
  assert.throws(() => hosted.preflight(plan, {max_units: 2, max_input_tokens: 3999}), error =>
    error.cause_code === 'chunked_token_cap' && /about 4000 input tokens.*max_input_tokens = 3999/.test(error.message));
});

test('the meter charges every request and refuses the one that would cross the cap', () => {
  const charge = hosted.meter({max_input_tokens: 10});
  charge('a'.repeat(20)); charge('a'.repeat(20));
  assert.throws(() => charge('a'.repeat(1)), error => error.cause_code === 'chunked_token_cap' && /after about 10 input tokens/.test(error.message));
});

function provider(replies) {
  const seen = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    seen.push(body);
    const value = replies.shift();
    return {ok: true, json: async () => ({model: body.model, usage: {prompt_tokens: 1},
      choices: [{finish_reason: 'tool_calls', message: {tool_calls: [{function: {name: 'chunked_review_result', arguments: JSON.stringify(value)}}]}}]})};
  };
  return {fetchImpl, seen};
}

test('the hosted ask uses the protected role models, one tool, and records provenance', async () => {
  process.env.DEEPSEEK_API_KEY = 'fictional';
  const {fetchImpl, seen} = provider([{a: 1}, {a: 2}, {a: 3}]);
  const charged = [];
  const ask = hosted.hostedAsk({config: CONFIG.acceptance, charge: prompt => charged.push(prompt.length), fetchImpl, wait: async () => {}});
  const schema = {type: 'object'};
  const first = await ask({role: 'examiner', phase: 'investigation', schema, prompt: 'p1', unit: 'u0'});
  await ask({role: 'challenger', phase: 'integration', schema, prompt: 'p2'});
  await ask({role: 'challenger', phase: 'grading', schema, prompt: 'p3'});
  assert.deepEqual(seen.map(body => body.model), ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-flash']);
  assert.deepEqual(Object.keys(seen[0].tools.map(tool => tool.function.parameters)), ['0']);
  assert.equal(seen[0].messages.length, 1);
  assert.deepEqual(charged, [2, 2, 2]);
  assert.deepEqual(first.value, {a: 1});
  assert.equal(first.provenance.provider, 'deepseek'); assert.equal(first.provenance.requested_model, 'deepseek-flash');
  assert.equal(first.provenance.role, 'examiner'); assert.equal(first.provenance.phase, 'investigation'); assert.equal(first.provenance.attempts, 1);
  assert.match(first.provenance.request_digest, /^[a-f0-9]{64}$/);
});

test('a reply that fails its own check is asked again with the same prompt, twice at most, and the cap is charged each time', async () => {
  process.env.DEEPSEEK_API_KEY = 'fictional';
  const logs = []; const charged = []; const observed = [];
  const check = value => {if (value.a !== 3) throw new Error('Invalid acceptance evidence: wrong shape');};
  const {fetchImpl, seen} = provider([{a: 1}, {a: 2}, {a: 3}]);
  const ask = hosted.hostedAsk({config: CONFIG.acceptance, charge: prompt => charged.push(prompt), fetchImpl, wait: async () => {}, log: line => logs.push(line),
    observe: item => observed.push(item)});
  const done = await ask({role: 'examiner', phase: 'investigation', schema: {}, prompt: 'same', check, unit: 'u1'});
  assert.equal(done.provenance.attempts, 3);
  assert.deepEqual(charged, ['same', 'same', 'same']);
  assert.equal(seen.length, 3);
  assert.ok(logs.some(line => /Chunked reviewer output invalid .* retry 1\/2/.test(line)));
  assert.deepEqual(observed.map(item => [item.unit, item.attempt]), [['u1', 1], ['u1', 2], ['u1', 3]]);
  const bad = provider([{a: 1}, {a: 1}, {a: 1}]);
  await assert.rejects(hosted.hostedAsk({config: CONFIG.acceptance, charge() {}, fetchImpl: bad.fetchImpl, wait: async () => {}})(
    {role: 'examiner', phase: 'grading', schema: {}, prompt: 'p', check}), /Invalid acceptance evidence/);
  assert.equal(bad.seen.length, 3);
});

test('hosted chunked configuration is validated with the protected acceptance object', () => {
  const base = {...CONFIG, acceptance: {...CONFIG.acceptance}};
  assert.doesNotThrow(() => validateConfig(base));
  assert.doesNotThrow(() => validateConfig({...base, acceptance: {...base.acceptance, chunked_hosted: {enabled: true, max_units: 8}}}));
  assert.doesNotThrow(() => validateConfig({...base, acceptance: {...base.acceptance, grader: 'typesafe', chunked_hosted: {enabled: false}}}));
  assert.throws(() => validateConfig({...base, acceptance: {...base.acceptance, chunked_hosted: {enabled: 1}}}), /Invalid hosted chunked review configuration: enabled must be a boolean/);
  assert.throws(() => validateConfig({...base, acceptance: {...base.acceptance, chunked_hosted: {enabled: true, max_units: 0}}}), /max_units must be a positive integer/);
  assert.throws(() => validateConfig({...base, acceptance: {...base.acceptance, grader: 'routed', chunked_hosted: {enabled: true}}}), /deepseek grader only/);
  assert.throws(() => validateConfig({...base, acceptance: {...base.acceptance, extra: 1}}), /Invalid Clouseau acceptance configuration/);
  assert.equal(validateConfig(base).acceptance.chunked_hosted, undefined);
});
