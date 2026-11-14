'use strict';
// When an assessment last listed the pull request's comments, on GitHub's clock, as the packaged assess step records it.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {watchCommentReads} = require('./stale-assessment.cjs');

function client() {
  const after = [];
  return {hook: {after: (name, fn) => {assert.equal(name, 'request'); after.push(fn);}},
    send: (options, date) => after.forEach(fn => fn({headers: date === undefined ? {} : {date}}, options))};
}

test('the stamp is GitHub\'s date for the first response of the last comment listing, and nothing else moves it', () => {
  const c = client(); const read = watchCommentReads(c);
  assert.equal(read(), null, 'no listing yet');
  c.send({method: 'GET', url: '/repos/{owner}/{repo}/issues/{issue_number}/comments', issue_number: 3}, 'Thu, 12 Nov 2026 14:00:01 GMT');
  assert.equal(read(), '2026-11-12T14:00:01.000Z');
  // Later pages of the same listing, other endpoints and writes do not move it.
  c.send({method: 'GET', url: 'https://api.github.com/repositories/1/issues/3/comments?per_page=100&page=2'}, 'Thu, 12 Nov 2026 14:00:09 GMT');
  c.send({method: 'GET', url: '/repos/{owner}/{repo}/issues/{issue_number}/comments', page: 3}, 'Thu, 12 Nov 2026 14:00:09 GMT');
  c.send({method: 'GET', url: '/repos/{owner}/{repo}/pulls/{pull_number}'}, 'Thu, 12 Nov 2026 14:00:09 GMT');
  c.send({method: 'POST', url: '/repos/{owner}/{repo}/issues/{issue_number}/comments'}, 'Thu, 12 Nov 2026 14:00:09 GMT');
  c.send({method: 'GET', url: '/repos/{owner}/{repo}/issues/{issue_number}/comments-other'}, 'Thu, 12 Nov 2026 14:00:09 GMT');
  assert.equal(read(), '2026-11-12T14:00:01.000Z');
  // A later listing (another attempt of assessWhenReady) is what the result decided on.
  c.send({method: 'get', url: 'https://api.github.com/repos/o/r/issues/3/comments?per_page=100'}, 'Thu, 12 Nov 2026 14:02:00 GMT');
  assert.equal(read(), '2026-11-12T14:02:00.000Z');
  // A last listing without a usable date leaves no stamp: the gate then never calls an assessment stale.
  c.send({method: 'GET', url: '/repos/{owner}/{repo}/issues/{issue_number}/comments'});
  assert.equal(read(), null);
  c.send({method: 'GET', url: '/repos/{owner}/{repo}/issues/{issue_number}/comments'}, 'not a date');
  assert.equal(read(), null);
});
