'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const exact = require('./exact-revert.cjs');
const {validateConfig} = require('./config.cjs');
const {digest} = require('./acceptance.cjs');

const id = (letter, length = 40) => letter.repeat(length);
const BASE = id('b');
const HEAD = id('e');
const repo = {owner: 'o', repo: 'r'};

// History is newest first: {sha, tree, parents}. `parents` defaults to the next commit.
function history(rows) {
  return rows.map((row, index) => ({sha: row.sha, parents: (row.parents ?? (rows[index + 1] ? [rows[index + 1].sha] : [])).map(sha => ({sha})),
    commit: {tree: {sha: row.tree}}}));
}

function world({rows, headTree = id('1'), status = 'ahead', mergeBase = BASE, headSha = HEAD}) {
  const commits = history(rows);
  return {github: {rest: {repos: {
    getCommit: async ({ref}) => ({data: {sha: headSha, commit: {tree: {sha: headTree}}, ref}}),
    compareCommitsWithBasehead: async ({basehead}) => ({data: {status, merge_base_commit: {sha: mergeBase}, basehead}}),
    listCommits: async ({page, per_page}) => ({data: commits.slice((page - 1) * per_page, page * per_page)}),
  }}}};
}

const pr = {number: 3, head: {sha: HEAD}, base: {sha: BASE, ref: 'main'}};
const run = (w, window = 10) => exact.verify({github: w.github, repo, pr, window});
const linear = (...trees) => trees.map((tree, index) => ({sha: index === 0 ? BASE : id('cdfghijk'[index]), tree: id(tree)}));

test('configuration is validated and only in protected configuration for protocol version two', () => {
  assert.deepEqual(exact.validate({window: 2}), {window: 2});
  for (const bad of [null, [], 'x', {}, {window: 1}, {window: 201}, {window: 2.5}, {window: '9'}, {window: 9, extra: 1}]) {
    assert.throws(() => exact.validate(bad), /Invalid exact_revert configuration/, JSON.stringify(bad));
  }
  const base = {...require('../test/fixtures/config.json'), version: 2, repository_policy: '.github/clouseau.md',
    acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-flash', grader: 'deepseek', grading_model: 'deepseek-flash', repair_attempts: 2}};
  assert.deepEqual(validateConfig({...base, exact_revert: {window: 50}}).exact_revert, {window: 50});
  assert.equal('exact_revert' in validateConfig(base), false);
  assert.throws(() => validateConfig({...base, exact_revert: {window: 1}}), /Invalid exact_revert/);
  assert.throws(() => validateConfig({...base, version: 1, acceptance: undefined, exact_revert: {window: 50}}), /requires acceptance protocol version two/);
});

test('an exact revert of the previous change matches the earlier accepted tree', async () => {
  // tip B (tree 2) changed A (tree 1); the PR restores tree 1.
  const verdict = await run(world({rows: linear('2', '1', '0', '9')}));
  assert.deepEqual(verdict, {matched: true, tree: id('1'), matched_commit: id('d'), distance: 1, window: 10, head_sha: HEAD, base_sha: BASE});
});

test('a root commit tree can be restored because nothing precedes it to be rolled back', async () => {
  assert.equal((await run(world({rows: linear('2', '1')}))).matched, true);
});

test('attacker: a tree that exists only on an unmerged branch or fork is not in the base history', async () => {
  const verdict = await run(world({rows: linear('2', '1', '0', '9'), headTree: id('7')}));
  assert.deepEqual(verdict, {matched: false, reason: 'the resulting tree is not a tree of the base history within the window'});
});

test('attacker: a side-branch commit merged by a merge commit is never an accepted state', async () => {
  const rows = [{sha: BASE, tree: id('4'), parents: [id('c'), id('d')]}, {sha: id('c'), tree: id('3'), parents: [id('f')]},
    {sha: id('d'), tree: id('5'), parents: [id('f')]}, {sha: id('f'), tree: id('1'), parents: [id('g')]}, {sha: id('g'), tree: id('0'), parents: []}];
  // Tree 5 only ever existed on the merged side branch: not on the first-parent chain.
  assert.equal((await run(world({rows, headTree: id('5')}))).matched, false);
  // The first-parent state before the merge is accepted (merge commit trees too).
  assert.equal((await run(world({rows, headTree: id('3')}))).matched, true);
  assert.equal((await run(world({rows, headTree: id('1')}))).matched, true);
});

test('attacker: a tree the history itself rolled back cannot be reinstated by reverting the revert', async () => {
  // 0 -> bad change (1) -> revert restores 0 (tip). Reverting the revert would reinstate 1.
  const rows = linear('0', '1', '0', '9');
  const verdict = await run(world({rows, headTree: id('1')}));
  assert.deepEqual(verdict, {matched: false, reason: 'the resulting tree was rolled back by a later base commit'});
  // The oldest tree (a root commit) was never rolled back and is still restorable.
  assert.equal((await run(world({rows, headTree: id('9')}))).matched, true);
});

test('attacker: a tree outside the history window, or whose predecessor lies outside it, is not accepted', async () => {
  const rows = linear('5', '4', '3', '2', '1');
  assert.equal((await run(world({rows, headTree: id('2')}), 3)).reason, 'the resulting tree is not a tree of the base history within the window');
  const unjudged = await run(world({rows, headTree: id('3')}), 3);
  assert.equal(unjudged.reason, 'the base history within the window cannot show that the tree was never rolled back');
  assert.equal((await run(world({rows, headTree: id('4')}), 3)).matched, true);
});

test('attacker: force-pushed history is judged only from the immutable base commit that the PR names', async () => {
  // The rewritten history does not list the old commit, so its tree is absent and nothing matches.
  const rewritten = world({rows: linear('2', '8', '0', '9'), headTree: id('1')});
  assert.equal((await run(rewritten)).matched, false);
  // A base commit that the listing does not return first yields no chain at all.
  const unrelated = world({rows: linear('2', '1').map(row => ({...row, sha: id('c') + row.sha.slice(1)}))});
  assert.deepEqual(await run(unrelated), {matched: false, reason: 'the base history is unavailable'});
  const malformed = world({rows: [{sha: BASE, tree: 'nothex'}, {sha: id('a'), tree: id('1')}]});
  assert.equal((await run(malformed)).reason, 'the base history is unavailable');
});

test('attacker: the head must be the PR head, the PR must sit on the current base, and an empty change is no revert', async () => {
  assert.equal((await run(world({rows: linear('2', '1'), headSha: id('f')}))).reason, 'the head commit tree is unavailable');
  assert.equal((await run(world({rows: linear('2', '1'), headTree: 'short'}))).reason, 'the head commit tree is unavailable');
  for (const status of ['diverged', 'behind', 'identical']) {
    assert.match((await run(world({rows: linear('2', '1'), status}))).reason, /not based on the current base commit/, status);
  }
  assert.match((await run(world({rows: linear('2', '1'), mergeBase: id('c')}))).reason, /not based on the current base commit/);
  assert.equal((await run(world({rows: linear('2', '1'), headTree: id('2')}))).reason, 'the pull request changes nothing');
});

test('history is read in bounded pages and a window larger than the history stops at its end', async () => {
  const rows = Array.from({length: 150}, (_, index) => ({sha: index === 0 ? BASE : index.toString(16).padStart(40, 'a'), tree: index.toString(16).padStart(40, '0')}));
  const pages = [];
  const w = world({rows, headTree: rows[110].tree});
  const list = w.github.rest.repos.listCommits;
  w.github.rest.repos.listCommits = async args => {pages.push(args.page); return list(args);};
  assert.equal((await run(w, 120)).matched, true);
  assert.deepEqual(pages, [1, 2]);
  pages.length = 0;
  assert.equal((await run(w, 100)).matched, false);
  assert.deepEqual(pages, [1]);
  pages.length = 0;
  assert.equal((await run(w, 200)).matched, true);
  assert.deepEqual(pages, [1, 2]);
});

function stub({controls = null, authorization = null, exempt = new Set()} = {}) {
  const calls = [];
  return {calls, REVIEW_CONTROL_REASON: 'controls', managedExemptions: async () => ({exempt, notices: []}),
    scopeReason: (_files, _pr, got) => {calls.push(got); return controls;}, purposeConfirmation: async () => authorization};
}

test('assessment writes a zero-AI record, requires owner confirmation for protected controls and otherwise continues the review', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-revert-'));
  try {
    const recordPath = path.join(dir, 'record.json');
    const w = world({rows: linear('2', '1', '0', '9')});
    const reports = [];
    const common = {github: w.github, repo, pr, files: [], comments: [], technical: {state: 'ok'}, config: {exact_revert: {window: 10}},
      identity: {version: 2, number: 3, head_sha: HEAD, base_sha: BASE}, recordPath, report: line => reports.push(line)};
    const accepted = await exact.assess({...common, legacy: stub(), engine: {sha: 'x'}});
    assert.equal(accepted.decision, 'auto_approve');
    assert.equal(accepted.review_source, 'exact_revert');
    assert.equal(accepted.provider_api_calls, 0);
    const record = JSON.parse(fs.readFileSync(recordPath));
    assert.equal(accepted.record_digest, digest(record));
    assert.deepEqual([record.controls, record.engine, record.snapshot], [false, {sha: 'x'}, {repository: 'o/r'}]);
    assert.ok('local_authorization' in record === false);
    assert.match(reports.at(-1), /^Exact revert accepted without an AI review: the resulting tree 111111111111 is byte-identical .* CI AI calls: 0\.$/);
    // No report sink and no engine are fine.
    assert.equal((await exact.assess({...common, report: undefined, legacy: stub()})).decision, 'auto_approve');

    const authorization = {comment_id: 4};
    const owner = await exact.assess({...common, legacy: stub({controls: 'controls', authorization})});
    assert.equal(owner.decision, 'owner_decision');
    assert.deepEqual(JSON.parse(fs.readFileSync(recordPath)).local_authorization, authorization);

    fs.rmSync(recordPath);
    reports.length = 0;
    assert.equal(await exact.assess({...common, legacy: stub({controls: 'controls'})}), null);
    assert.match(reports[0], /^Exact revert not applied: protected review controls changed and the exact-head owner confirmation is missing\.$/);
    assert.equal(await exact.assess({...common, legacy: stub({controls: 'Incomplete changed-file list'})}), null);
    assert.equal(reports[1], 'Exact revert not applied: Incomplete changed-file list.');
    assert.equal(await exact.assess({...common, report: undefined, legacy: stub({controls: 'Incomplete changed-file list'})}), null);
    const miss = world({rows: linear('2', '1'), headTree: id('7')});
    assert.equal(await exact.assess({...common, github: miss.github, legacy: stub()}), null);
    assert.match(reports[2], /^Exact revert not applied: the resulting tree is not a tree of the base history/);
    assert.equal(fs.existsSync(recordPath), false);
  } finally {fs.rmSync(dir, {recursive: true});}
});

test('the first-parent chain stops at a parent outside the listing and tolerates a root', () => {
  const commits = history([{sha: BASE, tree: id('1'), parents: [id('z')]}]);
  assert.deepEqual(exact.chain(commits, BASE).map(commit => commit.sha), [BASE]);
  assert.deepEqual(exact.chain(commits, id('q')), []);
  assert.deepEqual(exact.chain(history([{sha: BASE, tree: id('1')}]), BASE).length, 1);
});

test('a record or assessment from a different frozen engine is refused before anything is read', async () => {
  const record = {exact_revert: {head_sha: HEAD, base_sha: BASE, window: 5}, snapshot: {repository: 'o/r'}, engine: {sha: 'a'}};
  const assessment = {version: 2, review_source: 'exact_revert', decision: 'auto_approve', head_sha: HEAD, base_sha: BASE,
    record_digest: digest(record), engine: {sha: 'a'}};
  const input = {github: null, repo, config: {exact_revert: {window: 5}}, context: null, legacy: null, numberFor: null};
  for (const [changed, engine] of [[{}, {sha: 'b'}], [{engine: {sha: 'b'}}, {sha: 'a'}]]) {
    await assert.rejects(exact.verifyRecord({...input, record, assessment: {...assessment, ...changed}, engine}), /Stale or altered exact-revert record/);
  }
});
