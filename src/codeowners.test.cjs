'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pattern, parse, owns, authority, approved} = require('./codeowners.cjs');

function fixture(text = '* @alice') {
  const state = {text, permissions: 'write', membership: 'active', teamPush: true, reads: [], reviews: [], missing: false};
  const github = {rest: {repos: {
    getContent: async args => {state.reads.push(args); if (state.missing || args.path !== '.github/CODEOWNERS') throw Object.assign(new Error('missing'), {status: 404});
      return {data: {encoding: 'base64', content: Buffer.from(state.text).toString('base64'), size: Buffer.byteLength(state.text)}};},
    getCollaboratorPermissionLevel: async () => ({data: {permission: state.permissions}}),
  }, teams: {
    checkPermissionsForRepoInOrg: async () => ({data: {permissions: {push: state.teamPush}}}),
    getMembershipForUserInOrg: async () => ({data: {state: state.membership}}),
  }, pulls: {listReviews: async () => ({data: state.reviews})}}, paginate: async method => (await method()).data};
  const repo = {owner: 'example', repo: 'gateway'};
  const pr = {number: 1, changed_files: 1, user: {login: 'alice', type: 'User'}, base: {sha: 'b'.repeat(40)}, head: {sha: 'a'.repeat(40)}};
  const files = [{filename: 'src/upload.js'}];
  const check = () => authority({github, repo, pr, files});
  return {state, github, repo, pr, files, check};
}

test('GitHub path precedence, rooted paths, directories, globstars and empty ownership are respected', async () => {
  const f = fixture('* @alice\n/src/ @bob\n/src/upload.js @alice\n/private/\n# comment\n');
  assert.equal((await f.check()).automatic, true);
  f.files[0].filename = 'src/other.js'; assert.equal((await f.check()).automatic, false);
  f.files[0].filename = 'private/key'; assert.deepEqual((await f.check()).groups[0].owners, []);
  for (const [glob, yes, no] of [
    ['*.js', 'deep/code.js', 'code.ts'], ['src/**', 'src/deep/file.js', 'other/file.js'], ['/src/', 'src/deep/a.js', 'deep/src/a.js'],
    ['logs/', 'deep/logs/a.txt', 'logs.txt'], ['docs/*', 'docs/a.md', 'docs/deep/a.md'],
    ['**/logs', 'deep/logs/a', 'log/a'], ['src/**/a?.js', 'src/deep/ab.js', 'src/deep/abc.js'],
    ['/root.json', 'root.json', 'deep/root.json'], ['a+b.js', 'deep/a+b.js', 'deep/ab.js'],
  ]) { assert.equal(pattern(glob).test(yes), true, glob); assert.equal(pattern(glob).test(no), false, glob); }
  assert.equal(parse('  # ignored\n*.js @alice @bob # comment\n')[0].owners.length, 2);
  for (const glob of ['', '!src', '[ab].js', '\\#src', 'a\0b', '***.js', '/private*', 'prefix?']) assert.throws(() => pattern(glob));
  for (const text of [null, 'x'.repeat(3000000), '* person@example.test', '* @bad/name/again']) assert.throws(() => parse(text));
});

test('only a live verified owner of every affected old and new path may merge automatically', async () => {
  const f = fixture('* @alice\n/private/ @bob');
  assert.equal((await f.check()).automatic, true);
  assert.equal(f.state.reads[0].ref, f.pr.base.sha);
  f.files[0].previous_filename = 'private/old.js';
  assert.equal((await f.check()).automatic, false, 'rename cannot escape old-path ownership');
  delete f.files[0].previous_filename;
  for (const permission of ['read', 'triage', 'none']) {f.state.permissions = permission; assert.equal((await f.check()).automatic, false);}
  f.state.permissions = 'write'; f.pr.user.type = 'Bot'; assert.equal((await f.check()).automatic, false);
  f.pr.user.type = 'User'; f.pr.user.login = 'outsider'; assert.equal((await f.check()).automatic, false);
  assert.equal(await owns(f.github, f.repo, 'invalid[bot]', ['@alice']), false);
  assert.equal(await owns(f.github, f.repo, undefined, ['@alice']), false);
  f.pr.user.login = 'ALICE'; assert.equal((await f.check()).automatic, true);
});

test('team authority needs same-organization explicit repository write access and active membership', async () => {
  const f = fixture('* @example/platform');
  assert.equal((await f.check()).automatic, true);
  f.state.teamPush = false; assert.equal((await f.check()).automatic, false);
  f.state.teamPush = true; f.state.membership = 'pending'; assert.equal((await f.check()).automatic, false);
  assert.equal(await owns(f.github, f.repo, 'alice', ['@other/platform']), false);
  f.github.rest.teams.getMembershipForUserInOrg = async () => {throw new Error('Membership unavailable');};
  assert.equal((await f.check()).automatic, false);
});

test('missing, inaccessible, invalid or incomplete ownership never grants automatic merge', async () => {
  const f = fixture(); f.state.missing = true;
  assert.equal((await f.check()).automatic, false);
  assert.deepEqual(f.state.reads.map(read => read.path), ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']);
  f.state.missing = false;
  f.state.text = '* @alice\n/private* @bob';
  f.files[0].filename = 'private-data/key.txt';
  assert.equal((await f.check()).automatic, false, 'ambiguous directory glob cannot fall through to the global owner');
  f.state.text = '* @alice';
  f.files.length = 0; assert.equal((await f.check()).automatic, false);
  f.files.push({filename: 'a.js'}); f.pr.changed_files = 2; assert.equal((await f.check()).automatic, false);
  f.pr.changed_files = 1; f.state.text = ''; assert.equal((await f.check()).automatic, false);
  for (const data of [{encoding: 'utf8', content: 'x'}, {encoding: 'base64', content: 'eA==', size: 3000000},
    {encoding: 'base64', content: Buffer.from([255]).toString('base64')}]) {
    f.github.rest.repos.getContent = async () => ({data}); assert.equal((await f.check()).automatic, false);
  }
  f.github.rest.repos.getContent = async () => {throw new Error('API unavailable');};
  assert.equal((await f.check()).automatic, false);
  f.github.rest.repos.getContent = async args => {if (args.path !== 'CODEOWNERS') throw Object.assign(new Error(), {status: 404}); return {data: {encoding: 'base64', content: Buffer.from('* @alice').toString('base64')}};};
  assert.equal((await f.check()).location, 'CODEOWNERS');
});

test('external contributions require actual current-head code-owner approval, never bot approval or stale/dismissed review', async () => {
  const f = fixture('* @alice\n/docs/ @bob'); f.pr.user.login = 'contributor';
  f.files.push({filename: 'docs/a.md'}); f.pr.changed_files = 2;
  const ownership = await f.check(); assert.equal(ownership.automatic, false);
  const check = () => approved({...f, ownership});
  const review = (login, state = 'APPROVED', sha = f.pr.head.sha, type = 'User') => ({user: {login, type}, state, commit_id: sha});
  assert.equal(await check(), false);
  f.state.reviews = [review('alice'), review('bob')]; assert.equal(await check(), true);
  f.state.reviews.push(review('alice', 'COMMENTED')); assert.equal(await check(), true);
  f.state.reviews.push(review('alice', 'DISMISSED')); assert.equal(await check(), false);
  f.state.reviews = [review('alice', 'APPROVED', 'b'.repeat(40)), review('bob')]; assert.equal(await check(), false);
  f.state.reviews = [review('alice', 'APPROVED', f.pr.head.sha, 'Bot'), review('contributor'), review('bob')]; assert.equal(await check(), false);
  f.state.reviews = [review('alice'), review('bob')];
  f.github.rest.repos.getCollaboratorPermissionLevel = async () => {throw new Error('Unavailable');};
  assert.equal(await check(), false);
  assert.equal(await approved({...f, ownership: {groups: []}}), false);
  assert.equal(await approved({...f, ownership: {groups: [{owners: []}]}}), false);
});
