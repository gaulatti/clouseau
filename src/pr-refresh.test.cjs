'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {git} = require('./local-git.cjs');
const {digest} = require('./acceptance.cjs');
const {initializeIdentity, main} = require('./local-cli.cjs');
const {refreshPull, withMarker} = require('./pr-refresh.cjs');

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
    const pull = {state: 'open', base: 'main', head: head(), ref: 'feature', repository: 'example/local-fixture', title: 'fix: reject missing input', body: 'Body.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'};
    const events = [];
    const execute = (program, args, options) => {
      assert.equal(program, 'gh');
      if (args.includes('PATCH')) {
        pull.body = JSON.parse(options.input).body;
        events.push(`patch:${remoteHead() === pull.head ? 'before-push' : 'after-push'}`);
        return '';
      }
      events.push('read');
      return JSON.stringify(pull);
    };
    return await run({root, bare, work, other, advance, head, remoteHead, pull, events, execute, commit, write});
  } finally {delete process.env.GIT_SSH_COMMAND; fs.rmSync(root, {recursive: true, force: true});}
}

const request = (root, text = 'Reject missing input.') => {
  const filename = path.join(root, 'requirement.txt'); fs.writeFileSync(filename, text); return filename;
};
const stub = (extra = {}) => {
  const seen = {reviews: [], extras: [], publishes: []};
  return {seen, review: async (args, options) => {seen.reviews.push(args); seen.extras.push(options); return extra.result || {decision: 'auto_approve', receipt: '/receipt.json', head_sha: seen.reviews.length ? extra.head() : null};},
    publish: async args => {seen.publishes.push(args); return {marker: MARKER('1'.repeat(40)), artifact_commit: '1'.repeat(40)};}};
};
const args = (f, extra = {}) => ({pr: '7', directory: f.work, 'request-file': request(f.root), harness: 'claude', ...extra});
const unchanged = (f, before) => {assert.equal(f.head(), before); assert.equal(git(f.work, ['status', '--porcelain']), '');};

test('the pull request body keeps exactly one marker: replaced where it was, appended when absent', () => {
  const next = MARKER('2'.repeat(40));
  assert.equal(withMarker('', next), `${next}\n`);
  assert.equal(withMarker('Body.\n\n', next), `Body.\n\n${next}\n`);
  assert.equal(withMarker(`Body.\n${MARKER('1'.repeat(40))}\nTail`, next), `Body.\n${next}\nTail`);
  assert.equal(withMarker(`${MARKER('1'.repeat(40))} and ${MARKER('3'.repeat(40))} end`, next), `${next}  and  end`.replace('  and  end', ' and  end'));
});

test('refresh refuses before it changes anything: arguments, harness, dirty worktree, pull request facts, head, conflicts', async () => {
  await pullRepository(async f => {
    f.advance('docs.md', 'moved\n');  // a refresh has something to do, so it gets as far as needing a requirement
    const before = f.head(); const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-refresh-empty-'));
    const dependencies = {...stub(), execute: f.execute, available: () => true, state: empty};
    const refuses = (given, pattern, dependency = dependencies) => assert.rejects(refreshPull(given, dependency), pattern);
    await refuses({...args(f), pr: 'x'}, /pull request number/);
    await refuses({...args(f), pr: undefined}, /pull request number/);
    await refuses({...args(f), 'request-file': undefined}, /No accepted review of example\/local-fixture branch feature is recorded.*--request-file/);
    await refuses({...args(f), harness: undefined}, /exactly one of --agent/);
    await refuses({...args(f), agent: 'claude'}, /exactly one of --agent/);
    await refuses({...args(f), harness: undefined, agent: 'nope'}, /Supported agent harnesses/);
    await refuses({...args(f), harness: 'nope'}, /Unsupported --harness/);
    await refuses(args(f), /claude harness is not installed/, {...dependencies, available: () => false});
    fs.writeFileSync(path.join(f.work, 'untracked.txt'), 'x');
    await refuses(args(f), /uncommitted or untracked/);
    fs.rmSync(path.join(f.work, 'untracked.txt'));
    for (const [change, pattern] of [[{state: 'closed'}, /not open/], [{repository: 'someone/fork'}, /comes from someone\/fork/],
      [{ref: 'other-branch'}, /not the pull request branch other-branch/], [{base: 'release'}, /against release, not the configured base main/],
      [{head: 'f'.repeat(40)}, /is not the head of pull request 7/], [{title: ''}, /has no title/], [{title: undefined}, /has no title/]]) {
      const original = {...f.pull}; Object.assign(f.pull, change);
      await refuses(args(f), pattern); Object.assign(f.pull, original);
    }
    // A detached head is not the pull request branch.
    git(f.work, ['checkout', '-q', '--detach']);
    await refuses(args(f), /not the pull request branch feature/);
    git(f.work, ['checkout', '-q', 'feature']);
    // A head that is a merge, but not of this pull request head and the base, is not resumable either.
    git(f.work, ['commit', '-q', '--allow-empty', '-m', 'chore: local only']);
    await refuses(args(f), /is not the head of pull request 7/);
    git(f.work, ['reset', '-q', '--hard', before]);
    assert.deepEqual(dependencies.seen.reviews, []);
    unchanged(f, before);
    fs.rmSync(empty, {recursive: true, force: true});
  });
});

test('refresh leaves the checkout alone on a conflict, an unrelated base and a refused merge, and does nothing when the base is already merged', async () => {
  await pullRepository(async f => {
    const before = f.head(); const dependencies = {...stub(), execute: f.execute, available: () => true};
    assert.equal((await refreshPull(args(f), dependencies)).status, 'up_to_date');
    const cwd = process.cwd(); process.chdir(f.work);
    try {assert.equal((await refreshPull(args(f, {directory: undefined}), dependencies)).status, 'up_to_date', 'the checkout defaults to the current directory');}
    finally {process.chdir(cwd);}
    f.advance('src/handler.js', 'module.exports = "main";\n');
    await assert.rejects(refreshPull(args(f), dependencies), error => {
      assert.match(error.message, /origin\/main cannot be merged cleanly \(conflicts in src\/handler\.js\)\. Nothing was changed/);
      return true;
    });
    unchanged(f, before);
    assert.ok(!fs.existsSync(path.join(f.work, '.git/MERGE_HEAD')));
    // A history unrelated to the pull request's cannot be merged cleanly either, and git's own reason is shown.
    git(f.other, ['checkout', '-q', '--orphan', 'fresh']); git(f.other, ['rm', '-rfq', '.']);
    f.write(f.other, 'README.md', 'unrelated\n'); f.commit(f.other, 'chore: unrelated root');
    git(f.other, ['push', '-q', '-f', 'origin', 'fresh:main']);
    await assert.rejects(refreshPull(args(f), dependencies), /origin\/main cannot be merged cleanly \(.*unrelated histories/);
    unchanged(f, before);
    assert.deepEqual(dependencies.seen.reviews, []);
  });
});

test('a refused merge (a hook) is aborted and reported without a half-made merge', async () => {
  await pullRepository(async f => {
    const before = f.head(); const dependencies = {...stub(), execute: f.execute, available: () => true};
    f.advance('docs.md', 'moved\n');
    const hook = path.join(f.work, '.git/hooks/pre-merge-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho refused-by-hook >&2\nexit 1\n', {mode: 0o755});
    await assert.rejects(refreshPull(args(f), dependencies), /Merging origin\/main failed \(.*\); the branch is unchanged and nothing was pushed/);
    unchanged(f, before);
    assert.ok(!fs.existsSync(path.join(f.work, '.git/MERGE_HEAD')));
  });
});

test('a refresh merges the base (never a rebase), reviews the merge commit, and pushes once after the marker is in the body', async () => {
  await pullRepository(async f => {
    const before = f.head();
    const moved = f.advance('docs.md', 'moved\n');
    const dependencies = {...stub({head: () => f.head()}), execute: f.execute, available: () => true};
    const result = await refreshPull(args(f), dependencies);
    assert.equal(result.status, 'refreshed'); assert.equal(result.pushed, true); assert.equal(result.previous_head_sha, before);
    const merged = f.head();
    assert.notEqual(merged, before);
    assert.deepEqual(git(f.work, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').slice(1), [before, moved], 'a merge of the old head and the base tip');
    assert.equal(git(f.work, ['log', '-1', '--format=%s']).trim(), 'Merge origin/main into feature');
    assert.equal(f.remoteHead(), merged, 'pushed once, as a fast-forward');
    assert.equal(dependencies.seen.reviews.length, 1);
    assert.equal(dependencies.seen.reviews[0].base, 'origin/main'); assert.equal(dependencies.seen.reviews[0].harness, 'claude');
    assert.deepEqual(dependencies.seen.publishes, [{directory: f.work, receipt: '/receipt.json'}]);
    assert.deepEqual(dependencies.seen.extras, [{title: 'fix: reject missing input'}], 'the review is given the pull request title, not the merge subject');
    assert.equal(result.warnings, undefined);
    assert.ok(f.pull.body.includes(MARKER('1'.repeat(40))) && f.pull.body.includes('Generated with'), 'the marker joins the existing body');
    assert.deepEqual(f.events.filter(event => event.startsWith('patch')), ['patch:before-push']);
    assert.equal(git(f.work, ['status', '--porcelain']), '');
  });
});

test('publication warnings (protected controls changed) reach the result', async () => {
  await pullRepository(async f => {
    f.advance('docs.md', 'moved\n');
    const dependencies = {...stub({head: () => f.head()}), execute: f.execute, available: () => true};
    const publish = dependencies.publish;
    dependencies.publish = async given => ({...await publish(given), warnings: ['Protected review controls changed (x)']});
    assert.deepEqual((await refreshPull(args(f), dependencies)).warnings, ['Protected review controls changed (x)']);
  });
});

test('a review that does not pass, awaits an agent or fails never pushes; neither does a pass without a receipt', async () => {
  await pullRepository(async f => {
    const before = f.head(); const moved = f.advance('docs.md', 'moved\n');
    const run = async (result, extra = {}) => refreshPull(args(f, extra), {...stub({result}), execute: f.execute, available: () => true});
    const held = await run({decision: 'repair_required', receipt: null});
    assert.equal(held.pushed, false); assert.equal(held.decision, 'repair_required'); assert.match(held.note, /merge commit remains in the local branch/);
    assert.equal(f.remoteHead(), before); assert.equal(f.pull.body.includes('clouseau-local-review'), false);
    const merged = f.head();
    // The interrupted refresh resumes on its own merge commit: no second merge, no new fetch of the base.
    f.advance('docs2.md', 'moved again\n');
    const awaiting = await run({status: 'awaiting_agent', request_file: 'r', then: 'old'}, {harness: undefined, agent: 'claude'});
    assert.equal(awaiting.pushed, false); assert.match(awaiting.then, /Repeat the identical refresh command/);
    assert.equal(f.head(), merged, 'resuming does not merge again');
    const failed = await run({status: 'failed', reason: 'source_not_found', path: 'x'});
    assert.equal(failed.status, 'failed'); assert.equal(failed.pushed, false);
    await assert.rejects(run({decision: 'auto_approve', receipt: null}), /produced no signed receipt.*nothing was pushed/);
    assert.equal(f.remoteHead(), before); assert.equal(f.head(), merged); assert.equal(moved.length, 40);
  });
});

test('a pass is not pushed when the checkout, the pull request or the push itself changed underneath it', async () => {
  const scenarios = [
    ['the checkout', f => f.write(f.work, 'late.txt', 'x'), /Local source changed during review/],
    ['a closed pull request', f => {f.pull.state = 'closed';}, /changed during the refresh \(head .*\); nothing was pushed/],
    ['a moved pull request head', f => {f.pull.head = 'c'.repeat(40);}, /changed during the refresh \(head c+, expected [0-9a-f]{40}\); nothing was pushed/],
  ];
  for (const [name, mutate, pattern] of scenarios) {
    await pullRepository(async f => {
      const before = f.head(); f.advance('docs.md', 'moved\n');
      const dependencies = {...stub(), execute: f.execute, available: () => true,
        review: async () => {mutate(f); return {decision: 'auto_approve', receipt: '/receipt.json', head_sha: git(f.work, ['rev-parse', 'HEAD']).trim()};}};
      await assert.rejects(refreshPull(args(f), dependencies), pattern, name);
      assert.equal(f.remoteHead(), before, `${name}: nothing was pushed`);
      assert.deepEqual(f.events.filter(event => event.startsWith('patch')), [], `${name}: the body was not edited`);
    });
  }
  // The branch moved on GitHub (a non-fast-forward push): the body edit is undone and the failure says so.
  await pullRepository(async f => {
    f.advance('docs.md', 'moved\n');
    const theirs = path.join(f.root, 'theirs'); git(f.root, ['clone', '-q', f.bare, theirs]);
    git(theirs, ['config', 'user.name', 'T']); git(theirs, ['config', 'user.email', 't@example.invalid']);
    git(theirs, ['checkout', '-q', 'feature']); f.write(theirs, 'theirs.txt', 'x'); f.commit(theirs, 'chore: someone else pushed');
    git(theirs, ['push', '-q', 'origin', 'feature']);
    const pushed = git(f.bare, ['rev-parse', 'refs/heads/feature']).trim();
    const original = f.pull.body;
    await assert.rejects(refreshPull(args(f), {...stub({head: () => f.head()}), execute: f.execute, available: () => true}),
      /The push failed \(.*\); the pull request body was restored and the branch on GitHub is unchanged/);
    assert.equal(f.pull.body, original); assert.equal(f.remoteHead(), pushed);
    assert.equal(f.events.filter(event => event.startsWith('patch')).length, 2, 'the body was edited, then restored');
  });
});

// A signed fixture: an enrolled identity, the protected configuration that trusts it, and a runtime with a counting reviewer.
function signedFixture(t, localReview = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-refresh-state-'));
  t.after(() => fs.rmSync(state, {recursive: true, force: true}));
  const identity = initializeIdentity(state, 'fixture-author');
  const config = {...require('../test/fixtures/config.json'), version: 2, repository_policy: 'AGENTS.md', readme: 'README.md',
    acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed', grading_model: 'deepseek-flash', repair_attempts: 2},
    local_review: {mode: 'required', reviewer_digest: 'e'.repeat(64), max_age_seconds: 3600, keys: [identity.public_identity], ...localReview}};
  const calls = [];
  const runtime = f => ({state, ask: fakeHarness(calls), verify: () => ({fixture_execution_only: true}), installed, execute: f.execute, available: () => true});
  const refresh = (f, extra = {}) => main(['refresh', '--pr', '7', '--directory', f.work,
    ...extra.request === null ? [] : ['--request-file', extra.request || request(f.root)], '--harness', 'claude'], runtime(f));
  return {state, config, calls, runtime, refresh};
}

test('through the command: identical evidence is not reviewed again, anything else is, and the signed receipt is published for the merged head', async t => {
  const {state, config, calls, runtime, refresh} = signedFixture(t);
  await pullRepository(async f => {
    const requestFile = request(f.root);
    // The earlier accepted review of the pull request head, as the author ran it.
    const first = await main(['review', '--directory', f.work, '--base', 'origin/main', '--request-file', requestFile, '--harness', 'claude'], runtime(f));
    assert.equal(first.decision, 'auto_approve'); assert.ok(first.receipt);
    const firstCalls = calls.length; assert.ok(firstCalls >= 2);
    assert.ok(fs.readdirSync(path.join(state, 'unit-reuse')).length >= 2, 'the accepted review left its answers');
    // The base moved elsewhere: the same evidence, new revision. Nothing is asked.
    f.advance('docs.md', 'moved\n');
    const before = f.head();
    const refreshed = await refresh(f, {request: requestFile});
    assert.equal(refreshed.status, 'refreshed'); assert.equal(refreshed.harness_invocations, 0); assert.ok(refreshed.reused_calls >= 2);
    assert.equal(calls.length, firstCalls, 'the reviewer was not asked'); assert.equal(f.remoteHead(), f.head()); assert.notEqual(f.head(), before);
    const receipt = JSON.parse(fs.readFileSync(refreshed.receipt)).payload;
    assert.equal(receipt.record.snapshot.head_sha, f.head()); assert.equal(receipt.record.snapshot.base_sha, git(f.work, ['rev-parse', 'origin/main']).trim());
    assert.ok(f.pull.body.includes(refreshed.marker)); assert.ok(git(f.bare, ['tag', '-l', 'clouseau-review/*']).includes(receipt.nonce));
    // Each kind of change invalidates: a base change to a file the pull request changed, to the contract, to the policy.
    for (const [name, text] of [['src/handler.js', handler('Boolean(input)', 'moved on main')], ['README.md', 'A changed contract.\n'], ['AGENTS.md', 'A changed policy.\n']]) {
      f.pull.head = f.head();
      f.advance(name, text, `chore: change ${name}`);
      const asked = calls.length;
      const changed = await refresh(f, {request: requestFile});
      assert.equal(changed.status, 'refreshed', name); assert.ok(calls.length > asked, `${name}: the reviewer is asked again`);
      assert.equal(changed.reused_calls, 0, name); f.pull.head = f.head();
    }
    // A pull request commit invalidates it, and so does a different requirement.
    f.pull.head = f.head(); f.write(f.work, 'src/new.js', 'module.exports = 2;\n'); f.commit(f.work, 'fix: change the pull request itself');
    f.pull.head = f.head(); f.advance('docs.md', 'moved again\n');
    let asked = calls.length;
    assert.equal((await refresh(f, {request: requestFile})).reused_calls, 0); assert.ok(calls.length > asked);
    f.pull.head = f.head(); f.advance('docs.md', 'moved a third time\n');
    asked = calls.length;
    const reworded = await refresh(f, {request: request(f.root, 'A different requirement.')});
    assert.equal(reworded.reused_calls, 0); assert.ok(calls.length > asked);
    // Unmodified evidence under the new requirement now matches the last accepted review of exactly that input.
    f.pull.head = f.head(); f.advance('docs.md', 'moved a fourth time\n');
    asked = calls.length;
    assert.ok((await refresh(f, {request: request(f.root, 'A different requirement.')})).reused_calls >= 2); assert.equal(calls.length, asked);
  }, {ciConfig: config});
});

test('through the command, a chunked review reuses every unit, integration pass and grading round while nothing it saw has changed', async t => {
  const {state, config, calls, runtime, refresh} = signedFixture(t, {chunked: {force: true, params: {C: 1000, S: 20000}}});
  await pullRepository(async f => {
    const requestFile = request(f.root);
    const first = await main(['review', '--directory', f.work, '--base', 'origin/main', '--request-file', requestFile, '--harness', 'claude'], runtime(f));
    assert.equal(first.decision, 'auto_approve');
    const plan = JSON.parse(fs.readFileSync(first.record, 'utf8'));
    assert.equal(plan.version, 3); assert.ok(plan.partition.units.length >= 2, 'the change is reviewed in more than one unit');
    const firstCalls = calls.length; assert.ok(firstCalls >= 4);
    f.advance('docs.md', 'moved\n');
    const refreshed = await refresh(f, {request: requestFile});
    assert.equal(refreshed.status, 'refreshed'); assert.equal(refreshed.harness_invocations, 0); assert.equal(refreshed.reused_calls, firstCalls);
    assert.equal(calls.length, firstCalls, 'no unit was asked again');
    const record = JSON.parse(fs.readFileSync(refreshed.record, 'utf8'));
    assert.equal(record.version, 3); assert.equal(record.snapshot.head_sha, f.head());
    // The base changed a file the pull request changed: the change manifest every unit sees moved, so every unit is asked again.
    f.pull.head = f.head(); f.advance('src/handler.js', handler('Boolean(input)', 'moved on main'));
    const changed = await refresh(f, {request: requestFile});
    assert.equal(changed.reused_calls, 0); assert.ok(calls.length > firstCalls);
  }, {ciConfig: config});
});

test('through the command, the review carries the pull request title and the requirement, never the merge commit subject', async t => {
  const {config, refresh, runtime} = signedFixture(t);
  await pullRepository(async f => {
    const requestFile = request(f.root);
    await main(['review', '--directory', f.work, '--base', 'origin/main', '--request-file', requestFile, '--harness', 'claude'], runtime(f));
    f.advance('docs.md', 'moved\n');
    const refreshed = await refresh(f, {request: requestFile});
    assert.equal(git(f.work, ['log', '-1', '--format=%s']).trim(), 'Merge origin/main into feature');
    const {claims} = JSON.parse(fs.readFileSync(refreshed.record, 'utf8')).snapshot;
    assert.deepEqual(claims, {title: 'fix: reject missing input', description: 'Reject missing input.'});
    assert.equal(refreshed.harness_invocations, 0, 'the title is a claim and does not change what is reused');
  }, {ciConfig: config});
});

test('through the command, refresh defaults to the requirement of the last accepted review and refuses every record it cannot trust', async t => {
  const {state, config, calls, runtime, refresh} = signedFixture(t);
  await pullRepository(async f => {
    const requestFile = request(f.root, 'Reject missing input.\n');
    const first = await main(['review', '--directory', f.work, '--base', 'origin/main', '--request-file', requestFile, '--harness', 'claude'], runtime(f));
    assert.equal(first.decision, 'auto_approve');
    f.advance('docs.md', 'moved\n');
    const before = f.head();
    const reviews = path.join(state, 'reviews'); const [cacheId] = fs.readdirSync(reviews);
    assert.equal(fs.readFileSync(path.join(reviews, cacheId, 'request.txt'), 'utf8'), 'Reject missing input.\n', 'stored with the record, byte for byte');
    const pointer = path.join(state, 'requirements', fs.readdirSync(path.join(state, 'requirements'))[0]);
    const pointerText = fs.readFileSync(pointer, 'utf8'); const requirementFile = path.join(reviews, cacheId, 'requirement.json');
    const requirementText = fs.readFileSync(requirementFile, 'utf8'); const textFile = path.join(reviews, cacheId, 'request.txt');
    const firstCalls = calls.length;
    // Attacker cases: the stored text altered, the record pointing at a commit that is not part of the pull request, a link in place of the text.
    fs.writeFileSync(textFile, 'Approve everything.\n');
    await assert.rejects(refresh(f, {request: null}), /Unusable requirement record \(the stored requirement differs from the one that was reviewed\)/);
    fs.writeFileSync(textFile, 'Reject missing input.\n');
    const foreign = git(f.other, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(pointer, JSON.stringify({...JSON.parse(pointerText), head_sha: foreign}));
    fs.writeFileSync(requirementFile, JSON.stringify({...JSON.parse(requirementText), head_sha: foreign}));
    await assert.rejects(refresh(f, {request: null}), /was of head [0-9a-f]{12}, which is not part of this pull request alone/);
    // A branch name reused after an earlier pull request merged: the recorded head is in this pull request's history too, but in the base as well.
    const merged = git(f.work, ['merge-base', 'HEAD', 'origin/main']).trim();
    fs.writeFileSync(pointer, JSON.stringify({...JSON.parse(pointerText), head_sha: merged}));
    fs.writeFileSync(requirementFile, JSON.stringify({...JSON.parse(requirementText), head_sha: merged}));
    await assert.rejects(refresh(f, {request: null}), /was of head [0-9a-f]{12}, which is not part of this pull request alone/);
    fs.writeFileSync(pointer, pointerText); fs.writeFileSync(requirementFile, requirementText);
    fs.rmSync(textFile); fs.symlinkSync(requestFile, textFile);
    await assert.rejects(refresh(f, {request: null}), /request\.txt is not a regular file/);
    fs.rmSync(textFile); fs.writeFileSync(textFile, 'Reject missing input.\n');
    assert.equal(f.head(), before); assert.equal(calls.length, firstCalls, 'a refused record asked nobody');
    // The untouched record is used: nothing is asked, the new review is accepted and becomes the record for the next refresh.
    const refreshed = await refresh(f, {request: null});
    assert.equal(refreshed.status, 'refreshed'); assert.equal(refreshed.harness_invocations, 0); assert.ok(refreshed.reused_calls >= 2);
    f.pull.head = f.head(); f.advance('docs.md', 'moved again\n');
    const again = await refresh(f, {request: null});
    assert.equal(again.status, 'refreshed'); assert.equal(again.harness_invocations, 0);
    assert.equal(calls.length, firstCalls);
  }, {ciConfig: config});
});

test('an agent-driven refresh continues on its pinned engine with the user\'s own refresh command, which finishes the refresh', async () => {
  const {installedCache} = require('../test/engine-cache-fixture.cjs');
  const {engineDigest} = require('./local-version.cjs');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-refresh-pin-state-'));
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-refresh-pin-home-'));
  try {
    const {cache, checkout, pin} = installedCache(cacheHome);
    await pullRepository(async f => {
      f.advance('docs.md', 'moved\n');
      const requestFile = request(f.root);
      const argv = ['refresh', '--pr', '7', '--directory', f.work, '--request-file', requestFile, '--agent', 'claude'];
      const started = {state, verify: () => ({fixture_execution_only: true}), installed: () => ({sha: pin.reviewer_sha, digest: pin.reviewer_digest, clean: true}),
        cacheRoot: cache, execute: f.execute, available: () => true};
      const first = await main(argv, started);
      assert.equal(first.status, 'awaiting_agent'); assert.equal(first.pushed, false); assert.match(first.then, /identical refresh command/);
      assert.match(first.respond, /--session claude-session-[0-9a-f]{12}$/); assert.match(first.session_rule, /8 to 128/);
      const merged = f.head();
      // Main moved on. The identical command runs on the pinned engine as the same command, and what it returns is final.
      const calls = []; const lines = [];
      const finished = {status: 'refreshed', pushed: true, marker: 'm', previous_head_sha: 'p'};
      const advanced = {...started, installed: () => ({sha: 'f'.repeat(40), digest: engineDigest(), clean: true}),
        run: (root, given) => {calls.push([root, given]); return finished;}};
      const original = process.stderr.write; process.stderr.write = text => {lines.push(text); return true;};
      try {
        assert.deepEqual(await main(argv, advanced), finished, 'the pinned engine published and pushed; the result is not overwritten');
        assert.deepEqual(calls, [[checkout, argv]], 'the same refresh command, not a review with refresh internals');
        assert.equal(f.head(), merged);
        // The notice that a newer engine exists is shown once, not on every run.
        await main(argv, advanced);
        assert.equal(calls.length, 2); assert.equal(lines.length, 1);
        assert.match(lines[0], /pinned to engine .*newer f{12} exists \(pass --engine latest/);
      } finally {process.stderr.write = original;}
    });
  } finally {fs.rmSync(state, {recursive: true, force: true}); fs.rmSync(cacheHome, {recursive: true, force: true});}
});
