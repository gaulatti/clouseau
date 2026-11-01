'use strict';

// Verification of a chunked local review record (record.partition). Dark: nothing calls this unless a verifier
// is given `chunked` options, and a record that carries a partition is rejected when it is not.
//
// A chunked record stores the combined snapshot, the partition plan, the controller-computed seams and, per role,
// one report per review unit plus the integration entries. The merged report is DERIVED, never stored, so a
// merged report that differs from its parts cannot be forged. The decision still comes from the one existing
// derivation: this module only produces the same `reviews` list (merged report plus scores) that the
// non-chunked path builds, and the caller continues with reconcile, combine and the decision comparison.
//
// The partition and merge functions belong to other modules, so they are injected (`hooks`):
//   partition({snapshot, params}) -> {scheme, params, units: [{id, owned, context_ids, view_digest, cost}], plan_digest}
//   unitView(snapshot, unitSpec)  -> a snapshot-shaped view with its own `digest`
//   seams({snapshot, plan})       -> controller-computed seams
//   merge({role, unitReports: [{unit, report}], integration, snapshot, plan}) -> one ordinary merged report
// `params` are the PROTECTED parameters ({C, S}); nothing is ever read from the record. A record is never refused for
// its size: the snapshot and the unit count are unbounded, and a record too large for one receipt is stored as a
// signed multi-part receipt (receipt-parts.cjs).

const {digest, validateReport} = require('./acceptance.cjs');
const {validateInspection} = require('./acceptance-review.cjs');
const {locations, grade} = require('./acceptance-grading.cjs');

const SCHEME = 'clouseau-partition/1';
const ROLES = ['examiner', 'challenger'];
const MAX_RECEIPT_BYTES = 3000000;
// The largest record signed as ONE receipt, leaving headroom for the envelope. A larger partitioned record is signed as a
// multi-part receipt (receipt-parts.cjs), so no record is too large.
const RECORD_LIMIT = Math.floor(MAX_RECEIPT_BYTES * 0.95);

class ChunkedRecordError extends Error {
  constructor(cause, reason) {
    super(`Chunked review record rejected: ${reason}`);
    this.code = 'CHUNKED_RECORD'; this.cause_code = cause;
  }
}
const invalid = reason => {throw new ChunkedRecordError('chunked_record_invalid', reason);};
const need = (condition, reason) => {if (!condition) invalid(reason);};
// A path or id comes from signed but untrusted data: bounded and printable before it reaches a notice.
const named = value => JSON.stringify(String(value)).slice(0, 120);
const positive = value => Number.isSafeInteger(value) && value > 0;

// `cap` and `max_units` were bounds of an earlier contract. They are still accepted so that existing protected
// configuration keeps loading, and they bound nothing.
function parseParams(raw) {
  const legacy = ['cap', 'max_units'];
  if (!raw || typeof raw !== 'object' || Object.keys(raw).some(key => !['C', 'S', ...legacy].includes(key)) ||
      !positive(raw.C) || !positive(raw.S) || legacy.some(key => raw[key] !== undefined && !positive(raw[key]))) {
    invalid('protected chunk parameters {C, S} must be positive integers');
  }
  return {C: raw.C, S: raw.S};
}
const planParams = ({C, S}) => ({C, S});

function snapshotDigest(snapshot) {
  const value = {...snapshot}; delete value.digest;
  return digest(value);
}

const regenerated = (entry, snapshot) => snapshot.sources[entry.source].content.split('\n').slice(entry.start - 1, entry.end).join('\n');
const citation = (entry, snapshot) => entry && typeof entry.id === 'string' && Object.hasOwn(snapshot.sources, entry.source) &&
  Number.isSafeInteger(entry.start) && Number.isSafeInteger(entry.end) && entry.start >= 1 && entry.end >= entry.start &&
  entry.end <= snapshot.sources[entry.source].content.split('\n').length;

// Store thin: a quote the controller can regenerate byte for byte from source and coordinates is dropped.
// Anything else (a shorter quote, a forged one) is kept so that validation still sees it.
function elideQuotes(report, snapshot) {
  const thin = structuredClone(report);
  thin.evidence = thin.evidence.map(entry => {
    if (!citation(entry, snapshot) || entry.quote !== regenerated(entry, snapshot)) return entry;
    const {quote, ...reference} = entry;
    return reference;
  });
  return thin;
}

// The exact inverse. A thin entry takes the regenerated quote; an entry that still has one keeps it for validation.
function rehydrateQuotes(report, snapshot) {
  need(Array.isArray(report?.evidence), 'report has no evidence register');
  const full = structuredClone(report);
  full.evidence = full.evidence.map(entry => {
    need(citation(entry, snapshot), `evidence entry ${named(entry?.id)} cites no known source lines`);
    if (Object.hasOwn(entry, 'quote')) return entry;
    need(Object.keys(entry).sort().join(',') === 'end,id,source,start', `thin evidence entry ${named(entry.id)} has unexpected fields`);
    return {...entry, quote: regenerated(entry, snapshot)};
  });
  return full;
}

// Wrap the existing validators so their (controller-constant) messages become a visible, specific reason.
function checked(subject, run) {
  try {return run();} catch (error) {
    return invalid(`${subject} failed validation: ${String(error.message).slice(0, 160)}`);
  }
}

function checkOwnership(snapshot, plan) {
  const owners = new Map(); const ids = new Set();
  for (const unit of plan.units) {
    need(unit && typeof unit.id === 'string' && !ids.has(unit.id), `unit id ${named(unit?.id)} is missing or repeated`);
    ids.add(unit.id);
    need(Array.isArray(unit.owned) && unit.owned.length > 0 && Array.isArray(unit.context_ids), `unit ${unit.id} has no owned paths`);
    const parts = unit.parts ?? {};
    need(parts && typeof parts === 'object' && !Array.isArray(parts) && Object.entries(parts).every(([path, part]) => unit.owned.includes(path) &&
      part && Number.isSafeInteger(part.index) && Number.isSafeInteger(part.count) && part.index >= 0 && part.index < part.count),
    `unit ${unit.id} names a malformed segment`);
    for (const path of unit.owned) {
      need(snapshot.paths.includes(path), `unit ${unit.id} owns ${named(path)}, which is not a changed path`);
      const seen = owners.get(path) ?? [];
      need(!seen.length || (parts[path] && seen[0].part), `duplicate ownership: ${named(path)} is owned by units ${seen[0]?.unit} and ${unit.id}`);
      owners.set(path, [...seen, {unit: unit.id, part: parts[path]}]);
    }
    need(new Set(unit.context_ids).size === unit.context_ids.length &&
      unit.context_ids.every(id => Object.hasOwn(snapshot.sources, id)), `unit ${unit.id} lists unknown or repeated context sources`);
  }
  const unowned = snapshot.paths.filter(path => !owners.has(path));
  need(unowned.length === 0, `changed path ${named(unowned[0])} is owned by no unit`);
  // A split file is covered by each of its segments exactly once.
  for (const [path, list] of owners) {
    const count = list[0].part?.count;
    need(count === undefined || (list.length === count && list.every(item => item.part.count === count) &&
      new Set(list.map(item => item.part.index)).size === count), `changed path ${named(path)} is not covered by each of its segments exactly once`);
  }
}

function unitReportsOf(review, plan, views, role) {
  need(Array.isArray(review.unit_reports), `${role} has no unit reports`);
  const byUnit = new Map();
  for (const item of review.unit_reports) {
    need(item && typeof item.unit === 'string' && views.has(item.unit), `${role} has a report for unknown unit ${named(item?.unit)}`);
    need(!byUnit.has(item.unit), `${role} has more than one report for unit ${item.unit}`);
    byUnit.set(item.unit, item);
  }
  return plan.units.map(unit => {
    const item = byUnit.get(unit.id);
    need(item, `${role} has no report for unit ${unit.id}`);
    const view = views.get(unit.id);
    need(item.report?.snapshot === view.digest, `${role} report for unit ${unit.id} is not bound to that unit's view (swapped or stale report)`);
    const drafts = (item.drafts ?? []).map(draft => rehydrateQuotes(draft, view));
    const report = rehydrateQuotes(item.report, view);
    checked(`${role} report for unit ${unit.id}`, () => validateInspection(report, view, drafts));
    return {unit: unit.id, report};
  });
}

// One atomic grade per factor of the merged report, as in the non-chunked local review.
function applyGrades(merged, review, role) {
  const entries = locations(merged);
  const decisions = review.grading?.decisions ?? [];
  need(decisions.length === entries.length && new Set(decisions.map(item => item.id)).size === decisions.length &&
    entries.every(entry => decisions.some(item => item.id === entry.id)), `${role} grading does not cover exactly the merged findings`);
  for (const entry of entries) {
    const decision = decisions.find(item => item.id === entry.id);
    const {value} = checked(`${role} grade ${entry.id}`, () => grade(decision.answer));
    need(decision.value === value, `${role} grade ${entry.id} differs from its recorded answer`);
    entry.target.value = value;
  }
  return entries.length > 0;
}

function checkUsage(result, plan, graded, seams) {
  const ids = new Set(plan.units.map(unit => unit.id));
  need(result.usage.every(item => item.unit === undefined || ids.has(item.unit)), 'harness execution is tagged with an unknown unit');
  for (const role of ROLES) {
    const mine = result.usage.filter(item => item.role === role);
    for (const unit of plan.units) {
      need(mine.some(item => item.phase === 'investigation' && item.unit === unit.id), `${role} has no recorded investigation of unit ${unit.id}`);
    }
    // With no seams (recomputed by CI) there is nothing to integrate and no session is made.
    need(!seams.length || mine.some(item => item.phase === 'integration'), `${role} has no recorded integration pass`);
    need(!graded[role] || mine.some(item => item.phase === 'grading'), `${role} has no recorded grading round`);
  }
}

function usable(chunked) {
  const hooks = chunked?.hooks;
  need(chunked && hooks && ['partition', 'unitView', 'seams', 'merge'].every(name => typeof hooks[name] === 'function'),
    'this verifier is not enabled for chunked records (no protected parameters or recompute hooks)');
  return {params: parseParams(chunked.params), hooks};
}

// Returns {snapshotDigest(), reviews()}. `reviews()` is what the one existing derivation consumes.
function chunkedVerifier(record, chunked) {
  const {params, hooks} = usable(chunked);
  const {snapshot, result, partition} = record;
  need(partition && typeof partition === 'object' && Object.keys(partition).sort().join(',') === 'params,plan_digest,scheme,units' && partition.scheme === SCHEME,
    `unknown or malformed partition scheme ${named(partition?.scheme)}`);
  return {
    snapshotDigest: () => snapshotDigest(snapshot),
    reviews: () => {
      need(digest(partition.params) === digest(planParams(params)), 'partition parameters differ from the protected configuration');
      need(Array.isArray(partition.units) && partition.units.length > 0, 'partition has no units');
      checkOwnership(snapshot, partition);
      const views = new Map();
      for (const unit of partition.units) {
        const view = hooks.unitView(snapshot, unit);
        need(view.digest === unit.view_digest, `view digest of unit ${unit.id} differs from the recomputed unit view`);
        views.set(unit.id, view);
      }
      need(digest(hooks.partition({snapshot, params})) === digest(partition),
        'forged partition: it differs from the plan recomputed from the signed evidence and protected parameters');
      need(Array.isArray(record.seams) && digest(hooks.seams({snapshot, plan: partition})) === digest(record.seams),
        'seams differ from the seams recomputed from the signed evidence');
      const graded = {};
      const reviews = result.reviews.map(review => {
        const role = review.role;
        need(!Object.hasOwn(review, 'report') && !Object.hasOwn(review, 'scores'),
          `${role} review stores a merged report or scores; the merged report is derived and must not be stored`);
        need(Array.isArray(review.integration), `${role} has no integration entries`);
        const unitReports = unitReportsOf(review, partition, views, role);
        const merged = hooks.merge({role, unitReports, integration: review.integration, snapshot, plan: partition});
        graded[role] = applyGrades(merged, review, role);
        const drafts = (review.drafts ?? []).map(draft => rehydrateQuotes(draft, snapshot));
        const scores = checked(`${role} merged report`, () => validateReport(merged, validateInspection(merged, snapshot, drafts)));
        return {role, report: merged, drafts, scores};
      });
      checkUsage(result, partition, graded, record.seams);
      return reviews;
    },
  };
}

module.exports = {SCHEME, RECORD_LIMIT, ChunkedRecordError, parseParams, snapshotDigest, elideQuotes, rehydrateQuotes, chunkedVerifier};
