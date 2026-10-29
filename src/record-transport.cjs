'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {gzipSync, gunzipSync} = require('node:zlib');
const {digest} = require('./acceptance.cjs');
const {RECORD} = require('./acceptance-controller.cjs');

// GitHub measures the 1 MiB job-output allowance approximately as UTF-16.
// Reserve space for the compact assessment and the caller's other outputs.
const MAX_ENCODED_BYTES = 400000;
const MAX_COMPRESSED_BYTES = 300000;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024;

function requireThat(condition, message) {
  if (!condition) throw new Error(`Invalid review record transport: ${message}`);
}

function validateTransport(mode, payload) {
  requireThat(mode === 'artifact' || mode === 'job-output', 'choose artifact or job-output');
  requireThat(typeof payload === 'string', 'review-record must be text');
  requireThat(mode !== 'artifact' || payload === '', 'artifact mode cannot receive review-record');
}

function binding(assessment, context, runAttempt) {
  const value = {repository: `${context.repo.owner}/${context.repo.repo}`,
    run_id: String(context.runId), run_attempt: String(runAttempt),
    head_sha: assessment.head_sha, base_sha: assessment.base_sha,
    record_digest: assessment.record_digest ?? null, repair_digest: assessment.repair_digest ?? null,
    reference_digest: assessment.record_reference_digest ?? null};
  requireThat(assessment.version === 2 && /^[^/\s]+\/[^/\s]+$/.test(value.repository) &&
    /^[1-9][0-9]*$/.test(value.run_id) && /^[1-9][0-9]*$/.test(value.run_attempt) &&
    /^[a-f0-9]{40}$/.test(value.head_sha) && /^[a-f0-9]{40}$/.test(value.base_sha), 'incomplete run or revision identity');
  for (const name of ['record_digest', 'repair_digest', 'reference_digest']) {
    requireThat(value[name] === null || /^[a-f0-9]{64}$/.test(value[name]), 'invalid assessment digest');
  }
  return value;
}

function pack(bytes) {
  requireThat(bytes.length <= MAX_EXPANDED_BYTES, 'expanded limit exceeded; nothing was truncated');
  const compressed = gzipSync(bytes);
  requireThat(compressed.length <= MAX_COMPRESSED_BYTES, 'compressed limit exceeded; nothing was truncated');
  // The compressed cap implies at most 400,000 unpadded ASCII characters.
  return compressed.toString('base64url');
}

function unpack(encoded) {
  requireThat(typeof encoded === 'string' && encoded.length > 0 && encoded.length <= MAX_ENCODED_BYTES &&
    /^[A-Za-z0-9_-]+$/.test(encoded), 'invalid or oversized base64url data');
  const compressed = Buffer.from(encoded, 'base64url');
  requireThat(compressed.length <= MAX_COMPRESSED_BYTES && compressed.toString('base64url') === encoded,
    'noncanonical or oversized compressed data');
  try {
    return gunzipSync(compressed, {maxOutputLength: MAX_EXPANDED_BYTES});
  } catch {
    throw new Error('Invalid review record transport: corrupt gzip or expanded limit exceeded');
  }
}

function verifyData(record, repair, expected) {
  if (expected.record_digest === null) {
    requireThat(record === null && repair === null && expected.repair_digest === null, 'unexpected review data');
    return;
  }
  if (expected.reference_digest !== null) {
    // A compact local record carries only run facts; the write boundary rehydrates
    // the complete record from its immutable signed receipt and recomputes it.
    requireThat(record && repair === null && expected.repair_digest === null && record.local_receipt_reference === true &&
      !('snapshot' in record) && digest(record) === expected.reference_digest, 'compact record digest differs');
    return;
  }
  requireThat(record && digest(record) === expected.record_digest &&
    record.snapshot?.repository === expected.repository && record.snapshot?.head_sha === expected.head_sha &&
    record.snapshot?.base_sha === expected.base_sha, 'record digest or revision differs');
  requireThat(expected.repair_digest === null ? repair === null :
    repair && digest(repair) === expected.repair_digest, 'repair digest differs');
}

function encode({assessment, context, runAttempt, record, repair}) {
  const expected = binding(assessment, context, runAttempt);
  verifyData(record, repair, expected);
  return pack(Buffer.from(JSON.stringify({version: 1, binding: expected, record, repair}), 'utf8'));
}

function parseJson(bytes) {
  try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));}
  catch {throw new Error('Invalid review record transport: invalid UTF-8 or JSON data');}
}

function decode({payload, assessment, context, runAttempt}) {
  const expected = binding(assessment, context, runAttempt);
  const value = parseJson(unpack(payload));
  requireThat(value && Object.keys(value).sort().join(',') === 'binding,record,repair,version' && value.version === 1,
    'invalid envelope');
  requireThat(value.binding && Object.keys(value.binding).sort().join(',') === Object.keys(expected).sort().join(',') &&
    Object.entries(expected).every(([name, item]) => value.binding[name] === item), 'foreign or stale run binding');
  verifyData(value.record, value.repair, expected);
  return {record: value.record, repair: value.repair};
}

function readBounded(filename) {
  // Read one byte past the cap so file growth cannot evade the size check.
  const fd = fs.openSync(filename, 'r');
  try {
    const bytes = Buffer.alloc(MAX_EXPANDED_BYTES + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    requireThat(length <= MAX_EXPANDED_BYTES, 'source file exceeds expanded limit; nothing was truncated');
    return bytes.subarray(0, length);
  } finally {fs.closeSync(fd);}
}

function outputValue(encoded) {
  return JSON.stringify([encoded.slice(0, 100000), encoded.slice(100000, 200000),
    encoded.slice(200000, 300000), encoded.slice(300000)]);
}

function joinParts(parts, canonical) {
  requireThat(canonical === true && Array.isArray(parts) && parts.length === 4 &&
    parts.every(part => typeof part === 'string' && part.length <= 100000), 'invalid job-output chunks');
  const encoded = parts.join('');
  requireThat(outputValue(encoded) === JSON.stringify(parts), 'noncanonical job-output chunks');
  return encoded;
}

function publish({mode, assessment, context, runAttempt, core, recordPath = RECORD}) {
  validateTransport(mode, '');
  if (mode === 'artifact') return;
  const record = assessment.record_digest ? parseJson(readBounded(recordPath)) : null;
  const repair = assessment.repair_digest ? parseJson(readBounded(`${recordPath}.repair.json`)) : null;
  core.setOutput('review-record', outputValue(encode({assessment, context, runAttempt, record, repair})));
}

function receive({mode, payload, assessment, context, runAttempt, recordPath = RECORD}) {
  validateTransport(mode, payload);
  if (mode === 'artifact') return;
  const {record, repair} = decode({payload, assessment, context, runAttempt});
  if (record === null) return;
  fs.mkdirSync(path.dirname(recordPath), {recursive: true});
  fs.writeFileSync(recordPath, JSON.stringify(record) + '\n');
  if (repair !== null) fs.writeFileSync(`${recordPath}.repair.json`, JSON.stringify(repair) + '\n');
}

function retainOversizedDiagnostic(filename, context, runAttempt, core) {
  const runId = String(context.runId);
  const attempt = String(runAttempt);
  requireThat(/^[1-9][0-9]*$/.test(runId) && /^[1-9][0-9]*$/.test(attempt), 'incomplete diagnostic run identity');
  const relative = path.relative(fs.realpathSync(process.cwd()), fs.realpathSync(os.tmpdir()));
  requireThat(relative === '..' || relative.startsWith(`..${path.sep}`), 'diagnostic temporary directory must be outside checkout');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `clouseau-review-${runId}-${attempt}-`));
  fs.chmodSync(directory, 0o700);
  const retained = path.join(directory, 'acceptance.diagnostic.json');
  fs.copyFileSync(filename, retained, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(retained, 0o600);
  const hash = createHash('sha256');
  const fd = fs.openSync(retained, 'r');
  try {
    const bytes = Buffer.alloc(65536);
    let length;
    while ((length = fs.readSync(fd, bytes, 0, bytes.length, null)) > 0) hash.update(bytes.subarray(0, length));
  } finally {fs.closeSync(fd);}
  const message = `Oversized diagnostic retained without truncation at ${retained} sha256=${hash.digest('hex')}. ` +
    'Worker-local private evidence; not a GitHub artifact. Review remains blocked.';
  core.info(message);
  throw new Error(message);
}

function preserveDiagnostic({mode, core, context, runAttempt, recordPath = RECORD}) {
  validateTransport(mode, '');
  if (mode === 'artifact' || !fs.existsSync(`${recordPath}.diagnostic.json`)) return;
  let bytes;
  let encoded;
  try {
    bytes = readBounded(`${recordPath}.diagnostic.json`);
    encoded = pack(bytes);
  } catch (error) {
    if (!/limit exceeded|exceeds expanded limit/.test(error.message)) throw error;
    return retainOversizedDiagnostic(`${recordPath}.diagnostic.json`, context, runAttempt, core);
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  core.info(`CLOUSEAU_DIAGNOSTIC_GZIP_BASE64URL_BEGIN bytes=${bytes.length} sha256=${hash} encoded=${encoded.length}`);
  for (let offset = 0; offset < encoded.length; offset += 4096) {
    core.info(`CLOUSEAU_DIAGNOSTIC_GZIP_BASE64URL ${offset / 4096 + 1} ${encoded.slice(offset, offset + 4096)}`);
  }
  core.info('CLOUSEAU_DIAGNOSTIC_GZIP_BASE64URL_END');
}

module.exports = {MAX_ENCODED_BYTES, MAX_COMPRESSED_BYTES, MAX_EXPANDED_BYTES,
  validateTransport, encode, decode, joinParts, publish, receive, preserveDiagnostic};
