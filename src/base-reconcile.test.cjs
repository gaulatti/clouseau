'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {reconcileBase} = require('./base-reconcile.cjs');

const repo = {owner: 'example', repo: 'product'};
const tip = 'c'.repeat(40), old = 'b'.repeat(40);
const sha = n => String(n).repeat(40).slice(0, 40);

// Six simultaneously approved PRs, as in the bleecker layout; the first merged.
function fixture(overrides = {}) {
  const state = {comments: {}, updates: [], created: [], edited: [], behind: {}, reviews: {}, updateError: {}, ...overrides};
  const pulls = [2, 3, 4, 5, 6, 7].map(number => ({number, draft: false, auto_merge: {enabled_by: {login: 'github-actions[bot]'}},
    head: {sha: sha(number), repo: {full_name: 'example/product'}}, base: {ref: 'main'}}));
  state.pulls = pulls;
  const github = {rest: {
    pulls: {list: async () => ({data: state.pulls}), listReviews: async args => ({data: state.reviews[args.pull_number] || []})},
    repos: {
      compareCommits: async args => ({data: {behind_by: state.behind[args.head] ?? 1, merge_base_commit: {sha: old}}}),
      getBranch: async () => ({data: {commit: {sha: tip}}}),
    },
    issues: {
      listComments: async args => ({data: state.comments[args.issue_number] || []}),
      createComment: async args => state.created.push(args),
      updateComment: async args => state.edited.push(args),
    },
  }, paginate: async (method, args) => (await method(args)).data};
  const updateGithub = {rest: {pulls: {updateBranch: async args => {
    if (state.updateError[args.pull_number]) throw Object.assign(new Error('refused'), {status: state.updateError[args.pull_number]});
    state.updates.push(args);
  }}}};
  const logs = [];
  const core = {info: line => logs.push(line)};
  const context = {repo, eventName: 'push', payload: {ref: 'refs/heads/main'}};
  return {state, github, updateGithub, core, context, logs};
}
const run = (f, extra = {}) => reconcileBase({github: f.github, updateGithub: f.updateGithub, context: f.context, core: f.core, baseBranch: 'main', ...extra});

test('only a push to the base branch reconciles', async () => {
  for (const context of [{repo, eventName: 'pull_request', payload: {ref: 'refs/heads/main'}}, {repo, eventName: 'push', payload: {ref: 'refs/heads/other'}}]) {
    const f = fixture(); const outcome = await run(f, {context});
    assert.deepEqual(outcome, {updated: [], noticed: []}); assert.equal(f.state.created.length, 0);
  }
});

test('with an update credential one approved stale PR is updated at a time and every sibling gets a visible notice', async () => {
  const f = fixture(); const outcome = await run(f);
  assert.deepEqual(outcome, {updated: [2], noticed: [3, 4, 5, 6, 7]});
  assert.deepEqual(f.state.updates, [{...repo, pull_number: 2, expected_head_sha: sha(2)}]);
  assert.equal(f.state.created.length, 5);
  assert.ok(f.state.created.every(item => item.body.includes('clouseau-needs-branch-update') && item.body.includes('updated after it merges')));
  assert.deepEqual(f.state.created.map(item => item.issue_number), [3, 4, 5, 6, 7]);
  await run(f);
  assert.equal(f.state.updates.length, 2, 'the next push updates the next PR');
});

test('without a credential, a fork head or a refused update every stale approved PR is noticed and none is changed', async () => {
  const none = fixture(); const outcome = await run(none, {updateGithub: null});
  assert.deepEqual(outcome.updated, []); assert.equal(outcome.noticed.length, 6);
  assert.ok(none.state.created.every(item => !item.body.includes('updated after it merges')));
  const fork = fixture(); fork.state.pulls[0].head.repo = {full_name: 'someone/product'}; fork.state.pulls[1].head.repo = null;
  assert.deepEqual((await run(fork)).updated, [4], 'forks and deleted head repositories are never updated');
  const refused = fixture({updateError: {2: 422, 3: 'x'}});
  const result = await run(refused);
  assert.deepEqual(result, {updated: [4], noticed: [2, 3, 5, 6, 7]}, 'a conflict is noticed and the next PR is tried');
  assert.ok(refused.logs.some(line => line.includes('PR 2') && line.includes('HTTP 422')));
  assert.ok(refused.logs.some(line => line.includes('PR 3') && line.includes('HTTP unknown')));
});

test('only approved or auto-merge armed, ready, genuinely behind PRs are considered', async () => {
  const f = fixture();
  f.state.pulls[0].draft = true;
  f.state.pulls[1].auto_merge = null;                 // 3: unapproved, no auto-merge
  f.state.pulls[2].auto_merge = null;                 // 4: bot-approved on its head
  f.state.reviews[4] = [{user: {login: 'github-actions[bot]', type: 'Bot'}, state: 'APPROVED', commit_id: sha(4)}];
  f.state.pulls[3].auto_merge = null;                 // 5: approval for an older head
  f.state.reviews[5] = [{user: {login: 'github-actions[bot]', type: 'Bot'}, state: 'APPROVED', commit_id: sha(9)}];
  f.state.pulls[4].auto_merge = null;                 // 6: approval later dismissed
  f.state.reviews[6] = [{user: {login: 'github-actions[bot]', type: 'Bot'}, state: 'APPROVED', commit_id: sha(6)},
    {user: {login: 'github-actions[bot]', type: 'Bot'}, state: 'DISMISSED', commit_id: sha(6)}, {user: {login: 'x'}, state: 'COMMENTED', commit_id: sha(6)}];
  f.state.behind[sha(7)] = 0;                         // 7: already current
  const outcome = await run(f, {updateGithub: null});
  assert.deepEqual(outcome, {updated: [], noticed: [4]});
});

test('a repeated push replaces the same notice instead of adding another', async () => {
  const f = fixture();
  f.state.comments[3] = [{id: 77, user: {login: 'github-actions[bot]'}, body: `<!-- clouseau-needs-branch-update:${sha(3)}:${old} -->\nold`}];
  await run(f, {updateGithub: null});
  assert.deepEqual(f.state.edited.map(item => item.comment_id), [77]);
  assert.equal(f.state.created.filter(item => item.issue_number === 3).length, 0);
});

test('merges made by the bot with GITHUB_TOKEN raise no push event: a completed review run of a merged PR, a schedule or a dispatch reconcile instead', async () => {
  const runContext = (extra = {}) => ({repo, eventName: 'workflow_run', payload: {workflow_run: {event: 'pull_request_target', head_sha: sha(1), pull_requests: [{number: 1}], ...extra}}});
  const withMerged = (f, merged, base = 'main') => {
    f.github.rest.pulls.get = async args => ({data: {number: args.pull_number, merged, base: {ref: base}}});
    f.github.rest.repos.listPullRequestsAssociatedWithCommit = async () => ({data: [{number: 1}]});
    return f;
  };
  // The merged PR's review run completed: the base moved, siblings are reconciled.
  const merged = withMerged(fixture(), true);
  assert.deepEqual(await run(merged, {context: runContext()}), {updated: [2], noticed: [3, 4, 5, 6, 7]});
  // A review run of a PR that is not merged (or merged elsewhere) moved nothing.
  for (const [mergedFlag, base] of [[false, 'main'], [true, 'release']]) {
    const f = withMerged(fixture(), mergedFlag, base);
    assert.deepEqual(await run(f, {context: runContext()}), {updated: [], noticed: []}); assert.equal(f.state.created.length, 0);
    assert.match(f.logs[0], /did not move/);
  }
  // Only a pull_request_target review run is a merge signal.
  const other = withMerged(fixture(), true);
  assert.deepEqual(await run(other, {context: runContext({event: 'pull_request'})}), {updated: [], noticed: []});
  // A fork PR's run carries no pull request list: it is found through the head commit.
  const fork = withMerged(fixture(), true);
  assert.deepEqual((await run(fork, {context: runContext({pull_requests: []})})).updated, [2]);
  const absent = withMerged(fixture(), true); absent.github.rest.repos.listPullRequestsAssociatedWithCommit = async () => ({data: []});
  assert.deepEqual(await run(absent, {context: runContext({pull_requests: undefined})}), {updated: [], noticed: []});
  // A schedule or manual dispatch reconciles unconditionally (covers auto-merges that finish after the run).
  for (const eventName of ['schedule', 'workflow_dispatch']) {
    const f = fixture(); assert.deepEqual((await run(f, {context: {repo, eventName, payload: {}}})).updated, [2]);
  }
});

// GitHub reports `x-accepted-github-permissions: issues=write; pull_requests=write` for commenting on a pull
// request: both are needed, which is what the job in the lab (issues: write only) lacked (issue 142).
function withPermissions(f, granted) {
  const create = f.github.rest.issues.createComment;
  f.github.rest.issues.createComment = async args => {
    if (!(granted.includes('issues') && granted.includes('pull_requests'))) {
      throw Object.assign(new Error('Resource not accessible by integration'), {status: 403});
    }
    return create(args);
  };
  return f;
}

test('end to end: stale approved PRs get the notice with issues and pull-requests write, and a missing permission is a named failure, not a silent skip', async () => {
  const ok = withPermissions(fixture(), ['issues', 'pull_requests']);
  const outcome = await run(ok, {updateGithub: null});
  assert.deepEqual(outcome.noticed, [2, 3, 4, 5, 6, 7]);
  assert.equal(ok.state.created.length, 6);
  assert.ok(ok.state.created.every(item => /clouseau-needs-branch-update/.test(item.body)));
  const denied = withPermissions(fixture(), ['issues']);
  await assert.rejects(run(denied, {updateGithub: null}), error => {
    assert.match(error.message, /could not be posted on PR 2, 3, 4, 5, 6, 7 \(HTTP 403\)/);
    assert.match(error.message, /issues: write and pull-requests: write/);
    return true;
  });
  assert.ok(denied.logs.some(line => /PR 2: the branch-update notice could not be posted \(HTTP 403\)/.test(line)));
  const odd = fixture(); odd.github.rest.issues.createComment = async () => { throw new Error('network'); };
  await assert.rejects(run(odd, {updateGithub: null}), /HTTP unknown/);
});

test('one read of the base tip serves every PR, and a PR whose recorded base is the tip is never compared', async () => {
  const f = fixture(); let tips = 0, compares = 0;
  const getBranch = f.github.rest.repos.getBranch; f.github.rest.repos.getBranch = async args => {tips++; return getBranch(args);};
  const compare = f.github.rest.repos.compareCommits; f.github.rest.repos.compareCommits = async args => {compares++; return compare(args);};
  f.state.pulls[0].base = {ref: 'main', sha: tip};
  await run(f, {updateGithub: null});
  assert.equal(tips, 1, 'one getBranch for six notices, not one per PR');
  assert.equal(compares, 5, 'the up-to-date PR costs nothing');
});
