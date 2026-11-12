'use strict';
// Refresh behavior under the protected local_review.binding setting. Kept apart from pr-refresh.test.cjs so a change here does not resend that file as review evidence.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {git} = require('./local-git.cjs');
const {digest} = require('./acceptance.cjs');
const {initializeIdentity, main} = require('./local-cli.cjs');
const crypto = require('node:crypto');
const {refreshPull, withMarker, bindsDiff, localDiff} = require('./pr-refresh.cjs');
const {receiptStanding, githubReader} = require('./receipt-standing.cjs');
const {issueReceipt} = require('./local-receipt.cjs');

const GITHUB = 'git@github.com:example/local-fixture.git';
const MARKER = sha => `<!-- clouseau-local-review:v1 ${sha} -->`;
const installed = () => ({sha: 'e'.repeat(40), digest: 'e'.repeat(64), clean: true});

function fakeHarness(calls) {
  let count = 0;
  return async task => {
    calls.push(`${task.role}:${task.phase}`);
    let value;
    if (task.phase === 'investigation') {
      const report = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1)).template;
      report.gates.forEach(gate => {gate.state = 'satisfied';});
      value = {kind: 'report', report, request_sources: []};
    } else if (task.phase === 'integration') {
      value = {dispositions: JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1)).seams.map(seam => ({seam: seam.id, state: 'checked', reason: 'Both ends hold.'}))};
    } else value = {answers: Object.fromEntries(Object.keys(task.schema.properties.answers.properties).map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))};
    return {value, provenance: {harness: 'claude', role: task.role, phase: task.phase, session: `fictional-session-${++count}`,
      request_digest: digest(task), response_digest: digest(value), transport_digest: digest({fixture_only: value})}};
  };
}

// Five lines: the pull request edits the third, the base may edit the fifth, and the fourth keeps the two apart.
const handler = (body, tail) => `// Handler.\nconst MARK = 1;\nmodule.exports = input => ${body};\nconst END = 2;\n// tail: ${tail}\n`;

// A pull request fixture: a bare "GitHub" origin, a working clone on the feature branch, and a second clone that moves main.
function githubFiles(bare, head) {
  const base = git(bare, ['merge-base', 'refs/heads/main', head]).trim();
  const statuses = {A: 'added', M: 'modified', D: 'removed'};
  return git(bare, ['diff', '--name-status', base, head]).trim().split('\n').filter(Boolean).map(line => {
    const [code, filename] = line.split('\t');
    const text = git(bare, ['diff', '--no-ext-diff', '--no-textconv', base, head, '--', filename]);
    return {filename, status: statuses[code[0]], patch: text.slice(text.indexOf('@@')).replace(/\n$/, '')};
  });
}

async function pullRepository(run, {ciConfig = null, files = {}} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-refresh-'));
  try {
    const bare = path.join(root, 'origin.git'); git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
    const work = path.join(root, 'work'); fs.mkdirSync(work);
    const commit = (directory, message) => {git(directory, ['add', '.']); git(directory, ['commit', '-qm', message]);};
    const identify = directory => {git(directory, ['config', 'user.name', 'Fixture']); git(directory, ['config', 'user.email', 'fixture@example.invalid']);};
    git(work, ['init', '-q', '-b', 'main']); identify(work);
    git(work, ['remote', 'add', 'origin', GITHUB]);
    // The real transport, served from the bare repository: git runs this in place of ssh to github.com.
    const ssh = path.join(root, 'ssh'); fs.writeFileSync(ssh, `#!/bin/sh\nfor last; do :; done\ncommand=$(printf '%s' "$last" | sed -e 's#^git-#git #' -e "s#example/local-fixture.git#${bare}#")\nexec sh -c "$command"\n`, {mode: 0o755});
    process.env.GIT_SSH_COMMAND = ssh;
    fs.mkdirSync(path.join(work, 'src'));
    const write = (directory, name, text) => {fs.mkdirSync(path.dirname(path.join(directory, name)), {recursive: true}); fs.writeFileSync(path.join(directory, name), text);};
    write(work, 'README.md', 'Handle an accepted request and reject missing input.\n');
    write(work, 'AGENTS.md', 'Preserve purpose and meaningful tests.\n');
    write(work, '.gitignore', 'coverage.json\n');
    write(work, '.clouseau-local.json', JSON.stringify({version: 1, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md',
      verification: [['node', '--version']], coverage: {format: 'istanbul', report: 'coverage.json', source_directory: 'src'}}));
    write(work, 'src/handler.js', handler('Boolean(input)', 'base'));
    write(work, 'src/unrelated.js', 'module.exports = 0;\n');
    if (ciConfig) write(work, '.github/clouseau.json', JSON.stringify(ciConfig));
    for (const [name, text] of Object.entries(files)) write(work, name, text);
    commit(work, 'feat: accept input'); git(work, ['push', '-q', 'origin', 'main']);
    git(work, ['checkout', '-q', '-b', 'feature']);
    write(work, 'src/handler.js', handler('{ if (!input) throw Error("Missing input"); return true; }', 'base'));
    write(work, 'src/new.js', 'module.exports = 1;\n');
    commit(work, 'fix: reject missing input'); git(work, ['push', '-q', 'origin', 'feature']);
    const other = path.join(root, 'other'); git(root, ['clone', '-q', bare, other]); identify(other);
    const advance = (name, text, message = 'chore: move main') => {
      write(other, name, text); commit(other, message); git(other, ['push', '-q', 'origin', 'main']);
      return git(other, ['rev-parse', 'HEAD']).trim();
    };
    const head = () => git(work, ['rev-parse', 'HEAD']).trim();
    const remoteHead = () => git(bare, ['rev-parse', 'refs/heads/feature']).trim();
    const pull = {number: 7, author: 'fixture-author', state: 'open', base: 'main', head: head(), ref: 'feature', repository: 'example/local-fixture', title: 'fix: reject missing input', body: 'Body.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'};
    const events = [];
    const execute = (program, args, options) => {
      assert.equal(program, 'gh');
      if (args.includes('PATCH')) {
        pull.body = JSON.parse(options.input).body;
        events.push(`patch:${remoteHead() === pull.head ? 'before-push' : 'after-push'}`);
        return '';
      }
      // The two reads that loading a receipt makes: a file of the commit a marker names, as the contents API serves it.
      const content = /^repos\/example\/local-fixture\/contents\/([^?]+)\?ref=([0-9a-f]{40})$/.exec(args[1]);
      if (content) {
        let text;
        try {text = git(bare, ['show', `${content[2]}:${content[1]}`]);} catch {throw Object.assign(new Error('gh failed'), {stderr: 'gh: Not Found (HTTP 404)'});}
        return JSON.stringify({type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text)});
      }
      // The changed files of the pull request as GitHub lists them: the three-dot diff, each patch without its git header.
      if (/^repos\/example\/local-fixture\/pulls\/7\/files\?per_page=100&page=1$/.test(args[1])) return JSON.stringify(githubFiles(bare, pull.head));
      events.push('read');
      // The count GitHub reports; a fictional or unrelated head has none.
      let changed;
      try {changed = githubFiles(bare, pull.head).length;} catch {changed = undefined;}
      return JSON.stringify({...pull, base_sha: git(bare, ['rev-parse', 'refs/heads/main']).trim(), changed_files: changed});
    };
    return await run({root, bare, work, other, advance, head, remoteHead, pull, events, execute, commit, write});
  } finally {delete process.env.GIT_SSH_COMMAND; fs.rmSync(root, {recursive: true, force: true});}
}

const request = (root, text = 'Reject missing input.') => {
  const filename = path.join(root, 'requirement.txt'); fs.writeFileSync(filename, text); return filename;
};
const stub = (extra = {}) => {
  const seen = {reviews: [], extras: [], publishes: [], standings: []};
  return {seen, standing: async given => {seen.standings.push(given); return extra.standing || {applicable: true, usable: true};}, installed, review: async (args, options) => {seen.reviews.push(args); seen.extras.push(options); return extra.result || {decision: 'auto_approve', receipt: '/receipt.json', head_sha: seen.reviews.length ? extra.head() : null};},
    publish: async args => {seen.publishes.push(args); return {marker: MARKER('1'.repeat(40)), artifact_commit: '1'.repeat(40)};}};
};
const args = (f, extra = {}) => ({pr: '7', directory: f.work, 'request-file': request(f.root), harness: 'claude', ...extra});
const unchanged = (f, before) => {assert.equal(f.head(), before); assert.equal(git(f.work, ['status', '--porcelain']), '');};

// A signed fixture: an enrolled identity, the protected configuration that trusts it, and a runtime with a counting reviewer.
function signedFixture(t, localReview = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-refresh-state-'));
  t.after(() => fs.rmSync(state, {recursive: true, force: true}));
  const identity = initializeIdentity(state, 'fixture-author');
  const config = {...require('../test/fixtures/config.json'), version: 2, repository_policy: 'AGENTS.md', readme: 'README.md',
    acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed', grading_model: 'deepseek-flash', repair_attempts: 2},
    local_review: {mode: 'required', reviewer_digest: 'e'.repeat(64), max_age_seconds: 3600, keys: [identity.public_identity], ...localReview}};
  const calls = [];
  const runtime = f => ({state, ask: fakeHarness(calls), attest: technical => technical, verify: () => ({fixture_execution_only: true}), installed, execute: f.execute, available: () => true});
  const refresh = (f, extra = {}) => main(['refresh', '--pr', '7', '--directory', f.work,
    ...extra.request === null ? [] : ['--request-file', extra.request || request(f.root)], '--harness', 'claude'], runtime(f));
  return {state, config, calls, runtime, refresh};
}

test('under binding "diff" a base move that leaves the normalized diff unchanged is merged and pushed with no review; one that changes it is reviewed', async () => {
  const diff = {local_review: {binding: 'diff'}};
  await pullRepository(async f => {
    const before = f.head();
    const moved = f.advance('docs.md', 'moved\n');
    const covered = {...stub({standing: {applicable: true, usable: true, binding: 'diff'}}), execute: f.execute, available: () => true};
    const result = await refreshPull(args(f), covered);
    assert.equal(result.status, 'updated', JSON.stringify(result)); assert.equal(result.pushed, true); assert.equal(result.previous_head_sha, before);
    assert.match(result.note, /still covers the unchanged diff \(protected binding: diff\); nothing was reviewed or published/);
    assert.deepEqual([...covered.seen.reviews, ...covered.seen.publishes], []);
    assert.equal(f.remoteHead(), f.head(), 'the merge is pushed'); assert.equal(result.head_sha, f.head());
    assert.equal(git(f.work, ['merge-base', '--is-ancestor', moved, 'HEAD']) !== null, true, 'the branch now contains the moved base');
    assert.equal(bindsDiff(f.work, 'origin/main'), true);
    f.pull.head = f.head();
    // A receipt that does not cover the diff: the ordinary merge and review.
    f.advance('docs.md', 'moved again\n');
    const voided = {...stub({head: () => f.head(), standing: {applicable: true, usable: false, cause: 'receipt_source', sentence: 'x'}}), execute: f.execute, available: () => true};
    assert.equal((await refreshPull(args(f), voided)).status, 'refreshed'); assert.equal(voided.seen.reviews.length, 1);
  }, {ciConfig: diff});
  // The base moves inside a changed file. A distant line leaves every hunk, so the diff, unchanged: merged and pushed with no
  // review. A line inside a hunk's context changes that hunk: the merged head is reviewed.
  const long = Array.from({length: 20}, (_, index) => `const line${index} = ${index};`).join('\n') + '\n';
  for (const [line, reviewed] of [[18, false], [3, true]]) {
    await pullRepository(async f => {
      f.write(f.work, 'src/long.js', long.replace('line1 = 1;', 'line1 = 101;')); f.commit(f.work, 'fix: change an early line');
      git(f.work, ['push', '-q', 'origin', 'feature']); f.pull.head = f.head();
      const signed = localDiff(f.work, git(f.work, ['merge-base', 'HEAD', 'origin/main']).trim(), 'HEAD');
      f.advance('src/long.js', long.replace(`line${line} = ${line};`, `line${line} = ${100 + line};`));
      const covered = {...stub({head: () => f.head(), standing: {applicable: true, usable: true, binding: 'diff'}}), execute: f.execute, available: () => true};
      const result = await refreshPull(args(f), covered);
      assert.equal(result.status, reviewed ? 'refreshed' : 'updated', `line ${line}: ${JSON.stringify(result)}`);
      assert.equal(covered.seen.reviews.length, reviewed ? 1 : 0, `line ${line}`);
      assert.equal(localDiff(f.work, 'origin/main', 'HEAD') === signed, !reviewed, `line ${line}: the merged diff ${reviewed ? 'differs' : 'is unchanged'}`);
    }, {ciConfig: diff, files: {'src/long.js': long}});
  }
  await pullRepository(async f => {
    assert.equal(bindsDiff(f.work, 'origin/main'), false);
  });
});

test('through the command under binding "diff": the receipt stands across a base move and GitHub\'s update, and a new change voids it', async t => {
  const {runtime, refresh, calls, config} = signedFixture(t, {binding: 'diff'});
  await pullRepository(async f => {
    const requestFile = request(f.root);
    const first = await main(['review', '--directory', f.work, '--base', 'origin/main', '--request-file', requestFile, '--harness', 'claude'], runtime(f));
    assert.equal(first.decision, 'auto_approve');
    const published = await main(['publish', '--directory', f.work, '--receipt', first.receipt], runtime(f));
    f.pull.body = `Body.\n\n${published.marker}\n`;
    const asked = calls.length;
    const before = f.head();
    // The base moves elsewhere: refresh merges it and pushes with no review, and the receipt keeps covering the diff.
    f.advance('docs.md', 'moved\n');
    const moved = await refresh(f, {request: requestFile});
    assert.equal(moved.status, 'updated', JSON.stringify(moved)); assert.notEqual(f.head(), before); assert.equal(calls.length, asked);
    assert.equal(f.remoteHead(), f.head()); f.pull.head = f.head();
    const stands = await refresh(f, {request: requestFile});
    assert.equal(stands.status, 'up_to_date', JSON.stringify(stands)); assert.match(stands.note, /still verifies/); assert.equal(calls.length, asked);
    // GitHub updates the branch with a plain merge that leaves the diff unchanged: still up to date, as CI will judge it.
    git(f.work, ['fetch', '-q', 'origin', 'main']); git(f.work, ['merge', '-q', '--no-ff', '--no-edit', 'origin/main']);
    git(f.work, ['push', '-q', 'origin', 'HEAD:refs/heads/feature']); f.pull.head = f.head();
    const updated = await refresh(f, {request: requestFile});
    assert.equal(updated.status, 'up_to_date', JSON.stringify(updated)); assert.match(updated.note, /still verifies/); assert.equal(calls.length, asked);
    // A commit that changes a reviewed line voids it: the receipt is renewed by a new review.
    f.write(f.work, 'src/new.js', 'module.exports = 2;\n'); f.commit(f.work, 'fix: change the pull request itself');
    git(f.work, ['push', '-q', 'origin', 'HEAD:refs/heads/feature']); f.pull.head = f.head();
    const changed = await refresh(f, {request: requestFile});
    assert.equal(changed.status, 'renewed', JSON.stringify(changed)); assert.match(changed.cause, /receipt_source/); assert.ok(calls.length > asked);
  }, {ciConfig: config});
});

test('the local normalized diff names a rename by both paths and a change that shows no text by an empty patch', async () => {
  await pullRepository(async f => {
    const base = git(f.work, ['merge-base', 'HEAD', 'origin/main']).trim();
    const before = localDiff(f.work, base, 'HEAD');
    git(f.work, ['mv', 'src/unrelated.js', 'src/renamed.js']); f.write(f.work, 'src/empty.js', ''); f.commit(f.work, 'chore: rename and add an empty file');
    const after = localDiff(f.work, base, 'HEAD');
    assert.notEqual(after, before);
    // The same revisions give the same digest, and the rename's previous path counts.
    assert.equal(localDiff(f.work, base, 'HEAD'), after);
    git(f.work, ['mv', 'src/renamed.js', 'src/elsewhere.js']); f.commit(f.work, 'chore: rename again');
    assert.notEqual(localDiff(f.work, base, 'HEAD'), after);
  });
});

test('the local normalized diff reads paths git would quote or treat as globs as the same literal paths', async () => {
  await pullRepository(async f => {
    const base = git(f.work, ['merge-base', 'HEAD', 'origin/main']).trim();
    for (const name of ['src/café.js', 'src/[ab].js', 'src/tab\there.js']) {
      const before = localDiff(f.work, base, 'HEAD');
      f.write(f.work, name, 'module.exports = 1;\n'); f.commit(f.work, `chore: add ${JSON.stringify(name)}`);
      const added = localDiff(f.work, base, 'HEAD');
      assert.notEqual(added, before, `${JSON.stringify(name)} is in the diff`);
      f.write(f.work, name, 'module.exports = 2;\n'); f.commit(f.work, `chore: change ${JSON.stringify(name)}`);
      assert.notEqual(localDiff(f.work, base, 'HEAD'), added, `a change to ${JSON.stringify(name)} changes the diff: its patch is not empty`);
    }
  });
});

test('under binding "diff" a refresh that merged the base and then has no requirement leaves the branch as it found it', async () => {
  const long = Array.from({length: 20}, (_, index) => `const line${index} = ${index};`).join('\n') + '\n';
  await pullRepository(async f => {
    f.write(f.work, 'src/long.js', long.replace('line1 = 1;', 'line1 = 101;')); f.commit(f.work, 'fix: change an early line');
    git(f.work, ['push', '-q', 'origin', 'feature']); f.pull.head = f.head();
    const before = f.head();
    // The base changes a line inside the hunk's context, so the merge changes the diff and a review would be needed.
    f.advance('src/long.js', long.replace('line3 = 3;', 'line3 = 103;'));
    // An empty state directory: no stored requirement for this branch.
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-refresh-empty-'));
    const covered = {...stub({head: () => f.head(), standing: {applicable: true, usable: true, binding: 'diff'}}), state, execute: f.execute, available: () => true};
    try {await assert.rejects(refreshPull(args(f, {'request-file': undefined}), covered), /requirement/i);}
    finally {fs.rmSync(state, {recursive: true, force: true});}
    unchanged(f, before);
    assert.deepEqual([...covered.seen.reviews, ...covered.seen.publishes], []);
  }, {ciConfig: {local_review: {binding: 'diff'}}, files: {'src/long.js': long}});
});
