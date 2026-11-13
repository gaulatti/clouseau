'use strict';
// Owner confirmation under local_review.confirmation "diff" when the pull request re-declares compatibility after a base
// merge. Kept apart from policy-binding.test.cjs so this change does not resend that file as review evidence; the fixture is
// that file's.
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

// A compatibility declaration as GitHub lists an added file: its name is the sha256 of its identity, its patch the whole JSON.
const declaration = (decision, changes, name) => {
  const text = JSON.stringify({version: 1, decision, changes}, null, 2);
  return {filename: `compat/declarations/${name}.json`, status: 'added', patch: `@@ -0,0 +1,${text.split('\n').length} @@\n` +
    text.split('\n').map(line => `+${line}`).join('\n')};
};
const handlerChange = (sha256, path = 'src/handler.js') => ({path, mode: 0, sha256});
const PINNED = '1'.repeat(64); const REPINNED = '2'.repeat(64);

test('under confirmation "diff" a re-declaration that keeps every verdict and file carries the confirmation; any other does not', async () => {
  const confirmedWith = live => {
    const f = world({earlier: [file(), declaration('compatible', [handlerChange(PINNED)], 'a'.repeat(64))], live: [file(), ...live],
      comments: [comment(OLD)]});
    return f.policy.maintainerConfirmed(f.github, repo, f.pr);
  };
  // A merge of the base re-pinned the covered file's hash: a new declaration name and digest, the same verdict over the same file.
  assert.equal(await confirmedWith([declaration('compatible', [handlerChange(REPINNED)], 'b'.repeat(64))]), true, 're-pin only');
  // The verdict changed.
  assert.equal(await confirmedWith([declaration('incompatible', [handlerChange(REPINNED)], 'b'.repeat(64))]), false, 'decision changed');
  // A file the pull request did not declare before.
  assert.equal(await confirmedWith([declaration('compatible', [handlerChange(REPINNED), handlerChange(REPINNED, 'src/other.js')], 'b'.repeat(64))]),
    false, 'a newly declared file');
  // The declaration dropped, or a second one added.
  assert.equal(await confirmedWith([]), false, 'declaration removed');
  assert.equal(await confirmedWith([declaration('compatible', [handlerChange(REPINNED)], 'b'.repeat(64)),
    declaration('compatible', [handlerChange(REPINNED, 'src/other.js')], 'c'.repeat(64))]), false, 'a second declaration');
  // Anything under the directory that is not a well-formed added declaration is an ordinary file, compared byte for byte.
  assert.equal(await confirmedWith([{...declaration('compatible', [handlerChange(REPINNED)], 'b'.repeat(64)), status: 'modified'}]), false);
});
