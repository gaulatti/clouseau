'use strict';

// An agent-driven review spans many commands. The launcher refreshes Clouseau main before every call, and the review cache
// identity is bound to the reviewer revision, so a moving main would discard every registered answer. An in-flight review is
// therefore pinned to the engine revision that started it: a continuation re-executes that exact revision, but only when it
// is a checkout this installation made from its own cached source and its bytes still match the digest recorded at pinning.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {digest} = require('./acceptance.cjs');
const {git} = require('./local-git.cjs');
const {engineDigest} = require('./local-version.cjs');

const pinFile = (state, key) => path.join(state, 'pins', `${key}.json`);
const pinKey = parts => digest(parts);

function readPin(state, key) {
  const filename = pinFile(state, key);
  if (!fs.existsSync(filename)) return null;
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(value.reviewer_sha) || !/^[a-f0-9]{64}$/.test(value.reviewer_digest)) {
    throw new Error(`Invalid engine pin ${filename}; preserve it and continue with --engine latest to restart the review`);
  }
  return value;
}

function writePin(state, key, reviewer) {
  fs.mkdirSync(path.join(state, 'pins'), {recursive: true, mode: 0o700});
  fs.writeFileSync(pinFile(state, key), JSON.stringify({reviewer_sha: reviewer.sha, reviewer_digest: reviewer.digest}), {mode: 0o600});
}

const clearPin = (state, key) => fs.rmSync(pinFile(state, key), {force: true});

// Returns the pinned checkout only when this installation itself created it from its cached source and it is unmodified.
function verifiedRevision(cacheRoot, pin) {
  const checkout = path.join(cacheRoot, 'revisions', pin.reviewer_sha);
  const unusable = reason => new Error(`Pinned Clouseau revision ${pin.reviewer_sha} is ${reason}; the review cannot continue on it. ` +
    'Re-run with --engine latest to restart the review on the newest revision');
  if (!fs.existsSync(checkout)) throw unusable('not in the local cache');
  const common = git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  if (git(checkout, ['rev-parse', 'HEAD']).trim() !== pin.reviewer_sha || git(checkout, ['status', '--porcelain']).trim() ||
    fs.realpathSync(common) !== fs.realpathSync(path.join(cacheRoot, 'source.git'))) throw unusable('not an unmodified installation');
  if (engineDigest(checkout) !== pin.reviewer_digest) throw unusable('different from the verified engine bytes');
  return checkout;
}

function argvFor(args) {
  const {command, engine, ...rest} = args;
  return [command, ...Object.entries(rest).flatMap(([name, value]) => [`--${name}`, value])];
}

function execute(checkout, argv, spawn = cp.spawnSync) {
  const result = spawn('node', [path.join(checkout, 'bin/clouseau.cjs'), ...argv], {encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit']});
  if (![0, 2, 3].includes(result.status)) throw new Error(`Pinned Clouseau engine failed (status ${result.status}); see its message above`);
  return JSON.parse(result.stdout);
}

module.exports = {pinKey, readPin, writePin, clearPin, verifiedRevision, argvFor, execute};
