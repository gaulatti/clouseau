'use strict';
// Owner confirmation under the protected local_review.confirmation setting (with binding "diff"). Kept apart from policy.test.cjs so a change here does not resend that file as review evidence.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createPolicy} = require('./policy.cjs');

const config = require('../test/fixtures/config.json');
const repo = {owner: 'example', repo: 'local-fixture'};
const BASE = 'b'.repeat(40);
const OLD = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const patch = (line = 'one') => `@@ -1,2 +1,2 @@\n context\n-old\n+${line}`;
const file = (extra = {}) => ({filename: 'src/handler.js', status: 'modified', patch: patch(), ...extra});

// A pull request whose head `HEAD` updated an earlier head `OLD` by merging a new base `BASE`.
function world({live = [file()], earlier = [file()], lineage = 'ahead', comments = [], reviews = [], failure = null, mergeBase = BASE, contents = {},
  forcePushes = [], tips = {}, timeline = null} = {}) {
  const calls = [];
  const github = {
    paginate: async (fn, args) => (await fn(args)).data,
    rest: {
      pulls: {listFiles: async () => ({data: live}), listReviews: async () => ({data: reviews})},
      issues: {listComments: async () => ({data: comments})},
      repos: {
        getCollaboratorPermissionLevel: async () => ({data: {permission: 'admin'}}),
        // The protected configuration and purpose contract at a base: the same at every base unless `contents` says otherwise.
        getContent: async ({path, ref}) => {
          const value = contents[`${ref}:${path}`];
          if (value instanceof Error) throw value;
          return {data: {content: value === undefined ? `${path} unchanged` : value}};
        },
        compareCommits: async ({base, head}) => {
          calls.push(`${base.slice(0, 1)}..${head.slice(0, 1)}`);
          if (failure && failure.on === `${base}..${head}`) throw failure.error;
          if (base === BASE) return {data: {status: 'ahead', files: earlier, ...(mergeBase ? {merge_base_commit: {sha: mergeBase}} : {})}};
          if (Object.hasOwn(tips, head)) return {data: {status: tips[head], files: []}};
          return {data: {status: head === HEAD && base !== OTHER ? lineage : 'diverged', files: []}};
        },
      },
    },
  };
  // The pull request's force pushes, as its timeline reports them (`timeline` replaces the whole answer).
  github.graphql = async (query, args) => {
    calls.push(`timeline#${args.number}`);
    if (timeline instanceof Error) throw timeline;
    return timeline ?? {repository: {pullRequest: {timelineItems: {totalCount: forcePushes.length,
      nodes: forcePushes.map(([before, after]) => ({beforeCommit: {oid: before}, afterCommit: {oid: after}}))}}}};
  };
  const pr = {number: 7, head: {sha: HEAD}, base: {sha: BASE}, changed_files: live.length};
  // A policy of its own: confirmations are cached per policy, one per run.
  return {github, pr, calls, policy: createPolicy(config, {intentDiff: true})};
}
const comment = (sha, extra = {}) => ({id: 31, user: {login: 'gaulatti', type: 'User'}, body: `/approve-intent ${sha}`, ...extra});
const policies = {plain: createPolicy(config)};

test('without the binding an owner confirmation names the exact head, as before', async () => {
  const f = world({comments: [comment(OLD)], reviews: [{user: {login: 'gaulatti', type: 'User'}, state: 'APPROVED', commit_id: OLD}]});
  assert.equal(await policies.plain.purposeConfirmation(f.github, repo, f.pr, [comment(OLD)]), null);
  assert.equal(await policies.plain.maintainerConfirmed(f.github, repo, f.pr), false);
  assert.deepEqual(f.calls, [], 'nothing is compared without the binding');
  const exact = await policies.plain.purposeConfirmation(f.github, repo, f.pr, [comment(HEAD)]);
  assert.equal(exact.head_sha, HEAD); assert.equal(Object.hasOwn(exact, 'confirmed_sha'), false);
});

test('under binding "diff" a confirmation of an earlier head counts while the pull request diff is unchanged', async () => {
  // The update merged a base that moved the hunk: the normalized diff (headers reduced to @@) is the same.
  const f = world({live: [file({patch: patch().replace('@@ -1,2 +1,2 @@', '@@ -9,2 +9,2 @@')})], comments: [comment(OLD)]});
  const confirmed = await f.policy.purposeConfirmation(f.github, repo, f.pr, [comment(OLD)]);
  assert.equal(confirmed.head_sha, HEAD); assert.equal(confirmed.confirmed_sha, OLD); assert.equal(confirmed.actor, 'gaulatti');
  assert.equal(await f.policy.maintainerConfirmed(f.github, repo, f.pr), true);
  // An approving review of the earlier head counts the same way.
  const reviewed = world({reviews: [{user: {login: 'gaulatti', type: 'User'}, state: 'APPROVED', commit_id: OLD}]});
  assert.equal(await reviewed.policy.maintainerConfirmed(reviewed.github, repo, reviewed.pr, {reviewOnly: true}), true);
  // A renamed file is compared with its previous path.
  const renamed = file({status: 'renamed', previous_filename: 'src/old.js'});
  const moved = world({live: [renamed], earlier: [renamed], comments: [comment(OLD)]});
  assert.equal(await moved.policy.maintainerConfirmed(moved.github, repo, moved.pr), true);
  const elsewhere = world({live: [renamed], earlier: [{...renamed, previous_filename: 'src/other.js'}], comments: [comment(OLD)]});
  assert.equal(await elsewhere.policy.maintainerConfirmed(elsewhere.github, repo, elsewhere.pr), false);
});

test('under binding "diff" any change to the diff, another lineage or incomplete evidence voids an earlier confirmation', async () => {
  const voided = async (options, sha = OLD) => {
    const f = world({comments: [comment(sha)], ...options});
    assert.equal(await f.policy.purposeConfirmation(f.github, repo, f.pr, [comment(sha)]), null);
    assert.equal(await f.policy.maintainerConfirmed(f.github, repo, f.pr), false);
    return f;
  };
  await voided({live: [file({patch: patch('two')})]});
  await voided({live: [file(), file({filename: 'src/added.js', status: 'added'})]});
  await voided({lineage: 'diverged'});
  await voided({}, OTHER);
  await voided({live: [file({patch: undefined})]});
  await voided({earlier: [file({patch: ''})]});
  await voided({earlier: []});
  await voided({earlier: null});
  await voided({earlier: Array.from({length: 300}, (_, index) => file({filename: `src/f${index}.js`}))});
  await voided({failure: {on: `${OLD}..${HEAD}`, error: Object.assign(new Error('Not Found'), {status: 404})}});
  await voided({failure: {on: `${BASE}..${OLD}`, error: Object.assign(new Error('Unprocessable'), {status: 422})}});
  const short = world({comments: [comment(OLD)]}); short.pr.changed_files = 2;
  assert.equal(await short.policy.maintainerConfirmed(short.github, repo, short.pr), false, 'a truncated file list never matches');
  // A review with no commit, or a malformed id, never matches.
  const empty = world({reviews: [{user: {login: 'gaulatti', type: 'User'}, state: 'APPROVED'}]});
  assert.equal(await empty.policy.maintainerConfirmed(empty.github, repo, empty.pr, {reviewOnly: true}), false);
  // Any other failure is never read as a match: it surfaces.
  const broken = world({comments: [comment(OLD)], failure: {on: `${OLD}..${HEAD}`, error: Object.assign(new Error('Server Error'), {status: 500})}});
  await assert.rejects(broken.policy.maintainerConfirmed(broken.github, repo, broken.pr), /Server Error/);
});

test('under binding "diff" one comparison serves every check of the same head and base', async () => {
  const f = world({comments: [comment(OLD)]});
  await f.policy.purposeConfirmation(f.github, repo, f.pr, [comment(OLD)]);
  const after = f.calls.length;
  await f.policy.maintainerConfirmed(f.github, repo, f.pr);
  await f.policy.purposeConfirmation(f.github, repo, f.pr, [comment(OLD)]);
  assert.equal(f.calls.length, after);
});

test('under confirmation "diff" an earlier confirmation never carries across a base change to the configuration or contract', async () => {
  const EARLIER = 'e'.repeat(40);
  const policy = config.repository_policy;
  const carries = async contents => {
    const f = world({mergeBase: EARLIER, contents, comments: [comment(OLD)]});
    return f.policy.maintainerConfirmed(f.github, repo, f.pr);
  };
  assert.equal(await carries({}), true, 'the base moved, but the configuration and the contract are the same');
  assert.equal(await carries({[`${BASE}:.github/clouseau.json`]: '{"changed": true}'}), false, 'the protected configuration changed');
  assert.equal(await carries({[`${EARLIER}:${policy}`]: 'an earlier contract'}), false, 'the purpose contract changed');
  const absent = Object.assign(new Error('Not Found'), {status: 404});
  assert.equal(await carries({[`${EARLIER}:.github/clouseau.json`]: absent, [`${BASE}:.github/clouseau.json`]: absent}), true, 'absent at both bases is unchanged');
  assert.equal(await carries({[`${BASE}:.github/clouseau.json`]: absent}), false, 'added on the base is a change');
  await assert.rejects(carries({[`${BASE}:${policy}`]: Object.assign(new Error('Server Error'), {status: 500})}), /Server Error/);
  const unknown = world({mergeBase: null, comments: [comment(OLD)]});
  assert.equal(await unknown.policy.maintainerConfirmed(unknown.github, repo, unknown.pr), false, 'no merge base, no match');
});

test('the confirmation setting is valid only as "diff" and only together with binding "diff"', async () => {
  const {validateTrust} = require('./local-receipt.cjs');
  const {fixture} = require('../test/local-review-fixture.cjs');
  const f = await fixture();
  assert.doesNotThrow(() => validateTrust({...f.trust, binding: 'diff', confirmation: 'diff'}));
  assert.throws(() => validateTrust({...f.trust, confirmation: 'diff'}), /confirmation must be "diff" when set, and only together with binding "diff"/);
  for (const value of ['head', '', null, true]) assert.throws(() => validateTrust({...f.trust, binding: 'diff', confirmation: value}), /confirmation must be/);
});

test('a version 2 configuration lets a confirmation follow the diff only with confirmation and binding both "diff"', () => {
  const {confirmationFollowsDiff} = require('./policy.cjs');
  assert.equal(confirmationFollowsDiff({binding: 'diff', confirmation: 'diff'}), true);
  for (const value of [undefined, {}, {binding: 'diff'}, {confirmation: 'diff'}, {binding: 'diff', confirmation: 'head'}]) {
    assert.equal(confirmationFollowsDiff(value), false, JSON.stringify(value));
  }
});

test('under confirmation "diff" an earlier-head comment from a non-maintainer starts no comparison', async () => {
  const f = world({comments: [comment(OLD, {user: {login: 'someone', type: 'User'}})]});
  f.github.rest.repos.getCollaboratorPermissionLevel = async () => ({data: {permission: 'read'}});
  assert.equal(await f.policy.maintainerConfirmed(f.github, repo, f.pr), false);
  assert.deepEqual(f.calls, [], 'no compare is made for a comment its author could not confirm');
});

test('the gate and its reassessment decide an /approve-intent comment by the same check, which follows the diff only with the setting', async () => {
  // Without the setting: the exact head only; the gate also requires the bare command.
  const plain = world();
  assert.equal(await policies.plain.commentConfirms(plain.github, repo, plain.pr, `/approve-intent ${HEAD}`, {exact: true}), true);
  assert.equal(await policies.plain.commentConfirms(plain.github, repo, plain.pr, `/approve-intent ${OLD}`), false);
  assert.deepEqual(plain.calls, []);
  // With it: an earlier head of the same diff counts at the gate and at the reassessment.
  const f = world();
  assert.equal(await f.policy.commentConfirms(f.github, repo, f.pr, `/approve-intent ${OLD}`, {exact: true}), true);
  assert.equal(await f.policy.commentConfirms(f.github, repo, f.pr, `/approve-intent ${OLD}\n\nAccepted purpose:\nShip it.`), true);
  // The gate keeps requiring the bare command; any other text or another diff never counts.
  assert.equal(await f.policy.commentConfirms(f.github, repo, f.pr, `/approve-intent ${OLD}\n\nAccepted purpose:\nShip it.`, {exact: true}), false);
  assert.equal(await f.policy.commentConfirms(f.github, repo, f.pr, 'approve it'), false);
  const changed = world({live: [file({patch: patch('two')})]});
  assert.equal(await changed.policy.commentConfirms(changed.github, repo, changed.pr, `/approve-intent ${OLD}`, {exact: true}), false);
});

test('under confirmation "diff" a failed comparison is not cached, so a retry compares again', async () => {
  const f = world({failure: {on: `${OLD}..${HEAD}`, error: Object.assign(new Error('Rate limited'), {status: 403})}});
  await assert.rejects(f.policy.commentConfirms(f.github, repo, f.pr, `/approve-intent ${OLD}`), /Rate limited/);
  const failed = f.calls.length;
  f.github.rest.repos.compareCommits = async ({base, head}) => {
    f.calls.push('retry');
    return base === BASE ? {data: {status: 'ahead', files: [file()], merge_base_commit: {sha: BASE}}} : {data: {status: head === HEAD ? 'ahead' : 'diverged', files: []}};
  };
  assert.equal(await f.policy.commentConfirms(f.github, repo, f.pr, `/approve-intent ${OLD}`), true);
  assert.ok(f.calls.length > failed, 'the retry compared again instead of replaying the failure');
});

test('a version 2 configuration wires local_review.confirmation into the policy end to end', async () => {
  const {fixture} = require('../test/local-review-fixture.cjs');
  const trust = (await fixture()).trust;
  const v2 = localReview => createPolicy({...config, version: 2, repository_policy: '.github/clouseau.md', readme: 'README.md',
    acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed', grading_model: 'deepseek-flash', repair_attempts: 2},
    local_review: {...trust, ...localReview}});
  const decide = async policy => {
    const f = world();
    return policy.commentConfirms(f.github, repo, f.pr, `/approve-intent ${OLD}`, {exact: true});
  };
  assert.equal(await decide(v2({binding: 'diff', confirmation: 'diff'})), true, 'both set: the confirmation follows the diff');
  assert.equal(await decide(v2({binding: 'diff'})), false, 'binding alone: the exact head only');
  assert.equal(await decide(v2({})), false, 'neither: the exact head only');
  assert.throws(() => v2({confirmation: 'diff'}), /only together with binding "diff"/);
});

// The gate and the reassessment it starts, driven end to end for a protected-control change (the hold a local receipt cannot
// clear) whose head `HEAD` updated the confirmed head `OLD`. `OLD` was confirmed against an older base `OTHER`; the live base is
// `BASE`. The comments, reviews, runs and rules are the shapes the human-review gate tests use.
function gated({setting = true, live = [file({filename: '.github/clouseau.json'})], contents = {}, reviews = []} = {}) {
  const f = world({live, earlier: [file({filename: '.github/clouseau.json'})], mergeBase: OTHER, contents, reviews});
  const writes = [];
  const owner = {login: 'gaulatti', type: 'User'};
  const policy = setting ? f.policy : createPolicy(config);
  const pr = {...f.pr, node_id: 'PR_7', state: 'open', draft: false, user: {login: 'contributor', type: 'User'},
    head: {sha: HEAD, ref: 'feat/controls', repo: {id: 42}}, base: {sha: BASE, ref: 'main'}, auto_merge: {enabled_by: {login: 'github-actions[bot]'}}};
  const write = name => async args => {writes.push({name, args}); return {data: {id: 1}};};
  const run = {id: 22, head_sha: HEAD, head_branch: pr.head.ref, head_repository: {id: 42}, pull_requests: [{number: 7}],
    event: 'pull_request', status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/local-fixture/actions/runs/22'};
  Object.assign(f.github.rest.pulls, {get: async () => ({data: structuredClone(pr)}), createReview: write('review'), requestReviewers: write('request-review')});
  Object.assign(f.github.rest.issues, {createComment: write('comment'), addAssignees: write('assign')});
  Object.assign(f.github.rest.repos, {get: async () => ({data: {allow_auto_merge: true}}), getBranch: async () => ({data: {protected: true, commit: {sha: BASE}}}),
    getCollaboratorPermissionLevel: async () => ({data: {permission: 'write'}})});
  f.github.rest.actions = {
    listWorkflowRuns: async ({event}) => ({data: {workflow_runs: [{...run, event}]}}),
    getWorkflowRun: async () => ({data: {...run, event: 'pull_request_target'}}),
    listJobsForWorkflowRun: async () => ({data: [{name: 'verify', conclusion: 'success', steps: policy.VERIFY_STEPS.map(name => ({name, conclusion: 'success'}))}]}),
  };
  f.github.request = async route => {
    if (route.startsWith('POST')) {writes.push({name: 'rerun'}); return {};}
    return {data: [
      {type: 'required_status_checks', parameters: {strict_required_status_checks_policy: true,
        required_status_checks: ['verify', 'approve-and-merge'].map(context => ({context, integration_id: 15368}))}},
      {type: 'pull_request', parameters: {required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true}},
      {type: 'deletion'}, {type: 'non_fast_forward'}]};
  };
  f.github.graphql = async query => {
    if (query.startsWith('mutation')) {pr.auto_merge = query.includes('disablePullRequestAutoMerge') ? null : {}; return {};}
    return {repository: {pullRequest: {closingIssuesReferences: {nodes: [], pageInfo: {hasNextPage: false}}}}};
  };
  const core = {info() {}, summary: {addRaw(text) {writes.push({name: 'summary', text}); return this;}, async write() {}}};
  const context = (eventName, body) => ({repo, runId: 123, eventName, payload: eventName === 'issue_comment' ?
    {issue: {number: 7, pull_request: {}}, comment: {id: 31, user: owner, body}} : {pull_request: {number: 7}}});
  const assessment = {number: 7, head_sha: HEAD, base_sha: BASE, decision: 'auto_approve', reason: 'Changes a protected review control.'};
  const gate = (eventName = 'pull_request_target', body = `/approve-intent ${OLD}`) =>
    policy.gate({github: f.github, context: context(eventName, body), core, assessment, nativeGate: true, wait: async () => {}, maxPolls: 1, mergePolls: 1});
  const reassess = (body = `/approve-intent ${OLD}`) =>
    policy.requestReassessment({github: f.github, context: context('issue_comment', body), core: {info() {}}, wait: async () => {}});
  const confirm = () => {f.github.rest.issues.listComments = async () => ({data: [comment(OLD)]});};
  const approved = () => writes.some(item => item.name === 'review' && item.args.event === 'APPROVE' && item.args.commit_id === HEAD);
  return {gate, reassess, confirm, approved, writes};
}

test('under confirmation "diff" the gate clears the protected-control hold for an earlier head of the same diff, and only then', async () => {
  // The same diff on the updated head: the earlier confirmation clears the hold, from the comment event and from a rerun.
  const same = gated(); same.confirm();
  await same.gate('issue_comment');
  assert.ok(same.approved(), 'the earlier confirmation approves the updated head');
  const rerun = gated(); rerun.confirm();
  await rerun.gate();
  assert.ok(rerun.approved());
  // An approving review of the earlier head clears it the same way.
  const reviewed = gated({reviews: [{user: {login: 'gaulatti', type: 'User'}, state: 'APPROVED', commit_id: OLD}]});
  await reviewed.gate();
  assert.ok(reviewed.approved());
  // Without a confirmation the hold stands and the owner is asked to confirm this exact head.
  const missing = gated();
  await assert.rejects(missing.gate(), /maintainer intent confirmation is required/);
  assert.ok(!missing.approved());
  assert.ok(missing.writes.some(item => item.name === 'summary' && item.text.includes(`/approve-intent ${HEAD}`)));
  // A changed diff, a changed base configuration, or the setting off: the earlier confirmation never counts.
  const voided = [
    ['the diff changed', gated({live: [file({filename: '.github/clouseau.json', patch: patch('two')})]})],
    ['the base configuration changed', gated({contents: {[`${OTHER}:.github/clouseau.json`]: 'an older configuration'}})],
    ['the setting is off', gated({setting: false})],
  ];
  for (const [why, f] of voided) {
    await assert.rejects(f.gate('issue_comment'), /Stale or malformed intent confirmation/, why);
    f.confirm();
    await assert.rejects(f.gate(), /maintainer intent confirmation is required/, why);
    assert.ok(!f.approved(), why);
  }
});

test('under confirmation "diff" the reassessment an earlier-head confirmation starts follows the same check', async () => {
  const same = gated();
  await same.reassess();
  assert.deepEqual(same.writes.map(item => item.name), ['rerun']);
  const purpose = gated();
  await purpose.reassess(`/approve-intent ${OLD}\n\nAccepted purpose:\nShip the protected control.`);
  assert.deepEqual(purpose.writes.map(item => item.name), ['rerun']);
  for (const [why, f] of [
    ['the diff changed', gated({live: [file({filename: '.github/clouseau.json', patch: patch('two')})]})],
    ['the base configuration changed', gated({contents: {[`${OTHER}:.github/clouseau.json`]: 'an older configuration'}})],
    ['the setting is off', gated({setting: false})],
  ]) {
    await assert.rejects(f.reassess(), /Stale or malformed intent confirmation/, why);
    assert.deepEqual(f.writes, [], why);
  }
  // With the setting off the exact head still starts it, as before.
  const exact = gated({setting: false});
  await exact.reassess(`/approve-intent ${HEAD}`);
  assert.deepEqual(exact.writes.map(item => item.name), ['rerun']);
});

// The five branch-update cases, for the confirmation. `OLD` was confirmed; the live head `HEAD` is the branch after the update.
test('under confirmation "diff" the five branch-update cases: merge and shifted hunks keep it; rebase, a new commit and an altered resolution void it', async () => {
  const confirmed = async options => {
    const f = world({comments: [comment(OLD)], ...options});
    return f.policy.maintainerConfirmed(f.github, repo, f.pr);
  };
  // (a) main merged into the branch, unrelated files: the branch's own diff is unchanged.
  assert.equal(await confirmed({}), true, '(a) merge of main');
  // (b) the branch rebased onto the new main: the confirmed commit is no longer an ancestor of the head, but the pull request's
  // own timeline shows the force push that replaced it, so it was this branch's and the unchanged diff keeps it.
  assert.equal(await confirmed({lineage: 'diverged', forcePushes: [[OLD, HEAD]]}), true, '(b) rebase');
  assert.equal(await confirmed({lineage: 'diverged', forcePushes: [[OLD, HEAD]], live: [file({patch: patch('two')})]}), false, '(b) rebase and a changed hunk');
  // (c) main changed the same file in other hunks and merged cleanly: only the hunk offsets move, which the normalized diff
  // ignores; a main change inside the branch hunk's context lines changes the diff and voids it.
  assert.equal(await confirmed({live: [file({patch: patch().replace('@@ -1,2 +1,2 @@', '@@ -40,2 +40,2 @@')})]}), true, '(c) offsets only');
  assert.equal(await confirmed({live: [file({patch: patch().replace(' context', ' context edited on main')})]}), false, '(c) context changed');
  // (d) a real new commit on the branch changes the diff.
  assert.equal(await confirmed({live: [file(), file({filename: 'src/new.js', status: 'added'})]}), false, '(d) new commit');
  // (e) a conflict resolution that alters the branch's own added line.
  assert.equal(await confirmed({live: [file({patch: patch('one, resolved')})]}), false, '(e) altered resolution');
});

test('under confirmation "diff" a rebased confirmation carries only when this pull request\'s timeline proves the commit was its head', async () => {
  const PRIOR = 'e'.repeat(40);
  const confirmed = async options => {
    const f = world({comments: [comment(OLD)], lineage: 'diverged', ...options});
    return {result: await f.policy.maintainerConfirmed(f.github, repo, f.pr), calls: f.calls};
  };
  // A head that a later normal push extended, then a rebase replaced: the confirmed commit is an ancestor of that replaced head.
  assert.equal((await confirmed({forcePushes: [[PRIOR, HEAD]], tips: {[PRIOR]: 'ahead'}})).result, true, 'an ancestor of a replaced head');
  // The commit a force push produced counts as a head as well.
  assert.equal((await confirmed({forcePushes: [[PRIOR, OLD], [OLD, HEAD]], tips: {[PRIOR]: 'behind'}})).result, true, 'a produced head');
  // Never this pull request's head: a commit of another branch or fork with an identical diff does not carry.
  assert.equal((await confirmed({})).result, false, 'no force push at all');
  assert.equal((await confirmed({forcePushes: [[PRIOR, HEAD]], tips: {[PRIOR]: 'diverged'}})).result, false, 'unrelated to every head');
  // Evidence the engine could not read never carries: more force pushes than one page, a missing pull request, an unknown commit.
  // More force pushes than one page: even a page that would prove the commit was this pull request's head does not carry.
  const proving = [{beforeCommit: {oid: OLD}, afterCommit: {oid: HEAD}}];
  assert.equal((await confirmed({timeline: {repository: {pullRequest: {timelineItems: {totalCount: 1, nodes: proving}}}}})).result, true, 'one complete page');
  assert.equal((await confirmed({timeline: {repository: {pullRequest: {timelineItems: {totalCount: 101, nodes: proving}}}}})).result, false, 'unread pages');
  assert.equal((await confirmed({timeline: {repository: {pullRequest: null}}})).result, false, 'no pull request');
  assert.equal((await confirmed({forcePushes: [[PRIOR, HEAD]], failure: {on: `${OLD}..${PRIOR}`, error: Object.assign(new Error('Not Found'), {status: 404})}})).result,
    false, 'a garbage-collected commit');
  assert.equal((await confirmed({timeline: {repository: {pullRequest: {timelineItems: {totalCount: 1, nodes: [{beforeCommit: null, afterCommit: {oid: 'x'}}]}}}}})).result,
    false, 'malformed commits are ignored');
  // Any other failure is never read as a match: it surfaces.
  const f = world({comments: [comment(OLD)], lineage: 'diverged', timeline: Object.assign(new Error('Server Error'), {status: 502})});
  await assert.rejects(f.policy.maintainerConfirmed(f.github, repo, f.pr), /Server Error/);
  // An ancestor of the head needs no timeline read.
  const direct = await confirmed({lineage: 'ahead'});
  assert.equal(direct.result, true); assert.ok(!direct.calls.some(call => call.startsWith('timeline')));
});
