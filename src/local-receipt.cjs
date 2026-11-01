'use strict';

const crypto = require('node:crypto');
const {digest, validateReport} = require('./acceptance.cjs');
const {refresh, safePath, fetchText} = require('./acceptance-sources.cjs');
const {MAX_BYTES, LockfileError, isLockfile, lockfileEvidence} = require('./lockfile-summary.cjs');
const {validateInspection, combine} = require('./acceptance-review.cjs');
const {engineDigest} = require('./local-version.cjs');
const {reconcile} = require('./acceptance-ledger.cjs');
const {centralSource, acceptsEngine} = require('./central-version.cjs');
const {chunkedVerifier, ChunkedRecordError} = require('./chunked-record.cjs');
const {ReceiptRejected} = require('./receipt-rejection.cjs');
const {ReceiptPatchMismatch} = require('./receipt-patch.cjs');

const DOMAIN = 'clouseau.local-review.v1';
const MAX_RECEIPT_BYTES = 3000000;
const MARKER = /<!-- clouseau-local-review:v1 ([a-f0-9]{40}) -->/g;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fail = message => {throw new Error(`Invalid local review receipt: ${message}`);};
const requireReceipt = (value, message) => {if (!value) fail(message);};

// A failed receipt check carries a fixed class (see receipt-rejection.cjs); configuration and issuance failures do not.
const reject = (value, message, reason) => {if (!value) throw new ReceiptRejected(reason, message);};

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
  reject(snapshot && result && snapshot.digest === (verifier ? verifier.snapshotDigest() : refresh(structuredClone(snapshot)).digest),
    'altered evidence snapshot', 'record');
  reject(result.snapshot === snapshot.digest && result.policy_digest === snapshot.policy_digest &&
    result.config_digest === snapshot.config_digest, 'review does not match evidence', 'record');
  const graded = role => result.reviews?.find(item => item.role === role)?.report?.findings?.length > 0;
  reject(Array.isArray(result.usage) && result.usage.length >= 2 &&
    result.execution_digest === digest(result.usage) && new Set(result.usage.map(item => item.session)).size === result.usage.length &&
    result.usage.every(item => ['codex', 'claude', 'opencode'].includes(item.harness) && [undefined, 'agent_session'].includes(item.execution) &&
      typeof item.session === 'string' && item.session.length > 0 &&
      ['request_digest', 'response_digest', 'transport_digest'].every(name => /^[a-f0-9]{64}$/.test(item[name]))) &&
    // Grading runs only for findings, so a role without findings has no grading round to record.
    // A chunked record accounts for every unit and the integration pass inside its own verifier.
    (verifier || ['examiner', 'challenger'].every(role => ['investigation', 'grading'].every(phase =>
      (phase === 'grading' && !graded(role)) || result.usage.some(item => item.role === role && item.phase === phase)))),
    'complete independent harness execution records required', 'record');
  reject(Array.isArray(result.reviews) && result.reviews.length === 2 &&
    result.reviews.map(item => item.role).join(',') === 'examiner,challenger', 'two independent roles required', 'record');
  const reviews = verifier ? verifier.reviews() : result.reviews.map(item => ({...item,
    scores: validateReport(item.report, validateInspection(item.report, snapshot, item.drafts))}));
  const prior = record.local_previous?.findings || [];
  reject(digest(snapshot.prior_findings) === digest(prior), 'local finding history differs from the reviewed evidence', 'record');
  const state = reconcile({...result, reviews}, snapshot, prior);
  const combined = combine(reviews);
  const decision = state.unresolved.length && combined === 'auto_approve' ? 'review_incomplete' : combined;
  reject(result.decision === decision, 'claimed decision differs from calculated decision', 'record');
  return {decision, reviews};
}

function issueReceipt({record, privateKey, keyId, issuer, reviewerSha, reviewerDigest = engineDigest(), now = Date.now(), lifetime = 172800,
  nonce = crypto.randomBytes(32).toString('hex'), chunked = null}) {
  requireReceipt(reviewDecision(record, {chunked}).decision === 'auto_approve', 'only a passing review can be signed');
  requireReceipt(sha(reviewerSha) && /^[a-f0-9]{64}$/.test(reviewerDigest) && /^[a-f0-9]{64}$/.test(nonce) && Number.isSafeInteger(lifetime) &&
    lifetime > 0 && lifetime <= 172800, 'invalid runner revision, challenge or lifetime');
  const key = crypto.createPrivateKey(privateKey);
  requireReceipt(key.asymmetricKeyType === 'ed25519', 'Ed25519 signing key required');
  const payload = {type: DOMAIN, key_id: keyId, issuer, reviewer_sha: reviewerSha, reviewer_digest: reviewerDigest,
    issued_at: Math.floor(now / 1000), expires_at: Math.floor(now / 1000) + lifetime,
    nonce, record_digest: digest(record), record};
  const signature = crypto.sign(null, Buffer.from(`${DOMAIN}\0${digest(payload)}`), key).toString('base64url');
  return {payload, signature};
}

function verifySignedRecord(bundle, {trust, repository, author, headSha, baseSha, reviewerSha, reviewerDigest = engineDigest(), configDigest, policyDigest,
  now = Date.now(), engine = null, chunked = null}) {
  validateTrust(trust);
  reject(bundle && Object.keys(bundle).sort().join(',') === 'payload,signature' &&
    typeof bundle.signature === 'string' && /^[a-zA-Z0-9_-]{86}$/.test(bundle.signature) &&
    Buffer.byteLength(JSON.stringify(bundle)) <= MAX_RECEIPT_BYTES, 'malformed signature envelope', 'malformed');
  const p = bundle.payload;
  reject(p && Object.keys(p).sort().join(',') ===
    'expires_at,issued_at,issuer,key_id,nonce,record,record_digest,reviewer_digest,reviewer_sha,type' && p.type === DOMAIN,
  'unknown receipt type or fields', 'malformed');
  const key = trust.keys.find(item => item.id === p.key_id && item.issuer === p.issuer && !item.revoked);
  reject(key && crypto.verify(null, Buffer.from(`${DOMAIN}\0${digest(p)}`), key.public_key,
    Buffer.from(bundle.signature, 'base64url')), 'untrusted, revoked or invalid signature', 'signature');
  reject(key.github_actor === author, 'signing identity is not enrolled for this PR author', 'author');
  const timestamp = Math.floor(now / 1000);
  reject(Number.isSafeInteger(p.issued_at) && Number.isSafeInteger(p.expires_at) &&
    p.issued_at <= timestamp && p.expires_at > timestamp && p.expires_at > p.issued_at &&
    p.expires_at - p.issued_at <= trust.max_age_seconds && timestamp - p.issued_at <= trust.max_age_seconds &&
    typeof p.nonce === 'string' && /^[a-f0-9]{64}$/.test(p.nonce), 'expired, future or invalid challenge', 'expired');
  const record = p.record;
  const snapshot = record.snapshot;
  const changed = 'repository, revisions, policy, configuration or record changed';
  reject(p.record_digest === digest(record) && sha(p.reviewer_sha) && Boolean(snapshot && record.result), changed, 'record');
  reject(snapshot.repository === repository && sha(headSha) && snapshot.head_sha === headSha &&
    sha(baseSha) && snapshot.base_sha === baseSha, changed, 'revision');
  reject(snapshot.config_digest === configDigest && snapshot.policy_digest === policyDigest, changed, 'changed');
  // The engine comparison happens after every identity, trust, challenge and binding check. A different engine is
  // only reported once the receipt is otherwise proven bound to this exact change; it is never accepted. Another
  // engine's scoring cannot be re-validated here, so its signed claim must still be a pass.
  const engineMatches = (!(trust.central_source || engine) || acceptsEngine(trust, engine) && engine.digest === reviewerDigest &&
    p.reviewer_digest === engine.digest && p.reviewer_sha === engine.sha) &&
    (!reviewerSha || p.reviewer_sha === reviewerSha) && p.reviewer_digest === reviewerDigest &&
    (engine || trust.reviewer_digest === reviewerDigest);
  if (!engineMatches) {
    reject(record.result.decision === 'auto_approve', 'review did not pass', 'not_passing');
    reject(false, 'engine mismatch; the receipt predates the current protected engine and is never accepted as evidence', 'engine');
  }
  const result = reviewDecision(record, {chunked});
  reject(result.decision === 'auto_approve', 'review did not pass', 'not_passing');
  return {record, ...result};
}

function verifyReceipt(bundle, options) {
  const result = verifySignedRecord(bundle, options);
  const {snapshot} = result.record;
  reject(snapshot.intent_confirmation === null && snapshot.number === 0 &&
    Array.isArray(snapshot.prior_findings) && result.record.controls === false &&
    !Object.hasOwn(result.record, 'installation'), 'receipt cannot grant owner authority', 'record');
  return result;
}

function marker(body) {
  const text = body || '';
  reject(!text.includes('clouseau-installation-review:'), 'installation-only evidence cannot approve an ordinary PR', 'malformed');
  const matches = [...text.matchAll(MARKER)];
  reject(matches.length <= 1, 'multiple receipt references', 'malformed');
  reject([...text.matchAll(/clouseau-local-review:/g)].length === matches.length,
    'malformed or unsupported receipt reference', 'malformed');
  return matches[0]?.[1] || null;
}

async function loadReceipt({github, repo, ref}) {
  reject(sha(ref), 'immutable receipt reference required', 'malformed');
  let {data} = await github.rest.repos.getContent({...repo, ref, path: 'clouseau-review.json'});
  if (data.encoding === 'none') {
    reject(data.type === 'file' && sha(data.sha) && Number.isSafeInteger(data.size) &&
      data.size >= 0 && data.size <= MAX_RECEIPT_BYTES, 'complete receipt artifact unavailable', 'unavailable');
    const metadata = data;
    ({data} = await github.rest.git.getBlob({...repo, file_sha: metadata.sha}));
    reject(data.sha === metadata.sha && data.size === metadata.size,
      'receipt blob differs from immutable artifact', 'unavailable');
    reject(data.encoding === 'base64' && typeof data.content === 'string', 'complete receipt blob unavailable', 'unavailable');
    const bytes = Buffer.from(data.content, 'base64');
    reject(bytes.length === metadata.size && crypto.createHash('sha1')
      .update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === metadata.sha,
    'receipt blob content differs from immutable artifact', 'unavailable');
  }
  reject(data.encoding === 'base64' && typeof data.content === 'string' && data.size <= MAX_RECEIPT_BYTES,
    'complete receipt artifact unavailable', 'unavailable');
  try {return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));}
  catch {throw new ReceiptRejected('malformed', 'receipt artifact is not JSON');}
}

// A derived dependency summary is never trusted as signed: it is recomputed from the exact base and head
// lockfile bytes at the live revisions, and must equal the signed source byte for byte.
async function verifyLockfileSummary({github, repo, pr, snapshot, id, source, files}) {
  const live = files.find(item => item.filename === source.path);
  const item = snapshot.files.find(candidate => candidate.path === source.path);
  reject(live && item && item.lockfile === true && isLockfile(source.path) && source.authority === 'derived', 'derived lockfile evidence is not bound to a changed lockfile', 'source');
  const view = {head_sha: pr.head.sha, head_repository: {owner: pr.head.repo.owner.login, repo: pr.head.repo.name}};
  let expected;
  try {
    const baseText = live.status === 'added' ? null :
      await fetchText({github, repo, snapshot: view, filename: live.previous_filename || live.filename, ref: pr.base.sha, limit: MAX_BYTES});
    const headText = live.status === 'removed' ? null : await fetchText({github, repo, snapshot: view, filename: live.filename, ref: pr.head.sha, limit: MAX_BYTES});
    expected = lockfileEvidence({file: live, baseSha: pr.base.sha, headSha: pr.head.sha, baseText, headText});
  } catch (error) {
    if (error instanceof LockfileError || error.unavailable) reject(false, 'derived lockfile evidence cannot be recomputed', 'source');
    throw error;
  }
  reject(expected.id === id && digest(expected.source) === digest(source), 'derived lockfile evidence differs from the repository lockfiles', 'source');
}

async function verifySources({github, repo, pr, snapshot, config, files, reviewerSha, installation = null}) {
  reject(files.length === pr.changed_files && files.length > 0 &&
    digest(files.map(file => file.filename).sort()) === digest(snapshot.paths), 'changed-file inventory differs', 'source');
  reject(snapshot.files.length === files.length && files.every(file => snapshot.files.some(item =>
    item.path === file.filename && item.status === file.status)), 'changed-file status differs', 'source');
  require('./receipt-patch.cjs').verifyPatches({snapshot, files});
  reject(snapshot.tickets.length === 0 &&
    snapshot.intent_confirmation === null, 'unsupported mutable prior history or requirements', 'record');
  for (const filename of [config.readme, config.repository_policy]) {
    reject(Object.values(snapshot.sources).some(source => source.path === filename &&
      source.ref === (installation ? pr.head.sha : pr.base.sha) && source.authority === 'trusted' && source.kind === 'contract'),
    'protected purpose evidence omitted', 'source');
  }
  for (const [id, source] of Object.entries(snapshot.sources)) {
    if (id === 'installation-authorization') {
      reject(installation && source.authority === 'trusted' && source.kind === 'contract' &&
        source.path === `commits/${pr.head.sha}/comments/${installation.comment_id}` && source.ref === digest(installation) &&
        source.content === JSON.stringify(installation), 'installation authority was substituted', 'source');
      continue;
    }
    if (id === 'verification') {
      reject(source.authority === 'trusted' && source.kind === 'verification' && source.ref === pr.head.sha,
        'invalid local execution receipt', 'source');
      continue;
    }
    if (id === 'local-request') {
      reject(source.authority === 'untrusted' && source.kind === 'requirement' &&
        source.ref === digest(source.content), 'local request is not sealed untrusted evidence', 'source');
      continue;
    }
    if (source.kind === 'lockfile-summary') {
      await verifyLockfileSummary({github, repo, pr, snapshot, id, source, files});
      continue;
    }
    if (source.path.startsWith('.clouseau-ci/')) {
      let reference;
      try {reference = require('./central-version.cjs').engineEvidence(source.path, reviewerSha);}
      catch {reject(false, 'invalid frozen engine evidence', 'source');}
      const {relative, ref} = reference;
      reject(source.ref === ref &&
        source.authority === 'untrusted' && source.kind === 'source', 'invalid frozen engine evidence', 'source');
      const root = require('node:path').join(__dirname, '..');
      // The action has already checked this source against the run digest.
      // Git-free distributions compare the same file bytes without invoking Git.
      let content;
      if (ref === reviewerSha) content = require('node:fs').readFileSync(require('node:path').join(root, relative), 'utf8');
      else {
        const {data} = await github.rest.repos.getContent({owner: 'gaulatti', repo: 'clouseau', ref, path: relative});
        reject(data.encoding === 'base64' && typeof data.content === 'string' && data.size <= 300000, 'historical engine evidence unavailable', 'source');
        content = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(data.content, 'base64'));
        reject(!content.includes('\0'), 'binary historical engine evidence', 'source');
      }
      reject(content === source.content, 'signed engine evidence differs from the accepted engine', 'source');
      continue;
    }
    reject(safePath(source.path) && [pr.base.sha, pr.head.sha].includes(source.ref) &&
      ['source', 'contract'].includes(source.kind), 'source outside exact repository revisions', 'source');
    const contract = (source.ref === pr.base.sha || (installation && source.ref === pr.head.sha)) && [config.readme, config.repository_policy].includes(source.path);
    reject(source.authority === (contract ? 'trusted' : 'untrusted') &&
      source.kind === (contract ? 'contract' : 'source'), 'source authority was promoted', 'source');
    const sourceRepo = source.ref === pr.head.sha ? {owner: pr.head.repo.owner.login, repo: pr.head.repo.name} : repo;
    const {data} = await github.rest.repos.getContent({...sourceRepo, path: source.path, ref: source.ref});
    // The Contents API describes a symlink by its target; `git show` yields the same bytes locally.
    reject(data.type === 'symlink' ? data.target === source.content :
      data.encoding === 'base64' && Buffer.from(data.content, 'base64').toString('utf8') === source.content,
    'signed evidence differs from repository source', 'source');
  }
  for (const file of snapshot.files) {
    const live = files.find(item => item.filename === file.path);
    if (file.lockfile === true) {
      const derived = [file.base_source, file.head_source].filter(Boolean);
      reject(isLockfile(file.path) && derived.length === (file.status === 'added' || file.status === 'removed' ? 1 : 2) &&
        derived.every(id => snapshot.sources[id]?.kind === 'lockfile-summary' && snapshot.sources[id].path === file.path && id === derived[0]) &&
        (file.status === 'added' ? !file.base_source : file.status === 'removed' ? !file.head_source : true), 'changed-file evidence omitted or substituted', 'source');
      continue;
    }
    for (const side of ['base', 'head']) {
      if ((side === 'base' && file.status === 'added') || (side === 'head' && file.status === 'removed')) continue;
      const source = snapshot.sources[file[`${side}_source`]];
      reject(source && source.ref === pr[side].sha &&
        source.path === (side === 'base' ? live.previous_filename || file.path : file.path),
      'changed-file evidence omitted or substituted', 'source');
    }
  }
}

// Only the receipt's own verdict is ignored. A GitHub failure other than a missing object (outage, rate limit, permission) is
// something CI itself could not do and keeps its ordinary classification.
const rejection = error => error instanceof ReceiptRejected ? error.reason : error instanceof ChunkedRecordError ? 'record' : null;

// The one decision for a claimed receipt: `ref` is set only when it verifies in every respect. Any other outcome returns
// the fixed class in `rejected` (or neither, when no receipt is claimed) and the receipt is never consulted again.
async function screenReceipt({github, repo, pr, engine, trust, configDigest, policyDigest}) {
  let ref;
  try {ref = marker(pr.body);} catch (error) {return {ref: null, rejected: error.reason};}
  if (!ref) return {ref: null, rejected: null};
  let bundle;
  try {bundle = await loadReceipt({github, repo, ref});} catch (error) {
    const reason = rejection(error) ?? (error.status === 404 ? 'unavailable' : null);
    if (!reason) throw error;
    return {ref: null, rejected: reason};
  }
  try {
    const verified = verifyReceipt(bundle, {engine, trust, repository: `${repo.owner}/${repo.repo}`, author: pr.user.login,
      headSha: pr.head.sha, baseSha: pr.base.sha, configDigest, policyDigest});
    return {ref, bundle, verified, rejected: null};
  } catch (error) {return {ref: null, rejected: rejection(error) ?? 'malformed'};}
}

// The same decision for the live repository: the signed sources, inventory and patches must equal what GitHub reports.
async function screenSources(options) {
  try {
    await verifySources(options);
    return null;
  } catch (error) {
    const reason = rejection(error) ?? (error.status === 404 ? 'source' : null);
    if (!reason) throw error;
    return reason;
  }
}

module.exports = {screenReceipt, screenSources, DOMAIN, MAX_RECEIPT_BYTES, validateTrust, reviewDecision, issueReceipt, verifySignedRecord, verifyReceipt, marker, loadReceipt, verifySources};
