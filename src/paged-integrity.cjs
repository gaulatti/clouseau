'use strict';

const {digest} = require('./acceptance.cjs');
const {createSourceBank} = require('./source-bank.cjs');
const {verifySourceExposure, MAX_VIEW_ROUNDS} = require('./source-view.cjs');
const {materialize} = require('./acceptance-review.cjs');
const {authorityBounds} = require('./acceptance-grading.cjs');
const {concernDraft, MAX_SOURCE_BATCHES} = require('./paged-review.cjs');

const requireInspection = (condition, message) => {
  if (!condition) throw new Error(`Invalid paged inspection: ${message}`);
};
const exact = (value, names) => value && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',');
const invocationFields = ['request_digest', 'response_digest', 'transport_digest'];
const invocationKey = value => digest(Object.fromEntries(invocationFields.map(name => [name, value[name]])));
const emptyReport = () => ({evidence: [], coverage: {sources: [], dependencies: []},
  gates: [{name: 'review_completeness', state: 'unresolved'}]});

function reconstructEpoch(snapshot, bank) {
  requireInspection(bank && Array.isArray(bank.entries), 'historical bank inventory');
  const ids = bank.entries.filter(entry => entry.kind === 'source').map(entry => entry.source);
  const current = Object.keys(snapshot.sources);
  requireInspection(ids.length > 0 && ids.length < current.length &&
    ids.every((id, index) => id === current[index]), 'historical immutable source prefix');
  const prior = {...snapshot, sources: Object.fromEntries(ids.map(id => [id, snapshot.sources[id]]))};
  delete prior.digest; prior.digest = digest(prior);
  requireInspection(prior.digest === bank.snapshot_digest && digest(createSourceBank(prior)) === digest(bank), 'historical source identity');
  return prior;
}

function factualEquivalent(rawReport, gradedReport, snapshot) {
  const expected = materialize(rawReport, snapshot);
  const actual = structuredClone(gradedReport);
  const originalGate = expected.gates.find(item => item.name === 'review_completeness');
  const finalGate = actual.gates.find(item => item.name === 'review_completeness');
  if (originalGate.state === 'satisfied' && finalGate.state === 'unresolved' && finalGate.reason ===
    'Independent grading did not establish complete material source evidence. Inspector observation: ' + originalGate.reason) {
    Object.assign(finalGate, {state: originalGate.state, reason: originalGate.reason});
  }
  const facts = value => {
    const copy = structuredClone(value);
    for (const unit of copy.units) for (const group of ['fit', 'need', 'excess']) for (const factor of Object.values(unit[group])) {
      delete factor.min; delete factor.max;
    }
    for (const finding of copy.findings) for (const factor of Object.values(finding.factors)) {delete factor.min; delete factor.max;}
    return digest(copy);
  };
  if (facts(expected) === facts(actual)) return true;
  // Authority grading may explain an unsupported binding; it never changes
  // the underlying observation, citation, causal identity or disposition.
  authorityBounds(expected, snapshot);
  return facts(expected) === facts(actual);
}

function verifyPagedInspection({snapshot, report, role, usage, source_bank, source_view, source_history, page_progress}) {
  requireInspection(['examiner', 'challenger'].includes(role) && source_view?.role === role && Array.isArray(usage), 'owning role and execution');
  const bank = createSourceBank(snapshot);
  requireInspection(source_bank && typeof source_bank === 'object' && digest(source_bank) === digest(bank), 'current source bank identity');
  requireInspection(Array.isArray(source_history) && source_history.length <= 2 * MAX_SOURCE_BATCHES + 1, 'source epoch budget');
  requireInspection(Array.isArray(page_progress) && page_progress.length > 0 &&
    page_progress.length <= 2 * (MAX_VIEW_ROUNDS + MAX_SOURCE_BATCHES + 1), 'progress budget');
  const epochs = new Map(); let priorCount = 0;
  const register = (epochSnapshot, epochBank, exposure) => {
    requireInspection(exposure?.role === role && !epochs.has(epochBank.bank_digest), 'independent unique epoch');
    verifySourceExposure(epochSnapshot, emptyReport(), exposure, usage);
    const rounds = new Map(exposure.rounds.map((round, index) => [invocationKey(round.invocation), {round, index}]));
    requireInspection(rounds.size === exposure.rounds.length, 'unique delivery invocation');
    epochs.set(epochBank.bank_digest, {snapshot: epochSnapshot, bank: epochBank, exposure, rounds, prefix: [], visited: false,
      source_count: Object.keys(epochSnapshot.sources).length});
  };
  for (const previous of source_history) {
    requireInspection(exact(previous, ['bank', 'exposure']), 'historical epoch');
    const historical = reconstructEpoch(snapshot, previous.bank);
    const count = Object.keys(historical.sources).length;
    requireInspection(count > priorCount, 'chronological source growth'); priorCount = count;
    register(historical, previous.bank, previous.exposure);
  }
  register(snapshot, bank, source_view);
  const derivedDrafts = [];
  const observed = new Map();
  const usedInvocations = new Set();
  let previous = null; let pending = null; let cycles = 0; let deliveries = 0; let batches = 0; let batchLimit = 0;
  for (let index = 0; index < page_progress.length; index++) {
    const frame = page_progress[index];
    requireInspection(exact(frame, ['role', 'snapshot_digest', 'bank_digest', 'cycle_start', 'source_batch_limit', 'response', 'invocation']) &&
      frame.role === role && typeof frame.cycle_start === 'boolean' && Number.isSafeInteger(frame.source_batch_limit) &&
      frame.source_batch_limit >= 0 && frame.source_batch_limit <= MAX_SOURCE_BATCHES, 'independent progress frame');
    const epoch = epochs.get(frame.bank_digest);
    requireInspection(epoch && epoch.snapshot.digest === frame.snapshot_digest, 'known frozen progress epoch');
    epoch.visited = true;
    const provenance = frame.invocation;
    requireInspection(provenance && provenance.role === role && provenance.phase === 'investigation' &&
      invocationFields.every(key => /^[a-f0-9]{64}$/.test(provenance[key])) &&
      provenance.response_digest === digest(frame.response) && usage.some(call => call.role === role && call.phase === 'investigation' &&
        invocationFields.every(key => call[key] === provenance[key])), 'actual structured response execution');
    const key = invocationKey(provenance);
    requireInspection(!usedInvocations.has(key), 'repeated progress invocation'); usedInvocations.add(key);
    if (frame.cycle_start) {
      requireInspection(!pending && cycles < 2 && (!previous || previous.response.kind === 'report' && previous.bank_digest !== frame.bank_digest),
        'completed judgment cannot be resampled');
      cycles++; deliveries = 0; batches = 0; batchLimit = frame.source_batch_limit;
    } else requireInspection(previous && previous.response.kind !== 'report', 'explicit complete-cycle boundary');
    requireInspection(frame.source_batch_limit === batchLimit, 'unchanged cycle source-request budget');
    if (index === 0) requireInspection(frame.cycle_start, 'initial inspection boundary');
    if (previous && !frame.cycle_start) requireInspection(previous.response.kind === 'source_request' ?
      previous.bank_digest !== frame.bank_digest : previous.bank_digest === frame.bank_digest, 'source epoch transition');
    if (previous && previous.bank_digest !== frame.bank_digest) requireInspection(epoch.source_count >
      epochs.get(previous.bank_digest).source_count, 'monotonic immutable source growth');
    const delivered = epoch.rounds.get(key);
    if (pending) {
      requireInspection(delivered && pending.bank_digest === frame.bank_digest && digest(delivered.round.request) === digest(pending) &&
        delivered.index === epoch.prefix.length && deliveries < MAX_VIEW_ROUNDS, 'exact requested page delivery');
      epoch.prefix.push(delivered.round); deliveries++;
    } else requireInspection(!delivered, 'unsolicited page delivery');
    pending = null;
    const response = frame.response;
    requireInspection(exact(response, ['kind', 'report', 'page_request', 'request_sources', 'observations', 'concerns']) &&
      typeof response.observations === 'string' && response.observations.length <= 2000 &&
      Array.isArray(response.concerns) && response.concerns.length <= 8 && Array.isArray(response.request_sources), 'bounded structured progress');
    const prefix = {...epoch.exposure, rounds: epoch.prefix};
    const draft = concernDraft(epoch.snapshot, response.concerns);
    verifySourceExposure(epoch.snapshot, {...emptyReport(), evidence: draft.evidence}, prefix, usage);
    for (const concern of draft.findings) {
      const earlier = observed.get(concern.id);
      requireInspection(!earlier || ['path', 'cause', 'obligation'].every(key => earlier[key] === concern[key]), 'immutable causal concern identity');
      observed.set(concern.id, concern);
    }
    if (draft.findings.length) derivedDrafts.push(draft);
    if (response.kind === 'page_request') {
      requireInspection(response.report === null && response.request_sources.length === 0 &&
        exact(response.page_request, ['bank_digest', 'pages']), 'page request phase');
      pending = response.page_request;
    } else if (response.kind === 'source_request') {
      requireInspection(response.report === null && response.page_request === null && response.request_sources.length > 0 &&
        response.request_sources.length <= 8 && new Set(response.request_sources).size === response.request_sources.length &&
        batches < batchLimit, 'source request phase');
      batches++;
    } else {
      requireInspection(response.kind === 'report' && response.report && response.page_request === null &&
        response.request_sources.length === 0, 'factual report phase');
      const facts = materialize(response.report, epoch.snapshot);
      verifySourceExposure(epoch.snapshot, facts, prefix, usage);
      for (const finding of facts.findings) if (!observed.has(finding.id)) observed.set(finding.id, finding);
      if (index < page_progress.length - 1) derivedDrafts.push(facts);
    }
    previous = frame;
  }
  requireInspection(!pending && previous.response.kind === 'report' && previous.bank_digest === bank.bank_digest,
    'complete current factual response');
  requireInspection([...epochs.values()].every(epoch => epoch.visited && epoch.prefix.length === epoch.exposure.rounds.length),
    'complete epoch and delivery accounting');
  requireInspection(factualEquivalent(previous.response.report, report, snapshot), 'factual response changed during grading');
  verifySourceExposure(snapshot, report, source_view, usage);
  return derivedDrafts;
}

module.exports = {reconstructEpoch, factualEquivalent, verifyPagedInspection};
