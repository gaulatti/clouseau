'use strict';

const {rateLimitDelay} = require('./verification-wait.cjs');
const {REASONS} = require('./lockfile-summary.cjs');
const {noticeLine, describe, numbered, modeOf} = require('./receipt-rejection.cjs');
const MARKER = '<!-- clouseau-review-incomplete -->';
const GENERIC = 'Automated review evidence is incomplete; inspect the assessment diagnostic and repair the missing evidence.';

// Every cause is a fixed class with numbered steps the customer can run. `{repo}`, `{run}`, `{head}`, `{number}` and
// `{secret}` are filled from the assessment and the workflow run link; nothing else is ever interpolated.
const RERUN = 'Re-run only the failed jobs: `gh run rerun {run} --failed --repo {repo}`.';
const SECRET = 'Store the bare key (no spaces, quotation marks or line break) as the repository secret: `gh secret set {secret} --repo {repo}`.';
const NEXT_STEPS = Object.freeze({
  provider_key_missing: ['Add the provider key repository secret named in the reason: `gh secret set {secret} --repo {repo}`.', RERUN],
  provider_key_invalid: [SECRET, 'Confirm the stored key with the `check-provider` operation of the Clouseau action.', RERUN],
  provider_rejected: ['The provider refused the credential (HTTP 401 or 403). Create or activate a valid key in the provider console.',
    'Replace the provider key secret (`DEEPSEEK_API_KEY`, or `TYPESAFE_API_KEY` for the Jev provider): `gh secret set DEEPSEEK_API_KEY --repo {repo}`.', RERUN],
  provider_payment_required: ['The provider refused the request for payment reasons (HTTP 402); the key itself was accepted. Add credit or fix billing on the provider account that owns the key.', RERUN],
  provider_unavailable: ['No change to this pull request or its secrets is needed: the provider did not answer successfully. Check the provider status page.', RERUN],
  local_receipt_required: ['Run the local Clouseau review on this exact head: `clouseau review --directory . --base origin/BASE_BRANCH --request-file REQUIREMENT_FILE --agent claude|codex|opencode`.',
    'Publish it: `clouseau publish --directory . --receipt RECEIPT_FILE`, and put the marker it prints in the pull request description.'],
  local_receipt_unusable: ['Run the local Clouseau review on this exact head and update the receipt marker in the pull request description (`clouseau review ...`, then `clouseau publish --directory . --receipt RECEIPT_FILE`).',
    'Or remove the `clouseau-local-review` marker from the description: editing it re-runs this check through the CI AI reviewer.'],
  review_output_invalid: ['The reviewer model answered in an invalid form on every bounded attempt. ' + RERUN, 'If it repeats, report it with the link to this workflow run.'],
  provider_incomplete: ['The reviewer model did not finish its answer within the bounded budget. ' + RERUN],
  evidence_budget: ['Split the change so that the changed files together fit the 900 KB review evidence budget.', 'Push the smaller change as a new revision.'],
  changed_file_unreadable: ['Split the file named in the reason out of this change, or make it complete text of at most 300 KB.', 'Otherwise have a maintainer review that file manually.'],
  lockfile_unsummarizable: ['Regenerate the lockfile named in the reason with a supported lockfile version, or split it out of this change.', 'Otherwise have a maintainer review it manually.'],
  changed_files_incomplete: ['GitHub did not return a patch for every changed file (a very large, binary or truncated diff). Reduce the change so every file has a patch.', 'Otherwise have a maintainer review the change manually.'],
  tree_truncated: ['The repository tree is too large to locate existing tests. ' + RERUN, 'If it repeats, have a maintainer review the change manually.'],
  investigation_exhausted: ['The reviewer could not complete its bounded source investigation. ' + RERUN],
  verification_failed: ['Open the failing job linked in the reason (when it names one) and fix the failing step.', 'Push the fix: the review is reassessed when verification passes.'],
  github_api_error: ['GitHub rejected an API request this review needs; the status and endpoint are in the reason. ' + RERUN,
    'If it repeats, the pull request or repository state the reason describes must change.'],
  github_rate_limit: ['No change is needed: the repository installation token used its GitHub API budget.',
    'The review is reassessed when verification completes, or run `gh run rerun {run} --failed --repo {repo}` after the time stated in the reason.'],
  receipt_protected_controls: ['A local receipt cannot stand in for the owner. Ask a maintainer to comment exactly `/approve-intent {head}` on this pull request.',
    'Or remove the protected-file change (for example an AGENTS.md update, which should stay out of an ordinary pull request) and push a new head.'],
  receipt_history_changed: ['The findings on the pull request changed after the receipt was issued. Run the local review again on this exact head so the receipt reflects them (`clouseau review ...`).',
    'Publish it: `clouseau publish --directory . --receipt RECEIPT_FILE`, and update the marker in the pull request description.'],
  chunked_record_invalid: ['The signed chunked review record is not consistent with the evidence and protected parameters named in the reason. Run the local Clouseau review again on this exact head (`clouseau review ...`).',
    'Publish it: `clouseau publish --directory . --receipt RECEIPT_FILE`, and update the marker in the pull request description.'],
  decision_mismatch: ['The assessment and the stored record disagree (both decisions are in the reason). ' + RERUN, 'If it repeats, report it with the link to this workflow run.'],
  evidence_incomplete: ['Open the log of the failed assessment job in the workflow run below for the diagnostic and repair the missing evidence.',
    RERUN, 'Or push a new revision.'],
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
    // 401/403: the credential is refused. 402: the credential is fine but the account cannot pay. Anything else: no answer.
    const cause = {401: 'provider_rejected', 403: 'provider_rejected', 402: 'provider_payment_required'}[provider[2]] ?? 'provider_unavailable';
    const what = {provider_rejected: 'rejected the credential', provider_payment_required: 'refused the request because the account has no credit or billing (the credential was accepted)',
      provider_unavailable: 'was unavailable'}[cause];
    return {cause, reason: `${provider[1]} provider ${what} (HTTP ${provider[2]}).`};
  }
  if (['CHUNKED_RECORD', 'RECEIPT_AUTHORITY'].includes(error?.code)) return {cause: error.cause_code, reason: error.message};
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
    const detail = /^[a-z0-9 ,'\/._:-]{1,240}$/i.test(invalid[1]) ? `: ${invalid[1]}` : '';
    return {cause: 'review_output_invalid', reason: `The reviewer's output failed controller validation on 3 consecutive attempts${detail}.`};
  }
  if (/^(?:Technical finding|Unknown controller-supplied|Unit paths are derived)/.test(message)) return {cause: 'review_output_invalid', reason: 'The reviewer returned a finding or unit the controller cannot bind to the changed source, on 3 consecutive attempts.'};
  if (message === 'Complete review evidence exceeds the source budget') return {cause: 'evidence_budget', reason: 'The changed files together exceed the 900 KB review evidence budget.'};
  if (message === 'Changed-file evidence is incomplete') return {cause: 'changed_files_incomplete', reason: 'GitHub did not supply a complete patch for every changed file.'};
  if (message === 'Repository tree is too large to locate the existing tests') return {cause: 'tree_truncated', reason: 'The repository tree is too large to locate the existing tests.'};
  if (/^Automated source investigation exhausted/.test(message)) return {cause: 'investigation_exhausted', reason: 'The reviewer kept requesting source after its bounded investigation budget.'};
  return {cause: 'evidence_incomplete', reason: GENERIC};
}

// The values a step may mention: the repository and run from the workflow run link, the revision and the pull request.
function fill(text, assessment, runUrl, reason) {
  const link = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/.exec(String(runUrl));
  return text.replaceAll('{repo}', link?.[1] ?? 'OWNER/REPO').replaceAll('{run}', link?.[2] ?? 'RUN_ID')
    .replaceAll('{head}', String(assessment.head_sha)).replaceAll('{number}', String(assessment.number))
    .replaceAll('{secret}', /^[A-Z][A-Z0-9_]*(?= )/.exec(reason)?.[0] ?? 'SECRET_NAME');
}

// The fixed cause class of a notice: always a key of the table, never text from the assessment.
const causeOf = assessment => Object.hasOwn(NEXT_STEPS, assessment.cause) ? assessment.cause : 'evidence_incomplete';

// A receipt hold names the receipt's own cause (and its steps) instead of the generic receipt steps.
const receiptCause = assessment => ['local_receipt_required', 'local_receipt_unusable'].includes(assessment.cause) ?
  describe(assessment.receipt_notice, {mode: modeOf(assessment.cause), detail: assessment.receipt_notice_detail, number: assessment.number}) : null;

function body(assessment, runUrl) {
  const reason = String(assessment.reason).replaceAll('@', '').replace(/\s+/g, ' ').slice(0, 500);
  const cause = causeOf(assessment);
  const receipt = receiptCause(assessment);
  const steps = receipt ? receipt.steps : NEXT_STEPS[cause];
  return `${MARKER}\n## Clouseau review incomplete\n\n` +
    `Revision \`${String(assessment.head_sha).slice(0, 12)}\` was not approved or merged because no review decision could be reached.\n\n` +
    `**Cause:** \`${cause}\`${receipt ? ` (\`${receipt.code}\`)` : ''}\n\n**Reason:** ${reason}\n\n` +
    `**Next steps:**${receipt ? ` ${receipt.lead}` : ''}\n\n${numbered(steps.map(step => fill(step, assessment, runUrl, reason)))}\n\n` +
    `Workflow run: ${runUrl}${receipt ? '' : noticeLine(assessment)}\n\nThis notice contains no secret values.`;
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

// Why verification has not finished, by the state the assessment observed. Every state ends with the same promise: the review
// runs again by itself when verification completes. Only a run that never started needs the customer.
const PENDING_STEPS = Object.freeze({
  absent: ['No PR verification run exists for this revision. Check that the verification workflow is enabled for this repository (the Actions tab).',
    'A pull request opened before that workflow was installed has no run: update the branch so one starts: `gh pr update-branch {number}`.',
    'The review then runs again automatically when verification completes.'],
  queued: ['Verification is queued for a runner; nothing is needed. The review runs again automatically when verification completes.'],
  running: ['Verification is running; nothing is needed. The review runs again automatically when verification completes.'],
  finalizing: ['Verification just finished and its results are being recorded; nothing is needed. The review runs again automatically.'],
  unknown: ['Verification has not reported a final state; nothing is needed. The review runs again automatically when verification completes.'],
});

function pendingBody(assessment, runUrl) {
  const reason = String(assessment.reason ?? '').replaceAll('@', '').replace(/\s+/g, ' ').slice(0, 500);
  const state = Object.hasOwn(PENDING_STEPS, assessment.verification) ? assessment.verification : 'unknown';
  return `${PENDING}\n## Clouseau review pending\n\nRevision \`${String(assessment.head_sha).slice(0, 12)}\` is waiting for PR verification ` +
    `(tests, exact coverage and package build, state: ${state}). No decision has been made and nothing is approved or merged.\n\n` +
    `**Cause:** \`verification_pending_${state}\`\n\n${reason}\n\n**Next steps:**\n\n` +
    `${numbered(PENDING_STEPS[state].map(step => fill(step, assessment, runUrl, '')))}${noticeLine(assessment)}\n\nWorkflow run: ${runUrl}`;
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

module.exports = {apiErrorReason, PENDING, PENDING_STEPS, pendingBody, postPending, resolvePending, MARKER, GENERIC, NEXT_STEPS, classify, body, post, annotate};
