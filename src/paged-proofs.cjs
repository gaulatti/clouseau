'use strict';

const {proofCatalog, resolveProof} = require('./acceptance-sources.cjs');
const {readSourcePages} = require('./source-bank.cjs');

const MAX_PROOF_CATALOG_BYTES = 100000;

// This is a bounded citation selection, not a replacement source inventory.
// Every original byte stays in the bank. Re-requesting literal pages exposes
// their exact proof IDs again when a later cross-file question needs them.
function citableProofs(snapshot, view, exposure, currentPages, currentProofs, progress = [], drafts = []) {
  if (exposure.role !== view.role || exposure.bank_digest !== view.bank.bank_digest ||
      exposure.snapshot_digest !== snapshot.digest || currentPages.some(page => page.bank_digest !== view.bank.bank_digest)) {
    throw new Error('Invalid citable proof catalog: owning view differs');
  }
  const catalog = proofCatalog(snapshot); const byId = new Map(catalog.map(proof => [proof.id, proof]));
  const indexes = new Map(Object.keys(snapshot.sources).map((source, index) => [source, index]));
  const received = new Map();
  const pages = [...exposure.rounds.flatMap(round => readSourcePages(view.bank, round.request)), ...currentPages];
  for (const page of pages) {
    const entry = view.bank.entries[page.entry];
    if (entry.kind !== 'source') continue;
    if (!received.has(entry.source)) received.set(entry.source, new Map());
    received.get(entry.source).set(page.page, page);
  }
  const offsets = new Map();
  const visible = proof => {
    const delivered = [...(received.get(proof.source)?.values() || [])].sort((a, b) => a.start_byte - b.start_byte);
    if (!offsets.has(proof.source)) {
      let offset = 0;
      offsets.set(proof.source, [0, ...snapshot.sources[proof.source].content.split('\n').map(line => offset += Buffer.byteLength(line) + 1)]);
    }
    const lines = offsets.get(proof.source); const start = lines[proof.start - 1], end = lines[proof.end] - 1;
    let cursor = start;
    for (const page of delivered) {
      if (page.start_byte > cursor) break;
      cursor = Math.max(cursor, page.end_byte);
    }
    return cursor >= end && (end > start || delivered.some(page => page.start_byte <= start && page.end_byte >= end));
  };
  const selected = new Map();
  const add = id => {
    const proof = resolveProof(byId, id);
    if (proof && visible(proof)) selected.set(proof.id, proof);
  };
  const first = new Set();
  for (const proof of catalog) if (!first.has(proof.source)) {first.add(proof.source); add(proof.id);}
  for (const proof of currentProofs) add(proof.id);
  const citations = value => {
    if (Array.isArray(value)) {value.forEach(citations); return;}
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'observations' && typeof item === 'string') {
        for (const match of item.matchAll(/\bproof-(?:0|[1-9][0-9]*)-[1-9][0-9]*\b/g)) if (byId.has(match[0])) add(match[0]);
      } else if (key === 'evidence' && Array.isArray(item) && item.every(id => typeof id === 'string')) item.forEach(add);
      else if (key === 'evidence' && item && typeof item.primary === 'string' && Array.isArray(item.additional)) {
        [item.primary, ...item.additional].forEach(add);
      }
      else if (key === 'anchor' && typeof item === 'string') add(item);
      else citations(item);
    }
  };
  citations(progress.map(item => item.response)); citations(drafts);
  const result = [...selected.values()].map(({id, source, start, end}) => ({id, source_index: indexes.get(source), start, end}));
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_PROOF_CATALOG_BYTES) {
    throw new Error('Complete citable proof catalog exceeds its schema transport budget; nothing was truncated');
  }
  return result;
}

module.exports = {MAX_PROOF_CATALOG_BYTES, citableProofs};
