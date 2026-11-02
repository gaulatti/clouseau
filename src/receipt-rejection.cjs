'use strict';

// One rule for every local review receipt: it either verifies in every respect and is trusted, or it is ignored.
// An ignored receipt can approve nothing, so CI then performs every check itself (the ordinary hosted review),
// or, where the repository requires a receipt, reports `local_receipt_required`. The reason is always one of the
// fixed classes below; untrusted receipt text never reaches a notice.
const PHRASES = Object.freeze({
  malformed: 'it is malformed or unsupported',
  unavailable: 'it could not be read from its immutable reference',
  signature: 'its signature is not from an enrolled, active key',
  author: 'its signer is not enrolled for this pull request author',
  expired: 'it is expired or not yet valid',
  revision: 'it was issued for a different repository, head or base',
  changed: 'the policy or configuration changed after it was issued',
  source: 'the reviewed sources or diff differ from the pull request',
  record: 'its review record is incomplete or inconsistent',
  engine: 'it predates the current Clouseau engine',
  not_passing: 'the review it records did not pass',
  settings: 'the protected chunked review configuration is invalid',
  held: 'its evidence does not meet the approval evidence rule',
});

class ReceiptRejected extends Error {
  constructor(reason, message) {
    super(`Invalid local review receipt: ${message}`);
    this.code = 'RECEIPT_REJECTED';
    this.reason = reason;
  }
}

// The fixed one-line notice for a class; `required` repositories cannot be reviewed by CI instead.
// A file name comes from the pull request's own changed files; it is shown inline and cannot carry markup or a mention.
const nameOf = file => typeof file === 'string' && file ? ` (file: \`${file.replace(/[`@\r\n]/g, '').slice(0, 200)}\`)` : '';
const noticeText = (reason, required, file) => `Local review receipt ignored because ${PHRASES[reason]}${nameOf(file)}; ` +
  (required ? 'this repository requires a valid receipt, so run the local review again.' : 'CI reviewed this change itself.');

// The value comes from an earlier job's output, so only a known class is ever rendered.
function noticeLine(assessment) {
  const reason = assessment.receipt_notice;
  return typeof reason === 'string' && Object.hasOwn(PHRASES, reason) ?
    `\n\n${noticeText(reason, assessment.cause === 'local_receipt_required', assessment.receipt_notice_file)}` : '';
}

module.exports = {PHRASES, ReceiptRejected, noticeText, noticeLine};
