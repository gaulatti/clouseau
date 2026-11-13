'use strict';
// Reconciliation under the protected local_review.base_moved setting. Kept apart from base-reconcile.test.cjs so a change here does not resend that file as review evidence.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {reconcileBase} = require('./base-reconcile.cjs');

const repo = {owner: 'example', repo: 'product'};
const tip = 'c'.repeat(40), old = 'b'.repeat(40);
const sha = n => String(n).repeat(40).slice(0, 40);

// The six approved stale PRs of base-reconcile.test.cjs; updateBranch, like GitHub, gives the updated PR a new head on the tip.
function fixture(updateError = {}) {
  const state = {created: [], updates: []};
  state.pulls = [2, 3, 4, 5, 6, 7].map(number => ({number, draft: false, auto_merge: {enabled_by: {login: 'github-actions[bot]'}},
    head: {sha: sha(number), repo: {full_name: 'example/product'}}, base: {ref: 'main', sha: old}}));
  const github = {rest: {
    pulls: {list: async () => ({data: state.pulls}), listReviews: async () => ({data: []})},
    repos: {
      compareCommits: async args => ({data: {behind_by: args.head.startsWith('u') ? 0 : 1, merge_base_commit: {sha: old}}}),
      getBranch: async () => ({data: {commit: {sha: tip}}}),
    },
    issues: {listComments: async () => ({data: []}), createComment: async args => state.created.push(args), updateComment: async () => {}},
  }, paginate: async (method, args) => (await method(args)).data};
  const updateGithub = {rest: {pulls: {updateBranch: async args => {
    state.updates.push(args);
    if (updateError[args.pull_number]) throw Object.assign(new Error('refused'), {status: updateError[args.pull_number]});
    const pr = state.pulls.find(item => item.number === args.pull_number);
    pr.head.sha = `u${args.pull_number}`.padEnd(40, '0'); pr.base.sha = tip;
  }}}};
  const logs = [];
  return {state, github, updateGithub, logs, core: {info: line => logs.push(line)}};
}
const run = (f, extra = {}) => reconcileBase({github: f.github, updateGithub: f.updateGithub, core: f.core, baseBranch: 'main',
  context: {repo, eventName: 'push', payload: {ref: 'refs/heads/main'}}, ...extra});

test('base_moved "update": every stale same-repository PR is updated in one run and none receives a notice', async () => {
  const f = fixture();
  assert.deepEqual(await run(f, {baseMoved: 'update'}), {updated: [2, 3, 4, 5, 6, 7], noticed: []});
  assert.deepEqual(f.state.updates, [2, 3, 4, 5, 6, 7].map(number => ({...repo, pull_number: number, expected_head_sha: sha(number)})));
  assert.equal(f.state.created.length, 0);
  assert.ok(f.logs.some(line => line.includes('a diff-bound receipt that still attests needs no fresh review')));
  // Loop bound: updating branches never moves the base, so the next run finds every PR current and updates nothing.
  assert.deepEqual(await run(f, {baseMoved: 'update'}), {updated: [], noticed: []});
  assert.equal(f.state.updates.length, 6);
});

for (const baseMoved of [undefined, 'hold']) test(`base_moved ${baseMoved}: one PR at a time is updated, as today`, async () => {
  const f = fixture();
  assert.deepEqual(await run(f, baseMoved ? {baseMoved} : {}), {updated: [2], noticed: [3, 4, 5, 6, 7]});
  assert.equal(f.state.updates.length, 1);
  assert.ok(f.state.created.every(item => item.body.includes('updated after it merges') && !item.body.includes('base_moved` is')));
});

test('base_moved "update": a 422 is noticed as a conflict or moved head, a fork is named, and the rest are still updated', async () => {
  const f = fixture({3: 422, 5: 403});
  f.state.pulls[3].head.repo = {full_name: 'someone/product'};
  assert.deepEqual(await run(f, {baseMoved: 'update'}), {updated: [2, 4, 6, 7], noticed: [3, 5]});
  const body = number => f.state.created.find(item => item.issue_number === number).body;
  assert.match(body(3), /GitHub refused the automatic update \(HTTP 422\): a merge conflict with the base, or a head that moved, prevented it/);
  assert.match(body(5), /the head branch lives in a fork, which Clouseau never updates/);
  assert.ok(!f.state.created.some(item => item.body.includes('updated after it merges')), 'nothing is queued behind a sibling');
  // A refusal that is not a 422 keeps the plain notice: it claims no cause it does not know.
  const other = fixture({2: 403});
  assert.deepEqual(await run(other, {baseMoved: 'update'}), {updated: [3, 4, 5, 6, 7], noticed: [2]});
  assert.ok(!other.state.created[0].body.includes('base_moved` is'));
});

test('base_moved "update" without a credential notices every stale PR exactly as today', async () => {
  const [opted, today] = [fixture(), fixture()];
  assert.deepEqual(await run(opted, {baseMoved: 'update', updateGithub: null}), await run(today, {updateGithub: null}));
  assert.deepEqual(opted.state.created, today.state.created);
});
