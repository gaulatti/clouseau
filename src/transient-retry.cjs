'use strict';

const {rateLimitDelay} = require('./verification-wait.cjs');

// Backoff before each retry of a write that failed transiently: 2 s, 6 s, then 15 s (three retries after the
// first attempt). The review that precedes these calls is paid for, so a GitHub blip must not discard it.
const DELAYS_MS = Object.freeze([2000, 6000, 15000]);
// A rate limit that asks to wait longer than this is a hold, not a blip; it is reported as it always was.
const MAX_REQUESTED_WAIT_MS = 60000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// GitHub's own wording for a GraphQL failure that carries no cause ("Something went wrong while executing your
// query ... Please include EC12:..."), and the gateway timeouts it reports in the same channel.
const TRANSIENT_GRAPHQL = /something went wrong while executing your query|timed out|temporarily unavailable|try again/i;

// Transient: secondary or short rate limits, HTTP 5xx, and the unclassified GraphQL error above. Everything else
// (validation, permissions, "not mergeable", a protected-branch refusal) is deterministic and fails at once.
function isTransient(error) {
  const asked = rateLimitDelay(error);
  if (asked !== null) return asked <= MAX_REQUESTED_WAIT_MS;
  if (Number.isInteger(error?.status)) return error.status >= 500 && error.status < 600;
  const text = Array.isArray(error?.errors) ? error.errors.map(item => item?.message).join('\n') : String(error?.message ?? '');
  return TRANSIENT_GRAPHQL.test(text);
}

function describe(error) {
  const status = Number.isInteger(error?.status) ? `HTTP ${error.status}` : 'GraphQL error';
  const detail = String(error?.message ?? '').replaceAll('@', '').replace(/\s+/g, ' ').slice(0, 200);
  return `${status}: ${detail}`;
}

class TransientExhausted extends Error {
  constructor({operation, attempts, head, error}) {
    super(`GitHub kept failing transiently while ${operation} (${attempts} attempts; last ${describe(error)}). ` +
      `The Clouseau review of head ${head} was already accepted and nothing was lost: re-run only the failed job ` +
      `to repeat this step. Retrying it is safe and does not repeat the AI review.`);
    this.code = 'TRANSIENT_GITHUB'; this.attempts = attempts;
  }
}

// Runs `call(attempt)` and retries only transient failures with the bounded backoff. `call` receives the zero-based
// attempt so that a retry can first check whether an earlier, apparently failed attempt had in fact landed.
async function retryTransient(call, {operation, head, wait = sleep, delays = DELAYS_MS, report = () => {}}) {
  for (let attempt = 0; ; attempt++) {
    try {return await call(attempt);} catch (error) {
      if (!isTransient(error)) throw error;
      if (attempt >= delays.length) throw new TransientExhausted({operation, attempts: attempt + 1, head, error});
      const delay = Math.max(delays[attempt], rateLimitDelay(error) ?? 0);
      report(`Transient GitHub failure while ${operation} (${describe(error)}); retry ${attempt + 1}/${delays.length} in ${delay / 1000} s.`);
      await wait(delay);
    }
  }
}

module.exports = {DELAYS_MS, MAX_REQUESTED_WAIT_MS, TransientExhausted, isTransient, retryTransient};
