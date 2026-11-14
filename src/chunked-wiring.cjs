'use strict';

// Wiring of the chunked local review (design: chunked review, section 7, PR 7). No new review logic lives here: it
// resolves the protected `local_review.chunked` configuration, builds the recompute hooks of the chunked verifier from
// the merged planner, unit views, seams and merge, runs the unit runner, and assembles the chunked record.
//
// Chunked review is available by default for local review. The protected configuration can only TIGHTEN it:
//   chunked: {enabled?: boolean, force?: boolean, partition?: 1 | 2, params?: {C, S}, concurrency?, unit_deadline_ms?,
//             integration_cap?, integration_call_seams?, integration_max_seams?}
// `enabled: false` turns it off (an oversized change then fails exactly as before); `force: true` chunks even a change
// that fits one snapshot; `partition` picks the partition scheme a local review produces (1, the default, is
// clouseau-partition/1, whose units see no other unit's sources; 2 is clouseau-partition/2, whose units also see the
// other ends of their seams, seam-context.cjs); every number may only be lowered from DEFAULT_SETTINGS. CI reads the same
// object from the base branch, so the partition CI recomputes always uses the parameters the review used. The verifier
// recomputes whichever known scheme a record names, so receipts of either scheme stay verifiable across a change of it.

const fs = require('node:fs');
const path = require('node:path');
const {partition, SCHEME, SCHEMES} = require('./review-partition.cjs');
const {seamContext} = require('./seam-context.cjs');
const {changeTable, segmentLimit} = require('./change-table.cjs');
const {unitView, DEFAULTS: UNIT_DEFAULTS} = require('./review-units.cjs');
const {seamsOf} = require('./review-seams.cjs');
const {chunkedReview, mergeWithIntegration, DEFAULTS} = require('./chunked-review.cjs');

const DEFAULT_SETTINGS = Object.freeze({params: Object.freeze({C: 450000, S: 100000}), partition: 1, ...DEFAULTS});
// The `partition` setting names a scheme by its number.
const SCHEME_OF = Object.freeze({1: SCHEME, 2: SCHEMES[1]});
const KEYS = ['enabled', 'force', 'partition', 'params', 'concurrency', 'unit_deadline_ms', 'integration_cap', 'integration_call_seams', 'integration_max_seams'];
const LIMITED = ['concurrency', 'unit_deadline_ms', 'integration_cap', 'integration_call_seams', 'integration_max_seams'];
const whole = value => Number.isSafeInteger(value) && value > 0;

// The protected object, or an error message naming what is wrong (null when valid).
function problem(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !KEYS.includes(key))) return 'unknown or malformed fields';
  if (['enabled', 'force'].some(key => value[key] !== undefined && typeof value[key] !== 'boolean') || (value.enabled === false && value.force === true)) {
    return 'enabled and force must be booleans and cannot contradict each other';
  }
  if (value.partition !== undefined && !(Number.isSafeInteger(value.partition) && Object.hasOwn(SCHEME_OF, value.partition))) return 'partition must be 1 or 2';
  const {params} = value;
  if (params !== undefined && (!params || typeof params !== 'object' || Object.keys(params).sort().join(',') !== 'C,S' ||
      !whole(params.C) || !whole(params.S) || params.C > DEFAULT_SETTINGS.params.C || params.S > DEFAULT_SETTINGS.params.S)) {
    return 'params must be {C, S} positive integers no larger than the defaults';
  }
  if (LIMITED.some(key => value[key] !== undefined && (!whole(value[key]) || value[key] > DEFAULT_SETTINGS[key]))) {
    return 'concurrency, unit_deadline_ms, integration_cap, integration_call_seams and integration_max_seams must be positive integers no larger than the defaults';
  }
  return null;
}

// The settings in force, or null when the protected configuration disabled chunked review.
function settings(localReview) {
  const value = localReview?.chunked;
  const message = problem(value);
  if (message) throw new Error(`Invalid protected chunked review configuration: ${message}`);
  if (value?.enabled === false) return null;
  const {enabled, force, ...limits} = value ?? {};
  return {...DEFAULT_SETTINGS, ...limits, params: {...DEFAULT_SETTINGS.params, ...limits.params}, force: force === true};
}

// Plans and unit views are pure functions of the stored snapshot and the scheme, so one run of the verifier computes each
// once. `scheme` is the scheme a review produces; every hook also takes the scheme a stored record names, so the verifier
// recomputes /1 exactly as before and /2 with its seam context. An unknown scheme is refused by the planner.
function hooksFor(params, scheme = SCHEME) {
  const options = {unit_ceiling: params.C, shared: params.S};
  const limit = segmentLimit(options);
  const plans = new WeakMap();
  const view = (snapshot, unit, units) => unitView(snapshot, {id: unit.id, owned: unit.owned, context_ids: unit.context_ids, ...(unit.parts ? {parts: unit.parts} : {})},
    {units, sharedCap: params.S, segmentLimit: limit});
  const planOf = (snapshot, chosen = scheme) => {
    if (!plans.has(snapshot)) plans.set(snapshot, new Map());
    const cache = plans.get(snapshot);
    if (!cache.has(chosen)) {
      const raw = partition(changeTable(snapshot, options), options, {scheme: chosen});
      let specs = raw.units.map(({id, owned, parts}) => ({id, owned, context_ids: [], ...(parts ? {parts} : {})}));
      if (chosen !== SCHEME) {
        specs = seamContext({snapshot, specs, seams: seamsOf({snapshot, plan: raw}), cap: UNIT_DEFAULTS.cap,
          view: (unit, units) => view(snapshot, unit, units)});
      }
      // A /1 plan is the planner's own; a /2 plan's units carry the context the runner reviews them with.
      const plan = chosen === SCHEME ? raw : {...raw, units: raw.units.map((unit, index) => ({...unit, context_ids: specs[index].context_ids}))};
      cache.set(chosen, {plan, specs});
    }
    return cache.get(chosen);
  };
  const viewOf = (snapshot, unit, chosen = scheme) => view(snapshot, unit, planOf(snapshot, chosen).specs);
  const seams = ({snapshot, plan}) => seamsOf({snapshot, plan});
  return {
    plan: snapshot => planOf(snapshot).plan,
    partition: ({snapshot, scheme: chosen = scheme}) => {
      const {plan, specs} = planOf(snapshot, chosen);
      return {scheme: plan.scheme, params: {C: params.C, S: params.S},
        units: plan.units.map((unit, index) => ({...specs[index], view_digest: viewOf(snapshot, specs[index], chosen).digest, cost: unit.cost})),
        plan_digest: plan.plan_digest};
    },
    unitView: viewOf,
    seams,
    merge: ({unitReports, integration, snapshot, plan}) => mergeWithIntegration({integration, snapshot, seams: seams({snapshot, plan}),
      reports: unitReports.map(({unit, report}) => ({view: viewOf(snapshot, planOf(snapshot, plan.scheme).specs.find(spec => spec.id === unit), plan.scheme), report, drafts: []}))}).report,
  };
}

// The hooks of a review run under the settings in force: they plan with the configured scheme.
const activeHooks = active => hooksFor(active.params, SCHEME_OF[active.partition]);

// What the receipt verifier needs, from the same protected object; null when chunked review is disabled. The hooks
// recompute whichever known scheme a record names, whatever scheme this configuration makes local review produce.
function verifierOptions(localReview) {
  const active = settings(localReview);
  return active ? {params: active.params, hooks: hooksFor(active.params)} : null;
}

// A durable journal for the unit runner: one file per remembered call, so a resumed review never samples a finished call again.
function fileJournal(directory) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  return {
    get: key => (fs.existsSync(path.join(directory, `${key}.json`)) ? JSON.parse(fs.readFileSync(path.join(directory, `${key}.json`), 'utf8')) : undefined),
    set: (key, value) => {fs.writeFileSync(path.join(directory, `${key}.json`), JSON.stringify(value), {mode: 0o600});},
  };
}

// Runs the whole chunked review of a collected combined snapshot and returns the chunked record. `agent` sessions are
// answered one at a time by the calling agent, so they run sequentially to keep the exchange order deterministic.
async function review({snapshot, active, ask, journal, scope, agent = false, technical, priorFindings}) {
  const hooks = activeHooks(active);
  const plan = hooks.plan(snapshot);
  const seams = hooks.seams({snapshot, plan});
  const run = await chunkedReview({snapshot, plan, seams, ask, journal, scope,
    chunked: {params: active.params, concurrency: agent ? 1 : active.concurrency, unit_deadline_ms: active.unit_deadline_ms, integration_cap: active.integration_cap,
      integration_call_seams: active.integration_call_seams, integration_max_seams: active.integration_max_seams}});
  const record = {version: 3, snapshot, partition: run.partition, seams: run.seams, result: run.result, previous: {comment: null, findings: []},
    local_previous: {findings: priorFindings}, controls: false, technical};
  return {record, reviews: run.reviews};
}

module.exports = {DEFAULT_SETTINGS, SCHEME_OF, problem, settings, hooksFor, activeHooks, verifierOptions, fileJournal, review};
