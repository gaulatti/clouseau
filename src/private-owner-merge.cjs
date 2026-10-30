'use strict';

// An exact-head/base transaction for the narrow private-plan exception only.
// Callers must first validate the acceptance record and all technical gates.
async function finalizePrivateOwner({github, repo, pr, assessment, baseBranch, verify}) {
  const exact = value => value.state === 'open' && !value.draft &&
    value.head.sha === assessment.head_sha && value.base.sha === assessment.base_sha && value.base.ref === baseBranch;
  const branchUpdate = require('./branch-update.cjs');
  if (branchUpdate.baseOnlyMoved(pr, assessment, baseBranch)) throw await branchUpdate.surface({github, repo, pr, assessment, baseBranch});
  if (!exact(pr) || !/^[a-f0-9]{40}$/.test(assessment.head_sha) || !/^[a-f0-9]{40}$/.test(assessment.base_sha)) {
    throw new Error('Private owner merge requires the exact open assessed head and base');
  }
  const {data: settings} = await github.rest.repos.get(repo);
  const safeRef = ref => typeof ref === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(ref) &&
    !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/') && !ref.endsWith('.lock');
  if (!settings.node_id || pr.head.repo?.node_id !== settings.node_id || pr.base.repo?.node_id !== settings.node_id ||
      !safeRef(pr.head.ref) || !safeRef(baseBranch) || pr.head.ref === baseBranch || pr.auto_merge) {
    throw new Error('Private owner merge requires distinct same-repository refs and disabled native auto-merge');
  }
  const files = await github.paginate(github.rest.pulls.listFiles, {...repo, pull_number: pr.number, per_page: 100});
  const authority = await require('./codeowners.cjs').authority({github, repo, pr, files});
  if (!authority.automatic || authority.configured === false || !authority.groups.length) {
    throw new Error('Private automatic merge requires explicitly configured ownership of every affected path');
  }
  const reviews = await github.paginate(github.rest.pulls.listReviews, {...repo, pull_number: pr.number, per_page: 100});
  const latest = new Map();
  for (const review of reviews) if (review.state !== 'COMMENTED') latest.set(review.user?.login, review);
  const approval = latest.get('github-actions[bot]');
  if (!approval || approval.user.type !== 'Bot' || approval.state !== 'APPROVED' || approval.commit_id !== assessment.head_sha ||
      [...latest.values()].some(review => review.user?.type === 'User' && review.state === 'CHANGES_REQUESTED')) {
    throw new Error('Private automatic merge requires a fresh current-head bot approval and no outstanding change requests');
  }
  const {data: comparison} = await github.rest.repos.compareCommits({...repo, base: assessment.base_sha, head: assessment.head_sha});
  if (comparison.status !== 'ahead' || comparison.merge_base_commit?.sha !== assessment.base_sha) {
    throw new Error('Private owner merge requires the exact accepted base to be an ancestor of the reviewed head');
  }
  await verify();
  const {data: current} = await github.rest.pulls.get({...repo, pull_number: pr.number});
  const {data: branch} = await github.rest.repos.getBranch({...repo, branch: baseBranch});
  const headUnchanged = current.state === 'open' && !current.draft && current.head.sha === assessment.head_sha &&
    current.base.ref === baseBranch && !current.auto_merge && branch.protected === false;
  if (headUnchanged && (current.base.sha !== assessment.base_sha || branch.commit.sha !== assessment.base_sha)) {
    throw await branchUpdate.surface({github, repo, pr: current, assessment, baseBranch});
  }
  if (!exact(current) || current.auto_merge || branch.commit.sha !== assessment.base_sha || branch.protected !== false) {
    throw new Error('Private owner merge head, base or protection changed before the atomic write');
  }
  await github.graphql(`mutation($input:UpdateRefsInput!) { updateRefs(input:$input) { clientMutationId } }`, {input: {
    repositoryId: settings.node_id,
    refUpdates: [
      {name: `refs/heads/${baseBranch}`, beforeOid: assessment.base_sha, afterOid: assessment.head_sha, force: false},
      {name: `refs/heads/${pr.head.ref}`, beforeOid: assessment.head_sha, afterOid: assessment.head_sha, force: false},
    ],
  }});
  const {data: merged} = await github.rest.pulls.get({...repo, pull_number: pr.number});
  const {data: mergedBase} = await github.rest.repos.getBranch({...repo, branch: baseBranch});
  if (!merged.merged || merged.head?.sha !== assessment.head_sha || merged.merge_commit_sha !== assessment.head_sha || mergedBase.commit.sha !== assessment.head_sha) {
    throw new Error('Atomic owner merge submitted but exact merged PR audit is not yet observable; inspect before retrying');
  }
  return merged;
}

module.exports = {finalizePrivateOwner};
