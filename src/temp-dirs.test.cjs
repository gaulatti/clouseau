'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const temp = require('./temp-dirs.cjs');
const attestation = require('./verification-attestation.cjs');
const {digest} = require('./acceptance.cjs');
const {askHarness} = require('./local-harness.cjs');

const recipe = {version: 2, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md', verification: [['run', 'tests']],
  coverage: [{format: 'lcov', report: 'cov/lcov.info', source_directory: 'src', source_suffixes: ['.rs']}]};
const DAY = 24 * 60 * 60 * 1000;

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-temp-test-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

// Runs `body` with the system temp directory pointed at an empty private one and returns what was left in it.
async function leftBehind(t, body) {
  const root = scratch(t);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {await body();} finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
  return fs.readdirSync(root);
}

function old(directory, ageMs = 2 * DAY) {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(directory, when, when);
}

test('create returns a private directory under the temp directory and dispose removes it, twice without error', t => {
  const root = scratch(t);
  const previous = process.env.TMPDIR; process.env.TMPDIR = root;
  t.after(() => {if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;});
  const directory = temp.create('clouseau-base-');
  assert.equal(path.dirname(directory), root);
  assert.match(path.basename(directory), temp.OWNED);
  fs.writeFileSync(path.join(directory, 'file'), 'x');
  temp.dispose(directory);
  assert.equal(fs.existsSync(directory), false);
  temp.dispose(directory);
  temp.dispose('not\0valid');
});

test('sweepStale removes only owned directories older than a day and never follows a link', t => {
  const root = scratch(t);
  const make = name => {const directory = path.join(root, name); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'f'), 'x'); return directory;};
  const stale = ['clouseau-v8-AbC123', 'clouseau-v8-empty-xYz789', 'clouseau-base-aaaaaa', 'clouseau-harness-bbbbbb'].map(make);
  const fresh = make('clouseau-v8-fresh1'); const foreign = make('clouseau-record-abcdef'); const wrongTail = make('clouseau-v8-toolong1');
  const unregistered = make('clouseau-base-recent');
  const outside = scratch(t); fs.writeFileSync(path.join(outside, 'precious'), 'keep');
  fs.symlinkSync(outside, path.join(root, 'clouseau-v8-linked'));
  fs.writeFileSync(path.join(root, 'clouseau-v8-afile1'), 'x');
  for (const directory of [...stale, foreign, wrongTail]) old(directory);
  old(path.join(root, 'clouseau-v8-afile1'));
  fs.lutimesSync(path.join(root, 'clouseau-v8-linked'), new Date(0), new Date(0));
  const previous = process.env.TMPDIR; process.env.TMPDIR = root;
  const claimed = temp.create('clouseau-base-');
  process.env.TMPDIR = previous === undefined ? '' : previous; if (previous === undefined) delete process.env.TMPDIR;
  old(claimed);

  assert.equal(temp.sweepStale({root}), 4);
  for (const directory of stale) assert.equal(fs.existsSync(directory), false);
  for (const directory of [fresh, foreign, wrongTail, unregistered, claimed]) assert.equal(fs.existsSync(directory), true);
  assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'keep');
  assert.equal(fs.lstatSync(path.join(root, 'clouseau-v8-linked')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(root, 'clouseau-v8-afile1')), true);
  temp.dispose(claimed);
  assert.equal(temp.sweepStale({root, now: Date.now() + 3 * DAY, maxAgeMs: DAY}), 2);
});

test('sweepStale ignores an unreadable temp directory and entries it cannot remove', t => {
  const root = scratch(t);
  assert.equal(temp.sweepStale({root: path.join(root, 'missing')}), 0);
  const stuck = path.join(root, 'clouseau-v8-stuck1'); fs.mkdirSync(stuck); fs.writeFileSync(path.join(stuck, 'f'), 'x');
  old(stuck); fs.chmodSync(root, 0o500);
  try {assert.equal(temp.sweepStale({root}), 0);} finally {fs.chmodSync(root, 0o700);}
  assert.equal(fs.existsSync(stuck), true);
});

// A real process creates two directories, then ends the stated way.
function lifecycle(t, ending) {
  const root = scratch(t);
  const script = `const temp = require(${JSON.stringify(path.join(__dirname, 'temp-dirs.cjs'))});
    require('node:fs').writeFileSync(temp.create('clouseau-harness-') + '/f', 'x'); temp.create('clouseau-base-'); ${ending}`;
  const child = spawn(process.execPath, ['-e', script], {env: {...process.env, TMPDIR: root}, stdio: 'ignore'});
  return new Promise(resolve => child.on('close', () => resolve({left: fs.readdirSync(root)})));
}

test('a process that returns, exits or throws leaves no directory behind', async t => {
  for (const ending of ['', 'process.exit(3);', 'throw new Error("boom");']) {
    const result = await lifecycle(t, ending);
    assert.deepEqual(result.left, [], `ending ${JSON.stringify(ending)}`);
  }
});

test('SIGINT, SIGTERM and SIGHUP remove the directories and end the process with the conventional status', async t => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const root = scratch(t);
    const script = `const temp = require(${JSON.stringify(path.join(__dirname, 'temp-dirs.cjs'))});
      temp.create('clouseau-harness-'); temp.create('clouseau-base-'); console.log('ready'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', script], {env: {...process.env, TMPDIR: root}, stdio: ['ignore', 'pipe', 'ignore']});
    const ended = new Promise(resolve => child.on('close', (code, by) => resolve({code, by})));
    await new Promise(resolve => child.stdout.once('data', resolve));
    assert.equal(fs.readdirSync(root).length, 2);
    child.kill(signal);
    assert.deepEqual(await ended, {code: 128 + os.constants.signals[signal], by: null}, signal);
    assert.deepEqual(fs.readdirSync(root), [], signal);
  }
});

test('a base revision that cannot be checked out leaves no temporary directory', async t => {
  const left = await leftBehind(t, () => {
    const technical = {commands: [{argv: ['run', 'tests'], exit_code: 0}], verification_status: 'passed', local_config_digest: digest(recipe),
      coverage: {status: 'exact', passed: true, artifact_freshness: 'observed_current_run'}};
    assert.throws(() => attestation.evaluate({directory: '/x', config: recipe, technical, ciConfig: {coverage: {mode: 'changed_lines'}},
      baseSha: 'b'.repeat(40), verify: () => {}, exec: () => {throw new Error('no such revision');}}), /no such revision/);
  });
  assert.deepEqual(left, []);
});

test('a harness that fails leaves no temporary directory', async t => {
  const left = await leftBehind(t, async () => {
    await assert.rejects(askHarness({harness: 'claude', schema: {}, prompt: 'fixture', execute: async () => {throw new Error('transport down');}}), /transport down/);
  });
  assert.deepEqual(left, []);
});
