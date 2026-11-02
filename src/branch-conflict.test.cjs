'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {conflicting, mark, reasonFor, body, surface, STEPS, MARKER, CAUSE} = require('./branch-conflict.cjs');

const repo = {owner: 'example', repo: 'product'};
const head = 'a'.repeat(40), base = 'b'.repeat(40), moved = 'c'.repeat(40);
const assessment = {number: 4, head_sha: head, base_sha: base};

// A client whose pull request answers come from the queue, one per read; the last answer repeats.
function reader(...answers) {
  const reads = [];
  return {reads, github: {rest: {pulls: {get: async () => {reads.push(1); return {data: {head: {sha: head}, ...(answers.length > 1 ? answers.shift() : answers[0])}};}}}}};
}

test('only a definite conflict on the assessed head is a conflict', async () => {
  const waits = [];
  const wait = async ms => waits.push(ms);
  const check = async (answer, sha = head) => conflicting({github: reader(answer).github, repo, number: 4, headSha: sha, wait});
  assert.equal(await check({mergeable: false, mergeable_state: 'dirty'}), true);
  for (const answer of [{mergeable: false, mergeable_state: 'blocked'}, {mergeable: true, mergeable_state: 'clean'}, {mergeable: true, mergeable_state: 'dirty'}, {}]) {
    assert.equal(await check(answer), false, JSON.stringify(answer));
  }
  assert.equal(await check({mergeable: false, mergeable_state: 'dirty'}, moved), false, 'a push after the assessment is another revision');
  assert.deepEqual(waits, [], 'a computed answer is never waited for');
});

test('a mergeability that GitHub is still computing is re-read a bounded number of times and never guessed', async () => {
  const waits = [];
  const wait = async ms => waits.push(ms);
  const computing = {mergeable: null, mergeable_state: 'unknown'};
  const settled = reader(computing, computing, {mergeable: false, mergeable_state: 'dirty'});
  assert.equal(await conflicting({github: settled.github, repo, number: 4, headSha: head, wait}), true);
  assert.equal(settled.reads.length, 3); assert.deepEqual(waits, [2000, 4000]);
  waits.length = 0;
  const never = reader(computing);
  assert.equal(await conflicting({github: never.github, repo, number: 4, headSha: head, wait}), false, 'still unknown after the bound: no notice');
  assert.equal(never.reads.length, 4); assert.deepEqual(waits, [2000, 4000, 8000]);
});

test('a pull request the caller just read is judged without another read', async () => {
  const idle = reader({mergeable: true});
  const known = {head: {sha: head}, mergeable: false, mergeable_state: 'dirty'};
  assert.equal(await conflicting({github: idle.github, repo, number: 4, headSha: head, wait: async () => {}, known}), true);
  assert.equal(idle.reads.length, 0);
  const computing = {head: {sha: head}, mergeable: null};
  assert.equal(await conflicting({github: idle.github, repo, number: 4, headSha: head, wait: async () => {}, known: computing}), false, 'an unknown answer is re-read and then judged');
  assert.equal(idle.reads.length, 1);
});

test('mark names the cause only on an absent verification of a conflicting head', async () => {
  const wait = async () => {};
  const result = {number: 4, head_sha: head, decision: 'pending_technical', verification: 'absent', reason: 'Waiting'};
  const dirty = reader({mergeable: false, mergeable_state: 'dirty'});
  const marked = await mark(result, {github: dirty.github, repo, baseBranch: 'trunk', wait});
  assert.deepEqual(marked, {...result, cause: CAUSE, reason: reasonFor('trunk')});
  assert.match(marked.reason, /^Merge conflict with trunk: GitHub does not run PR verification/);
  const queued = {...result, verification: 'queued'};
  assert.equal(await mark(queued, {github: dirty.github, repo, baseBranch: 'trunk', wait}), queued, 'a verification that exists is never a conflict');
  assert.equal(dirty.reads.length, 1, 'and costs no read');
  const clean = reader({mergeable: true, mergeable_state: 'clean'});
  assert.equal(await mark(result, {github: clean.github, repo, baseBranch: 'trunk', wait}), result);
});

test('the notice names the cause, the base and numbered steps, and holds no placeholder', () => {
  const text = body(assessment, 'trunk');
  assert.ok(text.startsWith(`<!-- ${MARKER}:${head}:${base} -->\n## Clouseau: merge conflict\n`));
  assert.match(text, /\*\*Cause:\*\* `branch_conflict`: this pull request has a merge conflict with `trunk`\./);
  assert.ok(text.includes('GitHub does not start pull request verification for a branch that cannot be merged'));
  assert.ok(text.includes(`revision \`${head.slice(0, 12)}\``) && text.includes('does not report which files conflict'));
  assert.match(text, /\*\*Next steps:\*\*\n\n1\. .*`git fetch origin && git merge origin\/trunk`.*never rebase.*\n2\. .*`clouseau refresh --pr 4 --request-file REQUIREMENT_FILE.*\n3\. Verification .*only after the conflict is resolved and pushed/);
  assert.ok(!/[{}]/.test(text) && !text.includes('@'));
  assert.equal(STEPS[CAUSE].length, 3);
});

function client(comments = []) {
  const writes = [];
  const github = {rest: {issues: {listComments: async () => ({data: comments}),
    createComment: async args => {writes.push(['create', args]); comments.push({user: {login: 'github-actions[bot]'}, body: args.body});},
    updateComment: async args => writes.push(['update', args])}}};
  github.paginate = async (method, args) => (await method(args)).data;
  return {github, writes};
}

test('one notice per head and base: a rerun posts nothing, a moved base updates it, a new head posts its own', async () => {
  const {github, writes} = client([{user: {login: 'someone'}, body: `<!-- ${MARKER}:${head}:${base} -->\nforged`}]);
  await surface({github, repo, assessment, baseBranch: 'main'});
  assert.equal(writes.length, 1); assert.equal(writes[0][0], 'create'); assert.equal(writes[0][1].issue_number, 4);
  await surface({github, repo, assessment, baseBranch: 'main'});
  assert.equal(writes.length, 1, 'the same head and base never spams the pull request');
  const owned = client([{id: 9, user: {login: 'github-actions[bot]'}, body: body(assessment, 'main')}]);
  await surface({github: owned.github, repo, assessment: {...assessment, base_sha: moved}, baseBranch: 'main'});
  assert.equal(owned.writes.length, 1); assert.equal(owned.writes[0][0], 'update'); assert.equal(owned.writes[0][1].comment_id, 9);
  assert.ok(owned.writes[0][1].body.startsWith(`<!-- ${MARKER}:${head}:${moved} -->\n`));
  await surface({github: owned.github, repo, assessment: {...assessment, head_sha: 'd'.repeat(40)}, baseBranch: 'main'});
  assert.equal(owned.writes[1][0], 'create', 'a new head receives its own notice');
});
