'use strict';

// Wiring of the chunked local review (design: chunked review, section 7, PR 7). No new review logic lives here: it
// resolves the protected `local_review.chunked` configuration, builds the recompute hooks of the chunked verifier from
// the merged planner, unit views, seams and merge, runs the unit runner, and assembles the chunked record.
//
// Chunked review is available by default for local review. The protected configuration can only TIGHTEN it:
//   chunked: {enabled?: boolean, force?: boolean, params?: {C, S}, concurrency?, unit_deadline_ms?, integration_cap?}
// `enabled: false` turns it off (an oversized change then fails exactly as before); `force: true` chunks even a change
// that fits one snapshot; every number may only be lowered from DEFAULT_SETTINGS. CI reads the same object from the
// base branch, so the partition CI recomputes always uses the parameters the review used.

const fs = require('node:fs');
const path = require('node:path');
const {partition} = require('./review-partition.cjs');
const {changeTable, segmentLimit} = require('./change-table.cjs');
const {unitView} = require('./review-units.cjs');
const {seamsOf} = require('./review-seams.cjs');
const {chunkedReview, mergeWithIntegration, DEFAULTS} = require('./chunked-review.cjs');

const DEFAULT_SETTINGS = Object.freeze({params: Object.freeze({C: 450000, S: 100000}), ...DEFAULTS});
const KEYS = ['enabled', 'force', 'params', 'concurrency', 'unit_deadline_ms', 'integration_cap'];
const LIMITED = ['concurrency', 'unit_deadline_ms', 'integration_cap'];
const whole = value => Number.isSafeInteger(value) && value > 0;

// The protected object, or an error message naming what is wrong (null when valid).
function problem(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !KEYS.includes(key))) return 'unknown or malformed fields';
  if (['enabled', 'force'].some(key => value[key] !== undefined && typeof value[key] !== 'boolean') || (value.enabled === false && value.force === true)) {
    return 'enabled and force must be booleans and cannot contradict each other';
  }
  const {params} = value;
  if (params !== undefined && (!params || typeof params !== 'object' || Object.keys(params).sort().join(',') !== 'C,S' ||
      !whole(params.C) || !whole(params.S) || params.C > DEFAULT_SETTINGS.params.C || params.S > DEFAULT_SETTINGS.params.S)) {
    return 'params must be {C, S} positive integers no larger than the defaults';
  }
  if (LIMITED.some(key => value[key] !== undefined && (!whole(value[key]) || value[key] > DEFAULT_SETTINGS[key]))) {
    return 'concurrency, unit_deadline_ms and integration_cap must be positive integers no larger than the defaults';
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

// Plans and unit views are pure functions of the stored snapshot, so one run of the verifier computes each once.
function hooksFor(params) {
  const options = {unit_ceiling: params.C, shared: params.S};
  const limit = segmentLimit(options);
  const plans = new WeakMap();
  const planOf = snapshot => {
    if (!plans.has(snapshot)) {
      const plan = partition(changeTable(snapshot, options), options);
      const specs = plan.units.map(({id, owned, parts}) => ({id, owned, context_ids: [], ...(parts ? {parts} : {})}));
      plans.set(snapshot, {plan, specs});
    }
    return plans.get(snapshot);
  };
  const viewOf = (snapshot, unit) => unitView(snapshot, {id: unit.id, owned: unit.owned, context_ids: unit.context_ids, ...(unit.parts ? {parts: unit.parts} : {})},
    {units: planOf(snapshot).specs, sharedCap: params.S, segmentLimit: limit});
  const seams = ({snapshot, plan}) => seamsOf({snapshot, plan});
  return {
    plan: snapshot => planOf(snapshot).plan,
    partition: ({snapshot}) => {
      const {plan, specs} = planOf(snapshot);
      return {scheme: plan.scheme, params: {C: params.C, S: params.S},
        units: plan.units.map((unit, index) => ({...specs[index], view_digest: viewOf(snapshot, specs[index]).digest, cost: unit.cost})),
        plan_digest: plan.plan_digest};
    },
    unitView: viewOf,
    seams,
    merge: ({unitReports, integration, snapshot, plan}) => mergeWithIntegration({integration, snapshot, seams: seams({snapshot, plan}),
      reports: unitReports.map(({unit, report}) => ({view: viewOf(snapshot, planOf(snapshot).specs.find(spec => spec.id === unit)), report, drafts: []}))}).report,
  };
}

// What the receipt verifier needs, from the same protected object; null when chunked review is disabled.
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
  const hooks = hooksFor(active.params);
  const plan = hooks.plan(snapshot);
  const seams = hooks.seams({snapshot, plan});
  const run = await chunkedReview({snapshot, plan, seams, ask, journal, scope,
    chunked: {params: active.params, concurrency: agent ? 1 : active.concurrency, unit_deadline_ms: active.unit_deadline_ms, integration_cap: active.integration_cap}});
  const record = {version: 3, snapshot, partition: run.partition, seams: run.seams, result: run.result, previous: {comment: null, findings: []},
    local_previous: {findings: priorFindings}, controls: false, technical};
  return {record, reviews: run.reviews};
}

module.exports = {DEFAULT_SETTINGS, problem, settings, hooksFor, verifierOptions, fileJournal, review};
