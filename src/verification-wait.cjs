'use strict';

// A review job that polls for PR verification occupies a runner while it waits.
// On a runner pool with one slot the verification job it waits for is queued
// behind it and can never start. Waiting is therefore bounded by progress: a
// verification run that has not started within a short grace is a deadlock (or
// starvation), not a delay, and fails with a message that says how to recover.
const QUEUE_GRACE_POLLS = 8;
const POLL_MS = 15000;

function stalledVerification(polls) {
  return new Error(`PR verification has not started after ${polls} checks and this review job is holding a runner while it waits. ` +
    'On a runner pool with one slot the queued verification job can never start behind it. ' +
    'No decision was made and no acceptance record exists for this run. Re-run this workflow after the PR verification run has ' +
    'completed, or push a new head. A re-run of this attempt cannot create the missing record.');
}

// Returns a function that is called with each pending verification state and
// throws once verification has been absent or queued for longer than the grace.
function stallGuard(grace = QUEUE_GRACE_POLLS) {
  let idle = 0;
  return state => {
    idle = state === 'running' ? 0 : idle + 1;
    if (idle > grace) throw stalledVerification(idle);
  };
}

module.exports = {QUEUE_GRACE_POLLS, POLL_MS, stalledVerification, stallGuard};
