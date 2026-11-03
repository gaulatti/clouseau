'use strict';

// Whether the local review receipt a pull request carries still stands for its (unchanged) head: the decision CI makes before it
// trusts a receipt, taken here with the very same code (`screenReceipt`), on the pull request GitHub reports, the protected
// configuration of the base branch and the engine that is running. `clouseau refresh` uses it to tell "nothing to do" from
// "the receipt can no longer be used and must be renewed" when the base has not moved (docs/local-review.md).
//
// Nothing here trusts the marker or the receipt: a missing, forged, expired, foreign (another head, base or repository),
// unsigned or otherwise unverifiable receipt is simply `usable: false`, with the fixed cause class CI would show
// (receipt-rejection.cjs), never receipt text. Only a receipt that verifies in every respect is `usable: true`. A failure that is not the receipt's own (GitHub
// unreachable, rate limited) is thrown, so nothing is renewed on a guess.

const fs = require('node:fs');
const path = require('node:path');
const {digest} = require('./acceptance.cjs');
const {git} = require('./local-git.cjs');
const {screenReceipt} = require('./local-receipt.cjs');
const {describe} = require('./receipt-rejection.cjs');
const {SOURCE} = require('./central-version.cjs');

const POLICY = path.join(__dirname, '../policy/change-acceptance.md');

// The two reads of the GitHub API that loading a receipt makes, through `gh`; a missing object carries `status` 404 as it does in CI.
function githubReader(execute) {
  const get = async route => {
    try {
      return {data: JSON.parse(execute('gh', ['api', route], {encoding: 'utf8'}))};
    } catch (error) {
      if (/HTTP 404/.test(String(error.stderr))) error.status = 404;
      throw error;
    }
  };
  return {rest: {repos: {getContent: ({owner, repo, ref, path: file}) => get(`repos/${owner}/${repo}/contents/${file}?ref=${ref}`)},
    git: {getBlob: ({owner, repo, file_sha: sha}) => get(`repos/${owner}/${repo}/git/blobs/${sha}`)}}};
}

// `pull` is what GitHub reports: number, author login, body, head sha and base sha. `base` is the fetched remote base ref
// whose protected configuration governs the receipt. Without a `local_review` section there is no receipt to judge.
async function receiptStanding({directory, base, repo, pull, execute, installed}) {
  if (!git(directory, ['ls-tree', base, '--', '.github/clouseau.json']).trim()) return {applicable: false};
  const config = require('./config.cjs').validateConfig(JSON.parse(git(directory, ['show', `${base}:.github/clouseau.json`])));
  if (!config.local_review) return {applicable: false};
  const reviewer = installed();
  const screened = await screenReceipt({github: githubReader(execute), repo, engine: {...SOURCE, sha: reviewer.sha, digest: reviewer.digest},
    pr: {number: pull.number, body: pull.body, user: {login: pull.author}, head: {sha: pull.head}, base: {sha: pull.base_sha}},
    trust: config.local_review, configDigest: digest(config), policyDigest: digest(fs.readFileSync(POLICY, 'utf8')), reviewerDigest: reviewer.digest});
  if (screened.ref) return {applicable: true, usable: true};
  const cause = describe(screened.rejected ?? 'absent', {detail: screened.detail});
  return {applicable: true, usable: false, cause: cause.code, sentence: cause.sentence};
}

module.exports = {receiptStanding, githubReader};
