'use strict';

// This selector runs from protected main before any candidate code is loaded.
async function reviewerRef({github, context}) {
  const {owner, repo} = context.repo;
  const {data: pr} = await github.rest.pulls.get({...context.repo, pull_number: context.payload.pull_request.number});
  if (pr.state !== 'open' || pr.draft || pr.base.ref !== 'main' || pr.user.login !== owner ||
      pr.user.type !== 'User' || pr.head.repo?.full_name !== `${owner}/${repo}`) return 'main';
  const comments = await github.paginate(github.rest.issues.listComments,
    {...context.repo, issue_number: pr.number, per_page: 100});
  if (!comments.some(comment => comment.user?.login === owner && comment.user.type === 'User' &&
      comment.body.trim() === `/approve-intent ${pr.head.sha}`)) return 'main';
  let anchor;
  try {
    const {data: ref} = await github.rest.git.getRef({...context.repo, ref: `heads/policy-install/pr-${pr.number}`});
    anchor = ref.object.sha;
  } catch (error) {
    if (error.status === 404) return 'main';
    throw error;
  }
  if (!/^[a-f0-9]{40}$/.test(anchor) || !/^[a-f0-9]{40}$/.test(pr.head.sha)) throw new Error('Installation requires immutable revisions');
  const {data: comparison} = await github.rest.repos.compareCommits({...context.repo, base: anchor, head: pr.head.sha});
  if (!['identical', 'ahead'].includes(comparison.status)) throw new Error('Installation head must contain the prepared owner revision');
  return pr.head.sha;
}

module.exports = {reviewerRef};
