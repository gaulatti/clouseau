'use strict';

const {readPull} = require('./pull-read.cjs');

const CAUSE = 'assessment_predates_confirmation';
const MARKER = 'clouseau-stale-assessment';

// A gate that re-runs on its own ("Re-run failed jobs") consumes the assessment its run made earlier. When that assessment
// could not approve and an owner confirmation of this exact head was posted after it was made, the confirmation is not in
// it: the gate must not decide on it, and only a new assessment may read the confirmation (the gate never reads one into a
// decision itself). The gate then names the cause and tells the owner, once per head and confirmation, how to recover.
// `assessed_at` is stamped by the action before the assessment reads any comment, so a confirmation posted after it may
// have been seen; an approvable assessment is never stale, and one without the stamp (an older engine) is never checked.
async function newerConfirmation({github, context, assessment, legacy, number}) {
  if (typeof assessment.assessed_at !== 'string' || ['auto_approve', 'owner_decision'].includes(assessment.decision)) return null;
  const assessedAt = Date.parse(assessment.assessed_at);
  if (!Number.isFinite(assessedAt)) return null;
  const repo = context.repo;
  const {data: pr} = await readPull(github, repo, number);
  if (pr.head.sha !== assessment.head_sha) return null;
  const comments = await github.paginate(github.rest.issues.listComments, {...repo, issue_number: number, per_page: 100});
  const confirmation = await legacy.purposeConfirmation(github, repo, pr, comments);
  const comment = confirmation && comments.find(item => item.id === confirmation.comment_id);
  if (!comment || !(Date.parse(comment.created_at) > assessedAt)) return null;
  const marker = `<!-- ${MARKER}:${pr.head.sha}:${comment.id} -->`;
  if (!comments.some(item => item.user?.login === 'github-actions[bot]' && String(item.body).startsWith(`${marker}\n`))) {
    await github.rest.issues.createComment({...repo, issue_number: number, body: `${marker}\n## Clouseau: assessment predates your confirmation\n\n` +
      `**Cause:** \`${CAUSE}\`: this run's assessment of \`${pr.head.sha.slice(0, 12)}\` was made before your confirmation ` +
      `(${comment.html_url}), so it does not contain it and this gate cannot use it.\n\n` +
      '**Next step:** open the latest **Clouseau CI** run of this pull request and choose **Re-run all jobs** (not "Re-run failed jobs"), ' +
      'or post the same `/approve-intent` comment again. Your confirmation is kept; nothing else is needed.'});
  }
  return `Cause: \`${CAUSE}\`. The assessment of this head was made before the owner confirmation ${comment.id}; re-run all jobs so a new ` +
    'assessment reads it. "Re-run failed jobs" reuses the earlier assessment.';
}

module.exports = {CAUSE, MARKER, newerConfirmation};
