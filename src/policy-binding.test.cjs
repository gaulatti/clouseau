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
function world({live = [file()], earlier = [file()], lineage = 'ahead', comments = [], reviews = [], failure = null, mergeBase = BASE, contents = {}} = {}) {
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
          return {data: {status: head === HEAD && base !== OTHER ? lineage : 'diverged', files: []}};
        },
      },
    },
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
