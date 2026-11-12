'use strict';

const MARKER = 'clouseau-needs-branch-update';

// The accepted base moved after approval. The assessment, any signed local
// receipt and the exact-head approval are bound to the old base, so they must
// never be reused: the merge fails closed. This surfaces the reason on the PR
// with the one safe next step. Clouseau cannot update the branch itself with
// the workflow token because a push made with GITHUB_TOKEN does not start the
// verification workflow, which would leave the new head without evidence.
async function surface({github, repo, pr, assessment, baseBranch, note = '', tip = null}) {
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
    '`"diff"` and the update leaves its diff unchanged. Re-running the failed job cannot succeed.\n\n' +
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

module.exports = {MARKER, surface, baseOnlyMoved};
