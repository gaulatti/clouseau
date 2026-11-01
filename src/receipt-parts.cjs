'use strict';

// Multi-part receipts (design: chunked review). A receipt is one signed JSON file of at most 3,000,000 bytes, which a
// record of a very large change cannot fit however thin its reports are. Such a record is stored as consecutive byte
// slices of its own JSON, and the signed payload carries a ROOT in place of the record: the slice count, sizes and
// SHA-256 digests. The signature therefore covers every byte of every part, no part can be altered, dropped, reordered
// or swapped, and the verifier rebuilds exactly the record that was signed (`payload.record_digest` is the digest of the
// rebuilt record, not of the root). A record that fits one receipt is signed as before and never has a root.
//
// The limit that remains is the verifier's memory: it parses the whole rebuilt record as one JSON text, so a record
// beyond the JavaScript string limit (about 512 MB) cannot be verified. That is hundreds of megabytes of changed source.
const crypto = require('node:crypto');

const PART_SCHEME = 'clouseau-receipt-parts/1';
// Each part stays well inside the 3,000,000 byte file bound of a receipt artifact.
const PART_BYTES = 2000000;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const partName = index => `clouseau-review.part-${String(index + 1).padStart(4, '0')}`;
const isRoot = value => Boolean(value) && typeof value === 'object' && value.scheme === PART_SCHEME;
const digestOf = value => /^[a-f0-9]{64}$/.test(value);

function splitRecord(record, partBytes = PART_BYTES) {
  if (!Number.isSafeInteger(partBytes) || partBytes < 1) throw new TypeError('partBytes must be a positive integer');
  const bytes = Buffer.from(JSON.stringify(record));
  const parts = [];
  for (let at = 0; at < bytes.length; at += partBytes) parts.push(bytes.subarray(at, at + partBytes));
  return {root: {scheme: PART_SCHEME, bytes: bytes.length, sha256: sha256(bytes), parts: parts.map(part => ({bytes: part.length, sha256: sha256(part)}))}, parts};
}

// Rebuilds the record from the root and the part bytes (in order). Throws a plain Error with a specific reason.
function joinRecord(root, parts) {
  const listed = root.parts;
  const wellFormed = Object.keys(root).sort().join(',') === 'bytes,parts,scheme,sha256' && Array.isArray(listed) && listed.length > 0 &&
    digestOf(root.sha256) && Number.isSafeInteger(root.bytes) &&
    listed.every(item => item && Object.keys(item).sort().join(',') === 'bytes,sha256' && Number.isSafeInteger(item.bytes) && item.bytes > 0 && digestOf(item.sha256)) &&
    listed.reduce((total, item) => total + item.bytes, 0) === root.bytes;
  if (!wellFormed) throw new Error('malformed multi-part record root');
  if (!Array.isArray(parts) || parts.length !== listed.length) throw new Error('multi-part record parts are missing or extra');
  parts.forEach((part, index) => {
    if (!Buffer.isBuffer(part) || part.length !== listed[index].bytes || sha256(part) !== listed[index].sha256) {
      throw new Error(`multi-part record part ${index + 1} differs from the signed root`);
    }
  });
  const bytes = Buffer.concat(parts);
  if (sha256(bytes) !== root.sha256) throw new Error('multi-part record differs from the signed root');
  return JSON.parse(bytes.toString('utf8'));
}

module.exports = {PART_SCHEME, PART_BYTES, partName, isRoot, splitRecord, joinRecord};
