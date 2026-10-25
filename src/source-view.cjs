'use strict';

const {digest} = require('./acceptance.cjs');
const {createSourceBank, readSourcePages} = require('./source-bank.cjs');

const MAX_VIEW_ROUNDS = 128;
const states = new WeakMap();
const roles = ['examiner', 'challenger'];
const fields = ['request_digest', 'response_digest', 'transport_digest'];
const requireView = (condition, message) => {
  if (!condition) throw new Error(`Invalid source inspection: ${message}`);
};
const exact = (value, names) => value && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',');
const invocationValid = value => exact(value, fields) && fields.every(name => /^[a-f0-9]{64}$/.test(value[name]));

function createSourceView(snapshot, role) {
  requireView(roles.includes(role), 'independent role');
  const view = Object.freeze({role, bank: createSourceBank(snapshot)});
  states.set(view, {rounds: [], seen: new Map(), pending: null});
  return view;
}

function prepareSourcePages(view, request) {
  const state = states.get(view);
  requireView(state && !state.pending, 'pending page delivery');
  requireView(state.rounds.length < MAX_VIEW_ROUNDS, 'page investigation budget');
  const pages = readSourcePages(view.bank, request);
  state.pending = {request: JSON.parse(JSON.stringify(request)), pages};
  return pages;
}

function recordSourcePages(view, provenance) {
  const state = states.get(view);
  requireView(state?.pending, 'no pending page delivery');
  const invocation = Object.fromEntries(fields.map(name => [name, provenance?.[name]]));
  requireView(provenance?.role === view.role && provenance.phase === 'investigation' && invocationValid(invocation), 'execution provenance');
  requireView(!state.rounds.some(round => digest(round.invocation) === digest(invocation)), 'duplicate execution provenance');
  state.rounds.push({request: state.pending.request, pages_digest: digest(state.pending.pages), invocation});
  for (const page of state.pending.pages) {
    if (!state.seen.has(page.entry)) state.seen.set(page.entry, new Map());
    state.seen.get(page.entry).set(page.page, page);
  }
  state.pending = null;
}

function sourceExposure(view) {
  const state = states.get(view);
  requireView(state && !state.pending, 'pending page delivery');
  return {version: 1, role: view.role, snapshot_digest: view.bank.snapshot_digest, bank_digest: view.bank.bank_digest,
    rounds: JSON.parse(JSON.stringify(state.rounds))};
}

function requiredEntry(snapshot, entry) {
  return entry.kind !== 'source' || snapshot.files.some(file => [file.base_source, file.head_source].includes(entry.source)) ||
    entry.authority === 'trusted' && ['contract', 'verification'].includes(entry.source_kind);
}

// Current literal pages may constrain the response schema, but they never
// enter the acknowledged journal until the actual invocation completes.
function pageAvailability(snapshot, bank, exposure, currentPages = []) {
  requireView(exposure.snapshot_digest === snapshot.digest && bank.snapshot_digest === snapshot.digest &&
    exposure.bank_digest === bank.bank_digest && Array.isArray(currentPages), 'availability identity');
  requireView(currentPages.every(page => page.bank_digest === bank.bank_digest), 'current availability page identity');
  const received = new Map(bank.entries.map(entry => [entry.entry, new Set()]));
  for (const selector of [...exposure.rounds.flatMap(round => round.request.pages), ...currentPages]) {
    const entry = bank.entries[selector.entry];
    requireView(entry && Number.isSafeInteger(selector.entry) && Number.isSafeInteger(selector.page) && selector.page >= 0 && selector.page < entry.page_count,
      'availability selector');
    received.get(entry.entry).add(selector.page);
  }
  const entries = bank.entries.map(entry => ({entry: entry.entry, required: requiredEntry(snapshot, entry),
    page_count: entry.page_count, received_pages: [...received.get(entry.entry)].sort((a, b) => a - b)}));
  const unread = entries.filter(entry => entry.required).flatMap(entry => Array.from({length: entry.page_count}, (_, page) =>
    ({entry: entry.entry, page})).filter(selector => !received.get(entry.entry).has(selector.page)));
  return {role: exposure.role, bank_digest: bank.bank_digest, snapshot_digest: snapshot.digest, entries,
    required_unread_page_selectors: unread, completeness_ready: unread.length === 0,
    inspected_sources: bank.entries.filter(entry => entry.kind === 'source' && received.get(entry.entry).size === entry.page_count)
      .map(entry => entry.source)};
}

function verifySourceExposure(snapshot, report, exposure, usage) {
  requireView(exact(exposure, ['version', 'role', 'snapshot_digest', 'bank_digest', 'rounds']) && exposure.version === 1 &&
    roles.includes(exposure.role), 'exposure identity');
  const view = createSourceView(snapshot, exposure.role);
  requireView(exposure.snapshot_digest === snapshot.digest && exposure.bank_digest === view.bank.bank_digest, 'frozen exposure identity');
  requireView(Array.isArray(exposure.rounds) && exposure.rounds.length <= MAX_VIEW_ROUNDS, 'exposure round budget');
  for (const round of exposure.rounds) {
    requireView(exact(round, ['request', 'pages_digest', 'invocation']) && invocationValid(round.invocation), 'recorded delivery');
    const pages = prepareSourcePages(view, round.request);
    requireView(digest(pages) === round.pages_digest, 'substituted page delivery');
    if (usage !== undefined) requireView(Array.isArray(usage) && usage.some(call => call.role === view.role &&
      call.phase === 'investigation' && fields.every(name => call[name] === round.invocation[name])), 'missing authenticated execution');
    recordSourcePages(view, {role: view.role, phase: 'investigation', ...round.invocation});
  }
  const seen = states.get(view).seen;
  const entries = view.bank.entries;
  const sourceEntry = source => entries.find(entry => entry.kind === 'source' && entry.source === source);
  const complete = entry => entry && seen.get(entry.entry)?.size === entry.page_count;
  requireView(Array.isArray(report.evidence), 'citation inventory');
  for (const proof of report.evidence) {
    const entry = sourceEntry(proof.source);
    requireView(entry && Number.isSafeInteger(proof.start) && Number.isSafeInteger(proof.end), 'citation identity');
    const lines = snapshot.sources[proof.source].content.split('\n');
    requireView(proof.start >= 1 && proof.end >= proof.start && proof.end <= lines.length &&
      proof.quote === lines.slice(proof.start - 1, proof.end).join('\n'), 'citation bytes');
    const start = Buffer.byteLength(lines.slice(0, proof.start - 1).join('\n')) + (proof.start > 1 ? 1 : 0);
    const end = start + Buffer.byteLength(proof.quote);
    let cursor = start;
    const delivered = [...(seen.get(entry.entry)?.values() || [])].sort((a, b) => a.start_byte - b.start_byte);
    for (const page of delivered) {
      if (page.start_byte > cursor) break;
      cursor = Math.max(cursor, page.end_byte);
    }
    requireView(cursor >= end && (end > start || delivered.some(page =>
      page.start_byte <= start && page.end_byte >= end)), 'unseen citation bytes');
  }
  for (const item of report.coverage.sources) {
    if (item.state === 'inspected') requireView(complete(sourceEntry(item.source)), 'unseen source claimed inspected');
  }
  for (const item of report.coverage.dependencies) {
    if (item.state !== 'inspected') continue;
    const inspected = item.evidence.map(id => report.evidence.find(proof => proof.id === id)).some(proof => {
      const entry = proof && sourceEntry(proof.source);
      return entry?.path === item.path && entry.ref === snapshot.head_sha && complete(entry);
    });
    requireView(inspected, 'unseen dependency claimed inspected');
  }
  if (report.gates.find(gate => gate.name === 'review_completeness').state === 'satisfied') {
    for (const entry of entries) {
      requireView(!requiredEntry(snapshot, entry) || complete(entry), 'unseen required page cannot establish completeness');
    }
  }
  return true;
}

module.exports = {MAX_VIEW_ROUNDS, createSourceView, prepareSourcePages, recordSourcePages, sourceExposure, requiredEntry, pageAvailability, verifySourceExposure};
