'use strict';
// When an assessment last listed the pull request's comments, as the packaged assess step records it (stale-assessment.cjs).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {watchCommentReads} = require('./stale-assessment.cjs');

function client() {
  const before = [];
  return {hook: {before: (name, fn) => {assert.equal(name, 'request'); before.push(fn);}}, send: options => before.forEach(fn => fn(options))};
}

test('the stamp is the first request of the last comment listing, and nothing else moves it', () => {
  const c = client(); let clock = 0;
  const read = watchCommentReads(c, () => new Date(Date.UTC(2026, 10, 12, 14, 0, ++clock)));
  assert.equal(read(), null, 'no listing yet');
  c.send({method: 'GET', url: '/repos/{owner}/{repo}/issues/{issue_number}/comments', issue_number: 3, per_page: 100});
  assert.equal(read(), '2026-11-12T14:00:01.000Z');
  // Later pages of the same listing, other endpoints and writes do not move it.
  c.send({method: 'GET', url: 'https://api.github.com/repositories/1/issues/3/comments?per_page=100&page=2'});
  c.send({method: 'GET', url: '/repos/{owner}/{repo}/issues/{issue_number}/comments', page: 3});
  c.send({method: 'GET', url: '/repos/{owner}/{repo}/pulls/{pull_number}'});
  c.send({method: 'POST', url: '/repos/{owner}/{repo}/issues/{issue_number}/comments'});
  c.send({method: 'GET', url: '/repos/{owner}/{repo}/issues/{issue_number}/comments-other'});
  assert.equal(read(), '2026-11-12T14:00:01.000Z');
  // A later listing (another attempt of assessWhenReady) is what the result decided on.
  c.send({method: 'get', url: 'https://api.github.com/repos/o/r/issues/3/comments?per_page=100'});
  assert.equal(read(), '2026-11-12T14:00:02.000Z');
  // The default clock is the real one.
  const real = client(); const stamp = watchCommentReads(real);
  real.send({method: 'GET', url: '/repos/{owner}/{repo}/issues/{issue_number}/comments'});
  assert.ok(Math.abs(Date.parse(stamp()) - Date.now()) < 5000);
});
