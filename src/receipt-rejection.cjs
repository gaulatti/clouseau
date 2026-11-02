'use strict';

// One rule for every local review receipt: it either verifies in every respect and is trusted, or it is ignored.
// An ignored receipt can approve nothing, so CI then performs every check itself (the ordinary hosted review),
// or, where the repository requires a receipt, reports `local_receipt_required`.
//
// Every ignored receipt is shown with its cause: a fixed, machine-stable class (`receipt_<class>`), one sentence that
// names the concrete values that are safe to show, and numbered steps the customer can run. The class comes from the
// closed table below. The values come from a small allowlist (short commit ids, a changed file of the pull request,
// an expiry time, a base branch name), each re-validated when rendered because they travel through an earlier job's
// output. Untrusted receipt text, receipt contents and provider payloads never reach a notice.
const SHA = /^[0-9a-f]{40}$/;
const SHA_KEYS = ['receipt_head', 'current_head', 'receipt_base', 'current_base', 'receipt_engine', 'current_engine'];
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

function clean(raw) {
  const detail = {};
  if (!raw || typeof raw !== 'object') return detail;
  for (const key of SHA_KEYS) if (typeof raw[key] === 'string' && SHA.test(raw[key])) detail[key] = raw[key].slice(0, 12);
  // A file name comes from the pull request's own changed files; it is shown inline and cannot carry markup or a mention.
  const file = typeof raw.file === 'string' ? raw.file.replace(/[`@\r\n]/g, '').slice(0, 200) : '';
  if (file) detail.file = file;
  if (typeof raw.expires === 'string' && INSTANT.test(raw.expires)) detail.expires = raw.expires;
  if (['configuration', 'policy'].includes(raw.changed)) detail.changed = raw.changed;
  if (typeof raw.base_branch === 'string' && BRANCH.test(raw.base_branch)) detail.base_branch = raw.base_branch;
  return detail;
}

const tick = value => `\`${value}\``;
const shown = (detail, key, label, absent) => detail[key] ? `${label}${tick(detail[key])}` : absent;
const named = detail => detail.file ? ` (file: ${tick(detail.file)})` : '';

const REVIEW = 'clouseau review --directory . --base origin/{base} --request-file REQUIREMENT_FILE --agent claude|codex|opencode';
// The same three steps make a fresh receipt for the current head; a class adds what is specific to its cause before them.
const REISSUE = [
  'Commit everything, then review this exact head: `' + REVIEW + '` (outside an AI harness use `--harness codex|claude` instead of `--agent`).',
  'Publish the receipt: `clouseau publish --directory . --receipt RECEIPT_FILE`.',
  'Put the marker it prints in the pull request description, replacing the old `clouseau-local-review:` marker (editing the description re-runs this check).',
];
const OWNER = 'ask a repository owner to change the protected `local_review` section of `.github/clouseau.json` on the base branch';

// class -> sentence (what is wrong, with the values safe to show) and the steps specific to it.
const CAUSES = Object.freeze({
  absent: {
    say: () => 'the pull request description carries no `clouseau-local-review:` marker',
    steps: () => [],
  },
  unread: {
    say: () => 'this hosted run does not read receipts: it follows a receipt-only run, and that run already rejected the receipt (its notice names the cause)',
    steps: () => [],
  },
  malformed: {
    say: () => 'the marker or the published receipt is malformed or unsupported (for example more than one marker, an installation-only receipt, or an artifact that is not a Clouseau receipt)',
    steps: () => [],
  },
  unavailable: {
    say: () => 'the receipt could not be read from the immutable commit the marker names',
    steps: () => ['Check that the commit named by the marker still exists in this repository and has not been deleted; if it is gone, reissue the receipt.'],
  },
  signature: {
    say: () => 'its signature is not from an enrolled, active key',
    steps: () => ['Sign with an enrolled identity (`clouseau public-identity` prints the one on this machine); if it is not enrolled or was revoked, ' +
      OWNER + ' to enroll it.'],
  },
  author: {
    say: () => 'its signer is not enrolled for the author of this pull request',
    steps: () => ['Sign with an identity enrolled for the pull request author, or ' + OWNER + ' to enroll yours for this author.'],
  },
  attestation: {
    say: () => 'it is not a maintainer attestation that the protected configuration permits for this pull request and author',
    steps: () => ['Have the pull request author run the review, or ' + OWNER + ' to allow `local_review.attest` for this author.'],
  },
  expired: {
    say: d => `it is expired or not yet valid${d.expires ? ` (it expires ${tick(d.expires)})` : ''}`,
    steps: () => ['Receipts are valid only for a limited time after they are issued; review and publish again, then update the marker without waiting.'],
  },
  revision_repository: {
    say: () => 'it was issued for a different repository',
    steps: () => ['Run the review in a checkout of this repository, not a fork or another project.'],
  },
  revision_head: {
    say: d => `it reviewed ${shown(d, 'receipt_head', 'head ', 'an earlier head')} but this pull request is now at ${shown(d, 'current_head', 'head ', 'another head')}`,
    steps: () => ['Any push after a review needs a new review: make your last change first, then review and publish that head.'],
  },
  revision_base: {
    say: d => `it was issued against ${shown(d, 'receipt_base', 'base ', 'an earlier base')} but the base branch is now at ${shown(d, 'current_base', '', 'a newer commit')}`,
    steps: () => ['Update the branch with the base: `gh pr update-branch {number}` (or `git fetch origin && git merge origin/{base}`; never rebase), then `git pull` if GitHub did it.'],
  },
  changed: {
    say: d => `the protected ${d.changed ?? 'policy or configuration'} changed after the receipt was issued`,
    steps: () => ['Merge the current base into the branch (`git fetch origin && git merge origin/{base}`; never rebase) so the review uses the current rules.'],
  },
  source: {
    say: d => `the reviewed sources or diff differ from the pull request${named(d)}`,
    steps: () => ['The review reads committed files only: commit all changes, do not amend or add commits after the review, and make sure the pull request contains exactly the reviewed commits.'],
  },
  record: {
    say: () => 'its review record is incomplete or inconsistent with what was signed',
    steps: () => ['Do not edit a receipt by hand; discard it and run a fresh review.'],
  },
  engine: {
    say: d => `it was issued by ${shown(d, 'receipt_engine', 'Clouseau engine ', 'an older Clouseau engine')} and this run uses ${shown(d, 'current_engine', 'engine ', 'the current protected engine')}, which does not list that engine as review-compatible`,
    steps: () => ['Run the review again: the `clouseau` launcher refreshes to the current protected engine before it starts (pass `--engine latest` to leave a review that was started on an older engine).'],
  },
  not_passing: {
    say: () => 'the review it records did not pass',
    steps: () => ['Open the findings of the local review, repair the blockers within the accepted requirement, and review the new head.'],
  },
  settings: {
    say: () => 'the protected chunked review configuration is invalid, so no receipt can be checked',
    steps: () => ['This is not fixable from the pull request: ' + OWNER + ' (the `chunked` settings), then re-run this check.'],
    reissue: false,
  },
  untested: {
    say: d => `no supplied test imports changed production code${named(d)}`,
    steps: () => ['Add or extend a test that imports each named production file (or the module that wraps it), commit it, and review again.'],
  },
  integrity: {
    say: d => `test integrity is unresolved${named(d)}`,
    steps: () => ['Make the tests prove the change (real assertions on the changed behavior, no weakened or deleted checks), commit, and review again.'],
  },
  completeness: {
    say: d => `review completeness is unresolved${named(d)}`,
    steps: () => ['Supply the evidence the reviewer could not read (sources or tests it names as missing), commit, and review again.'],
  },
});

// What an ignored receipt means for this run: a repository that requires one is blocked, the receipt-only route cannot review
// the change itself, and anywhere else CI has already reviewed it.
const LEAD = Object.freeze({
  required: 'This repository requires a valid receipt, so nothing is approved until you do the following.',
  receipt_only: 'This receipt-only run did not review the change itself. Do the following, or remove the `clouseau-local-review:` marker from the description so the CI AI reviewer runs.',
  optional: 'CI reviewed this change itself, so no action is needed. To use a receipt instead, do the following.',
});

class ReceiptRejected extends Error {
  constructor(reason, message, detail = {}) {
    super(`Invalid local review receipt: ${message}`);
    this.code = 'RECEIPT_REJECTED';
    this.reason = reason;
    this.detail = detail;
  }
}

// An unknown number or base branch stays a visible placeholder; it is never guessed.
const substitute = (text, context) => text.replaceAll('{number}', context.number).replaceAll('{base}', context.base);

// The cause of one ignored receipt: its stable code, its sentence and its numbered steps, for a known class only.
function describe(reason, {mode = 'optional', detail: raw, number = 0} = {}) {
  if (typeof reason !== 'string' || !Object.hasOwn(CAUSES, reason)) return null;
  const detail = clean(raw);
  const cause = CAUSES[reason];
  const context = {number: Number.isSafeInteger(number) && number > 0 ? String(number) : 'PR_NUMBER', base: detail.base_branch ?? 'BASE_BRANCH'};
  const steps = [...cause.steps(detail), ...cause.reissue === false ? [] : REISSUE].map(step => substitute(step, context));
  return {code: `receipt_${reason}`, sentence: cause.say(detail), steps, lead: LEAD[mode], detail};
}

const numbered = steps => steps.map((step, index) => `${index + 1}. ${step}`).join('\n');

// The fixed notice for a class. `mode` is `required`, `receipt_only` or `optional`.
function noticeText(reason, context = {}) {
  const found = describe(reason, context);
  return `Local review receipt not used (cause: \`${found.code}\`): ${found.sentence}. ${found.lead}\n\n${numbered(found.steps)}`;
}

const modeOf = cause => cause === 'local_receipt_required' ? 'required' : cause === 'local_receipt_unusable' ? 'receipt_only' : 'optional';

// The value comes from an earlier job's output, so only a known class is ever rendered.
function noticeLine(assessment) {
  const context = {mode: modeOf(assessment.cause), detail: assessment.receipt_notice_detail, number: assessment.number};
  return describe(assessment.receipt_notice, context) ? `\n\n${noticeText(assessment.receipt_notice, context)}` : '';
}

module.exports = {CAUSES, ReceiptRejected, describe, numbered, modeOf, noticeText, noticeLine};
