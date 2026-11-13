'use strict';

const MARKER = 'clouseau-needs-branch-update';

// The accepted base moved after approval. The assessment, any signed local
// receipt and the exact-head approval are bound to the old base, so they must
// never be reused: the merge fails closed. This surfaces the reason on the PR
// with the one safe next step. Clouseau cannot update the branch itself with
// the workflow token because a push made with GITHUB_TOKEN does not start the
// verification workflow, which would leave the new head without evidence.
// `automatic` is set only under the protected `local_review.base_moved: "update"` (see settle below) and names why Clouseau did
// not update the branch itself; absent, the notice is the one it always was.
const AUTOMATIC = Object.freeze({
  missing: 'no update credential was supplied, so Clouseau could not update the branch itself: set the `update-token` input of ' +
    'the gate step to a token that starts workflows and has contents: write on this repository',
  refused: 'GitHub refused the automatic update (HTTP 422): a merge conflict with the base, or a head that moved, prevented it, ' +
    'so you must update this branch by hand',
  fork: 'the head branch lives in a fork, which Clouseau never updates, so you must update this branch by hand',
});

async function surface({github, repo, pr, assessment, baseBranch, note = '', tip = null, automatic = null}) {
  // The reconciler reads the base tip once for all PRs; a single gate reads it for its own PR.
  const branch = {commit: {sha: tip ?? (await github.rest.repos.getBranch({...repo, branch: baseBranch})).data.commit.sha}};
  const prefix = `<!-- ${MARKER}:${assessment.head_sha}:`;
  const marker = `${prefix}${branch.commit.sha} -->`;
  const comments = await github.paginate(github.rest.issues.listComments, {...repo, issue_number: pr.number, per_page: 100});
  const owned = comments.filter(item => item.user?.login === 'github-actions[bot]' && item.body.startsWith(prefix));
  const text = `${marker}\n## Clouseau: branch update needed\n\n` +
    `**Cause:** \`base_moved\`: \`${baseBranch}\` moved from \`${assessment.base_sha.slice(0, 12)}\` to \`${branch.commit.sha.slice(0, 12)}\` after revision ` +
    `\`${assessment.head_sha.slice(0, 12)}\` was assessed, so it was not merged. The assessment and the exact-head approval are ` +
    'bound to the old base and cannot be reused; neither is a local review receipt, unless the protected `local_review.binding` is ' +
    '`"diff"` and the update leaves its diff unchanged. Re-running the failed job cannot succeed.' +
    (automatic ? ` The protected \`local_review.base_moved\` is \`"update"\`, but ${AUTOMATIC[automatic]}.` : '') + '\n\n' +
    `**Next steps:**\n\n1. Update this branch with the latest \`${baseBranch}\` using your own credentials so verification starts: ` +
    `\`gh pr update-branch ${pr.number}\` (or the "Update branch" button, or \`git fetch origin && git merge origin/${baseBranch}\` and push; never rebase).\n` +
    '2. Wait: Clouseau re-verifies and re-reviews the new revision automatically.\n' +
    '3. Only if this repository requires a local review receipt: run `clouseau refresh --pr ' + pr.number + '`, which merges the base ' +
    'and, unless a `binding: "diff"` receipt still covers the unchanged diff, reviews and publishes the new head and updates the ' +
    `marker in the pull request description.${note ? `\n\n${note}` : ''}`;
  // One notice per head: a later base move updates it in place instead of adding another.
  if (!owned.some(item => item.body.startsWith(`${marker}\n`))) {
    if (owned.length) await github.rest.issues.updateComment({...repo, comment_id: owned[0].id, body: text});
    else await github.rest.issues.createComment({...repo, issue_number: pr.number, body: text});
  }
  return new Error(`Needs branch update: ${baseBranch} moved after approval; update this PR branch so the new revision is verified and reviewed`);
}

// Only the base differs: same open PR, same assessed head, same base ref.
function baseOnlyMoved(pr, assessment, baseBranch) {
  return pr.state === 'open' && !pr.draft && pr.head.sha === assessment.head_sha &&
    pr.base.ref === baseBranch && pr.base.sha !== assessment.base_sha;
}

// Opt-in, protected `local_review.base_moved: "update"` (valid only with `binding: "diff"`, local-receipt.cjs validateTrust):
// instead of holding, the gate asks GitHub to merge the base into the branch server-side with the independent `update-token`
// credential, whose push starts the new head's own workflows (a GITHUB_TOKEN push would start none). Bounded: it is called
// only when baseOnlyMoved, i.e. the live head IS the assessed head; `expected_head_sha` makes GitHub refuse if the head moved
// meanwhile; the new head's assessment carries the new base, so it updates again only if the base moves again; and updating a
// branch never moves the base, so two pull requests cannot update each other. Returns the error that ends the job: a named
// `base_update_requested` outcome after an update, else the needs-branch-update notice. Under "hold" or absent this is exactly
// surface(). A refusal other than HTTP 422 is thrown as it is.
const UPDATE_CAUSE = 'base_update_requested';
// `approved`: the gate already submitted its approval of this revision (the private-owner merge boundary, where the base can
// move after the approval and before the atomic write), so the outcome says so instead of claiming it was never approved.
async function settle({github, updateGithub, repo, pr, assessment, baseBranch, mode, approved = false}) {
  if (mode !== 'update') return surface({github, repo, pr, assessment, baseBranch});
  if (!updateGithub) return surface({github, repo, pr, assessment, baseBranch, automatic: 'missing'});
  if (pr.head.repo?.full_name !== `${repo.owner}/${repo.repo}`) return surface({github, repo, pr, assessment, baseBranch, automatic: 'fork'});
  try {
    await updateGithub.rest.pulls.updateBranch({...repo, pull_number: pr.number, expected_head_sha: pr.head.sha});
  } catch (error) {
    if (error.status !== 422) throw error;
    return surface({github, repo, pr, assessment, baseBranch, automatic: 'refused'});
  }
  return Object.assign(new Error(`Branch updated server-side (cause: \`${UPDATE_CAUSE}\`): \`${baseBranch}\` moved after revision ` +
    `\`${assessment.head_sha.slice(0, 12)}\` was assessed, and the protected \`local_review.base_moved\` is \`"update"\`, so Clouseau ` +
    `merged \`${baseBranch}\` into this pull request branch with the \`update-token\` credential. ` + (approved ?
    'This revision was approved before the base moved but was not merged; that approval does not carry to the new head, whose own ' +
    'run continues with verification and then this gate. Nothing needs to be done.' :
    'This revision was neither approved nor merged; the new head\'s own run continues with verification and then this gate. ' +
    'Nothing needs to be done.')),
  {code: 'BASE_UPDATE_REQUESTED', cause_code: UPDATE_CAUSE});
}

module.exports = {MARKER, UPDATE_CAUSE, AUTOMATIC, surface, baseOnlyMoved, settle};
