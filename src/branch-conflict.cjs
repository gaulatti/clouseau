'use strict';

const {readPull} = require('./pull-read.cjs');
const {numbered} = require('./receipt-rejection.cjs');

const MARKER = 'clouseau-branch-conflict';
const CAUSE = 'branch_conflict';
// GitHub computes mergeability lazily after a push: `mergeable: null` means "not computed yet", never "mergeable".
const ATTEMPTS = 4;

// GitHub does not start `pull_request` workflows for a pull request that has a merge conflict with its base, so the
// verification run never exists and nothing on the pull request says why. The `pull_request_target` run still starts, and
// this is the one place that names the cause. The answer is read from GitHub, retried while it is being computed, and
// never guessed (`known` is a pull request the caller has just read, which saves the first read): anything but a definite `mergeable: false` in state `dirty` on the assessed head is "no conflict".
async function conflicting({github, repo, number, headSha, wait, known = null}) {
  const read = async () => (await readPull(github, repo, number)).data;
  let pr = known ?? await read();
  for (let attempt = 1; ; attempt++) {
    if (pr.head.sha !== headSha) return false;
    if (pr.mergeable !== null) return pr.mergeable === false && pr.mergeable_state === 'dirty';
    if (attempt === ATTEMPTS) return false;
    await wait(1000 * 2 ** attempt);
    pr = await read();
  }
}

const reasonFor = baseBranch => `Merge conflict with ${baseBranch}: GitHub does not run PR verification for a pull request that cannot be merged, so none exists for this revision.`;

// An assessment that is still waiting for a verification run which cannot start: the same pending decision, now with its cause.
async function mark(result, {github, repo, baseBranch, wait}) {
  if (result.verification !== 'absent' || !await conflicting({github, repo, number: result.number, headSha: result.head_sha, wait})) return result;
  return {...result, cause: CAUSE, reason: reasonFor(baseBranch)};
}

const STEPS = Object.freeze({
  [CAUSE]: [
    'Merge the base into your branch and resolve the conflicts: `git fetch origin && git merge origin/{base}` (never rebase), edit the conflicting files, then commit the merge.',
    'Refresh the review evidence and push once, last: `clouseau refresh --pr {number} --request-file REQUIREMENT_FILE --agent claude|codex|opencode`, or review and publish by hand (`clouseau review ...`, `clouseau publish ...`), update the marker in the pull request description, then `git push`.',
    'Verification (tests, exact coverage and package build) starts only after the conflict is resolved and pushed; Clouseau then reviews the new revision automatically.',
  ],
});

function body(assessment, baseBranch) {
  const marker = `<!-- ${MARKER}:${assessment.head_sha}:${assessment.base_sha} -->`;
  const steps = STEPS[CAUSE].map(step => step.replaceAll('{base}', baseBranch).replaceAll('{number}', String(assessment.number)));
  return `${marker}\n## Clouseau: merge conflict\n\n**Cause:** \`${CAUSE}\`: this pull request has a merge conflict with \`${baseBranch}\`. ` +
    `GitHub does not start pull request verification for a branch that cannot be merged, so tests, coverage and the build have not run for revision ` +
    `\`${String(assessment.head_sha).slice(0, 12)}\` and nothing is approved or merged. GitHub does not report which files conflict; the merge in step 1 lists them.\n\n` +
    `**Next steps:**\n\n${numbered(steps)}`;
}

// One notice per head and base: a base that moves again updates it in place instead of adding another.
async function surface({github, repo, assessment, baseBranch}) {
  const text = body(assessment, baseBranch);
  const prefix = `<!-- ${MARKER}:${assessment.head_sha}:`;
  const comments = await github.paginate(github.rest.issues.listComments, {...repo, issue_number: assessment.number, per_page: 100});
  const owned = comments.filter(item => item.user?.login === 'github-actions[bot]' && item.body.startsWith(prefix));
  if (owned.some(item => item.body === text)) return;
  if (owned.length) await github.rest.issues.updateComment({...repo, comment_id: owned[0].id, body: text});
  else await github.rest.issues.createComment({...repo, issue_number: assessment.number, body: text});
}

module.exports = {MARKER, CAUSE, STEPS, conflicting, mark, reasonFor, body, surface};
