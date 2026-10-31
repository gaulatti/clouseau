'use strict';

// Issue 151: in base-move batches the needs-branch-update notice appeared for 5 of 5 behind PRs in one batch and for
// none of 12 in the next two. Cause: the first merge happens while the other PRs are still under review, so the only
// full reconciliation (triggered by the merged PR's review run) found nothing approved; the later approvals completed
// their own review runs, but those PRs were not merged and so triggered nothing. These tests replay that order.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {reconcileBase} = require('./base-reconcile.cjs');

const repo = {owner: 'example', repo: 'product'};
const sha = n => String(n).padStart(40, 'a');
const BASE0 = 'b'.repeat(40);

function world() {
  const state = {ids: 0, tip: BASE0, prs: new Map(), reviews: new Map(), comments: new Map(), writes: [], calls: {}};
  for (let n = 1; n <= 8; n++) {
    state.prs.set(n, {number: n, state: 'open', draft: false, merged: false, auto_merge: null, head: {sha: sha(n), repo: {full_name: 'example/product'}}, base: {ref: 'main', sha: BASE0}});
    state.comments.set(n, []); state.reviews.set(n, []);
  }
  const count = name => { state.calls[name] = (state.calls[name] || 0) + 1; };
  const github = {rest: {
    pulls: {
      list: async () => { count('list'); return {data: [...state.prs.values()].filter(pr => pr.state === 'open')}; },
      get: async ({pull_number}) => { count('get'); return {data: structuredClone(state.prs.get(pull_number))}; },
      listReviews: async ({pull_number}) => { count('reviews'); return {data: state.reviews.get(pull_number)}; },
    },
    repos: {
      getBranch: async () => { count('branch'); return {data: {commit: {sha: state.tip}}}; },
      compareCommits: async () => { count('compare'); return {data: {behind_by: state.tip === BASE0 ? 0 : 1, merge_base_commit: {sha: BASE0}}}; },
    },
    issues: {
      listComments: async ({issue_number}) => { count('comments'); return {data: state.comments.get(issue_number)}; },
      createComment: async ({issue_number, body}) => {
        count('create'); state.writes.push(['create', issue_number]);
        state.comments.get(issue_number).push({id: ++state.ids, user: {login: 'github-actions[bot]'}, body});
      },
      updateComment: async ({comment_id, body}) => {
        count('update');
        const [number, list] = [...state.comments.entries()].find(([, items]) => items.some(item => item.id === comment_id));
        state.writes.push(['update', number]);
        list.find(item => item.id === comment_id).body = body;
      },
    }}, paginate: async (method, args) => (await method(args)).data};
  const summaries = [];
  const core = {info() {}, summary: {addRaw(text) { summaries.push(text); return this; }, write: async () => {}}};
  return {state, github, core, summaries};
}
const approve = (w, n) => {
  const pr = w.state.prs.get(n);
  pr.auto_merge = {enabled_by: {login: 'github-actions[bot]'}};
  w.state.reviews.get(n).push({state: 'APPROVED', commit_id: pr.head.sha, user: {login: 'github-actions[bot]', type: 'Bot'}});
};
const merge = (w, n, tip) => { Object.assign(w.state.prs.get(n), {state: 'closed', merged: true}); w.state.tip = tip; };
const reviewRun = (n, event = 'pull_request_target') => ({repo, eventName: 'workflow_run', payload: {workflow_run: {event, head_sha: sha(n), pull_requests: [{number: n}]}}});
const run = (w, context) => reconcileBase({github: w.github, updateGithub: null, context, core: w.core, baseBranch: 'main'});
const notices = (w, n) => w.state.comments.get(n).filter(item => item.body.startsWith('<!-- clouseau-needs-branch-update'));

test('8 PRs approved at nearly the same time, the first merges: every approved stale PR ends with exactly one notice, however the triggers fall', async () => {
  const w = world();
  approve(w, 1); merge(w, 1, 'c'.repeat(40));
  // The merged PR's review run completes while PRs 2-8 are still under review: the full scan finds nothing approved.
  assert.deepEqual(await run(w, reviewRun(1)), {updated: [], noticed: []});
  assert.equal(w.state.writes.length, 0, 'the old behaviour: no approvals yet, no notices, and no later trigger');
  // The others are approved one after another; each review run completes, unmerged. Duplicated and out-of-order triggers.
  for (const n of [4, 2, 7, 3, 8, 5, 6]) {
    approve(w, n);
    assert.deepEqual((await run(w, reviewRun(n))).noticed, [n], `PR ${n} is noticed by its own review run`);
    if (n % 2) await run(w, reviewRun(n));
  }
  await run(w, {repo, eventName: 'schedule', payload: {}});
  await run(w, {repo, eventName: 'workflow_dispatch', payload: {}});
  await run(w, reviewRun(1));
  for (let n = 2; n <= 8; n++) assert.equal(notices(w, n).length, 1, `PR ${n} carries exactly one notice`);
  assert.equal(notices(w, 1).length, 0, 'the merged PR gets none');
  assert.equal(w.state.writes.filter(([kind]) => kind === 'create').length, 7, 'created once per PR');
  assert.equal(w.state.writes.filter(([kind]) => kind === 'update').length, 0, 'repeated triggers for the same base are idempotent: no edit, no duplicate');
});

test('a later base move edits each notice in place after the last trigger', async () => {
  const w = world();
  approve(w, 1); merge(w, 1, 'c'.repeat(40));
  for (const n of [2, 3, 4]) { approve(w, n); await run(w, reviewRun(n)); }
  w.state.tip = 'd'.repeat(40);
  await run(w, {repo, eventName: 'schedule', payload: {}});
  await run(w, {repo, eventName: 'schedule', payload: {}});
  for (const n of [2, 3, 4]) {
    assert.equal(notices(w, n).length, 1);
    assert.ok(notices(w, n)[0].body.includes(`:${'d'.repeat(40)} -->`), 'edited to the current base');
  }
  assert.deepEqual([w.state.writes.filter(([kind]) => kind === 'create').length, w.state.writes.filter(([kind]) => kind === 'update').length], [3, 3]);
});

test('a review run costs a handful of requests: it checks only its own PR', async () => {
  const w = world();
  approve(w, 1); merge(w, 1, 'c'.repeat(40)); approve(w, 5);
  w.state.calls = {};
  await run(w, reviewRun(5));
  assert.ok(Object.values(w.state.calls).reduce((a, b) => a + b, 0) <= 7, JSON.stringify(w.state.calls));
  assert.equal(w.state.calls.list, undefined, 'the open-PR list is not read for a single PR');
});

test('a run that does nothing says why, in the log and in the run summary', async () => {
  const w = world();
  const cases = [
    [reviewRun(3, 'pull_request'), /the completed run was a pull_request run, not a pull_request_target review run/],
    [{repo, eventName: 'push', payload: {ref: 'refs/heads/feature'}}, /a push to feature, not the base branch/],
    [{repo, eventName: 'issue_comment', payload: {}}, /a issue_comment event does not move the base/],
    [reviewRun(3), /Base reconciliation \(the review run of open PR 3, that PR only\): 0 updated, 0 noticed/],
  ];
  for (const [context, expected] of cases) {
    w.summaries.length = 0;
    await run(w, context);
    assert.match(w.summaries.join(''), expected);
  }
  // A draft, closed or other-base PR and an unknown PR are explained as well.
  w.state.prs.get(3).draft = true; w.summaries.length = 0;
  await run(w, reviewRun(3));
  assert.match(w.summaries.join(''), /belongs to no open or merged PR on the base branch/);
  w.state.prs.get(4).base.ref = 'release'; w.summaries.length = 0;
  await run(w, reviewRun(4));
  assert.match(w.summaries.join(''), /belongs to no open or merged PR/);
  const noSummary = {info() {}};
  assert.deepEqual(await reconcileBase({github: w.github, updateGithub: null, context: reviewRun(1, 'pull_request'), core: noSummary, baseBranch: 'main'}), {updated: [], noticed: []});
});
