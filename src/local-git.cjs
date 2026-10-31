'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {digest, patchOf} = require('./acceptance.cjs');
const {safePath, refresh, evidenceSize, BUDGET} = require('./acceptance-sources.cjs');

// Room kept free of the optional engine seed for sources a reviewer asks for later.
const SEED_RESERVE = 150000;
const {coverageParts} = require('./coverage-plan.cjs');

function git(directory, args, input) {
  return cp.execFileSync('git', ['-C', directory, ...args], {encoding: 'utf8', input, maxBuffer: 2000000});
}

function readLocalConfig(value) {
  if (!value || ![1, 2].includes(value.version) || !/^[a-zA-Z0-9._/-]+$/.test(value.base_branch) ||
    !safePath(value.readme) || !safePath(value.repository_policy) ||
    !Array.isArray(value.verification) || !value.verification.length || value.verification.some(command =>
      !Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string' || !arg.length))) {
    throw new Error('Invalid local-only Clouseau configuration');
  }
  coverageParts(value, {allowUnsupported: true});
  return value;
}

function githubRepository(directory) {
  const remote = git(directory, ['remote', 'get-url', 'origin']).trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new Error('An explicit GitHub origin is required for review provenance');
  return {owner: match[1], repo: match[2]};
}

function collectLocal({directory, base, request, technical, ciConfig = null, reviewerSha = null, installation = null, engineRoot = path.join(__dirname, '..')}) {
  const head = git(directory, ['rev-parse', 'HEAD']).trim();
  const baseSha = git(directory, ['rev-parse', '--verify', `${base}^{commit}`]).trim();
  const repo = githubRepository(directory);
  if (git(directory, ['status', '--porcelain']).trim()) throw new Error('Commit the complete change before creating a signed local review');
  const configurationRef = installation ? head : baseSha;
  const localConfig = readLocalConfig(JSON.parse(git(directory, ['show', `${configurationRef}:.clouseau-local.json`])));
  const config = ciConfig || localConfig;
  const tokens = git(directory, ['diff', '--name-status', '-z', '--find-renames', baseSha, head]).split('\0');
  const changed = [];
  while (tokens.length && tokens[0]) {
    const status = tokens.shift(); const oldPath = tokens.shift();
    const filename = status.startsWith('R') ? tokens.shift() : oldPath;
    if (!safePath(filename) || !['A', 'M', 'D', 'R'].includes(status[0])) throw new Error('Unsupported or unsafe changed path');
    changed.push({filename, previous_filename: oldPath, status: {A: 'added', M: 'modified', D: 'removed', R: 'renamed'}[status[0]]});
  }
  if (!changed.length) throw new Error('A nonempty change against the protected base is required');
  const snapshot = {version: 2, review_manifest_version: 1, repository: `${repo.owner}/${repo.repo}`, number: 0,
    base_sha: baseSha, head_sha: head, head_repository: repo,
    paths: changed.map(file => file.filename).sort(), config_digest: digest(config),
    policy_digest: digest(fs.readFileSync(path.join(__dirname, '../policy/change-acceptance.md'), 'utf8')),
    sources: {}, files: [], history: [], tickets: [], intent_confirmation: null, prior_findings: [],
    local_config_digest: digest(localConfig), claims: {title: git(directory, ['log', '-1', '--format=%s']).trim(), description: request}};
  const source = (filename, ref) => {
    if (!safePath(filename)) throw new Error('Unsafe local evidence path');
    // Reviewers may inspect their own frozen public engine through the CI
    // checkout alias without requiring CI to be installed on this workstation.
    if (filename.startsWith('.clouseau-ci/')) {
      const {engineEvidence, readEngineEvidence} = require('./central-version.cjs');
      const {relative, ref: revision} = engineEvidence(filename, reviewerSha);
      const id = `engine:${revision}:${relative}`;
      const content = readEngineEvidence(filename, reviewerSha, engineRoot);
      snapshot.sources[id] = {path: filename, ref: revision, authority: 'untrusted', kind: 'source', content};
      return id;
    }
    const id = `${ref}:${filename}`;
    if (snapshot.sources[id]) return id;
    const content = git(directory, ['show', `${ref}:${filename}`]);
    if (content.includes('\0') || Buffer.byteLength(content) > 300000) throw new Error('Binary or oversized local evidence');
    const contract = (ref === baseSha || (installation && ref === head)) && [config.readme, config.repository_policy].includes(filename);
    snapshot.sources[id] = {path: filename, ref, authority: contract ? 'trusted' : 'untrusted',
      kind: contract ? 'contract' : 'source', content};
    return id;
  };
  for (const filename of [config.readme, config.repository_policy]) {
    if (!installation || git(directory, ['ls-tree', baseSha, '--', filename]).trim()) source(filename, baseSha);
  }
  source('.clouseau-local.json', configurationRef);
  if (installation) {
    for (const file of installation.manifest.files) source(file.path, head);
    snapshot.sources['installation-authorization'] = {authority: 'trusted', kind: 'contract',
      path: `commits/${head}/comments/${installation.comment_id}`, ref: digest(installation), content: JSON.stringify(installation)};
  }
  snapshot.sources.verification = {authority: 'trusted', kind: 'verification', path: 'verification', ref: head,
    content: JSON.stringify(technical)};
  snapshot.sources['local-request'] = {authority: 'untrusted', kind: 'requirement', path: 'local-request',
    ref: digest(request), content: request};
  for (const file of changed) {
    const item = {path: file.filename, status: file.status,
      patch: git(directory, ['diff', '--no-ext-diff', '--no-textconv', baseSha, head, '--', file.previous_filename, file.filename])};
    if (file.status !== 'added') {
      item.base_source = source(file.previous_filename, baseSha);
      snapshot.history.push({path: file.filename, commits: git(directory,
        ['log', '-3', '--format=%H %s', baseSha, '--', file.previous_filename]).trim()});
    }
    if (file.status !== 'removed') item.head_source = source(file.filename, head);
    // A whole added file is its patch body: keep the header and let the head source carry the text once.
    const compact = {...item, patch: item.patch.slice(0, item.patch.indexOf('\n', item.patch.indexOf('\n@@ ') + 1) + 1), patch_body: 'head_source'};
    if (file.status === 'added' && item.patch.includes('\n@@ ') && patchOf({sources: snapshot.sources}, compact) === item.patch) Object.assign(item, compact);
    snapshot.files.push(item);
  }
  // The seed lists files every pinned engine revision might hold; a revision
  // that never had one simply has no such evidence, and a request can still ask.
  for (const filename of require('./central-version.cjs').engineContext(snapshot)) {
    let id;
    try {id = source(filename, head);} catch (error) {if (error.code !== 'ENGINE_PATH_ABSENT') throw error; continue;}
    // The seed is optional context: beyond the reserve it is omitted with a stated reason, never a failed review.
    if (evidenceSize(snapshot) > BUDGET - SEED_RESERVE) {
      delete snapshot.sources[id];
      snapshot.omitted_sources = [...(snapshot.omitted_sources || []), {path: filename, reason: 'would exceed the evidence budget reserved for requested sources'}];
    }
  }
  refresh(snapshot);
  const addSources = async paths => {
    if (!Array.isArray(paths) || !paths.length || paths.length > 8 || new Set(paths).size !== paths.length) {
      throw new Error('Local source requests require one to eight distinct paths');
    }
    for (const filename of paths) source(filename, head);
    refresh(snapshot);
  };
  return {snapshot, localConfig, addSources};
}

function assertUnchanged(directory, snapshot) {
  if (git(directory, ['rev-parse', 'HEAD']).trim() !== snapshot.head_sha ||
    git(directory, ['status', '--porcelain']).trim()) throw new Error('Local source changed during review; no receipt issued');
}

module.exports = {git, githubRepository, readLocalConfig, collectLocal, assertUnchanged};
