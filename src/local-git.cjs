'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {digest} = require('./acceptance.cjs');
const {safePath, refresh} = require('./acceptance-sources.cjs');
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
  coverageParts(value);
  return value;
}

function githubRepository(directory) {
  const remote = git(directory, ['remote', 'get-url', 'origin']).trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new Error('An explicit GitHub origin is required for review provenance');
  return {owner: match[1], repo: match[2]};
}

function collectLocal({directory, base, request, technical, ciConfig = null, reviewerSha = null, installation = null}) {
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
      const relative = filename.slice('.clouseau-ci/'.length);
      const engineRoot = path.join(__dirname, '..');
      if (!/^[a-f0-9]{40}$/.test(reviewerSha || '')) throw new Error('Frozen reviewer identity is required for engine source evidence');
      const revision = reviewerSha;
      const id = `engine:${revision}:${relative}`;
      const content = fs.readFileSync(path.join(engineRoot, relative), 'utf8');
      if (content.includes('\0') || Buffer.byteLength(content) > 300000) throw new Error('Binary or oversized engine evidence');
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
    snapshot.files.push(item);
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
