'use strict';

// GitHub API budget: 403/429/secondary-limit responses are retried with bounded backoff, polling is cheap,
// and an exhausted budget ends in an explicit classified hold, including a 60-PR burst.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pollSchedule, rateLimitDelay, withRateLimit, RateLimitHold, heldReason, headShaOf} = require('./verification-wait.cjs');
const {classify, body, NEXT_STEPS} = require('./incomplete.cjs');
const {createPolicy} = require('./policy.cjs');

const http = (status, headers = {}, message = 'x') => Object.assign(new Error(message), {status, response: {headers}});
const NOW = 1_800_000_000_000;

test('rate-limit responses are recognised from status, retry-after, remaining/reset and secondary-limit messages', () => {
  assert.equal(rateLimitDelay(http(429), NOW), 0);
  assert.equal(rateLimitDelay(http(403, {'retry-after': '7'}), NOW), 7000);
  assert.equal(rateLimitDelay(http(429, {'retry-after': '0'}), NOW), 0);
  assert.equal(rateLimitDelay(http(403, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 90)}), NOW), 90000);
  assert.equal(rateLimitDelay(http(403, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 - 5)}), NOW), 0, 'a reset in the past waits nothing');
  assert.equal(rateLimitDelay(http(403, {'x-ratelimit-remaining': '0'}), NOW), 0, 'no reset header: backoff decides');
  assert.equal(rateLimitDelay(http(403, {}, 'You have exceeded a secondary rate limit.'), NOW), 0);
  assert.equal(rateLimitDelay(http(403, {}, 'API rate limit exceeded for installation'), NOW), 0);
  assert.equal(rateLimitDelay(http(403, {}, 'You have triggered an abuse detection mechanism'), NOW), 0);
  assert.equal(rateLimitDelay(http(403, {}, 'Resource not accessible by integration'), NOW), null, 'a permission error is not a rate limit');
  assert.equal(rateLimitDelay(http(500), NOW), null);
  assert.equal(rateLimitDelay(new Error('plain'), NOW), null);
  assert.equal(rateLimitDelay(undefined, NOW), null);
  assert.equal(rateLimitDelay(Object.assign(new Error('x'), {status: 429}), NOW), 0, 'a response without headers');
});

test('a rate-limited call is retried with exponential backoff, jitter and the server-requested wait, then succeeds', async () => {
  const waits = []; const reports = [];
  const failures = [http(403, {'retry-after': '20'}), http(429), http(403, {}, 'secondary rate limit')];
  let calls = 0;
  const value = await withRateLimit(async () => {calls++; if (failures.length) throw failures.shift(); return 'done';},
    {wait: async ms => waits.push(ms), now: () => NOW, random: () => 0.5, report: line => reports.push(line)});
  assert.equal(value, 'done'); assert.equal(calls, 4);
  assert.deepEqual(waits, [20500, 2500, 4500], 'max(server wait, 2^n s) plus 500 ms jitter');
  assert.equal(reports.length, 3); assert.match(reports[0], /waiting 21 s before retry 1\/7/);
  assert.equal(await withRateLimit(async () => 'quiet', {wait: async () => assert.fail('no wait needed')}), 'quiet', 'defaults need no clock');
});

test('a wait beyond the budget or too many attempts ends in an explicit hold naming the reset time', async () => {
  const reset = String(NOW / 1000 + 3600);
  await assert.rejects(withRateLimit(async () => {throw http(403, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset});},
    {wait: async () => assert.fail('must not sleep for an hour'), now: () => NOW, random: () => 0}), error => {
    assert.ok(error instanceof RateLimitHold); assert.equal(error.code, 'RATE_LIMIT'); assert.equal(error.resetAt, NOW + 3600000);
    assert.equal(heldReason(error), `Held: GitHub API rate limit, will retry after ${new Date(NOW + 3600000).toISOString()}.`);
    return true;
  });
  let calls = 0; const waits = [];
  await assert.rejects(withRateLimit(async () => {calls++; throw http(429);}, {wait: async ms => waits.push(ms), now: () => NOW, random: () => 0, maxWaitMs: 10 ** 9}), RateLimitHold);
  assert.equal(calls, 8, 'bounded attempts'); assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 32000, 60000]);
  const other = http(500);
  await assert.rejects(withRateLimit(async () => {throw other;}, {wait: async () => assert.fail('not a rate limit')}), error => error === other);
});

test('verification polling backs off while nothing is running and resets when it runs', () => {
  const schedule = pollSchedule(900);
  assert.deepEqual([1, 2, 3, 4, 5].map(() => schedule('queued').delay), [15000, 30000, 60000, 120000, 120000]);
  assert.deepEqual(schedule('running'), {stalled: false, delay: 15000});
  assert.equal(schedule('absent').delay, 15000, 'running resets the backoff');
  let polls = 0; const idle = pollSchedule(900);
  while (!idle('queued').stalled) polls++;
  assert.equal(polls, 10, 'a 15 minute grace costs 10 requests instead of 60');
  assert.equal(pollSchedule(0)('queued').stalled, true);
});

test('an exhausted budget is a classified hold whose visible notice names the cause and the retry time', () => {
  const hold = new RateLimitHold(NOW);
  const classified = classify(hold);
  assert.equal(classified.cause, 'github_rate_limit');
  assert.equal(classified.reason, heldReason(hold));
  const notice = body({number: 1, head_sha: 'a'.repeat(40), ...classified}, 'https://github.com/o/r/actions/runs/1');
  assert.match(notice, /Held: GitHub API rate limit, will retry after 2027-/);
  assert.ok(notice.includes(NEXT_STEPS.github_rate_limit));
});

const config = require('../test/fixtures/config.json');
const SHA = 'a'.repeat(40);
const context = {repo: {owner: 'example', repo: 'gateway'}, eventName: 'pull_request_target', payload: {pull_request: {number: 3, head: {sha: SHA}}}};
function burst(pending) {
  const calls = {etags: []};
  const pr = {number: 3, state: 'open', draft: false, head: {sha: SHA, ref: 'f', repo: {id: 1}}, base: {sha: 'b'.repeat(40), ref: 'main'}, user: {login: 'c'}};
  let limit = null;
  const github = {rest: {
    pulls: {get: async () => {if (limit) throw limit(); return {data: pr};}},
    actions: {listWorkflowRuns: async args => {
      calls.etags.push(args.headers?.['if-none-match']);
      if (limit) throw limit();
      if (args.headers?.['if-none-match'] === '"v1"') throw http(304);
      return {headers: {etag: '"v1"'}, data: {workflow_runs: [{id: 9, head_sha: SHA, status: pending, conclusion: null, pull_requests: [{number: 3}], html_url: 'u'}]}};
    }},
  }};
  return {github, calls, setLimit: fn => {limit = fn;}};
}

test('the wait loop sends conditional requests and survives a rate limit, then holds when the budget stays exhausted', async () => {
  const policy = createPolicy(config);
  const info = []; const outputs = {};
  const core = {info: line => info.push(line), setOutput: (name, value) => {outputs[name] = value;}};
  // Conditional requests: after the first answer every poll is a 304 served from the cache.
  const quiet = burst('queued');
  const waits = [];
  const stalled = await policy.awaitVerification({github: quiet.github, context, core, expectedHead: SHA, wait: async ms => waits.push(ms), queuedGraceSeconds: 100});
  assert.equal(stalled.pending, true); assert.equal(outputs.verified, 'false');
  assert.deepEqual(quiet.calls.etags, [undefined, '"v1"', '"v1"', '"v1"'], 'only the first request is unconditional');
  assert.deepEqual(waits, [15000, 30000, 60000]);
  // A transient 403 is waited out inside the loop and never aborts it.
  let thrown = 0; const flakyWaits = [];
  const flaky = {rest: {
    pulls: {get: async () => {if (thrown < 2) {thrown++; throw http(403, {'retry-after': '1'});} return {data: {number: 3, state: 'open', draft: false, head: {sha: SHA, ref: 'f', repo: {id: 1}}, base: {ref: 'main'}}};}},
    actions: {listWorkflowRuns: async () => ({headers: {}, data: {workflow_runs: [{id: 9, head_sha: SHA, status: 'completed', conclusion: 'failure', pull_requests: [{number: 3}], html_url: 'u'}]}})}}};
  assert.match((await policy.awaitVerification({github: flaky, context, core, expectedHead: SHA, wait: async ms => flakyWaits.push(ms)})).failure, /concluded failure/);
  assert.equal(flakyWaits.length, 2, 'two rate limits were waited out before the real answer');
  // An exhausted budget ends in an explicit hold, not a crash.
  const spent = burst('queued');
  spent.setLimit(() => http(403, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3000)}));
  const held = await policy.awaitVerification({github: spent.github, context, core, expectedHead: SHA, wait: async () => assert.fail('no sleeping for the reset')});
  assert.equal(held.state, 'rate_limited'); assert.equal(outputs.verified, 'false');
  assert.ok(info.some(line => /Held: GitHub API rate limit, will retry after/.test(line)));
  assert.match(held.retry_after, /^\d{4}-/);
  const assessed = await policy.assessWhenReady({github: spent.github, context, wait: async () => assert.fail('no sleeping')});
  assert.equal(assessed.decision, 'review_incomplete'); assert.equal(assessed.cause, 'github_rate_limit');
  assert.match(assessed.reason, /^Held: GitHub API rate limit, will retry after /);
  assert.equal(assessed.head_sha, SHA);
  const dispatch = {...context, payload: {}};
  assert.equal((await policy.assessWhenReady({github: spent.github, context: {...dispatch, payload: {pull_request: {number: 3}}}, wait: async () => {}})).head_sha, '');
});

test('a 60-PR burst fits the shared hourly budget and never produces a crash', async () => {
  const BUDGET = 1000; let used = 0;
  const reviews = Array.from({length: 60}, (_, index) => {
    const policy = createPolicy(config);
    const sha = String(index).padStart(40, '0');
    const github = {rest: {
      pulls: {get: async () => {if (++used > BUDGET) throw http(403, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3000)}, 'API rate limit exceeded for installation'); return {data: {number: index + 1, state: 'open', draft: false, head: {sha, ref: 'f', repo: {id: 1}}, base: {ref: 'main'}}};}},
      actions: {listWorkflowRuns: async args => {
        if (++used > BUDGET) throw http(403, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3000)}, 'API rate limit exceeded for installation');
        if (args.headers?.['if-none-match']) { used--; throw http(304); }
        return {headers: {etag: '"e"'}, data: {workflow_runs: []}};
      }}}};
    return {policy, github, sha, index};
  });
  const outcomes = await Promise.all(reviews.map(async ({policy, github, sha, index}) => {
    const outputs = {};
    const result = await policy.awaitVerification({github, context: {repo: context.repo, eventName: 'pull_request_target', payload: {pull_request: {number: index + 1}}}, core: {info() {}, setOutput: (n, v) => {outputs[n] = v;}}, expectedHead: sha, wait: async () => {}});
    return {result, outputs};
  }));
  assert.ok(outcomes.every(item => item.outputs.verified === 'false'), 'every review ended in a defined state');
  assert.ok(used <= BUDGET + 60, `60 PRs used ${used} requests (before: 60 x 120 polls x 2 requests)`);
  assert.equal(outcomes.filter(item => item.result.state === 'rate_limited').length, 0, 'conditional polling keeps the burst inside the budget');
});

test('a raw rate-limit error that escapes the wrapper is classified as the same hold', () => {
  const reset = Math.floor(Date.now() / 1000) + 1800;
  const withReset = classify(http(403, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset)}, 'API rate limit exceeded for installation'));
  assert.equal(withReset.cause, 'github_rate_limit');
  assert.equal(withReset.reason, `Held: GitHub API rate limit, will retry after ${new Date(reset * 1000).toISOString()}.`);
  const without = classify(http(429));
  assert.equal(without.cause, 'github_rate_limit');
  assert.match(without.reason, /^Held: GitHub API rate limit, will retry after 20\d\d-/);
  assert.equal(classify(http(403, {}, 'Resource not accessible by integration')).cause, 'evidence_incomplete');
});

test('the head named by the event is used, and a manual dispatch names none; other errors are never swallowed as rate limits', async () => {
  assert.equal(headShaOf({payload: {pull_request: {head: {sha: SHA}}}}), SHA);
  assert.equal(headShaOf({payload: {pull_request: {}}}), '');
  assert.equal(headShaOf({payload: {}}), '');
  const policy = createPolicy(config);
  const broken = {rest: {pulls: {get: async () => {throw new Error('boom');}}}};
  await assert.rejects(policy.assessWhenReady({github: broken, context, wait: async () => {}}), /boom/);
});
