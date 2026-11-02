'use strict';

const {numbered} = require('./receipt-rejection.cjs');

// The notices of the approval gate that are shown on a pull request or in its check run: why a maintainer is asked, and why
// the gate stopped. Every one carries a fixed cause class (a key of these tables, never text from the run), one sentence
// from the gate itself, and numbered steps. `{repo}`, `{run}`, `{head}` and `{number}` are the only values filled in.
const RERUN = 'Re-run the failed job: `gh run rerun {run} --failed --repo {repo}`.';
const CONFIRM = 'A maintainer comments exactly `/approve-intent {head}` on this pull request. This confirms intent only; all tests and coverage remain mandatory.';
const LATER = 'Wait for the run of the new revision; nothing is wrong with this pull request.';

const INTENT = Object.freeze({
  intent_bot_authored: ['A maintainer submits an approving review of this exact revision, because the approval bot cannot approve its own pull request: `gh pr review {number} --approve --repo {repo}`.', CONFIRM],
  intent_protected_controls: ['Review the protected-control change (the sentence above names the rule), then have a maintainer confirm it.', CONFIRM,
    'Or move the protected-control change out of this pull request and push a new head.'],
  intent_incomplete_patch: ['Reduce the change so GitHub returns a patch for every file, or review the withheld files by hand.', CONFIRM],
  intent_owner_decision: ['Read the review above; if it is correct, have a maintainer confirm the change belongs in this repository.', CONFIRM],
});

const FAILURES = Object.freeze([
  [/^PR verification concluded/, 'gate_verification_failed', ['Open the failing job linked above and fix the failing step.', 'Push the fix: the review runs again when verification passes.']],
  [/^Auto-merge was not enabled/, 'auto_merge_not_armed', ['Allow auto-merge for the repository: `gh repo edit {repo} --enable-auto-merge`.', RERUN]],
  [/^Automatic merge remains enabled/, 'auto_merge_must_be_off', ['Turn auto-merge off for this pull request: `gh pr merge {number} --disable-auto --repo {repo}`.', RERUN]],
  [/^AI assessment must finish/, 'assessment_pending', ['Wait for the AI assessment to finish after verification; the gate runs again with its result.', RERUN]],
  [/^A maintainer intent confirmation is required/, 'intent_required', [CONFIRM]],
  [/^PR changed|^Stale intent assessment/, 'revision_changed', ['A push or a base change happened while the gate ran, so its result belongs to an older revision.', LATER]],
  [/^Verification is pending/, 'verification_not_finished', ['If this pull request comes from a fork, a maintainer approves its workflow runs (Actions tab, "Approve and run").', RERUN]],
  [/^Maintainer confirmation was withdrawn/, 'confirmation_withdrawn', [CONFIRM]],
  [/^Code ownership changed/, 'ownership_changed', ['Code ownership changed while the gate ran. ' + RERUN]],
  [/^A current-head code-owner approval is required/, 'code_owner_approval_required', ['A code owner approves the current head of this pull request: `gh pr review {number} --approve --repo {repo}`.',
    'A code owner merges it; automatic merge is disabled for this change.']],
  [/^Private-plan acceptance mode changed/, 'protection_mode_changed', ['The repository protection settings changed while the gate ran. ' + RERUN]],
]);
const GENERIC = ['gate_failed', ['Open the failed job log of the workflow run for the full error.', RERUN, 'If it repeats, push a new revision.']];

const fill = (text, context) => text.replaceAll('{repo}', context.repo).replaceAll('{run}', context.run)
  .replaceAll('{head}', context.head).replaceAll('{number}', context.number);

// Why the maintainer is asked, by the gate's own state.
function intentCause({selfAuthored, scope, controlReason}) {
  return selfAuthored ? 'intent_bot_authored' : !scope ? 'intent_owner_decision' : scope === controlReason ? 'intent_protected_controls' : 'intent_incomplete_patch';
}

const intentBlock = (cause, context) => `**Cause:** \`${cause}\`\n\n**Next steps:**\n\n${numbered(INTENT[cause].map(step => fill(step, context)))}`;

// The check-run summary of a gate that stopped: the gate's own sentence, then the cause class and what to do.
function failureBlock(message, context) {
  const [, cause, steps] = FAILURES.find(([pattern]) => pattern.test(message)) ?? [null, ...GENERIC];
  return `${message}\n\n**Cause:** \`${cause}\`\n\n**Next steps:**\n\n${numbered(steps.map(step => fill(step, context)))}`;
}

module.exports = {INTENT, FAILURES, GENERIC, intentCause, intentBlock, failureBlock};
