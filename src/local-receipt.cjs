'use strict';

const crypto = require('node:crypto');
const {digest, validateReport} = require('./acceptance.cjs');
const {refresh, safePath} = require('./acceptance-sources.cjs');
const {validateInspection, combine} = require('./acceptance-review.cjs');
const {engineDigest} = require('./local-version.cjs');
const {reconcile} = require('./acceptance-ledger.cjs');
const {centralSource, acceptsEngine} = require('./central-version.cjs');

const DOMAIN = 'clouseau.local-review.v1';
const MAX_RECEIPT_BYTES = 3000000;
const MARKER = /<!-- clouseau-local-review:v1 ([a-f0-9]{40}) -->/g;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fail = message => {throw new Error(`Invalid local review receipt: ${message}`);};
const requireReceipt = (value, message) => {if (!value) fail(message);};

function validateTrust(trust) {
  requireReceipt(trust && (centralSource(trust.central_source) && trust.reviewer_digest === undefined ||
    trust.central_source === undefined && /^[a-f0-9]{64}$/.test(trust.reviewer_digest)) && ['required', 'optional'].includes(trust.mode) &&
    Array.isArray(trust.keys) && trust.keys.length > 0 &&
    Number.isSafeInteger(trust.max_age_seconds) && trust.max_age_seconds > 0 &&
    trust.max_age_seconds <= 86400, 'explicit trust policy and maximum age required');
  const ids = new Set();
  for (const key of trust.keys) {
    requireReceipt(key && typeof key.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(key.id) &&
      !ids.has(key.id) && typeof key.issuer === 'string' && key.issuer.length > 0 &&
      typeof key.github_actor === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(key.github_actor) &&
      typeof key.public_key === 'string' && key.public_key.length < 1000 &&
      typeof key.revoked === 'boolean', 'invalid or repeated trusted issuer');
    const publicKey = crypto.createPublicKey(key.public_key);
    requireReceipt(publicKey.asymmetricKeyType === 'ed25519', 'Ed25519 public key required');
    ids.add(key.id);
  }
  return trust;
}

function reviewDecision(record) {
  const {snapshot, result} = record;
  requireReceipt(snapshot && result && snapshot.digest === refresh(structuredClone(snapshot)).digest,
    'altered evidence snapshot');
  requireReceipt(result.snapshot === snapshot.digest && result.policy_digest === snapshot.policy_digest &&
    result.config_digest === snapshot.config_digest, 'review does not match evidence');
  const graded = role => result.reviews?.find(item => item.role === role)?.report?.findings?.length > 0;
  requireReceipt(Array.isArray(result.usage) && result.usage.length >= 2 &&
    result.execution_digest === digest(result.usage) && new Set(result.usage.map(item => item.session)).size === result.usage.length &&
    result.usage.every(item => ['codex', 'claude', 'opencode'].includes(item.harness) && [undefined, 'agent_session'].includes(item.execution) &&
      typeof item.session === 'string' && item.session.length > 0 &&
      ['request_digest', 'response_digest', 'transport_digest'].every(name => /^[a-f0-9]{64}$/.test(item[name]))) &&
    // Grading runs only for findings, so a role without findings has no grading round to record.
    ['examiner', 'challenger'].every(role => ['investigation', 'grading'].every(phase =>
      (phase === 'grading' && !graded(role)) || result.usage.some(item => item.role === role && item.phase === phase))),
    'complete independent harness execution records required');
  requireReceipt(Array.isArray(result.reviews) && result.reviews.length === 2 &&
    result.reviews.map(item => item.role).join(',') === 'examiner,challenger', 'two independent roles required');
  const reviews = result.reviews.map(item => ({...item,
    scores: validateReport(item.report, validateInspection(item.report, snapshot, item.drafts))}));
  const prior = record.local_previous?.findings || [];
  requireReceipt(digest(snapshot.prior_findings) === digest(prior), 'local finding history differs from the reviewed evidence');
  const state = reconcile({...result, reviews}, snapshot, prior);
  const combined = combine(reviews);
  const decision = state.unresolved.length && combined === 'auto_approve' ? 'review_incomplete' : combined;
  requireReceipt(result.decision === decision, 'claimed decision differs from calculated decision');
  return {decision, reviews};
}

function issueReceipt({record, privateKey, keyId, issuer, reviewerSha, reviewerDigest = engineDigest(), now = Date.now(), lifetime = 3600,
  nonce = crypto.randomBytes(32).toString('hex')}) {
  requireReceipt(reviewDecision(record).decision === 'auto_approve', 'only a passing review can be signed');
  requireReceipt(sha(reviewerSha) && /^[a-f0-9]{64}$/.test(reviewerDigest) && /^[a-f0-9]{64}$/.test(nonce) && Number.isSafeInteger(lifetime) &&
    lifetime > 0 && lifetime <= 86400, 'invalid runner revision, challenge or lifetime');
  const key = crypto.createPrivateKey(privateKey);
  requireReceipt(key.asymmetricKeyType === 'ed25519', 'Ed25519 signing key required');
  const payload = {type: DOMAIN, key_id: keyId, issuer, reviewer_sha: reviewerSha, reviewer_digest: reviewerDigest,
    issued_at: Math.floor(now / 1000), expires_at: Math.floor(now / 1000) + lifetime,
    nonce, record_digest: digest(record), record};
  const signature = crypto.sign(null, Buffer.from(`${DOMAIN}\0${digest(payload)}`), key).toString('base64url');
  return {payload, signature};
}

function verifySignedRecord(bundle, {trust, repository, author, headSha, baseSha, reviewerSha, reviewerDigest = engineDigest(), configDigest, policyDigest,
  now = Date.now(), engine = null}) {
  validateTrust(trust);
  requireReceipt(bundle && Object.keys(bundle).sort().join(',') === 'payload,signature' &&
    typeof bundle.signature === 'string' && /^[a-zA-Z0-9_-]{86}$/.test(bundle.signature) &&
    Buffer.byteLength(JSON.stringify(bundle)) <= MAX_RECEIPT_BYTES, 'malformed signature envelope');
  const p = bundle.payload;
  requireReceipt(p && Object.keys(p).sort().join(',') ===
    'expires_at,issued_at,issuer,key_id,nonce,record,record_digest,reviewer_digest,reviewer_sha,type' && p.type === DOMAIN,
    'unknown receipt type or fields');
  const key = trust.keys.find(item => item.id === p.key_id && item.issuer === p.issuer && !item.revoked);
  requireReceipt(key && crypto.verify(null, Buffer.from(`${DOMAIN}\0${digest(p)}`), key.public_key,
    Buffer.from(bundle.signature, 'base64url')), 'untrusted, revoked or invalid signature');
  requireReceipt(key.github_actor === author, 'signing identity is not enrolled for this PR author');
  const timestamp = Math.floor(now / 1000);
  requireReceipt(Number.isSafeInteger(p.issued_at) && Number.isSafeInteger(p.expires_at) &&
    p.issued_at <= timestamp && p.expires_at > timestamp && p.expires_at > p.issued_at &&
    p.expires_at - p.issued_at <= trust.max_age_seconds && timestamp - p.issued_at <= trust.max_age_seconds &&
    typeof p.nonce === 'string' && /^[a-f0-9]{64}$/.test(p.nonce), 'expired, future or invalid challenge');
  if (trust.central_source || engine) {
    requireReceipt(acceptsEngine(trust, engine) && engine.digest === reviewerDigest &&
      p.reviewer_digest === engine.digest && p.reviewer_sha === engine.sha,
    'engine mismatch; refresh public Clouseau and review again, then start a fresh CI run. No paid fallback is allowed');
  }
  const record = p.record;
  const snapshot = record.snapshot;
  requireReceipt(p.record_digest === digest(record) && snapshot.repository === repository &&
    sha(headSha) && snapshot.head_sha === headSha && sha(baseSha) && snapshot.base_sha === baseSha &&
    sha(p.reviewer_sha) && (!reviewerSha || p.reviewer_sha === reviewerSha) &&
    p.reviewer_digest === reviewerDigest && (engine || trust.reviewer_digest === reviewerDigest) && snapshot.config_digest === configDigest &&
    snapshot.policy_digest === policyDigest, 'repository, revisions, policy, configuration or record changed');
  const result = reviewDecision(record);
  requireReceipt(result.decision === 'auto_approve', 'review did not pass');
  return {record, ...result};
}

function verifyReceipt(bundle, options) {
  const result = verifySignedRecord(bundle, options);
  const {snapshot} = result.record;
  requireReceipt(snapshot.intent_confirmation === null && snapshot.number === 0 &&
    Array.isArray(snapshot.prior_findings) && result.record.controls === false &&
    !Object.hasOwn(result.record, 'installation'), 'receipt cannot grant owner authority');
  return result;
}

function marker(body) {
  const text = body || '';
  requireReceipt(!text.includes('clouseau-installation-review:'), 'installation-only evidence cannot approve an ordinary PR');
  const matches = [...text.matchAll(MARKER)];
  requireReceipt(matches.length <= 1, 'multiple receipt references');
  requireReceipt([...text.matchAll(/clouseau-local-review:/g)].length === matches.length,
    'malformed or unsupported receipt reference; no paid fallback is allowed');
  return matches[0]?.[1] || null;
}

async function loadReceipt({github, repo, ref}) {
  requireReceipt(sha(ref), 'immutable receipt reference required');
  let {data} = await github.rest.repos.getContent({...repo, ref, path: 'clouseau-review.json'});
  if (data.encoding === 'none') {
    requireReceipt(data.type === 'file' && sha(data.sha) && Number.isSafeInteger(data.size) &&
      data.size >= 0 && data.size <= MAX_RECEIPT_BYTES, 'complete receipt artifact unavailable');
    const metadata = data;
    ({data} = await github.rest.git.getBlob({...repo, file_sha: metadata.sha}));
    requireReceipt(data.sha === metadata.sha && data.size === metadata.size,
      'receipt blob differs from immutable artifact');
    requireReceipt(data.encoding === 'base64' && typeof data.content === 'string', 'complete receipt blob unavailable');
    const bytes = Buffer.from(data.content, 'base64');
    requireReceipt(bytes.length === metadata.size && crypto.createHash('sha1')
      .update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === metadata.sha,
    'receipt blob content differs from immutable artifact');
  }
  requireReceipt(data.encoding === 'base64' && typeof data.content === 'string' && data.size <= MAX_RECEIPT_BYTES,
    'complete receipt artifact unavailable');
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
}

async function verifySources({github, repo, pr, snapshot, config, files, reviewerSha, installation = null}) {
  requireReceipt(files.length === pr.changed_files && files.length > 0 &&
    digest(files.map(file => file.filename).sort()) === digest(snapshot.paths), 'changed-file inventory differs');
  requireReceipt(snapshot.files.length === files.length && files.every(file => snapshot.files.some(item =>
    item.path === file.filename && item.status === file.status)), 'changed-file status differs');
  requireReceipt(snapshot.tickets.length === 0 &&
    snapshot.intent_confirmation === null, 'unsupported mutable prior history or requirements');
  for (const filename of [config.readme, config.repository_policy]) {
    requireReceipt(Object.values(snapshot.sources).some(source => source.path === filename &&
      source.ref === (installation ? pr.head.sha : pr.base.sha) && source.authority === 'trusted' && source.kind === 'contract'),
    'protected purpose evidence omitted');
  }
  for (const [id, source] of Object.entries(snapshot.sources)) {
    if (id === 'installation-authorization') {
      requireReceipt(installation && source.authority === 'trusted' && source.kind === 'contract' &&
        source.path === `commits/${pr.head.sha}/comments/${installation.comment_id}` && source.ref === digest(installation) &&
        source.content === JSON.stringify(installation), 'installation authority was substituted');
      continue;
    }
    if (id === 'verification') {
      requireReceipt(source.authority === 'trusted' && source.kind === 'verification' && source.ref === pr.head.sha,
        'invalid local execution receipt');
      continue;
    }
    if (id === 'local-request') {
      requireReceipt(source.authority === 'untrusted' && source.kind === 'requirement' &&
        source.ref === digest(source.content), 'local request is not sealed untrusted evidence');
      continue;
    }
    if (source.path.startsWith('.clouseau-ci/')) {
      let reference;
      try {reference = require('./central-version.cjs').engineEvidence(source.path, reviewerSha);}
      catch {fail('invalid frozen engine evidence');}
      const {relative, ref} = reference;
      requireReceipt(source.ref === ref &&
        source.authority === 'untrusted' && source.kind === 'source', 'invalid frozen engine evidence');
      const root = require('node:path').join(__dirname, '..');
      // The action has already checked this source against the run digest.
      // Git-free distributions compare the same file bytes without invoking Git.
      let content;
      if (ref === reviewerSha) content = require('node:fs').readFileSync(require('node:path').join(root, relative), 'utf8');
      else {
        const {data} = await github.rest.repos.getContent({owner: 'gaulatti', repo: 'clouseau', ref, path: relative});
        requireReceipt(data.encoding === 'base64' && typeof data.content === 'string' && data.size <= 300000, 'historical engine evidence unavailable');
        content = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(data.content, 'base64'));
        requireReceipt(!content.includes('\0'), 'binary historical engine evidence');
      }
      requireReceipt(content === source.content, 'signed engine evidence differs from the accepted engine');
      continue;
    }
    requireReceipt(safePath(source.path) && [pr.base.sha, pr.head.sha].includes(source.ref) &&
      ['source', 'contract'].includes(source.kind), 'source outside exact repository revisions');
    const contract = (source.ref === pr.base.sha || (installation && source.ref === pr.head.sha)) && [config.readme, config.repository_policy].includes(source.path);
    requireReceipt(source.authority === (contract ? 'trusted' : 'untrusted') &&
      source.kind === (contract ? 'contract' : 'source'), 'source authority was promoted');
    const sourceRepo = source.ref === pr.head.sha ? {owner: pr.head.repo.owner.login, repo: pr.head.repo.name} : repo;
    const {data} = await github.rest.repos.getContent({...sourceRepo, path: source.path, ref: source.ref});
    // The Contents API describes a symlink by its target; `git show` yields the same bytes locally.
    requireReceipt(data.type === 'symlink' ? data.target === source.content :
      data.encoding === 'base64' && Buffer.from(data.content, 'base64').toString('utf8') === source.content,
    'signed evidence differs from repository source');
  }
  for (const file of snapshot.files) {
    const live = files.find(item => item.filename === file.path);
    for (const side of ['base', 'head']) {
      if ((side === 'base' && file.status === 'added') || (side === 'head' && file.status === 'removed')) continue;
      const source = snapshot.sources[file[`${side}_source`]];
      requireReceipt(source && source.ref === pr[side].sha &&
        source.path === (side === 'base' ? live.previous_filename || file.path : file.path),
      'changed-file evidence omitted or substituted');
    }
  }
}

module.exports = {DOMAIN, MAX_RECEIPT_BYTES, validateTrust, reviewDecision, issueReceipt, verifySignedRecord, verifyReceipt, marker, loadReceipt, verifySources};
