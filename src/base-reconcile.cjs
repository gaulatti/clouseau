'use strict';

const branchUpdate = require('./branch-update.cjs');
const {readPull} = require('./pull-read.cjs');

// A move of the base branch is the only event that invalidates an
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

// What this event asks of the reconciler. A merge made with the workflow GITHUB_TOKEN (the unattended path) creates no
// push event, so a push is not the only trigger. Scope `all` re-checks every open PR: the base certainly moved (a push
// to it, a schedule or dispatch, or the completed review run of a PR that is now merged). Scope `one` checks only the
// PR whose review run just completed: the base may already have moved before that PR was approved (the usual order in
// a batch, where the first merge happens while the others are still being reviewed), and no merge event follows, so
// without this the late approvals would never receive their notice. Anything else says why nothing is to be done.
async function trigger({github, context, baseBranch}) {
  const repo = context.repo;
  if (context.eventName === 'push') {
    return context.payload.ref === `refs/heads/${baseBranch}` ? {scope: 'all', why: 'a push to the base branch'} :
      {scope: 'none', why: `a push to ${String(context.payload.ref).replace(/^refs\/heads\//, '')}, not the base branch`};
  }
  if (['schedule', 'workflow_dispatch'].includes(context.eventName)) return {scope: 'all', why: `a ${context.eventName} run`};
  if (context.eventName !== 'workflow_run') return {scope: 'none', why: `a ${context.eventName} event does not move the base`};
  const run = context.payload.workflow_run;
  if (run.event !== 'pull_request_target') return {scope: 'none', why: `the completed run was a ${run.event} run, not a pull_request_target review run`};
  const numbers = run.pull_requests?.length ? run.pull_requests.map(item => item.number) :
    (await github.rest.repos.listPullRequestsAssociatedWithCommit({...repo, commit_sha: run.head_sha})).data.map(item => item.number);
  let open = null;
  for (const pull_number of numbers) {
    const {data: pr} = await readPull(github, repo, pull_number);
    if (pr.base.ref !== baseBranch) continue;
    if (pr.merged) return {scope: 'all', why: `the review run of merged PR ${pr.number}`};
    if (pr.state === 'open' && !pr.draft && !open) open = pr;
  }
  return open ? {scope: 'one', pr: open, why: `the review run of open PR ${open.number}`} :
    {scope: 'none', why: 'the completed review run belongs to no open or merged PR on the base branch'};
}

// A line in the log and in the run summary, so that a run that does nothing explains itself.
function explain(core, text) {
  core.info(text);
  if (core.summary) core.summary.addRaw(`${text}\n`, true).write();
}

async function reconcileBase({github, updateGithub = null, context, core, baseBranch}) {
  const repo = context.repo;
  const outcome = {updated: [], noticed: []}; const failed = [];
  const asked = await trigger({github, context, baseBranch});
  if (asked.scope === 'none') {
    explain(core, `Base reconciliation skipped: ${asked.why}; the protected base branch did not move for this event.`);
    return outcome;
  }
  const pulls = asked.scope === 'one' ? [asked.pr] : await github.paginate(github.rest.pulls.list, {...repo, state: 'open', base: baseBranch, per_page: 100});
  // One read of the base tip serves every PR; a PR whose recorded base is still the tip cannot be behind.
  const tip = (await github.rest.repos.getBranch({...repo, branch: baseBranch})).data.commit.sha;
  const stale = [];
  for (const pr of pulls.filter(item => !item.draft).sort((a, b) => a.number - b.number)) {
    if (pr.base.sha === tip) continue;
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
    // A notice that cannot be written must not hide the others, and must not look like success: the failure
    // names the permission (commenting on a pull request needs both issues: write and pull-requests: write).
    try {
      await branchUpdate.surface({github, repo, pr, baseBranch, tip, assessment: {head_sha: pr.head.sha, base_sha: mergeBase},
        note: updateGithub && sameRepository ? 'Another approved pull request is being updated first; this one is updated after it merges, or update it yourself.' : ''});
      outcome.noticed.push(pr.number);
    } catch (error) {
      core.info(`PR ${pr.number}: the branch-update notice could not be posted (HTTP ${Number.isInteger(error.status) ? error.status : 'unknown'}).`);
      failed.push({number: pr.number, status: Number.isInteger(error.status) ? error.status : null});
    }
  }
  if (failed.length) {
    throw new Error(`The branch-update notice could not be posted on PR ${failed.map(item => item.number).join(', ')} ` +
      `(HTTP ${[...new Set(failed.map(item => item.status ?? 'unknown'))].join('/')}). Commenting on a pull request needs the job permissions issues: write and pull-requests: write.`);
  }
  explain(core, `Base reconciliation (${asked.why}, ${asked.scope === 'one' ? 'that PR only' : `${pulls.length} open PRs`}): ${outcome.updated.length} updated, ${outcome.noticed.length} noticed.`);
  return outcome;
}

module.exports = {reconcileBase, approvedByBot, trigger};
