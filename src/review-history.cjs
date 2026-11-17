'use strict';
// `"review_history": "pull_request"` in the base's `.clouseau-local.json` (docs/review-history.md):
// `clouseau review` takes its prior findings from the open pull request's acceptance ledger instead of this
// machine's local history, so the signed input history (`local_previous`, `snapshot.prior_findings`) equals the ledger CI
// compares it with. Only gh reads GitHub here, and the ledger is parsed by the validation the gate uses (`priorState`).
//
// Every failure stops the review with one stable prefix. A successful lookup that finds no open pull request for the branch is
// a definite answer: the local history, as without the key. An open pull request without a ledger comment has an empty ledger.
//
// gh is checked by its first call, not by `gh auth status` (which also fails when the network is down): a missing executable
// is ENOENT, and gh exits 4 when it has no credentials at all, or reports HTTP 401 when GitHub rejects the ones it has.
const {priorState} = require('./acceptance-ledger.cjs');
const {cliApi} = require('./installation-github.cjs');

const PREFIX = 'Pull request ledger:';
const PAGE = 100;
const PAGES = 100;

const stop = (problem, detail) => new Error(`${PREFIX} ${problem} (${detail})`);
const line = text => String(text).trim().split('\n')[0].trim().slice(0, 200);

// The failure of one gh call, described by GitHub's status when gh reports one and the first line gh printed, never by the token.
function failure(problem, error) {
  if (error?.code === 'ENOENT') return stop('gh is not available', 'review_history: "pull_request" needs the GitHub CLI on PATH');
  const said = line(error?.stderr || '');
  if (error?.status === 4 || /HTTP 401/.test(said)) return stop('gh is not authenticated', 'run gh auth login');
  const status = /HTTP (\d{3})/.exec(said)?.[1];
  return stop(problem, `${status ? `GitHub status ${status}: ` : ''}${said || line(error?.message)}`);
}

// The open pull request's ledger: {number, comment, findings}, or null when the branch has no open pull request. A known
// number (`--pr`, `refresh`) is read directly; otherwise the pull request is discovered by the origin repository and branch.
async function pullRequestLedger({repo, branch, number = null, execute}) {
  const api = cliApi(execute);
  const slug = `${repo.owner}/${repo.repo}`;
  const read = async (problem, endpoint) => {
    try {return await api('GET', endpoint);} catch (error) {throw failure(problem, error);}
  };
  if (number === null) {
    // A fork's pull requests live in another repository; which one is not guessed.
    if ((await read('the pull request lookup failed', `repos/${slug}`))?.fork === true) {
      throw stop('forks are not supported yet', `${slug} is a fork; only pull requests of the origin repository are read`);
    }
    const pulls = await read('the pull request lookup failed',
      `repos/${slug}/pulls?head=${repo.owner}:${encodeURIComponent(branch)}&state=open&per_page=${PAGE}`);
    if (!Array.isArray(pulls)) throw stop('the pull request lookup failed', 'GitHub returned no list of pull requests');
    if (pulls.length > 1) throw stop(`more than one open pull request for branch ${branch}`, pulls.map(pull => `#${pull.number}`).join(', '));
    if (!pulls.length) return null;
    number = pulls[0].number;
    if (!Number.isSafeInteger(number) || number < 1) throw stop('the pull request lookup failed', 'GitHub returned a pull request without a number');
  }
  const comments = [];
  for (let page = 1; ; page++) {
    if (page > PAGES) throw stop('the ledger could not be read', `more than ${PAGE * PAGES} comments`);
    const batch = await read('the ledger could not be read', `repos/${slug}/issues/${number}/comments?per_page=${PAGE}&page=${page}`);
    if (!Array.isArray(batch)) throw stop('the ledger could not be read', 'GitHub returned no list of comments');
    comments.push(...batch);
    if (batch.length < PAGE) break;
  }
  let state;
  try {state = priorState(comments, slug, number);} catch (error) {throw stop('the ledger failed validation', line(error.message));}
  return {number, comment: state.comment, findings: state.findings};
}

// The local findings a review against the ledger no longer carries in: blocking, unresolved and absent from the ledger.
function localOnly(local, findings) {
  const ledger = new Set(findings.map(item => item.id));
  return local.filter(item => item.blocking === true && ['confirmed', 'outstanding'].includes(item.state) && !ledger.has(item.id));
}

// The prior findings of a review under the key: {findings, number}, the ledger's and its pull request, or `local` and null
// when the branch has no open pull request. Each local-only unresolved blocker is named (`warn`); that never stops the review.
async function priorFindings({local, repo, branch, number = null, execute, warn = text => process.stderr.write(`${text}\n`)}) {
  const ledger = await pullRequestLedger({repo, branch, number, execute});
  if (!ledger) return {findings: local, number: null};
  for (const item of localOnly(local, ledger.findings)) {
    warn(`Local-only finding not on the pull request ledger: ${item.id} "${item.title.replace(/\s+/g, ' ')}" (${item.state})`);
  }
  return {findings: ledger.findings, number: ledger.number};
}

module.exports = {PREFIX, pullRequestLedger, localOnly, priorFindings};
