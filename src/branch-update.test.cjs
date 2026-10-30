'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {surface, baseOnlyMoved, MARKER} = require('./branch-update.cjs');

const head = 'a'.repeat(40), base = 'b'.repeat(40), moved = 'c'.repeat(40);
const assessment = {number: 4, head_sha: head, base_sha: base};
const pr = {number: 4, state: 'open', draft: false, head: {sha: head}, base: {ref: 'main', sha: moved}};

function client(comments = []) {
  const created = [];
  const github = {rest: {repos: {getBranch: async () => ({data: {commit: {sha: moved}}})},
    issues: {listComments: async () => ({data: comments}), createComment: async args => {created.push(args); comments.push({user: {login: 'github-actions[bot]'}, body: args.body});}}}};
  github.paginate = async (method, args) => (await method(args)).data;
  return {github, created};
}

test('only the base differing on the same open head is a base move', () => {
  assert.equal(baseOnlyMoved(pr, assessment, 'main'), true);
  for (const change of [{state: 'closed'}, {draft: true}, {head: {sha: moved}}, {base: {ref: 'other', sha: moved}}, {base: {ref: 'main', sha: base}}]) {
    assert.equal(baseOnlyMoved({...pr, ...change}, assessment, 'main'), false);
  }
});

test('a moved base fails closed with one explicit secret-free needs-branch-update comment per head and base', async () => {
  const {github, created} = client();
  const repo = {owner: 'example', repo: 'product'};
  const error = await surface({github, repo, pr, assessment, baseBranch: 'main'});
  assert.match(error.message, /^Needs branch update: main moved after approval/);
  assert.equal(created.length, 1);
  assert.equal(created[0].issue_number, 4);
  assert.ok(created[0].body.startsWith(`<!-- ${MARKER}:${head}:${moved} -->\n`));
  assert.match(created[0].body, /update-branch 4/);
  assert.match(created[0].body, /Re-running the failed job cannot succeed/);
  assert.match(created[0].body, /local review again on the new head/);
  assert.ok(created[0].body.includes(base.slice(0, 12)) && created[0].body.includes(moved.slice(0, 12)));
  await surface({github, repo, pr, assessment, baseBranch: 'main'});
  assert.equal(created.length, 1, 'a rerun updates nothing and never spams the PR');
  const next = {...assessment, head_sha: 'd'.repeat(40)};
  await surface({github, repo, pr, assessment: next, baseBranch: 'main'});
  assert.equal(created.length, 2, 'a new head receives its own notice');
});
