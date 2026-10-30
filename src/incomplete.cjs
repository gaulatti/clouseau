'use strict';

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
  evidence_incomplete: 'Open the `clouseau-acceptance` artifact of the workflow run for the diagnostic, repair the missing evidence, ' +
    'then re-run the failed jobs or push a new revision.',
});

// Map an investigation failure to a fixed, secret-free cause and reason. Raw
// error text is never forwarded: it can carry provider or repository content.
function classify(error) {
  if (error?.code === 'PROVIDER_KEY') return {cause: error.cause_code, reason: error.message};
  const provider = /^(Acceptance|Jev) provider unavailable: HTTP ([0-9]{3})$/.exec(error?.message ?? '');
  if (provider) {
    const rejected = ['401', '403'].includes(provider[2]);
    return {cause: rejected ? 'provider_rejected' : 'provider_unavailable',
      reason: `${provider[1]} provider ${rejected ? 'rejected the credential' : 'was unavailable'} (HTTP ${provider[2]}).`};
  }
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

function annotate({core, assessment}) {
  if (assessment.decision === 'review_incomplete') {
    core.warning(`Clouseau review incomplete (${assessment.cause || 'evidence_incomplete'}): ${assessment.reason}`);
  }
}

module.exports = {MARKER, GENERIC, NEXT_STEPS, classify, body, post, annotate};
