'use strict';
// Refresh behavior under the protected local_review.human_review setting. Kept apart from pr-refresh.test.cjs so a change here does not resend that file as review evidence.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {git} = require('./local-git.cjs');
const {digest} = require('./acceptance.cjs');
const {initializeIdentity, main} = require('./local-cli.cjs');
const crypto = require('node:crypto');
const {refreshPull, withMarker} = require('./pr-refresh.cjs');
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
      events.push('read');
      return JSON.stringify({...pull, base_sha: git(bare, ['rev-parse', 'refs/heads/main']).trim()});
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

test('under human_review "signed" a review with findings is signed, stands for refresh, and is never reviewed again by it; without it nothing is signed', async t => {
  const violating = calls => {
    const pass = fakeHarness(calls);
    return async task => {
      if (task.phase !== 'investigation') return pass(task);
      const answer = await pass(task);
      const gate = answer.value.report.gates.find(item => item.name !== 'test_integrity'); gate.state = 'violated';
      return {...answer, value: answer.value, provenance: {...answer.provenance, response_digest: digest(answer.value)}};
    };
  };
  for (const humanReview of [true, false]) {
    const {runtime, refresh, calls, config} = signedFixture(t, humanReview ? {human_review: 'signed'} : {});
    await pullRepository(async f => {
      const requestFile = request(f.root);
      const asked = {...runtime(f), ask: violating(calls)};
      const first = await main(['review', '--directory', f.work, '--base', 'origin/main', '--request-file', requestFile, '--harness', 'claude'], asked);
      assert.equal(first.decision, 'repair_required');
      if (!humanReview) {assert.equal(first.receipt, null, 'without the opt-in a review with findings signs nothing'); return;}
      assert.ok(first.receipt, 'with the opt-in the review with findings is signed');
      const published = await main(['publish', '--directory', f.work, '--receipt', first.receipt], asked);
      f.pull.body = `Body.\n\n${published.marker}\n`;
      const before = calls.length;
      const standing = await refresh(f, {request: requestFile});
      assert.equal(standing.status, 'up_to_date', JSON.stringify(standing));
      assert.match(standing.note, /its signed review requires a human: a maintainer approves this head with \/approve-intent [a-f0-9]{40}/);
      assert.equal(calls.length, before, 'nothing is reviewed again');
    }, {ciConfig: config});
  }
});
