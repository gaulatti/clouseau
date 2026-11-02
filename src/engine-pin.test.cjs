'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {git} = require('./local-git.cjs');
const pinning = require('./engine-pin.cjs');

const {write, installedCache} = require('../test/engine-cache-fixture.cjs');

test('a pin is private, validated and removable', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-pin-'));
  try {
    const key = pinning.pinKey({head: 'a'});
    assert.equal(pinning.readPin(state, key), null);
    pinning.writePin(state, key, {sha: 'a'.repeat(40), digest: 'b'.repeat(64)});
    assert.deepEqual(pinning.readPin(state, key), {reviewer_sha: 'a'.repeat(40), reviewer_digest: 'b'.repeat(64)});
    assert.equal(fs.statSync(path.join(state, 'pins', `${key}.json`)).mode & 0o077, 0);
    pinning.clearPin(state, key); assert.equal(pinning.readPin(state, key), null);
    write(path.join(state, 'pins', `${key}.json`), JSON.stringify({reviewer_sha: 'x', reviewer_digest: 'y'}));
    assert.throws(() => pinning.readPin(state, key), /Invalid engine pin.*--engine latest/);
    write(path.join(state, 'pins', `${key}.json`), JSON.stringify({reviewer_sha: 'a'.repeat(40), reviewer_digest: 'b'.repeat(64), notified: 'x'}));
    assert.throws(() => pinning.readPin(state, key), /Invalid engine pin/);
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});

test('only an unmodified checkout the installer made from its own source, with the recorded bytes, is runnable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-pin-cache-'));
  try {
    const {cache, checkout, pin, origin} = installedCache(root);
    assert.equal(pinning.verifiedRevision(cache, pin), checkout);
    assert.throws(() => pinning.verifiedRevision(cache, {...pin, reviewer_sha: 'c'.repeat(40)}), /not in the local cache.*--engine latest/);
    assert.throws(() => pinning.verifiedRevision(cache, {...pin, reviewer_digest: 'd'.repeat(64)}), /different from the verified engine bytes/);
    // A checkout that is not a worktree of the cached source is refused even if it is clean and the right revision.
    const sha = pin.reviewer_sha;
    fs.rmSync(checkout, {recursive: true}); git(root, ['clone', '-q', origin, checkout]);
    assert.throws(() => pinning.verifiedRevision(cache, pin), /not an unmodified installation/);
    // A modified or wrong-revision checkout is refused.
    fs.rmSync(checkout, {recursive: true}); git(cache, ['--git-dir', path.join(cache, 'source.git'), 'worktree', 'prune']);
    git(cache, ['--git-dir', path.join(cache, 'source.git'), 'worktree', 'add', '-q', '--detach', checkout, sha]);
    assert.equal(pinning.verifiedRevision(cache, pin), checkout);
    write(path.join(checkout, 'src/a.cjs'), 'tampered');
    assert.throws(() => pinning.verifiedRevision(cache, pin), /not an unmodified installation/);
    git(checkout, ['checkout', '-q', '--', '.']);
    git(checkout, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'moved']);
    assert.throws(() => pinning.verifiedRevision(cache, pin), /not an unmodified installation/);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('a continuation is re-executed verbatim on the pinned engine, without the escape flag', () => {
  assert.deepEqual(pinning.argvFor({command: 'review', directory: '/r', engine: 'latest', agent: 'claude'}), ['review', '--directory', '/r', '--agent', 'claude']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-pin-exec-'));
  try {
    for (const [status, ok] of [[0, true], [2, true], [3, true], [1, false]]) {
      write(path.join(root, 'bin/clouseau.cjs'), `process.stdout.write(JSON.stringify({argv: process.argv.slice(2)}));process.exitCode=${status};`);
      if (ok) assert.deepEqual(pinning.execute(root, ['review', '--agent', 'claude']), {argv: ['review', '--agent', 'claude']});
      else assert.throws(() => pinning.execute(root, ['review']), /Pinned Clouseau engine failed \(status 1\)/);
    }
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('a pinned engine that cannot even start is a failure, not a result', () => {
  assert.throws(() => pinning.execute('/nonexistent-clouseau-engine', ['review'], () => ({status: null})), /status null/);
});

test('the newer-engine notice is owed once per newer revision, then remembered in the pin', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-pin-notice-'));
  try {
    const key = pinning.pinKey({head: 'n'});
    pinning.writePin(state, key, {sha: 'a'.repeat(40), digest: 'b'.repeat(64)});
    const pin = pinning.readPin(state, key);
    assert.equal(pinning.noticeOwed(pin, 'c'.repeat(40)), true);
    pinning.markNotified(state, key, pin, 'c'.repeat(40));
    const noted = pinning.readPin(state, key);
    assert.deepEqual(noted, {reviewer_sha: 'a'.repeat(40), reviewer_digest: 'b'.repeat(64), notified: 'c'.repeat(40)});
    assert.equal(fs.statSync(path.join(state, 'pins', `${key}.json`)).mode & 0o077, 0);
    assert.equal(pinning.noticeOwed(noted, 'c'.repeat(40)), false, 'the same newer revision is not announced again');
    assert.equal(pinning.noticeOwed(noted, 'd'.repeat(40)), true, 'a revision newer still is');
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});

test('a failing pinned engine is reported with its own message, and a working one keeps its warnings visible', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-pin-error-'));
  const original = process.stderr.write; const written = [];
  try {
    write(path.join(root, 'bin/clouseau.cjs'), 'process.stderr.write("Usage: clouseau <command>\\nunknown option --bogus\\n");process.exitCode=1;');
    assert.throws(() => pinning.execute(root, ['review']), error => {
      assert.match(error.message, /^Pinned Clouseau engine failed \(status 1\): Usage: clouseau <command>\nunknown option --bogus$/);
      return true;
    });
    // A long message keeps its end, where the cause is.
    write(path.join(root, 'bin/clouseau.cjs'), 'process.stderr.write("x".repeat(5000) + "the real cause");process.exitCode=1;');
    assert.throws(() => pinning.execute(root, ['review']), error => {
      assert.ok(error.message.endsWith('the real cause')); assert.ok(error.message.length < 2100); return true;
    });
    // An engine that cannot start says why.
    assert.throws(() => pinning.execute(root, ['review'], () => ({status: null, error: new Error('spawn node ENOENT')})), /status null\): spawn node ENOENT/);
    // Warnings of a successful run still reach the person, and the result is still the engine's stdout.
    write(path.join(root, 'bin/clouseau.cjs'), 'process.stderr.write("notice: something");process.stdout.write("{\\"ok\\":true}");');
    process.stderr.write = text => {written.push(String(text)); return true;};
    assert.deepEqual(pinning.execute(root, ['review']), {ok: true});
    process.stderr.write = original;
    assert.deepEqual(written, ['notice: something']);
  } finally {process.stderr.write = original; fs.rmSync(root, {recursive: true, force: true});}
});

test('the real engine rejects what the old refresh continuation sent, and the same real engine answers a proper refresh command with its own error', () => {
  const root = path.join(__dirname, '..');
  // What the continuation used to send for a refresh: no command and options that refresh never accepts.
  const old = pinning.argvFor({directory: '/r', base: 'origin/main', 'request-file': '/q', harness: undefined, agent: 'claude'});
  assert.throws(() => pinning.execute(root, old), /Pinned Clouseau engine failed \(status 1\): .*Usage: clouseau/s);
  // The command the continuation sends now is the user's own: the engine's actual message comes back.
  assert.throws(() => pinning.execute(root, pinning.argvFor({command: 'refresh', pr: 'x', engine: 'latest'})),
    /Pinned Clouseau engine failed \(status 1\): --pr takes a pull request number/);
});
