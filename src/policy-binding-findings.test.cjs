'use strict';
// Owner confirmation of a findings hold under local_review.confirmation "diff" (local_review.human_review "signed"). Kept apart
// from policy-binding.test.cjs so this change does not resend that file as review evidence; the fixture is that file's.
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

// A signed review that carries findings passes `{findings: true}`: only a confirmation of the exact head counts, whatever the
// setting says, and an earlier one starts no comparison. `OLD` was confirmed; `HEAD` is the live head with the same diff.
test('under confirmation "diff" a findings hold counts only a confirmation of the exact head', async () => {
  const decide = async (hold, sha = OLD, options = {}) => {
    const f = world({comments: [comment(sha)], ...options});
    const results = [await f.policy.maintainerConfirmed(f.github, repo, f.pr, hold),
      Boolean(await f.policy.purposeConfirmation(f.github, repo, f.pr, [comment(sha)], hold)),
      await f.policy.commentConfirms(f.github, repo, f.pr, `/approve-intent ${sha}`, {exact: true, ...hold})];
    assert.equal(new Set(results).size, 1, 'every confirmation check decides alike');
    return {result: results[0], calls: f.calls};
  };
  // An earlier commit whose diff equals the live diff (a merge of main after it, or an empty re-review commit) does not carry.
  const earlier = await decide({findings: true});
  assert.equal(earlier.result, false, 'an earlier confirmation of a findings hold');
  assert.ok(!earlier.calls.some(call => call.includes('..')), 'no comparison is made');
  // The exact head counts, without any request.
  const exact = await decide({findings: true}, HEAD);
  assert.equal(exact.result, true, 'the exact head');
  assert.ok(!exact.calls.some(call => call.includes('..')));
  // Without findings the hold confirms on the diff rule exactly as before.
  assert.equal((await decide({})).result, true, 'no findings: the diff rule');
  // With the setting off, the exact head only, findings or not.
  const off = world({comments: [comment(OLD)]});
  for (const hold of [{findings: true}, {}]) {
    assert.equal(await policies.plain.maintainerConfirmed(off.github, repo, off.pr, hold), false);
    assert.equal(await policies.plain.maintainerConfirmed(off.github, repo, {...off.pr, head: {sha: OLD}}, hold), true);
  }
  assert.deepEqual(off.calls, []);
});
