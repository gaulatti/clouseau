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
const {screenReceipt, screenSources, MAX_RECEIPT_BYTES} = require('./local-receipt.cjs');
const {describe} = require('./receipt-rejection.cjs');
const {SOURCE} = require('./central-version.cjs');

const POLICY = path.join(__dirname, '../policy/change-acceptance.md');

// The most `gh api` may print for one receipt read: the blob endpoint returns the receipt (at most MAX_RECEIPT_BYTES) as base64
// wrapped every 60 characters (each break is the two JSON characters \n), plus fixed metadata. Node's default 1 MiB buffer is smaller than a maximal receipt.
const BASE64_BYTES = Math.ceil(MAX_RECEIPT_BYTES / 3) * 4;
const RECEIPT_RESPONSE_LIMIT = BASE64_BYTES + Math.ceil(BASE64_BYTES / 60) * 2 + 65536;

// The two reads of the GitHub API that loading a receipt makes, through `gh`; a missing object carries `status` 404 as it does in CI.
function githubReader(execute) {
  const get = async route => {
    try {
      return {data: JSON.parse(execute('gh', ['api', route], {encoding: 'utf8', maxBuffer: RECEIPT_RESPONSE_LIMIT}))};
    } catch (error) {
      if (error.code === 'ENOBUFS') {
        throw new Error(`GitHub's response for ${route} exceeds the ${RECEIPT_RESPONSE_LIMIT}-byte read limit derived from the ${MAX_RECEIPT_BYTES}-byte receipt size cap; the receipt was not read`);
      }
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
    trust: config.local_review, configDigest: digest(config), policyDigest: digest(fs.readFileSync(POLICY, 'utf8')), reviewerDigest: reviewer.digest,
    humanReview: config.local_review.human_review === 'signed'});
  // Under the protected `human_review: "signed"` a signed review that requires a human stands too, as CI holds it for the
  // maintainer: nothing is reviewed again for it.
  const held = screened.ref && screened.verified.human_review ? {human_review: true} : {};
  // Under the protected `binding: "diff"` the head no longer binds the receipt, so its diff must equal the pull request's, as
  // CI checks it (screenSources), on the changed files GitHub reports now.
  if (screened.ref && config.local_review.binding === 'diff') {
    const files = [];
    for (let page = 1; ; page++) {
      const batch = JSON.parse(execute('gh', ['api', `repos/${repo.owner}/${repo.repo}/pulls/${pull.number}/files?per_page=100&page=${page}`], {encoding: 'utf8', maxBuffer: RECEIPT_RESPONSE_LIMIT}));
      files.push(...batch);
      if (batch.length < 100) break;
    }
    let file;
    const rejected = await screenSources({github: githubReader(execute), repo, snapshot: screened.verified.record.snapshot, config, files,
      reviewerSha: screened.bundle.payload.reviewer_sha, pr: {number: pull.number, changed_files: pull.changed_files,
        head: {sha: pull.head, repo: {owner: {login: repo.owner}, name: repo.repo}}, base: {sha: pull.base_sha}}, note: named => {file = named;}});
    if (rejected) {
      const cause = describe(rejected, {detail: {file}});
      return {applicable: true, usable: false, cause: cause.code, sentence: cause.sentence};
    }
    return {applicable: true, usable: true, binding: 'diff', ...held};
  }
  if (screened.ref) return {applicable: true, usable: true, ...held};
  const cause = describe(screened.rejected ?? 'absent', {detail: screened.detail});
  return {applicable: true, usable: false, cause: cause.code, sentence: cause.sentence};
}

module.exports = {receiptStanding, githubReader, RECEIPT_RESPONSE_LIMIT};
