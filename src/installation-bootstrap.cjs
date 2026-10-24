'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {digest} = require('./acceptance.cjs');
const {git, githubRepository, readLocalConfig, assertUnchanged} = require('./local-git.cjs');
const {safePath} = require('./acceptance-sources.cjs');
const {validateConfig} = require('./config.cjs');
const {validateTrust, verifySignedRecord} = require('./local-receipt.cjs');

const HEADER = '/authorize-clouseau-installation v1\n';
const INSTALLATION_MARKER = /<!-- clouseau-installation-review:v1 ([a-f0-9]{40}) -->/g;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const LOGIN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/;
const fail = message => { throw new Error(`Invalid initial installation: ${message}`); };
const requireInstallation = (condition, message) => { if (!condition) fail(message); };
const exact = (value, names) => value && Object.keys(value).sort().join(',') === [...names].sort().join(',');

function publicIdentity(value) {
  const result = Object.fromEntries(['id', 'issuer', 'github_actor', 'public_key', 'revoked'].map(name => [name, value[name]]));
  requireInstallation(typeof result.public_key === 'string' && result.public_key.startsWith('-----BEGIN PUBLIC KEY-----') &&
    !result.public_key.includes('PRIVATE KEY') && result.revoked === false, 'only an active public enrollment may be exported');
  validateTrust({mode: 'required', reviewer_digest: '0'.repeat(64), max_age_seconds: 3600, keys: [result]});
  return result;
}

function readIdentity(filename) {
  const stat = fs.lstatSync(filename);
  requireInstallation(stat.isFile() && !(stat.mode & 0o077) && stat.size <= 10000, 'identity must be a private regular file');
  let value;
  try { value = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { fail('identity metadata is malformed'); }
  const enrollment = publicIdentity(value);
  requireInstallation(crypto.createPublicKey(value.private_key).export({type: 'spki', format: 'pem'}) === enrollment.public_key,
    'identity public and private keys do not match');
  return {identity: value, public_identity: enrollment};
}

function exportIdentity({identity, state, directory}) {
  const candidates = identity ? [path.resolve(identity)] : (fs.existsSync(state) ? fs.readdirSync(state) : [])
    .filter(name => /^[a-f0-9]{24}\.json$/.test(name)).map(name => path.join(state, name));
  requireInstallation(candidates.length === 1, 'select one installed identity with --identity, or explicitly create one with init-identity');
  if (directory) {
    const source = fs.realpathSync(directory);
    const filename = fs.realpathSync(candidates[0]);
    requireInstallation(filename !== source && !filename.startsWith(source + path.sep), 'signing identity must remain outside project source');
  }
  return {identity_file: candidates[0], public_identity: readIdentity(candidates[0]).public_identity};
}

function validateManifest(value, now = Date.now()) {
  requireInstallation(exact(value, ['version', 'repository', 'base_branch', 'base_sha', 'head_sha', 'reviewer_sha', 'reviewer_digest',
    'policy_digest', 'request', 'local_config_digest', 'config_digest', 'identity', 'files', 'issued_at', 'expires_at']) && value.version === 1,
  'a complete version-one frozen manifest is required');
  requireInstallation(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(value.repository) &&
    /^[a-zA-Z0-9._/-]+$/.test(value.base_branch) &&
    ['base_sha', 'head_sha', 'reviewer_sha'].every(name => SHA.test(value[name])) && value.base_sha !== value.head_sha &&
    ['reviewer_digest', 'policy_digest', 'local_config_digest', 'config_digest'].every(name => HASH.test(value[name])),
  'repository, immutable revisions and policy/configuration identities are required');
  requireInstallation(typeof value.request === 'string' && value.request.trim().length > 0 && value.request.length <= 20000,
    'the literal bounded accepted requirement is required');
  requireInstallation(exact(value.identity, ['id', 'issuer', 'github_actor', 'public_key', 'revoked']), 'public enrollment fields only');
  publicIdentity(value.identity);
  const timestamp = Math.floor(now / 1000);
  requireInstallation(Number.isSafeInteger(value.issued_at) && Number.isSafeInteger(value.expires_at) &&
    value.issued_at <= timestamp && value.expires_at > timestamp && value.expires_at > value.issued_at &&
    value.expires_at - value.issued_at <= 3600, 'authorization is expired, future-dated or exceeds one hour');
  requireInstallation(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 100 &&
    value.files.every(file => exact(file, ['path', 'sha256']) && safePath(file.path) && HASH.test(file.sha256)) &&
    new Set(value.files.map(file => file.path)).size === value.files.length &&
    value.files.map(file => file.path).join('\0') === value.files.map(file => file.path).sort().join('\0') &&
    ['.clouseau-local.json', '.github/clouseau.json'].every(filename => value.files.some(file => file.path === filename)),
  'complete, unique and sorted frozen control-file hashes are required');
  return value;
}

function grantBody(manifest) {
  return HEADER + JSON.stringify(manifest, null, 2);
}

function parseGrant(body, now = Date.now()) {
  requireInstallation(typeof body === 'string' && body.startsWith(HEADER) && body.length <= 60000,
    'a distinct installation authorization is required; intent comments cannot enroll trust');
  const manifest = validateManifest(JSON.parse(body.slice(HEADER.length)), now);
  requireInstallation(body === grantBody(manifest), 'authorization text changed');
  return manifest;
}

function installationMarker(body) {
  const text = body || '';
  const matches = [...text.matchAll(INSTALLATION_MARKER)];
  requireInstallation(matches.length === 1 && !text.includes('clouseau-local-review:'), 'one installation-only receipt marker is required');
  return matches[0][1];
}

function frozenSource(directory, ref, filename) {
  const entry = git(directory, ['ls-tree', ref, '--', filename]).trim();
  requireInstallation(/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry), 'control source must be a committed regular file');
  const content = git(directory, ['show', `${ref}:${filename}`]);
  requireInstallation(!content.includes('\0') && Buffer.byteLength(content) <= 300000, 'complete textual control source is required');
  return content;
}

function candidateConfiguration(directory, head) {
  const local = readLocalConfig(JSON.parse(frozenSource(directory, head, '.clouseau-local.json')));
  const config = validateConfig(JSON.parse(frozenSource(directory, head, '.github/clouseau.json')));
  requireInstallation(config.version === 2 && config.local_review && local.base_branch === config.base_branch,
    'version-two CI policy with explicit public receipt enrollment is required');
  return {local, config};
}

function bindConfiguration(local, config, identity, reviewerDigest) {
  requireInstallation(config.version === 2 && config.local_review && local.base_branch === config.base_branch &&
    config.local_review.keys.length === 1 && digest(config.local_review.keys[0]) === digest(identity) &&
    config.local_review.reviewer_digest === reviewerDigest && config.manual_reviewer === identity.github_actor,
  'the proposed local/CI policy, one public enrollment, runner actor and frozen engine must agree');
}

function controlPaths(local, config, tracked) {
  const files = new Set(['.clouseau-local.json', '.github/clouseau.json', config.readme, config.repository_policy,
    local.readme, local.repository_policy, `.github/workflows/${config.workflow}`]);
  for (const filename of tracked) if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(filename) ||
    ['AGENTS.md', 'CLAUDE.md', '.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].includes(filename)) files.add(filename);
  return [...files].sort();
}

function prepareManifest({directory, base, request, enrollment, reviewer, now = Date.now()}) {
  requireInstallation(reviewer.clean, 'the shared engine must be an unmodified immutable checkout');
  requireInstallation(!git(directory, ['status', '--porcelain']).trim(), 'commit the complete installation candidate first');
  const head = git(directory, ['rev-parse', 'HEAD']).trim();
  const {local, config} = candidateConfiguration(directory, head);
  const baseSha = git(directory, ['rev-parse', '--verify', `${base || `origin/${local.base_branch}`}^{commit}`]).trim();
  requireInstallation(!git(directory, ['ls-tree', baseSha, '--', '.clouseau-local.json', '.github/clouseau.json']).trim(),
    'accepted review configuration already exists; use the ordinary review/repair protocol');
  const identity = publicIdentity(enrollment);
  bindConfiguration(local, config, identity, reviewer.digest);
  const tracked = git(directory, ['ls-tree', '-r', '--name-only', head]).trim().split('\n');
  const manifest = {version: 1, repository: Object.values(githubRepository(directory)).join('/'), base_branch: config.base_branch,
    base_sha: baseSha, head_sha: head, reviewer_sha: reviewer.sha, reviewer_digest: reviewer.digest,
    policy_digest: digest(fs.readFileSync(path.join(__dirname, '../policy/change-acceptance.md'), 'utf8')), request,
    local_config_digest: digest(local), config_digest: digest(config), identity,
    files: controlPaths(local, config, tracked).map(filename => ({path: filename,
      sha256: crypto.createHash('sha256').update(frozenSource(directory, head, filename)).digest('hex')})),
    issued_at: Math.floor(now / 1000), expires_at: Math.floor(now / 1000) + 3600};
  return validateManifest(manifest, now);
}

async function qualify({api, manifest, actor = manifest.identity.github_actor, now = Date.now()}) {
  validateManifest(manifest, now);
  requireInstallation(LOGIN.test(actor) && actor === manifest.identity.github_actor, 'the authorization actor must be the enrolled runner');
  const repository = await api('GET', `repos/${manifest.repository}`);
  const permission = await api('GET', `repos/${manifest.repository}/collaborators/${actor}/permission`);
  requireInstallation(repository.full_name === manifest.repository && repository.default_branch === manifest.base_branch &&
    permission.permission === 'admin' && permission.user?.login === actor && permission.user.type === 'User',
  'current native repository administrator authority is required');
  const base = await api('GET', `repos/${manifest.repository}/branches/${encodeURIComponent(manifest.base_branch)}`);
  requireInstallation(base.commit?.sha === manifest.base_sha, 'the accepted base changed');
  const engine = await api('GET', 'repos/gaulatti/clouseau/branches/main');
  requireInstallation(engine.protected === true && SHA.test(engine.commit?.sha), 'protected public Clouseau main is unavailable');
  const comparison = await api('GET', `repos/gaulatti/clouseau/compare/${manifest.reviewer_sha}...${engine.commit.sha}`);
  requireInstallation(['identical', 'ahead'].includes(comparison.status), 'the frozen engine is not released on protected Clouseau main');
  return {repository, base, actor};
}

async function authorizeManifest({api, manifest, now = Date.now()}) {
  const actor = await api('GET', 'user');
  requireInstallation(actor.type === 'User', 'native human administrator authentication is required');
  await qualify({api, manifest, actor: actor.login, now});
  const comment = await api('POST', `repos/${manifest.repository}/commits/${manifest.head_sha}/comments`, {body: grantBody(manifest)});
  return verifyGrant({api, manifest, commentId: comment.id, now});
}

async function verifyGrant({api, manifest, commentId, now = Date.now()}) {
  requireInstallation(Number.isSafeInteger(commentId) && commentId > 0, 'a native commit-comment identity is required');
  const comment = await api('GET', `repos/${manifest.repository}/comments/${commentId}`);
  const parsed = parseGrant(comment.body, now);
  requireInstallation(digest(parsed) === digest(manifest) && comment.commit_id === manifest.head_sha &&
    comment.user?.type === 'User' && comment.user.login === manifest.identity.github_actor, 'authorization source, actor or frozen manifest differs');
  await qualify({api, manifest, actor: comment.user.login, now});
  return {version: 1, comment_id: commentId, actor: comment.user.login, body_digest: digest(comment.body), manifest};
}

function assertManifestLocal(directory, manifest, reviewer, now = Date.now()) {
  const current = prepareManifest({directory, base: manifest.base_sha, request: manifest.request, enrollment: manifest.identity,
    reviewer, now: manifest.issued_at * 1000});
  requireInstallation(digest(current) === digest(manifest), 'source, engine or authorized configuration changed');
  validateManifest(manifest, now);
  assertUnchanged(directory, {head_sha: manifest.head_sha});
}

async function verifyInstallationReceipt(bundle, {api, grant, reviewerSha, reviewerDigest, author, now = Date.now()}) {
  const manifest = validateManifest(grant.manifest, now);
  requireInstallation(manifest.policy_digest === digest(fs.readFileSync(path.join(__dirname, '../policy/change-acceptance.md'), 'utf8')),
    'the grant cannot replace the shared engine policy identity');
  const current = await verifyGrant({api, manifest, commentId: grant.comment_id, now});
  requireInstallation(digest(current) === digest(grant), 'initial authorization was changed or revoked');
  requireInstallation(grant.actor === author &&
    reviewerSha === manifest.reviewer_sha && reviewerDigest === manifest.reviewer_digest,
  'installation authority and frozen shared engine do not match');
  const result = verifySignedRecord(bundle, {trust: {mode: 'required', reviewer_digest: reviewerDigest, max_age_seconds: 3600, keys: [manifest.identity]},
    repository: manifest.repository, author, headSha: manifest.head_sha, baseSha: manifest.base_sha,
    reviewerSha, reviewerDigest, configDigest: manifest.config_digest, policyDigest: manifest.policy_digest, now});
  requireInstallation(result.record.controls === true && digest(result.record.installation) === digest(grant) &&
    result.record.snapshot.number === 0 && result.record.snapshot.intent_confirmation === null &&
    result.record.snapshot.local_config_digest === manifest.local_config_digest &&
    result.record.snapshot.sources['installation-authorization']?.content === JSON.stringify(grant) &&
    bundle.payload.expires_at <= manifest.expires_at, 'receipt is not bound exclusively to this initial trust acceptance');
  requireInstallation(manifest.files.every(file => Object.values(result.record.snapshot.sources).some(source =>
    source.path === file.path && source.ref === manifest.head_sha && typeof source.content === 'string' &&
    crypto.createHash('sha256').update(source.content).digest('hex') === file.sha256)),
  'the complete authorized controls must be present in reviewed source evidence');
  return result;
}

module.exports = {HEADER, publicIdentity, readIdentity, exportIdentity, validateManifest, grantBody, parseGrant,
  installationMarker, frozenSource, candidateConfiguration, bindConfiguration, controlPaths, prepareManifest, qualify, authorizeManifest, verifyGrant,
  assertManifestLocal, verifyInstallationReceipt};
