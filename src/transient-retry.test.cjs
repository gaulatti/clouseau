'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {DELAYS_MS, TransientExhausted, isTransient, retryTransient} = require('./transient-retry.cjs');

const HEAD = 'a'.repeat(40);
const http = (status, message = 'failure', headers = {}) => Object.assign(new Error(message), {status, response: {headers}});

test('only transient GitHub failures are classified as retryable', () => {
  assert.deepEqual([...DELAYS_MS], [2000, 6000, 15000]);
  const blip = 'Something went wrong while executing your query. Please include `EC12:AAAA` when reporting this issue.';
  for (const error of [new Error(blip), Object.assign(new Error('Request failed'), {errors: [{message: blip}]}),
    Object.assign(new Error('Request failed'), {errors: [{}, {message: 'Timed out'}]}), http(500), http(502), http(599),
    http(403, 'You have exceeded a secondary rate limit', {'retry-after': '60'}), http(429, 'slow down')]) {
    assert.equal(isTransient(error), true, error.message);
  }
  for (const error of [new Error('Pull request is not mergeable'), Object.assign(new Error('x'), {errors: [{type: 'UNPROCESSABLE', message: 'Auto merge is not allowed'}]}),
    Object.assign(new Error('x'), {errors: []}), http(400), http(401), http(403, 'Resource not accessible by integration'), http(404), http(422, 'Validation Failed'),
    http(600), http(429, 'primary limit', {'retry-after': '61'}), http(403, 'rate limit', {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999'}),
    null, undefined, {}, Object.assign(new Error(blip), {status: 422})]) {
    assert.equal(isTransient(error), false, String(error?.message));
  }
});

test('the call is retried after each delay, receives its attempt number and succeeds as soon as GitHub does', async () => {
  const waits = []; const reports = []; const seen = [];
  const result = await retryTransient(async attempt => {
    seen.push(attempt);
    if (attempt < 3) throw http(502, 'Bad gateway');
    return 'done';
  }, {operation: 'enabling auto-merge', head: HEAD, wait: async ms => {waits.push(ms);}, report: message => reports.push(message)});
  assert.equal(result, 'done');
  assert.deepEqual(seen, [0, 1, 2, 3]);
  assert.deepEqual(waits, [2000, 6000, 15000]);
  assert.equal(reports.length, 3);
  assert.match(reports[2], /retry 3\/3 in 15 s/);
});

test('exhaustion names the accepted head, the attempts and the safe retry without leaking an address or the raw error object', async () => {
  const error = http(503, 'Service   unavailable for @someone\n' + 'x'.repeat(400));
  await assert.rejects(retryTransient(async () => {throw error;}, {operation: 'submitting the approval', head: HEAD, wait: async () => {}}), caught => {
    assert.ok(caught instanceof TransientExhausted);
    assert.equal(caught.code, 'TRANSIENT_GITHUB'); assert.equal(caught.attempts, 4);
    assert.match(caught.message, new RegExp(`review of head ${HEAD} was already accepted`));
    assert.match(caught.message, /submitting the approval \(4 attempts; last HTTP 503: Service unavailable for someone/);
    assert.match(caught.message, /Retrying it is safe and does not repeat the AI review/);
    assert.ok(!caught.message.includes('@'));
    assert.ok(caught.message.length < 700);
    return true;
  });
  await assert.rejects(retryTransient(async () => {throw {status: 500};}, {operation: 'op', head: HEAD, wait: async () => {}, delays: []}),
    /1 attempts; last HTTP 500: \)/);
  await assert.rejects(retryTransient(async () => {throw new Error('Something went wrong while executing your query');},
    {operation: 'op', head: HEAD, wait: async () => {}, delays: []}), /1 attempts; last GraphQL error: Something went wrong/);
});

test('a non-transient failure is rethrown unchanged on the first attempt without waiting', async () => {
  const error = http(422, 'Validation Failed');
  let calls = 0;
  await assert.rejects(retryTransient(async () => {calls++; throw error;}, {operation: 'op', head: HEAD, wait: async () => assert.fail('must not wait')}), caught => caught === error);
  assert.equal(calls, 1);
});

test('the default wait is real time and the default report is silent', async () => {
  const started = Date.now();
  let calls = 0;
  await retryTransient(async () => {if (++calls === 1) throw http(500);}, {operation: 'op', head: HEAD, delays: [5]});
  assert.equal(calls, 2);
  assert.ok(Date.now() - started >= 4);
});
