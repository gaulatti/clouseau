'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {engineDigest} = require('./local-version.cjs');
const SOURCE = Object.freeze({repository: 'gaulatti/clouseau', ref: 'refs/heads/main'});
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function centralSource(source) {
  return Boolean(source && Object.keys(source).sort().join(',') === 'ref,repository' &&
    source.repository === SOURCE.repository && source.ref === SOURCE.ref);
}

async function resolveCentral(github) {
  // No caller-controlled repository, branch, PR metadata or artifact input.
  const {data} = await github.rest.repos.getBranch({owner: 'gaulatti', repo: 'clouseau', branch: 'main'});
  if (data.name !== 'main' || data.protected !== true || !sha(data.commit?.sha)) {
    throw new Error('Cannot resolve protected gaulatti/clouseau main to an immutable commit');
  }
  return data.commit.sha;
}

function verifyRevision(revision, root = path.join(__dirname, '..')) {
  if (fs.existsSync(path.join(root, '.git'))) {
    if (cp.execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim() !== revision) {
      throw new Error('Checked-out source differs from the frozen engine SHA');
    }
    if (cp.execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], {encoding: 'utf8'}).trim()) {
      throw new Error('Uncommitted or untracked source cannot identify a frozen engine');
    }
  }
}

function identifyEngine(revision, root) {
  if (!sha(revision)) throw new Error('An immutable central engine SHA is required');
  verifyRevision(revision, root);
  const directory = path.resolve(root || path.join(__dirname, '..'));
  const checksum = require(path.join(directory, 'src/local-version.cjs')).engineDigest(directory);
  if (!hash(checksum)) throw new Error('Frozen engine returned an invalid source digest');
  return {...SOURCE, sha: revision, digest: checksum};
}

function verifyEngine(engine, root) {
  if (!engine || engine.repository !== SOURCE.repository || engine.ref !== SOURCE.ref ||
      !sha(engine.sha) || !hash(engine.digest) || engine.digest !== engineDigest(root)) {
    throw new Error('Frozen Clouseau engine source or digest differs from this run selection');
  }
  verifyRevision(engine.sha, root);
  return Object.freeze({...engine});
}

function environmentEngine(root) {
  const revision = process.env.CLOUSEAU_ENGINE_SHA;
  const checksum = process.env.CLOUSEAU_ENGINE_DIGEST;
  if (!revision && !checksum) return null;
  return verifyEngine({...SOURCE, sha: revision, digest: checksum}, root);
}


module.exports = {SOURCE, centralSource, resolveCentral, identifyEngine, verifyEngine, environmentEngine};
