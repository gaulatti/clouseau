'use strict';

const crypto = require('node:crypto');
const {digest, validateReport} = require('./acceptance.cjs');
const {refresh, safePath, fetchText} = require('./acceptance-sources.cjs');
const {MAX_BYTES, LockfileError, isLockfile, lockfileEvidence} = require('./lockfile-summary.cjs');
const {validateInspection, combine} = require('./acceptance-review.cjs');
const {engineDigest} = require('./local-version.cjs');
const {reconcile} = require('./acceptance-ledger.cjs');
const {centralSource, acceptsEngine} = require('./central-version.cjs');
const {chunkedVerifier, RECORD_LIMIT} = require('./chunked-record.cjs');
const {partName, isRoot, splitRecord, joinRecord} = require('./receipt-parts.cjs');

const DOMAIN = 'clouseau.local-review.v1';
const MAX_RECEIPT_BYTES = 3000000;
const MARKER = /<!-- clouseau-local-review:v1 ([a-f0-9]{40}) -->/g;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fail = message => {throw new Error(`Invalid local review receipt: ${message}`);};
const requireReceipt = (value, message) => {if (!value) fail(message);};

// A receipt that is valid in every respect except that it was produced by a different engine revision than the
// protected one the caller resolved. The code, never the message text, lets the CI controller ignore it.
class EngineMismatchError extends Error {
  constructor(message) {
    super(`Invalid local review receipt: ${message}`);
    this.code = 'ENGINE_MISMATCH';
  }
}

function validateTrust(trust) {
  requireReceipt(trust && (centralSource(trust.central_source) && trust.reviewer_digest === undefined ||
    trust.central_source === undefined && /^[a-f0-9]{64}$/.test(trust.reviewer_digest)) && ['required', 'optional'].includes(trust.mode) &&
    Array.isArray(trust.keys) && trust.keys.length > 0 &&
    Number.isSafeInteger(trust.max_age_seconds) && trust.max_age_seconds > 0 &&
    trust.max_age_seconds <= 172800, 'explicit trust policy and maximum age required');
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

// A record without `partition` takes the unchanged path below. A chunked record is verified by the chunked verifier
// (new shape if present, else current); it only supplies the merged reviews, and the single derivation continues here.
function reviewDecision(record, {chunked = null} = {}) {
  const {snapshot, result} = record;
  const verifier = Object.hasOwn(record, 'partition') ? chunkedVerifier(record, chunked) : null;
  requireReceipt(snapshot && result && snapshot.digest === (verifier ? verifier.snapshotDigest() : refresh(structuredClone(snapshot)).digest),
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
    // A chunked record accounts for every unit and the integration pass inside its own verifier.
    (verifier || ['examiner', 'challenger'].every(role => ['investigation', 'grading'].every(phase =>
      (phase === 'grading' && !graded(role)) || result.usage.some(item => item.role === role && item.phase === phase)))),
    'complete independent harness execution records required');
  requireReceipt(Array.isArray(result.reviews) && result.reviews.length === 2 &&
    result.reviews.map(item => item.role).join(',') === 'examiner,challenger', 'two independent roles required');
  const reviews = verifier ? verifier.reviews() : result.reviews.map(item => ({...item,
    scores: validateReport(item.report, validateInspection(item.report, snapshot, item.drafts))}));
  const prior = record.local_previous?.findings || [];
  requireReceipt(digest(snapshot.prior_findings) === digest(prior), 'local finding history differs from the reviewed evidence');
  const state = reconcile({...result, reviews}, snapshot, prior);
  const combined = combine(reviews);
  const decision = state.unresolved.length && combined === 'auto_approve' ? 'review_incomplete' : combined;
  requireReceipt(result.decision === decision, 'claimed decision differs from calculated decision');
  return {decision, reviews};
}

function issueReceipt({record, privateKey, keyId, issuer, reviewerSha, reviewerDigest = engineDigest(), now = Date.now(), lifetime = 172800,
  nonce = crypto.randomBytes(32).toString('hex'), chunked = null}) {
  requireReceipt(reviewDecision(record, {chunked}).decision === 'auto_approve', 'only a passing review can be signed');
  requireReceipt(sha(reviewerSha) && /^[a-f0-9]{64}$/.test(reviewerDigest) && /^[a-f0-9]{64}$/.test(nonce) && Number.isSafeInteger(lifetime) &&
    lifetime > 0 && lifetime <= 172800, 'invalid runner revision, challenge or lifetime');
  const key = crypto.createPrivateKey(privateKey);
  requireReceipt(key.asymmetricKeyType === 'ed25519', 'Ed25519 signing key required');
  // A partitioned record too large for one receipt is signed as a root over consecutive parts (receipt-parts.cjs); the
  // bundle then also carries the parts, which publishing stores as separate files. Any other record is signed as before.
  const split = Object.hasOwn(record, 'partition') && Buffer.byteLength(JSON.stringify(record)) > RECORD_LIMIT ? splitRecord(record) : null;
  const payload = {type: DOMAIN, key_id: keyId, issuer, reviewer_sha: reviewerSha, reviewer_digest: reviewerDigest,
    issued_at: Math.floor(now / 1000), expires_at: Math.floor(now / 1000) + lifetime,
    nonce, record_digest: digest(record), record: split ? split.root : record};
  const signature = crypto.sign(null, Buffer.from(`${DOMAIN}\0${digest(payload)}`), key).toString('base64url');
  return split ? {payload, signature, parts: split.parts.map(part => part.toString('base64'))} : {payload, signature};
}

// The enrolled key that signed this envelope, or a refusal. It looks at the signed payload only, never at a record or a
// part, so it can run before anything else is fetched.
function signingKey(bundle, trust) {
  // The parts of a multi-part receipt travel beside the signed envelope; each is bounded like a receipt artifact.
  const keyList = bundle && typeof bundle === 'object' ? Object.keys(bundle).sort().join(',') : '';
  requireReceipt(['payload,signature', 'parts,payload,signature'].includes(keyList) &&
    typeof bundle.signature === 'string' && /^[a-zA-Z0-9_-]{86}$/.test(bundle.signature) &&
    Buffer.byteLength(JSON.stringify({payload: bundle.payload, signature: bundle.signature})) <= MAX_RECEIPT_BYTES, 'malformed signature envelope');
  const p = bundle.payload;
  requireReceipt(p && Object.keys(p).sort().join(',') ===
    'expires_at,issued_at,issuer,key_id,nonce,record,record_digest,reviewer_digest,reviewer_sha,type' && p.type === DOMAIN,
    'unknown receipt type or fields');
  const key = trust.keys.find(item => item.id === p.key_id && item.issuer === p.issuer && !item.revoked);
  requireReceipt(key && crypto.verify(null, Buffer.from(`${DOMAIN}\0${digest(p)}`), key.public_key,
    Buffer.from(bundle.signature, 'base64url')), 'untrusted, revoked or invalid signature');
  return key;
}

function verifySignedRecord(bundle, {trust, repository, author, headSha, baseSha, reviewerSha, reviewerDigest = engineDigest(), configDigest, policyDigest,
  now = Date.now(), engine = null, chunked = null}) {
  validateTrust(trust);
  const key = signingKey(bundle, trust);
  const p = bundle.payload;
  requireReceipt(key.github_actor === author, 'signing identity is not enrolled for this PR author');
  const timestamp = Math.floor(now / 1000);
  requireReceipt(Number.isSafeInteger(p.issued_at) && Number.isSafeInteger(p.expires_at) &&
    p.issued_at <= timestamp && p.expires_at > timestamp && p.expires_at > p.issued_at &&
    p.expires_at - p.issued_at <= trust.max_age_seconds && timestamp - p.issued_at <= trust.max_age_seconds &&
    typeof p.nonce === 'string' && /^[a-f0-9]{64}$/.test(p.nonce), 'expired, future or invalid challenge');
  // The engine comparison happens here, after every identity, trust and challenge check. A different engine is
  // only reported once the receipt is otherwise proven bound to this exact change; it is never accepted.
  const engineMatches = !(trust.central_source || engine) || acceptsEngine(trust, engine) && engine.digest === reviewerDigest &&
    p.reviewer_digest === engine.digest && p.reviewer_sha === engine.sha;
  requireReceipt(isRoot(p.record) === Object.hasOwn(bundle, 'parts'), 'a multi-part receipt needs its parts, and only it has them');
  let record = p.record;
  if (isRoot(record)) {
    requireReceipt(Array.isArray(bundle.parts), 'malformed multi-part record parts');
    try {
      record = joinRecord(record, bundle.parts.map(part => Buffer.from(part, 'base64')));
    } catch (error) {
      fail(error.message);
    }
  }
  const snapshot = record.snapshot;
  requireReceipt(p.record_digest === digest(record) && snapshot.repository === repository &&
    sha(headSha) && snapshot.head_sha === headSha && sha(baseSha) && snapshot.base_sha === baseSha &&
    sha(p.reviewer_sha) && snapshot.config_digest === configDigest && snapshot.policy_digest === policyDigest &&
    (!engineMatches || (!reviewerSha || p.reviewer_sha === reviewerSha) &&
      p.reviewer_digest === reviewerDigest && (engine || trust.reviewer_digest === reviewerDigest)),
  'repository, revisions, policy, configuration or record changed');
  if (!engineMatches) {
    // Another engine's scoring cannot be re-validated here; its signed claim must still be a pass.
    requireReceipt(record.result.decision === 'auto_approve', 'review did not pass');
    throw new EngineMismatchError('engine mismatch; the receipt predates the current protected engine and is never accepted as evidence');
  }
  const result = reviewDecision(record, {chunked});
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

// One artifact file of the immutable receipt commit, as bytes.
async function loadFile({github, repo, ref, path}) {
  let {data} = await github.rest.repos.getContent({...repo, ref, path});
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
  return Buffer.from(data.content, 'base64');
}

// The signed envelope and, for a multi-part receipt, its parts in the order the signed root lists them. Parts are fetched
// only for an envelope that an enrolled key signed (`trust`), so an unsigned root can never make CI read files.
async function loadReceipt({github, repo, ref, trust}) {
  requireReceipt(sha(ref), 'immutable receipt reference required');
  const bundle = JSON.parse((await loadFile({github, repo, ref, path: 'clouseau-review.json'})).toString('utf8'));
  const root = bundle?.payload?.record;
  if (isRoot(root)) {
    requireReceipt(trust, 'a multi-part receipt is only loaded against a trust policy');
    signingKey(bundle, validateTrust(trust));
    requireReceipt(Array.isArray(root.parts) && root.parts.length > 0, 'malformed multi-part record root');
    bundle.parts = [];
    for (let index = 0; index < root.parts.length; index++) {
      bundle.parts.push((await loadFile({github, repo, ref, path: partName(index)})).toString('base64'));
    }
  }
  return bundle;
}

// A derived dependency summary is never trusted as signed: it is recomputed from the exact base and head
// lockfile bytes at the live revisions, and must equal the signed source byte for byte.
async function verifyLockfileSummary({github, repo, pr, snapshot, id, source, files}) {
  const live = files.find(item => item.filename === source.path);
  const item = snapshot.files.find(candidate => candidate.path === source.path);
  requireReceipt(live && item && item.lockfile === true && isLockfile(source.path) && source.authority === 'derived', 'derived lockfile evidence is not bound to a changed lockfile');
  const view = {head_sha: pr.head.sha, head_repository: {owner: pr.head.repo.owner.login, repo: pr.head.repo.name}};
  let expected;
  try {
    const baseText = live.status === 'added' ? null :
      await fetchText({github, repo, snapshot: view, filename: live.previous_filename || live.filename, ref: pr.base.sha, limit: MAX_BYTES});
    const headText = live.status === 'removed' ? null : await fetchText({github, repo, snapshot: view, filename: live.filename, ref: pr.head.sha, limit: MAX_BYTES});
    expected = lockfileEvidence({file: live, baseSha: pr.base.sha, headSha: pr.head.sha, baseText, headText});
  } catch (error) {
    if (error instanceof LockfileError || error.unavailable) fail('derived lockfile evidence cannot be recomputed');
    throw error;
  }
  requireReceipt(expected.id === id && digest(expected.source) === digest(source), 'derived lockfile evidence differs from the repository lockfiles');
}

async function verifySources({github, repo, pr, snapshot, config, files, reviewerSha, installation = null}) {
  requireReceipt(files.length === pr.changed_files && files.length > 0 &&
    digest(files.map(file => file.filename).sort()) === digest(snapshot.paths), 'changed-file inventory differs');
  requireReceipt(snapshot.files.length === files.length && files.every(file => snapshot.files.some(item =>
    item.path === file.filename && item.status === file.status)), 'changed-file status differs');
  require('./receipt-patch.cjs').verifyPatches({snapshot, files});
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
    if (source.kind === 'lockfile-summary') {
      await verifyLockfileSummary({github, repo, pr, snapshot, id, source, files});
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
    if (file.lockfile === true) {
      const derived = [file.base_source, file.head_source].filter(Boolean);
      requireReceipt(isLockfile(file.path) && derived.length === (file.status === 'added' || file.status === 'removed' ? 1 : 2) &&
        derived.every(id => snapshot.sources[id]?.kind === 'lockfile-summary' && snapshot.sources[id].path === file.path && id === derived[0]) &&
        (file.status === 'added' ? !file.base_source : file.status === 'removed' ? !file.head_source : true), 'changed-file evidence omitted or substituted');
      continue;
    }
    for (const side of ['base', 'head']) {
      if ((side === 'base' && file.status === 'added') || (side === 'head' && file.status === 'removed')) continue;
      const source = snapshot.sources[file[`${side}_source`]];
      requireReceipt(source && source.ref === pr[side].sha &&
        source.path === (side === 'base' ? live.previous_filename || file.path : file.path),
      'changed-file evidence omitted or substituted');
    }
  }
}

module.exports = {EngineMismatchError, DOMAIN, MAX_RECEIPT_BYTES, validateTrust, reviewDecision, issueReceipt, verifySignedRecord, verifyReceipt, marker, loadReceipt, verifySources};
