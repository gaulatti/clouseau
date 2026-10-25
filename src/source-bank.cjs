'use strict';

const {createHash} = require('node:crypto');
const {digest} = require('./acceptance.cjs');

const LIMITS = Object.freeze({source_bytes: 2000000, entry_bytes: 4000000, bank_bytes: 16000000,
  entries: 1024, page_bytes: 32000, pages_per_view: 4, view_bytes: 300000, manifest_bytes: 200000, prompt_bytes: 900000});
const contents = new WeakMap();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const requireBank = (condition, message) => {
  if (!condition) throw new Error(`Invalid immutable source bank: ${message}`);
};

function createSourceBank(snapshot) {
  requireBank(snapshot && typeof snapshot === 'object' && snapshot.sources && typeof snapshot.sources === 'object' &&
    !Array.isArray(snapshot.sources) && Array.isArray(snapshot.files), 'snapshot inventory');
  const {digest: identity, ...identitySource} = snapshot;
  requireBank(identity === digest(identitySource), 'snapshot identity');
  requireBank(Buffer.byteLength(JSON.stringify(snapshot)) <= LIMITS.bank_bytes, 'complete bank exceeds byte budget');
  const sourceEntries = Object.entries(snapshot.sources);
  requireBank(sourceEntries.length > 0 && sourceEntries.length + snapshot.files.length + 1 <= LIMITS.entries, 'entry inventory');
  const raw = sourceEntries.map(([source, value]) => {
    requireBank(value && typeof value.path === 'string' && typeof value.ref === 'string' &&
      ['trusted', 'untrusted'].includes(value.authority) && typeof value.kind === 'string', 'source identity');
    return {kind: 'source', source, path: value.path, ref: value.ref, authority: value.authority,
      source_kind: value.kind, text: value.content};
  });
  for (const file of snapshot.files) {
    requireBank(file && typeof file.path === 'string' && typeof file.patch === 'string', 'changed patch inventory');
    raw.push({kind: 'patch', path: file.path, ref: snapshot.head_sha, authority: 'untrusted', text: file.patch});
  }
  const {sources, files, digest: ignored, ...metadata} = snapshot;
  raw.push({kind: 'context', path: 'frozen-change-context', ref: identity, authority: 'untrusted',
    text: JSON.stringify({...metadata, files: files.map(({patch, ...file}) => file)})});
  const pages = [];
  const entries = raw.map(({text, ...description}, entry) => {
    requireBank(typeof text === 'string' && !text.includes('\0'), 'complete textual entry');
    const bytes = Buffer.from(text, 'utf8');
    requireBank(bytes.toString('utf8') === text, 'lossy UTF-8 entry');
    requireBank(bytes.length <= (description.kind === 'source' ? LIMITS.source_bytes : LIMITS.entry_bytes), 'entry exceeds byte budget');
    const chunks = [];
    let offset = 0; let line = 1;
    do {
      let end = Math.min(bytes.length, offset + LIMITS.page_bytes);
      // A page boundary never replaces part of a UTF-8 scalar. Adjacent byte
      // intervals reconstruct the original blob, including very long lines.
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      const literal = bytes.subarray(offset, end).toString('utf8');
      const nextLine = line + literal.split('\n').length - 1;
      chunks.push(Object.freeze({entry, page: chunks.length, start_byte: offset, end_byte: end,
        start_line: line, end_line: nextLine, sha256: sha256(literal), text: literal}));
      offset = end; line = nextLine;
    } while (offset < bytes.length);
    pages.push(Object.freeze(chunks));
    return Object.freeze({...description, entry, bytes: bytes.length, sha256: sha256(bytes), line_count: line, page_count: chunks.length});
  });
  const manifest = {version: 1, snapshot_digest: identity, entries: Object.freeze(entries)};
  const bank = Object.freeze({...manifest, bank_digest: digest(manifest)});
  requireBank(Buffer.byteLength(JSON.stringify(bank)) <= LIMITS.manifest_bytes, 'complete inventory exceeds view budget');
  contents.set(bank, Object.freeze(pages));
  return bank;
}

function readSourcePages(bank, request) {
  const stored = contents.get(bank);
  requireBank(stored && request && Object.keys(request).sort().join(',') === 'bank_digest,pages' &&
    request.bank_digest === bank.bank_digest, 'frozen view identity');
  requireBank(Array.isArray(request.pages) && request.pages.length > 0 && request.pages.length <= LIMITS.pages_per_view,
    'page request budget');
  const selected = new Set();
  const result = request.pages.map(item => {
    requireBank(item && Object.keys(item).sort().join(',') === 'entry,page' && Number.isSafeInteger(item.entry) &&
      item.entry >= 0 && item.entry < stored.length && Number.isSafeInteger(item.page) &&
      item.page >= 0 && item.page < stored[item.entry].length, 'page selector');
    const id = `${item.entry}:${item.page}`;
    requireBank(!selected.has(id), 'duplicate page selector'); selected.add(id);
    return Object.freeze({bank_digest: bank.bank_digest, ...stored[item.entry][item.page]});
  });
  requireBank(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.view_bytes, 'complete page view exceeds byte budget');
  return Object.freeze(result);
}

module.exports = {LIMITS, createSourceBank, readSourcePages};
