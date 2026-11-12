'use strict';

const {DELAYS_MS, isTransient} = require('./transient-retry.cjs');
const {rateLimitDelay} = require('./verification-wait.cjs');

// The actions/github-script client runs with `retries: 0`, so one HTTP 5xx from GitHub (seen on GET /pulls/{n} within a
// minute of a pull request being opened) killed a step outright: the assessment, the attestation decision, the reassessment.
// Every packaged step installs this hook first. It retries only reads (GET and HEAD), which repeat safely, with the shared
// transient backoff; a write keeps its own handling (retryTransient with its check that an earlier attempt did not land), so
// nothing here can submit a review, a comment or a merge twice. A failure that persists is the original error.
const INSTALLED = Symbol.for('clouseau.github-retry');
const READS = new Set(['GET', 'HEAD']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function install(github, {wait = sleep, delays = DELAYS_MS, report = () => {}} = {}) {
  if (github[INSTALLED]) return github;
  github.hook.wrap('request', async (request, options) => {
    if (!READS.has(String(options.method).toUpperCase())) return request(options);
    for (let attempt = 0; ; attempt++) {
      try {return await request(options);} catch (error) {
        if (!isTransient(error) || attempt >= delays.length) throw error;
        const delay = Math.max(delays[attempt], rateLimitDelay(error) ?? 0);
        report(`GitHub answered ${options.method} ${options.url} with ${Number.isInteger(error.status) ? `HTTP ${error.status}` : 'a transient error'}; ` +
          `retry ${attempt + 1}/${delays.length} in ${delay / 1000} s.`);
        await wait(delay);
      }
    }
  });
  Object.defineProperty(github, INSTALLED, {value: true});
  return github;
}

module.exports = {install};
