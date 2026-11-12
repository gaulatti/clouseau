'use strict';
// The read retry every packaged github-script step installs (src/github-retry.cjs), on a client shaped like Octokit's
// `hook.wrap('request', (request, options) => ...)`.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {install} = require('./github-retry.cjs');

const unavailable = () => Object.assign(new Error('Service Unavailable'), {status: 503});
function client(respond) {
  const wrappers = []; const sent = [];
  const raw = async options => {sent.push(`${options.method} ${options.url}`); return respond(options, sent.length);};
  const github = {hook: {wrap: (name, fn) => {assert.equal(name, 'request'); wrappers.push(fn);}},
    request: options => wrappers.reduce((next, fn) => opts => fn(next, opts), raw)(options)};
  return {github, sent, wrappers};
}
const options = {wait: async ms => {waits.push(ms);}, report: line => {lines.push(line);}};
let waits = []; let lines = [];
const reset = () => {waits = []; lines = [];};

test('a read that GitHub answers with HTTP 5xx is retried with the shared backoff and then succeeds', async () => {
  reset();
  const c = client((_, count) => {if (count <= 2) throw unavailable(); return {status: 200, data: {number: 84}};});
  install(c.github, options);
  assert.deepEqual((await c.github.request({method: 'GET', url: '/repos/{owner}/{repo}/pulls/{pull_number}'})).data, {number: 84});
  assert.equal(c.sent.length, 3); assert.deepEqual(waits, [2000, 6000]);
  assert.match(lines[0], /^GitHub answered GET \/repos\/\{owner\}\/\{repo\}\/pulls\/\{pull_number\} with HTTP 503; retry 1\/3 in 2 s\.$/);
  // HEAD repeats safely too, and a network failure without a status (GraphQL-style wording) counts as transient.
  reset();
  const head = client((_, count) => {if (count === 1) throw new Error('Something went wrong while executing your query'); return {status: 200};});
  install(head.github, options);
  await head.github.request({method: 'head', url: '/x'});
  assert.equal(head.sent.length, 2); assert.match(lines[0], /with a transient error/);
});

test('a read that keeps failing ends with the original error after the bounded retries', async () => {
  reset();
  const c = client(() => {throw unavailable();});
  install(c.github, options);
  await assert.rejects(c.github.request({method: 'GET', url: '/x'}), error => error.status === 503 && error.message === 'Service Unavailable');
  assert.equal(c.sent.length, 4); assert.deepEqual(waits, [2000, 6000, 15000]);
});

test('a short rate limit waits at least as long as GitHub asks', async () => {
  reset();
  const limited = () => Object.assign(new Error('secondary rate limit'), {status: 403, response: {headers: {'retry-after': '9'}}});
  const c = client((_, count) => {if (count === 1) throw limited(); return {status: 200};});
  install(c.github, options);
  await c.github.request({method: 'GET', url: '/x'});
  assert.deepEqual(waits, [9000]);
});

test('writes and deterministic failures are never retried here, and installing twice wraps once', async () => {
  reset();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const c = client(() => {throw unavailable();});
    install(c.github, options);
    await assert.rejects(c.github.request({method, url: '/x'}), /Service Unavailable/);
    assert.equal(c.sent.length, 1, `${method} is left to its own handling`);
  }
  const missing = client(() => {throw Object.assign(new Error('Not Found'), {status: 404});});
  install(missing.github, options);
  await assert.rejects(missing.github.request({method: 'GET', url: '/x'}), /Not Found/);
  assert.equal(missing.sent.length, 1); assert.deepEqual(waits, []);
  const twice = client(() => ({status: 200}));
  assert.equal(install(install(twice.github, options), options), twice.github);
  assert.equal(twice.wrappers.length, 1);
  // The default wait and report are real timers and a no-op.
  const real = client((_, count) => {if (count === 1) throw unavailable(); return {status: 200};});
  install(real.github, {delays: [1]});
  await real.github.request({method: 'GET', url: '/x'});
  assert.equal(real.sent.length, 2);
});
