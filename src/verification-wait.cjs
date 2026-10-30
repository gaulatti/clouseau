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

// Returns a function called with each pending verification state. It returns
// true once verification has been absent or queued for longer than the grace.
function queueTracker(seconds) {
  const limit = Math.ceil(seconds * 1000 / POLL_MS);
  let idle = 0;
  return state => {
    idle = state === 'running' ? 0 : idle + 1;
    return idle > limit;
  };
}

module.exports = {DEFAULT_QUEUE_GRACE_SECONDS, MAX_QUEUE_GRACE_SECONDS, POLL_MS, WAITING_REASON, graceSeconds, queueTracker};
