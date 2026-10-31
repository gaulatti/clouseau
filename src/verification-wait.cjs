'use strict';

// A review job that polls for PR verification occupies a runner while it waits.
// On a runner pool with one slot the verification job it waits for is queued
// behind it and can never start. Waiting is bounded by progress: verification
// that is running is awaited, but one that has not started within the
// configured queue grace ends the review cleanly in a pending state. It holds
// no runner afterwards and is reassessed when the verification run completes.
const DEFAULT_QUEUE_GRACE_SECONDS = 900;
const MAX_QUEUE_GRACE_SECONDS = 3600;
const POLL_MS = 15000;

const graceSeconds = config => config.verification_queue_grace_seconds ?? DEFAULT_QUEUE_GRACE_SECONDS;

const WAITING_REASON = 'Waiting for verification: PR verification had not started within the queue grace, so this review ended ' +
  'without holding a runner and made no decision. It is reassessed automatically when the PR verification run completes; ' +
  'otherwise re-run this workflow after verification completes, or push a new head.';

// Polling is paid for from the repository's shared REST budget (1000 requests per hour for the
// installation token), so it is deliberately cheap: a running verification is polled every POLL_MS,
// an absent or queued one with exponentially growing gaps (15, 30, 60 s, then 120 s), because nothing
// can change faster than a runner starts and the completed run reassesses the PR by itself.
const MAX_IDLE_POLL_MS = 120000;

// Returns a function called with each pending verification state. It returns the next delay and
// whether verification has been absent or queued for longer than the grace (measured in waited time).
function pollSchedule(seconds) {
  let idle = 0; let waited = 0;
  return state => {
    if (state === 'running') {idle = 0; waited = 0; return {stalled: false, delay: POLL_MS};}
    if (waited >= seconds * 1000) return {stalled: true, delay: 0};
    const delay = Math.min(POLL_MS * 2 ** idle++, MAX_IDLE_POLL_MS);
    waited += delay;
    return {stalled: false, delay};
  };
}

// GitHub signals an exhausted budget with 429, or 403 carrying retry-after, x-ratelimit-remaining: 0, or a
// primary/secondary rate-limit message. Returns the milliseconds the response asks us to wait (0 when
// it states none), or null when the error is not a rate limit at all.
function rateLimitDelay(error, now = Date.now()) {
  const headers = error?.response?.headers ?? {};
  const message = String(error?.message ?? '');
  const limited = error?.status === 429 || (error?.status === 403 &&
    (headers['retry-after'] !== undefined || headers['x-ratelimit-remaining'] === '0' || /rate limit|abuse detection|secondary rate/i.test(message)));
  if (!limited) return null;
  if (headers['retry-after'] !== undefined) return Math.max(0, Number(headers['retry-after']) * 1000);
  if (headers['x-ratelimit-remaining'] === '0' && headers['x-ratelimit-reset'] !== undefined) return Math.max(0, Number(headers['x-ratelimit-reset']) * 1000 - now);
  return 0;
}

class RateLimitHold extends Error {
  constructor(resetAt) {
    super('GitHub API rate limit exhausted');
    this.code = 'RATE_LIMIT'; this.resetAt = resetAt;
  }
}

// Retries a read-only or idempotent call that hit a rate limit. The wait is the larger of what GitHub
// asked for and a bounded exponential backoff, plus jitter so that many PRs do not wake together. If
// the wait needed would exceed the remaining budget the call ends in a RateLimitHold stating when to retry.
async function withRateLimit(call, options, attempt = 0, waited = 0) {
  const {wait, now = Date.now, random = Math.random, maxAttempts = 8, maxWaitMs = 20 * 60000, report = () => {}} = options;
  try {return await call();} catch (error) {
    const asked = rateLimitDelay(error, now());
    if (asked === null) throw error;
    const delay = Math.max(asked, Math.min(2 ** attempt * 1000, 60000)) + Math.floor(random() * 1000);
    if (attempt + 1 >= maxAttempts || waited + delay > maxWaitMs) throw new RateLimitHold(now() + Math.max(asked, delay));
    report(`GitHub API rate limit: waiting ${Math.ceil(delay / 1000)} s before retry ${attempt + 1}/${maxAttempts - 1}`);
    await wait(delay);
    return withRateLimit(call, options, attempt + 1, waited + delay);
  }
}

// The PR head named by the event payload, or empty when the event (a manual dispatch) carries none.
const headShaOf = context => context.payload.pull_request?.head?.sha ?? '';

// A conditional GET: an unchanged answer is HTTP 304, which is served from the cache and does not count against
// the primary rate limit. `request` receives extra headers (an If-None-Match when a cached answer exists).
async function conditionalGet(cache, key, request) {
  const cached = cache.get(key);
  let response;
  try {response = await request(cached ? {'if-none-match': cached.etag} : {});} catch (error) {
    if (error.status !== 304 || !cached) throw error;
    return {data: cached.data, headers: {}};
  }
  if (response.headers?.etag) cache.set(key, {etag: response.headers.etag, data: response.data});
  return response;
}

const heldReason = hold => `Held: GitHub API rate limit, will retry after ${new Date(hold.resetAt).toISOString()}.`;

module.exports = {DEFAULT_QUEUE_GRACE_SECONDS, MAX_QUEUE_GRACE_SECONDS, MAX_IDLE_POLL_MS, POLL_MS, WAITING_REASON, graceSeconds,
  pollSchedule, rateLimitDelay, RateLimitHold, withRateLimit, heldReason, headShaOf, conditionalGet};
