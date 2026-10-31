'use strict';

const {rateLimitDelay} = require('./verification-wait.cjs');
const {REASONS} = require('./lockfile-summary.cjs');
const MARKER = '<!-- clouseau-review-incomplete -->';
const GENERIC = 'Automated review evidence is incomplete; inspect the assessment diagnostic and repair the missing evidence.';

const NEXT_STEPS = Object.freeze({
  provider_key_missing: 'Add the provider key repository secret named in the reason, then re-run the failed jobs.',
  provider_key_invalid: 'Re-save the named secret as the bare key only (no spaces, quotation marks or trailing newline), ' +
    'confirm it with the `check-provider` operation, then re-run the failed jobs.',
  provider_rejected: 'The provider refused the credential. Replace the secret with a valid, active key, then re-run the failed jobs.',
  provider_unavailable: 'The provider did not answer successfully. Re-run the failed jobs later; no change to this PR is needed.',
  local_receipt_required: 'Run the local Clouseau review on this exact head and put its receipt marker in the PR description.',
  engine_mismatch: 'Re-run the local Clouseau review with the current frozen engine, then update the receipt marker.',
  review_output_invalid: 'The reviewer model answered in an invalid form on every bounded attempt. Re-run the failed jobs; if it repeats, report it with the assessment diagnostic.',
  provider_incomplete: 'The reviewer model did not finish its answer within the bounded budget. Re-run the failed jobs.',
  evidence_budget: 'Split the change so that the changed files fit the review evidence budget, then push a new revision.',
  changed_file_unreadable: 'A changed file cannot be read as complete text within the review limits. Split it out of this change or review it manually.',
  lockfile_unsummarizable: 'A changed dependency lockfile could not be summarized and its raw text does not fit the review limits. Regenerate it with a supported lockfile version, split it out of this change, or review it manually.',
  changed_files_incomplete: 'GitHub did not return a patch for every changed file (very large, binary or truncated diff). Reduce the change or review it manually.',
  receipt_patch_mismatch: 'The signed review saw a diff that differs from the pull request diff GitHub reports for the named file. Run the local Clouseau review again on this exact head and update the receipt marker.',
  tree_truncated: 'The repository tree is too large to locate existing tests. Re-run later or review manually.',
  investigation_exhausted: 'The reviewer could not complete its bounded source investigation. Re-run the failed jobs.',
  verification_failed: 'Open the failing job linked in the reason (when it names one), fix the failing step, and push; the review is reassessed when verification passes.',
  github_api_error: 'GitHub rejected an API request this review needs (status and endpoint are in the reason). Re-run the failed jobs; if it repeats, the PR or repository state it describes must change.',
  github_rate_limit: 'No change is needed. The repository installation token used its GitHub API budget; the review is reassessed when verification completes, or re-run the failed jobs after the time stated above.',
  chunked_record_invalid: 'The signed chunked review record is not consistent with the evidence and protected parameters named in the reason. Run the local Clouseau review again on this exact head.',
  record_too_large: 'The chunked review record is too large to sign within the receipt limit. Split the change into smaller reviews.',
  evidence_incomplete: 'Open the `clouseau-acceptance` artifact of the workflow run for the diagnostic, repair the missing evidence, ' +
    'then re-run the failed jobs or push a new revision.',
});

// Map an investigation failure to a fixed, secret-free cause and reason. Raw
// error text is never forwarded: it can carry provider or repository content.
// An HTTP error from GitHub, described by status, method and endpoint path (no host, query or credentials).
function apiErrorReason(error) {
  const where = (() => {
    try {return new URL(error.request.url).pathname.replace(/^\/repos\//, '').slice(0, 120);} catch {return 'an unknown endpoint';}
  })();
  const method = String(error.request?.method ?? 'GET').toUpperCase();
  const detail = String(error.message ?? '').replaceAll('@', '').replace(/\s+/g, ' ').slice(0, 100);
  return `GitHub API request failed: HTTP ${error.status} ${method} ${where}${detail ? ` (${detail})` : ''}.`;
}

function classify(error) {
  if (error?.code === 'PROVIDER_KEY') return {cause: error.cause_code, reason: error.message};
  const provider = /^(Acceptance|Jev) provider unavailable: HTTP ([0-9]{3})$/.exec(error?.message ?? '');
  if (provider) {
    const rejected = ['401', '403'].includes(provider[2]);
    return {cause: rejected ? 'provider_rejected' : 'provider_unavailable',
      reason: `${provider[1]} provider ${rejected ? 'rejected the credential' : 'was unavailable'} (HTTP ${provider[2]}).`};
  }
  if (error?.code === 'RECEIPT_PATCH_MISMATCH') return {cause: 'receipt_patch_mismatch', reason: `The signed local review patch for ${error.path} differs from the pull request diff reported by GitHub (or the file or status is missing).`};
  if (error?.code === 'CHUNKED_RECORD') return {cause: error.cause_code, reason: error.message};
  if (error?.code === 'RATE_LIMIT') return {cause: 'github_rate_limit', reason: `Held: GitHub API rate limit, will retry after ${new Date(error.resetAt).toISOString()}.`};
  // A raw rate-limit response that escaped the retrying wrapper is the same hold, never a crash.
  const asked = rateLimitDelay(error);
  if (asked !== null) {
    const reset = error.response?.headers?.['x-ratelimit-reset'];
    const at = reset === undefined ? Date.now() + Math.max(asked, 900000) : Number(reset) * 1000;
    return {cause: 'github_rate_limit', reason: `Held: GitHub API rate limit, will retry after ${new Date(at).toISOString()}.`};
  }
  if (Number.isInteger(error?.status) && error.status >= 400) return {cause: 'github_api_error', reason: apiErrorReason(error)};
  const message = error?.message ?? '';
  // Every known failure of the AI step maps to a fixed cause that names the missing or failing item.
  // Only our own constant messages (and a repository path) are forwarded, never provider or source text.
  if (error?.lockfile) {
    return {cause: 'lockfile_unsummarizable', reason: `Dependency lockfile ${String(error.lockfile.path).slice(0, 200)} cannot be summarized (${REASONS[error.lockfile.reason]}) and its raw text does not fit the review limits.`};
  }
  if (error?.unavailable) return {cause: 'changed_file_unreadable', reason: `Changed file ${String(error.path ?? 'unknown').slice(0, 200)} cannot be read as complete text within the review limits (not found, binary, invalid text or over 300 KB).`};
  if (/^Acceptance provider returned an invalid structured result$|^Acceptance provider returned malformed JSON$/.test(message)) {
    return {cause: 'review_output_invalid', reason: 'The reviewer model returned an unusable answer (invalid tool call or malformed JSON) on 3 consecutive attempts with the same prompt.'};
  }
  if (message === 'Acceptance provider did not complete the bounded review') return {cause: 'provider_incomplete', reason: 'The reviewer model did not complete its answer within the bounded token budget.'};
  const invalid = /^Invalid acceptance evidence: (.*)$/.exec(message);
  if (invalid) {
    const detail = /^[a-z0-9 ,'-]{1,120}$/i.test(invalid[1]) ? `: ${invalid[1]}` : '';
    return {cause: 'review_output_invalid', reason: `The reviewer's output failed controller validation on 3 consecutive attempts${detail}.`};
  }
  if (/^(?:Technical finding|Unknown controller-supplied|Unit paths are derived)/.test(message)) return {cause: 'review_output_invalid', reason: 'The reviewer returned a finding or unit the controller cannot bind to the changed source, on 3 consecutive attempts.'};
  if (message === 'Complete review evidence exceeds the source budget') return {cause: 'evidence_budget', reason: 'The changed files together exceed the 900 KB review evidence budget.'};
  if (message === 'Changed-file evidence is incomplete') return {cause: 'changed_files_incomplete', reason: 'GitHub did not supply a complete patch for every changed file.'};
  if (message === 'Repository tree is too large to locate the existing tests') return {cause: 'tree_truncated', reason: 'The repository tree is too large to locate the existing tests.'};
  if (/^Automated source investigation exhausted/.test(message)) return {cause: 'investigation_exhausted', reason: 'The reviewer kept requesting source after its bounded investigation budget.'};
  return {cause: 'evidence_incomplete', reason: GENERIC};
}

function body(assessment, runUrl) {
  const step = NEXT_STEPS[assessment.cause] || NEXT_STEPS.evidence_incomplete;
  const reason = String(assessment.reason).replaceAll('@', '').replace(/\s+/g, ' ').slice(0, 500);
  return `${MARKER}\n## Clouseau review incomplete\n\n` +
    `Revision \`${String(assessment.head_sha).slice(0, 12)}\` was not approved or merged because no review decision could be reached.\n\n` +
    `**Reason:** ${reason}\n\n**Next step:** ${step}\n\n` +
    `Workflow run: ${runUrl}\n\nThis notice contains no secret values.`;
}

async function post({github, context, assessment}) {
  const repo = context.repo;
  const issue_number = assessment.number;
  const runUrl = `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  const comments = await github.paginate(github.rest.issues.listComments, {...repo, issue_number, per_page: 100});
  const existing = comments.find(item => item.user?.login === 'github-actions[bot]' && item.body.startsWith(`${MARKER}\n`));
  const text = body(assessment, runUrl);
  if (existing) await github.rest.issues.updateComment({...repo, comment_id: existing.id, body: text});
  else await github.rest.issues.createComment({...repo, issue_number, body: text});
}

const PENDING = '<!-- clouseau-review-pending -->';

function pendingBody(assessment, runUrl) {
  const reason = String(assessment.reason ?? '').replaceAll('@', '').replace(/\s+/g, ' ').slice(0, 500);
  return `${PENDING}\n## Clouseau review pending\n\nRevision \`${String(assessment.head_sha).slice(0, 12)}\` is waiting for PR verification ` +
    `(tests, exact coverage and package build, state: ${String(assessment.verification ?? 'unknown')}). No decision has been made and nothing is approved or merged. ` +
    `The review runs again automatically when verification completes; no action is needed.\n\n${reason}\n\nWorkflow run: ${runUrl}`;
}

// One short comment per PR, updated in place; replaced by a resolution line once a decision exists.
async function postPending({github, context, assessment}) {
  const repo = context.repo; const issue_number = assessment.number;
  const runUrl = `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  const comments = await github.paginate(github.rest.issues.listComments, {...repo, issue_number, per_page: 100});
  const existing = comments.find(item => item.user?.login === 'github-actions[bot]' && item.body.startsWith(`${PENDING}\n`));
  const text = pendingBody(assessment, runUrl);
  if (existing) await github.rest.issues.updateComment({...repo, comment_id: existing.id, body: text});
  else await github.rest.issues.createComment({...repo, issue_number, body: text});
}

async function resolvePending({github, context, number}) {
  const repo = context.repo;
  const comments = await github.paginate(github.rest.issues.listComments, {...repo, issue_number: number, per_page: 100});
  const existing = comments.find(item => item.user?.login === 'github-actions[bot]' && item.body.startsWith(`${PENDING}\n`) && !item.body.includes('Resolved'));
  if (existing) await github.rest.issues.updateComment({...repo, comment_id: existing.id, body: `${PENDING}\n## Clouseau review pending\n\nResolved: this pending state has ended; see the latest Clouseau result.`});
}

function annotate({core, assessment}) {
  if (assessment.decision === 'review_incomplete') {
    core.warning(`Clouseau review incomplete (${assessment.cause || 'evidence_incomplete'}): ${assessment.reason}`);
  }
}

module.exports = {apiErrorReason, PENDING, pendingBody, postPending, resolvePending, MARKER, GENERIC, NEXT_STEPS, classify, body, post, annotate};
