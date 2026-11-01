'use strict';

// Review units for a change whose complete evidence exceeds one snapshot budget (design: chunked review).
//
// A unit is a VIEW of the combined snapshot, never a copy of its sources: `unitView` is a pure, read-only
// function that returns an ordinary snapshot an unchanged examiner, challenger and validator can use.
// `mergeUnitReports` turns the validated per-unit reports back into ONE ordinary report over the combined
// snapshot, so the existing `validateInspection`, `scoreReport`, `approvalHold` and `combine` derive the
// decision exactly once, from that merged input. Nothing here decides anything and nothing here is called yet.
//
// Unit input shape (pinned by the design's record, `partition.units[]`; the partition planner produces it):
//   {id: string, owned: [changed paths], context_ids: [source ids of the combined snapshot]}
// Every changed path is owned by exactly one unit (invariant I1). A source that is not a changed file's own
// base/head source and is not named in any unit's `context_ids` is shared context and goes to every unit.

const {GATES, digest, specifiersOf, resolveSpecifier, JS_PATH} = require('./acceptance.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const {validateInspection} = require('./acceptance-review.cjs');

const DEFAULTS = Object.freeze({cap: 900000, sharedCap: 100000, manifestCap: 60000, foreignShare: 0.2});
// Strictest first: a violated gate anywhere is violated, `inapplicable` only when every unit says so.
const STRICTNESS = Object.freeze(['violated', 'unresolved', 'satisfied', 'inapplicable']);
const DISPOSITION = Object.freeze(['missing', 'inspected', 'excluded']);

function refuse(code, message, extra = {}) {
  return Object.assign(new Error(`${message} (${code})`), {code, ...extra});
}

const size = sources => sources.reduce((total, source) => total + source.content.length, 0);
const fileSources = file => [file.base_source, file.head_source].filter(Boolean);

// I1: the specs are a disjoint cover of the changed paths and `unit` is one of them.
function checkPartition(snapshot, unit, units) {
  const ids = units.map(item => item.id);
  const owned = units.flatMap(item => item.owned);
  if (units.some(item => typeof item.id !== 'string' || !item.id || !Array.isArray(item.owned) || !Array.isArray(item.context_ids)) ||
      new Set(ids).size !== ids.length || !units.some(item => item.id === unit.id && digest(item) === digest(unit))) {
    throw refuse('partition_invalid', 'Unit specifications are malformed, repeated or do not contain this unit');
  }
  if (owned.length !== new Set(owned).size || owned.length !== snapshot.paths.length || !snapshot.paths.every(name => owned.includes(name))) {
    throw refuse('partition_invalid', 'Units must own every changed path exactly once');
  }
  if (units.some(item => item.context_ids.some(id => !Object.hasOwn(snapshot.sources, id)))) {
    throw refuse('partition_invalid', 'A unit names context that is not a source of the combined snapshot');
  }
}

const patchLines = patch => {
  const counts = {additions: 0, deletions: 0};
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) counts.additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) counts.deletions++;
  }
  return counts;
};

// Every changed path with its status, line counts, evidence size, rename origin and owning unit: all units see
// the whole change, so a reviewer knows what lies outside the files it owns.
function manifestOf(snapshot, units) {
  const owner = new Map(units.flatMap(item => item.owned.map(name => [name, item.id])));
  return snapshot.files.map(file => {
    const sources = fileSources(file).map(id => snapshot.sources[id]);
    const previous = sources.find(source => source.path !== file.path)?.path;
    return {path: file.path, status: file.status, ...(previous ? {previous_path: previous} : {}), ...patchLines(file.patch),
      size: size(sources), unit: owner.get(file.path)};
  });
}

// For each import edge from an owned file to a changed file of ANOTHER unit, that callee's patch, read-only.
// Total size is bounded; what does not fit is listed so the omission is visible, never silent.
function foreignHunks(snapshot, ownedFiles, ownedPaths, units, budget) {
  const owner = new Map(units.flatMap(item => item.owned.map(name => [name, item.id])));
  const others = snapshot.files.filter(file => !ownedPaths.has(file.path));
  const known = others.map(file => file.path);
  const wanted = new Set();
  for (const file of ownedFiles.filter(item => item.head_source && JS_PATH.test(item.path))) {
    for (const specifier of specifiersOf(snapshot.sources[file.head_source].content)) {
      for (const target of resolveSpecifier(file.path, specifier, known)) wanted.add(target);
    }
  }
  const hunks = []; const omitted = [];
  let used = 0;
  for (const file of others.filter(item => wanted.has(item.path)).sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (used + file.patch.length > budget) omitted.push(file.path);
    else {used += file.patch.length; hunks.push({path: file.path, unit: owner.get(file.path), status: file.status, patch: file.patch});}
  }
  return {foreign_hunks: hunks, foreign_omitted: omitted};
}

// A normal snapshot for one unit. Same base, head, policy and configuration as the combined snapshot, so its
// digest binds all of them; `partition_of` binds the combined snapshot itself.
function unitView(snapshot, unit, options = {}) {
  const {cap, sharedCap, manifestCap, foreignShare} = Object.fromEntries(Object.entries(DEFAULTS).map(([name, value]) => [name, options[name] === undefined ? value : options[name]]));
  // A comparison with NaN, a string, zero, a negative or Infinity is false or vacuous and would accept oversized evidence.
  for (const [name, value] of Object.entries({cap, sharedCap, manifestCap})) {
    if (!Number.isSafeInteger(value) || value <= 0) throw refuse('limit_invalid', `Evidence limit ${name} must be a positive safe integer`);
  }
  if (typeof foreignShare !== 'number' || !(foreignShare > 0 && foreignShare <= 1)) throw refuse('limit_invalid', 'Evidence limit foreignShare must be a number above 0 and at most 1');
  const units = options.units || [unit];
  checkPartition(snapshot, unit, units);
  const ownedPaths = new Set(unit.owned);
  const ownedFiles = snapshot.files.filter(file => ownedPaths.has(file.path));
  const changed = new Set(snapshot.files.flatMap(fileSources));
  const mine = new Set(ownedFiles.flatMap(fileSources));
  const named = new Set(units.flatMap(item => item.context_ids));
  const ids = Object.keys(snapshot.sources).filter(id => mine.has(id) || unit.context_ids.includes(id) ||
    snapshot.sources[id].authority === 'derived' || (!changed.has(id) && !named.has(id)));
  const shared = ids.filter(id => !mine.has(id) && !unit.context_ids.includes(id));
  if (size(shared.map(id => snapshot.sources[id])) > sharedCap) {
    throw refuse('shared_context_too_large', 'Shared review context exceeds its cap', {unit: unit.id});
  }
  const manifest = manifestOf(snapshot, units);
  if (JSON.stringify(manifest).length > manifestCap) throw refuse('manifest_too_large', 'The change manifest exceeds its cap', {unit: unit.id});
  const previousPaths = new Set(ownedFiles.flatMap(file => fileSources(file).map(id => snapshot.sources[id].path)));
  const first = units[0].id === unit.id;
  const view = {...snapshot,
    paths: [...unit.owned].sort(), files: ownedFiles,
    sources: Object.fromEntries(ids.map(id => [id, snapshot.sources[id]])),
    history: snapshot.history.filter(item => previousPaths.has(item.path)),
    // A prior finding belongs to the unit that owns its path; one whose path is no longer in the change goes to the first unit.
    prior_findings: snapshot.prior_findings?.filter(item => ownedPaths.has(item.path) || (first && !snapshot.paths.includes(item.path))),
    unit: {id: unit.id, owned: [...unit.owned].sort(), context_ids: [...unit.context_ids].sort()},
    partition_of: snapshot.digest, change_manifest: manifest,
    ...foreignHunks(snapshot, ownedFiles, ownedPaths, units, Math.floor(cap * foreignShare))};
  if (snapshot.covering_tests) view.covering_tests = Object.fromEntries(Object.entries(snapshot.covering_tests).filter(([name]) => ownedPaths.has(name)));
  delete view.digest;
  try {
    return refresh(view, cap);
  } catch (error) {
    throw refuse('unit_exceeds_budget', error.message, {unit: unit.id});
  }
}

// The digest `refresh` assigns, without applying any size cap (the cap was enforced when the view was built).
const viewDigest = view => {const {digest: _, ...value} = view; return digest(value);};

// `reports`: [{view, report, drafts}] from running the unchanged reviewers on each `unitView`, in plan order.
// `snapshot`: the combined snapshot. Returns {report, drafts} for the existing validators.
function mergeUnitReports(reports, snapshot) {
  const views = reports.map(item => item.view);
  const ids = views.map(view => view.unit.id);
  const owned = views.flatMap(view => view.unit.owned);
  if (new Set(ids).size !== ids.length || owned.length !== new Set(owned).size || owned.length !== snapshot.paths.length ||
      !snapshot.paths.every(name => owned.includes(name))) {
    throw refuse('merge_invalid', 'Unit reports must cover every changed path exactly once');
  }
  for (const {view, report, drafts = []} of reports) {
    if (view.partition_of !== snapshot.digest || view.digest !== viewDigest(view)) {
      throw refuse('merge_invalid', 'A unit report belongs to another snapshot or an altered view', {unit: view.unit.id});
    }
    validateInspection(report, view, drafts);
  }
  const ledger = new Set((snapshot.prior_findings || []).map(item => item.id));
  const namespaced = (unit, name) => `${unit}:${name}`;
  const findingId = item => (ledger.has(item.id) ? item.id : `p${digest(item.path).slice(0, 8)}:${item.id}`);
  // Rewrites every evidence reference of a report fragment to its namespaced form.
  const refs = (value, rename) => {
    if (Array.isArray(value)) return value.map(item => refs(item, rename));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === 'evidence' && Array.isArray(item) && item.every(entry => typeof entry === 'string') ? item.map(rename) : refs(item, rename)]));
  };
  const merged = {evidence: [], units: [], findings: [], accounting: [], resolutions: [], reopenings: [], summaries: []};
  const drafted = [];
  const gates = new Map(GATES.map(name => [name, []]));
  const dispositions = new Map(Object.keys(snapshot.sources).map(id => [id, []]));
  const dependencies = new Map();
  const ownerOf = new Map(snapshot.files.flatMap(file => {
    const unit = views.find(view => view.unit.owned.includes(file.path)).unit.id;
    return fileSources(file).map(id => [id, unit]);
  }));
  for (const {view, report, drafts = []} of reports) {
    const unit = view.unit.id;
    const rename = id => namespaced(unit, id);
    const draftIds = new Map(drafts.flatMap(draft => draft.findings.map(item => [item.id, findingId(item)])));
    merged.evidence.push(...report.evidence.map(item => ({...item, id: rename(item.id)})));
    merged.units.push(...refs(report.units, rename).map(item => ({...item, id: namespaced(unit, item.id)})));
    for (const item of refs(report.findings, rename)) {
      const id = findingId(item);
      if (merged.findings.some(other => other.id === id)) throw refuse('merge_invalid', 'Two units report the same finding identity', {unit});
      merged.findings.push({...item, id});
    }
    merged.accounting.push(...refs(report.accounting, rename).map(item => ({...item, units: item.units.map(id => namespaced(unit, id))})));
    merged.resolutions.push(...refs(report.resolutions, rename).map(item => ({...item, id: draftIds.get(item.id) || item.id})));
    merged.summaries.push(`${unit}: ${report.summary}`);
    for (const gate of report.gates) gates.get(gate.name).push({unit, gate: refs(gate, rename)});
    drafts.forEach((draft, index) => {
      const key = id => namespaced(unit, `d${index}:${id}`);
      drafted[index] = drafted[index] || {findings: [], evidence: []};
      drafted[index].evidence.push(...draft.evidence.map(item => ({...item, id: key(item.id)})));
      drafted[index].findings.push(...refs(draft.findings, key).map(item => ({...item, id: findingId(item)})));
    });
    if (snapshot.review_manifest_version) {
      merged.reopenings.push(...refs(report.reopenings, rename));
      for (const item of report.coverage.sources) dispositions.get(item.source).push({unit, item: refs(item, rename)});
      for (const item of report.coverage.dependencies) {
        dependencies.set(item.path, [...(dependencies.get(item.path) || []), {unit, item: refs(item, rename)}]);
      }
    }
  }
  const report = {version: 4, snapshot: snapshot.digest, summary: merged.summaries.join(' | ').slice(0, 2000), evidence: merged.evidence,
    units: merged.units, findings: merged.findings,
    gates: GATES.map(name => {
      const state = STRICTNESS.find(candidate => gates.get(name).some(({gate}) => gate.state === candidate));
      const {unit, gate} = gates.get(name).find(item => item.gate.state === state);
      return {...gate, reason: `${unit}: ${gate.reason}`.slice(0, 2000)};
    }),
    accounting: merged.accounting, resolutions: merged.resolutions};
  if (snapshot.review_manifest_version) {
    // `missing` anywhere stays missing; otherwise the owner unit's judgement of a source stands.
    const choose = (entries, owner) => {
      const rank = entry => DISPOSITION.indexOf(entry.item.state);
      const best = [...entries].sort((a, b) => rank(a) - rank(b));
      return (rank(best[0]) > 0 && entries.find(entry => entry.unit === owner)) || best[0];
    };
    report.coverage = {
      sources: [...dispositions].map(([source, entries]) => {
        if (!entries.length) return {source, state: 'missing', reason: 'No review unit was given this source.', evidence: []};
        const {unit, item} = choose(entries, ownerOf.get(source));
        return {...item, reason: `${unit}: ${item.reason}`.slice(0, 2000)};
      }),
      dependencies: [...dependencies.values()].map(entries => {
        const {unit, item} = choose(entries);
        return {...item, reason: `${unit}: ${item.reason}`.slice(0, 2000)};
      }),
    };
    report.reopenings = merged.reopenings;
    // Missing material evidence is by rule an unresolved completeness gate (acceptance.cjs validateCompleteness).
    const completeness = report.gates.find(gate => gate.name === 'review_completeness');
    if (completeness.state !== 'unresolved' && [...report.coverage.sources, ...report.coverage.dependencies].some(item => item.state === 'missing')) {
      completeness.state = 'unresolved'; completeness.reason = `${completeness.reason} (Material evidence is recorded as missing.)`.slice(0, 2000);
    }
  }
  return {report, drafts: drafted};
}

module.exports = {DEFAULTS, unitView, mergeUnitReports};
