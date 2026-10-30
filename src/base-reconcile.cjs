'use strict';

const branchUpdate = require('./branch-update.cjs');

// A push to the base branch is the only event that moves the base under an
// already-approved PR, and nothing else re-runs that PR's gate. Re-evaluate
// every open ready PR whose approval or armed auto-merge is bound to the old
// base. Fail closed: nothing is approved or merged here.
//
// With an independent update credential (like repair-token), one such PR at a
// time is brought up to date; its push starts normal verification and a fresh
// independent review. Serializing avoids invalidating several in-flight
// re-reviews by the very next sibling merge. Every other stale PR (and every
// PR when no credential is supplied, the head is a fork, or the update is
// refused) receives the visible needs-branch-update notice. A push made with
// the workflow GITHUB_TOKEN would not start verification, so it is never used.
async function approvedByBot(github, repo, pr) {
  const reviews = await github.paginate(github.rest.pulls.listReviews, {...repo, pull_number: pr.number, per_page: 100});
  const latest = new Map();
  for (const review of reviews) if (review.state !== 'COMMENTED') latest.set(review.user?.login, review);
  const approval = latest.get('github-actions[bot]');
  return Boolean(approval && approval.user.type === 'Bot' && approval.state === 'APPROVED' && approval.commit_id === pr.head.sha);
}

async function reconcileBase({github, updateGithub = null, context, core, baseBranch}) {
  const repo = context.repo;
  const outcome = {updated: [], noticed: []};
  if (context.eventName !== 'push' || context.payload.ref !== `refs/heads/${baseBranch}`) {
    core.info('Not a push to the protected base branch; no base reconciliation is needed.');
    return outcome;
  }
  const pulls = await github.paginate(github.rest.pulls.list, {...repo, state: 'open', base: baseBranch, per_page: 100});
  const stale = [];
  for (const pr of pulls.filter(item => !item.draft).sort((a, b) => a.number - b.number)) {
    if (!pr.auto_merge && !await approvedByBot(github, repo, pr)) continue;
    const {data: comparison} = await github.rest.repos.compareCommits({...repo, base: baseBranch, head: pr.head.sha});
    if (comparison.behind_by > 0) stale.push({pr, mergeBase: comparison.merge_base_commit.sha});
  }
  for (const {pr, mergeBase} of stale) {
    const sameRepository = pr.head.repo?.full_name === `${repo.owner}/${repo.repo}`;
    if (updateGithub && sameRepository && !outcome.updated.length) {
      try {
        await updateGithub.rest.pulls.updateBranch({...repo, pull_number: pr.number, expected_head_sha: pr.head.sha});
        outcome.updated.push(pr.number);
        core.info(`Updated PR ${pr.number} with ${baseBranch}; normal verification and a fresh review start on the new head.`);
        continue;
      } catch (error) {
        core.info(`PR ${pr.number} could not be updated automatically (HTTP ${Number.isInteger(error.status) ? error.status : 'unknown'}).`);
      }
    }
    await branchUpdate.surface({github, repo, pr, baseBranch, assessment: {head_sha: pr.head.sha, base_sha: mergeBase},
      note: updateGithub && sameRepository ? 'Another approved pull request is being updated first; this one is updated after it merges, or update it yourself.' : ''});
    outcome.noticed.push(pr.number);
  }
  core.info(`Base reconciliation: ${outcome.updated.length} updated, ${outcome.noticed.length} noticed.`);
  return outcome;
}

module.exports = {reconcileBase, approvedByBot};
