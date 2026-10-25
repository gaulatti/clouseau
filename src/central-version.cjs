'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {engineDigest} = require('./local-version.cjs');
const {safePath} = require('./acceptance-sources.cjs');
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
  verifyRevision(revision, directory);
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

function acceptsEngine(trust, engine) {
  const frozen = Boolean(engine && engine.repository === SOURCE.repository && engine.ref === SOURCE.ref &&
    sha(engine.sha) && hash(engine.digest));
  // An explicit engine identity is supplied only by the trusted frozen-source
  // workflow (or the refreshed public local runner), never by receipt data.
  // This also permits the one-time migration from legacy digest enrollment.
  return trust.central_source ? centralSource(trust.central_source) && frozen :
    frozen || Boolean(engine && trust.reviewer_digest === engine.digest);
}

function engineEvidence(filename, reviewerSha) {
  if (!sha(reviewerSha) || !filename.startsWith('.clouseau-ci/')) throw new Error('Frozen reviewer identity is required for engine source evidence');
  const input = filename.slice('.clouseau-ci/'.length);
  const at = input.lastIndexOf('@');
  const relative = at < 0 ? input : input.slice(0, at);
  const ref = at < 0 ? reviewerSha : input.slice(at + 1);
  if (!safePath(relative) || !sha(ref)) throw new Error('Engine evidence requires a safe path and immutable commit');
  return {relative, ref};
}

function readEngineEvidence(filename, reviewerSha, root = path.join(__dirname, '..')) {
  const {relative, ref} = engineEvidence(filename, reviewerSha);
  let bytes;
  if (ref === reviewerSha) bytes = fs.readFileSync(path.join(root, relative));
  else {
    try {cp.execFileSync('git', ['-C', root, 'cat-file', '-e', `${ref}^{commit}`], {stdio: 'ignore'});}
    catch {cp.execFileSync('git', ['-C', root, 'fetch', '--quiet', '--no-write-fetch-head', '--no-tags', '--depth=1', `https://github.com/${SOURCE.repository}.git`, ref], {stdio: 'pipe', timeout: 30000});}
    if (cp.execFileSync('git', ['-C', root, 'cat-file', '-t', `${ref}:${relative}`], {encoding: 'utf8'}).trim() !== 'blob') throw new Error('Engine evidence must be a file');
    bytes = cp.execFileSync('git', ['-C', root, 'show', `${ref}:${relative}`], {maxBuffer: require('./source-bank.cjs').LIMITS.source_bytes + 1});
  }
  const content = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  if (content.includes('\0') || bytes.length > require('./source-bank.cjs').LIMITS.source_bytes) throw new Error('Binary or oversized engine evidence');
  return content;
}

function engineContext(snapshot) {
  const pins = new Set(); const legacy = new Set(); let wiki = false;
  for (const file of snapshot.files) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path) || !file.head_source) continue;
    const content = snapshot.sources[file.head_source].content;
    if (content.includes('.clouseau-ci/src/wiki-git.cjs')) wiki = true;
    for (const match of content.matchAll(/^\s+(?:-\s*)?uses:\s*['"]?gaulatti\/clouseau\/scripts\/resolve@([a-f0-9]{40})['"]?\s*(?:#.*)?$/gm)) pins.add(match[1]);
    for (const source of [file.base_source, file.head_source].filter(Boolean)) {
      for (const match of snapshot.sources[source].content.matchAll(/^\s+(?:-\s*)?uses:\s*['"]?gaulatti\/clouseau@([a-f0-9]{40})['"]?\s*(?:#.*)?$/gm)) legacy.add(match[1]);
    }
  }
  if (!pins.size) return [];
  // These are the actual source/test dependencies requested by the bounded
  // consumer installation investigations, not another executable engine.
  // This bounded seed is not a completeness claim: immutable dependencies not
  // seeded here remain available through the normal source-request protocol.
  const current = ['action.yml', 'src/central-version.cjs', 'src/config.cjs', 'src/policy.cjs',
    'src/acceptance-controller.cjs', 'src/local-receipt.cjs', 'test/automatic-upgrade-contract.mjs',
    'src/local-version.cjs', 'src/codeowners.cjs', 'src/merge-protection.cjs', 'src/private-owner-merge.cjs', 'src/local-cli.cjs',
    'src/local-git.cjs', 'src/local-harness.cjs', 'scripts/clouseau', 'scripts/install-agent',
    'bin/clouseau.cjs', 'skills/clouseau/SKILL.md', 'src/local-review.cjs', 'src/acceptance-sources.cjs', 'src/record-transport.cjs',
    'src/provider.cjs', 'src/review-provider.cjs', 'src/acceptance.cjs', 'src/acceptance-review.cjs',
    ...(wiki ? ['src/wiki-git.cjs', 'src/wiki.cjs'] : [])];
  return [...current.map(filename => `.clouseau-ci/${filename}`), ...[...pins].flatMap(ref =>
    ['scripts/resolve/action.yml', 'src/central-version.cjs'].map(filename => `.clouseau-ci/${filename}@${ref}`)),
    ...[...legacy].flatMap(ref => ['action.yml', 'src/config.cjs', 'src/policy.cjs', 'src/local-receipt.cjs']
      .map(filename => `.clouseau-ci/${filename}@${ref}`))].slice(0, 32);
}

module.exports = {SOURCE, centralSource, resolveCentral, identifyEngine, verifyEngine, environmentEngine, acceptsEngine, engineEvidence, readEngineEvidence, engineContext};
