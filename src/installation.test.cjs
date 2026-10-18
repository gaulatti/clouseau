'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {reviewerRef} = require('./installation.cjs');

function setup() {
  const head = 'a'.repeat(40), anchor = 'b'.repeat(40);
  const state = {pr: {number: 20, state: 'open', draft: false, base: {ref: 'main'},
    user: {login: 'owner', type: 'User'}, head: {sha: head, repo: {full_name: 'owner/reviewer'}}},
    comments: [{user: {login: 'owner', type: 'User'}, body: `/approve-intent ${head}`}], anchor,
    comparison: 'identical', anchorReads: 0};
  const github = {rest: {pulls: {get: async () => ({data: state.pr})}, issues: {listComments: {}},
    git: {getRef: async args => {
      state.anchorReads++; assert.equal(args.ref, 'heads/policy-install/pr-20');
      if (state.error) throw state.error;
      return {data: {object: {sha: state.anchor}}};
    }}, repos: {compareCommits: async args => {
      assert.equal(args.base, anchor); assert.equal(args.head, head); return {data: {status: state.comparison}};
    }}}, paginate: async () => state.comments};
  const select = () => reviewerRef({github, context: {repo: {owner: 'owner', repo: 'reviewer'}, payload: {pull_request: {number: 20}}}});
  return {state, select};
}

test('only a ready owner-confirmed internal installation can select its exact candidate revision', async () => {
  for (const comparison of ['identical', 'ahead']) {
    const f = setup(); f.state.comparison = comparison; assert.equal(await f.select(), 'a'.repeat(40));
  }
  for (const mutate of [
    s => {s.pr.state = 'closed';}, s => {s.pr.draft = true;}, s => {s.pr.base.ref = 'other';},
    s => {s.pr.user.login = 'contributor';}, s => {s.pr.user.type = 'Bot';},
    s => {s.pr.head.repo = null;}, s => {s.pr.head.repo.full_name = 'external/fork';},
    s => {s.comments = [];}, s => {s.comments[0].user = null;}, s => {s.comments[0].user.login = 'contributor';},
    s => {s.comments[0].user.type = 'Bot';}, s => {s.comments[0].body = '/approve-intent stale';},
  ]) {
    const f = setup(); mutate(f.state); assert.equal(await f.select(), 'main'); assert.equal(f.state.anchorReads, 0);
  }
});

test('an absent installation uses main, while inaccessible, invalid or divergent prepared references fail closed', async () => {
  let f = setup(); f.state.error = {status: 404}; assert.equal(await f.select(), 'main');
  f = setup(); f.state.error = new Error('GitHub unavailable'); await assert.rejects(f.select(), /unavailable/);
  for (const field of ['anchor', 'head']) {
    f = setup(); if (field === 'anchor') f.state.anchor = 'unbound'; else {
      f.state.pr.head.sha = 'unbound'; f.state.comments[0].body = '/approve-intent unbound';
    }
    await assert.rejects(f.select(), /immutable revisions/);
  }
  for (const status of ['behind', 'diverged']) {
    f = setup(); f.state.comparison = status; await assert.rejects(f.select(), /prepared owner revision/);
  }
});

test('the actual PR workflow selects from main without model credentials and uses the selection for assessment and native approval', () => {
  const workflow = fs.readFileSync(require('node:path').join(__dirname, '../.github/workflows/ci.yml'), 'utf8');
  const selector = workflow.split('  select-reviewer:')[1].split('  assess-intent:')[0];
  assert.match(selector, /ref: main/); assert.match(selector, /installation.cjs/);
  assert.doesNotMatch(selector, /secrets\.|write/);
  for (const name of ['assess-intent', 'approve-and-merge']) {
    const section = workflow.split(`  ${name}:`)[1].split(/\n  [a-z][a-z-]+:/)[0];
    assert.match(section, /needs:.*select-reviewer/);
    assert.match(section, /ref:.*needs.select-reviewer.outputs.ref/);
  }
});
