'use strict';
// Owner confirmation under the protected local_review.binding setting. Kept apart from policy.test.cjs so a change here does not resend that file as review evidence.
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
function world({live = [file()], earlier = [file()], lineage = 'ahead', comments = [], reviews = [], failure = null} = {}) {
  const calls = [];
  const github = {
    paginate: async (fn, args) => (await fn(args)).data,
    rest: {
      pulls: {listFiles: async () => ({data: live}), listReviews: async () => ({data: reviews})},
      issues: {listComments: async () => ({data: comments})},
      repos: {
        getCollaboratorPermissionLevel: async () => ({data: {permission: 'admin'}}),
        compareCommits: async ({base, head}) => {
          calls.push(`${base.slice(0, 1)}..${head.slice(0, 1)}`);
          if (failure && failure.on === `${base}..${head}`) throw failure.error;
          if (base === BASE) return {data: {status: 'ahead', files: earlier}};
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
