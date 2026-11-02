'use strict';

// Hosted chunked review (docs/chunked-hosted.md). Dark: nothing here runs unless the protected base-branch configuration
// carries `acceptance.chunked_hosted` with `enabled: true`. The hosted CI review of a change whose evidence does not fit one
// snapshot is partitioned into bounded units by the same modules the local review uses, each unit is reviewed by the
// examiner and the challenger, the seams between units get one integration pass per role, and the merge, grading and
// verification are the unchanged chunked ones (chunked-review.cjs, chunked-record.cjs).
//
// Size never fails a review here. A cost cap that the change would exceed HOLDS the pull request with a notice that names
// the cap and how to raise it; it never skips evidence and never reviews a part of the change.

const wiring = require('./chunked-wiring.cjs');
const {chunkedReview, ChunkedReviewRefusal} = require('./chunked-review.cjs');
const {requestJSON} = require('./review-provider.cjs');
const {digest} = require('./acceptance.cjs');

// Cost caps, protected configuration only. A cap may be raised as well as lowered: raising it is how a maintainer accepts the
// cost of a very large change. Input tokens are estimated from prompt characters.
const CAPS = Object.freeze({max_units: 32, max_input_tokens: 4000000});
const CHARS_PER_TOKEN = 4;
const TOOL = 'chunked_review_result';
const ATTEMPTS = 3;
const BUDGET_MESSAGE = 'Complete review evidence exceeds the source budget';
const positive = value => Number.isSafeInteger(value) && value > 0;

class HostedChunkedHold extends Error {
  constructor(cause, message) {
    super(message);
    this.name = 'HostedChunkedHold';
    this.code = 'HOSTED_CHUNKED_HELD';
    this.cause_code = cause;
  }
}

const split = value => {
  const {max_units: units, max_input_tokens: tokens, ...core} = value;
  return {core, caps: {max_units: units, max_input_tokens: tokens}};
};

// The protected object, or a message naming what is wrong (null when valid). `enabled` is required: the feature is off
// unless a maintainer turns it on.
function problem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'must be an object';
  if (typeof value.enabled !== 'boolean') return 'enabled must be a boolean';
  const {core, caps} = split(value);
  const bad = Object.keys(caps).find(name => caps[name] !== undefined && !positive(caps[name]));
  if (bad) return `${bad} must be a positive integer`;
  return wiring.problem(core);
}

// The settings in force, or null when the feature is absent or off. An invalid object throws.
function settings(acceptance) {
  const value = acceptance?.chunked_hosted;
  if (value === undefined) return null;
  const message = problem(value);
  if (message) throw new Error(`Invalid protected hosted chunked review configuration: ${message}`);
  if (!value.enabled) return null;
  const {core, caps} = split(value);
  return {...wiring.settings({chunked: core}), max_units: caps.max_units ?? CAPS.max_units,
    max_input_tokens: caps.max_input_tokens ?? CAPS.max_input_tokens};
}

// What the record verifier needs, from the same protected object; null when the feature is off.
function verifierOptions(acceptance) {
  const active = settings(acceptance);
  return active ? {params: active.params, hooks: wiring.hooksFor(active.params)} : null;
}

// Only the two ways a change can be too large for one snapshot start a chunked review. Anything else is a real failure.
const oversize = error => error.message === BUDGET_MESSAGE || (error.unavailable === true && error.reason === 'size');

const held = (cause, message) => new HostedChunkedHold(cause, message);
const raise = 'A maintainer can raise it in the protected base-branch Clouseau configuration';

function preflight(plan, active) {
  const tokens = Math.ceil(2 * plan.units.reduce((sum, unit) => sum + unit.cost, 0) / CHARS_PER_TOKEN);
  if (plan.units.length > active.max_units) {
    throw held('chunked_unit_cap', `Held, not failed: this change needs ${plan.units.length} review units, above the protected cap ` +
      `acceptance.chunked_hosted.max_units = ${active.max_units}. Nothing was skipped. ${raise} (raise max_units; estimated ` +
      `${tokens} input tokens), then re-run.`);
  }
  if (tokens > active.max_input_tokens) {
    throw held('chunked_token_cap', `Held, not failed: this change needs about ${tokens} input tokens, above the protected cap ` +
      `acceptance.chunked_hosted.max_input_tokens = ${active.max_input_tokens}. Nothing was skipped. ${raise} ` +
      `(raise max_input_tokens), then re-run.`);
  }
  return tokens;
}

// The hosted provider seam: {role, phase, schema, prompt, check?, unit?} -> {value, provenance}. Models come from the
// protected acceptance roles. `charge(prompt)` is called before every provider request and throws once the token cap
// would be crossed. A reply that fails its own check is asked again with the same prompt, at most twice, as the
// single-snapshot reviewer does.
function hostedAsk({config, charge, fetchImpl, wait, log, observe = () => {}}) {
  return async task => {
    const model = task.phase === 'grading' ? config.grading_model : config[task.role];
    for (let attempt = 1; ; attempt++) {
      charge(task.prompt);
      const result = await requestJSON({model, schemas: {[TOOL]: task.schema}, thinking: false, fetchImpl, wait, report: log,
        messages: [{role: 'user', content: task.prompt}]});
      observe({role: task.role, phase: task.phase, unit: task.unit ?? null, model, attempt, usage: result.usage});
      try {
        if (task.check) task.check(result.value);
      } catch (error) {
        if (attempt === ATTEMPTS) throw error;
        if (log) log(`Chunked reviewer output invalid (${error.message}); retry ${attempt}/${ATTEMPTS - 1} with the same prompt`);
        continue;
      }
      return {value: result.value, provenance: {provider: 'deepseek', requested_model: model, role: task.role, phase: task.phase,
        request_digest: digest({schema: task.schema, prompt: task.prompt}), response_digest: digest(result.value),
        tokens: result.usage.map(item => item.tokens), attempts: attempt}};
    }
  };
}

// A running counter of estimated input tokens; throws the cap hold instead of making a request that would cross it.
function meter(active) {
  let used = 0;
  return prompt => {
    const need = Math.ceil(prompt.length / CHARS_PER_TOKEN);
    if (used + need > active.max_input_tokens) {
      throw held('chunked_token_cap', `Held, not failed: the review reached the protected cap acceptance.chunked_hosted.max_input_tokens = ` +
        `${active.max_input_tokens} after about ${used} input tokens. Nothing was skipped. ` +
        `${raise} (raise max_input_tokens), then re-run.`);
    }
    used += need;
  };
}

// Plans the change, enforces the caps before any provider call, and runs the chunked review. Returns the pieces of a
// version 3 record: {result, partition, seams}.
async function review({snapshot, active, config, fetchImpl, wait, log, observe, journal, scope}) {
  const hooks = wiring.hooksFor(active.params);
  const plan = hooks.plan(snapshot);
  const seams = hooks.seams({snapshot, plan});
  preflight(plan, active);
  const ask = hostedAsk({config, charge: meter(active), fetchImpl, wait, log, observe});
  try {
    const {result, partition} = await chunkedReview({snapshot, plan, seams, ask, journal, scope,
      chunked: {params: active.params, concurrency: active.concurrency, unit_deadline_ms: active.unit_deadline_ms, integration_cap: active.integration_cap,
        integration_call_seams: active.integration_call_seams, integration_max_seams: active.integration_max_seams}});
    return {result, partition, seams};
  } catch (error) {
    if (error instanceof ChunkedReviewRefusal) throw held(`chunked_${error.code}`, `Held, not failed: the chunked review stopped: ${error.message}.`);
    throw error;
  }
}

module.exports = {CAPS, CHARS_PER_TOKEN, HostedChunkedHold, problem, settings, verifierOptions, oversize, preflight, hostedAsk, meter, review};
