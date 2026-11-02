'use strict';

async function assertMergeProtection({github, repo, baseBranch, manual, privateOwnerAutomatic = false, assertProtection}) {
  const {data: settings} = await github.rest.repos.get(repo);
  const {data: branch} = await github.rest.repos.getBranch({...repo, branch: baseBranch});
  if (manual) {
    if (settings.allow_auto_merge !== false) throw new Error('Manual merge mode requires repository auto-merge to be disabled');
    try {
      await assertProtection();
    } catch (error) {
      if (!(settings.private === true && branch.protected === false && error.status === 403 &&
          /Upgrade to GitHub Pro or make this repository public/i.test(error.message))) throw error;
      return {enforced: false, reason: 'GitHub cannot enforce protection on this private plan. Tests and review passed independently; every merge remains manual.'};
    }
    if (branch.protected !== true) throw new Error('Available branch protection must be enabled before manual-mode approval');
    return {enforced: true};
  }
  if (privateOwnerAutomatic && settings.private === true && branch.protected === false && settings.allow_auto_merge === false) {
    try { await assertProtection(); } catch (error) {
      if (!(error.status === 403 && /Upgrade to GitHub Pro or make this repository public/i.test(error.message))) throw error;
      return {enforced: false, controllerManaged: true, reason: 'Private-plan branch protection is unavailable; explicit code-owner work alone may use the controller-enforced atomic acceptance path.'};
    }
    throw new Error('Available branch protection must be enabled before automatic approval');
  }
  // Repository settings are never a hard failure in automatic mode: review,
  // acceptance record and approval complete, and only the merge is withheld.
  // Without protection the bot approval cannot make an unsafe merge more
  // possible than it already is, so it is harmless; merging or arming
  // auto-merge on insufficient protection is what stays forbidden.
  const gaps = [];
  if (!settings.allow_auto_merge) gaps.push('auto-merge disabled');
  if (!branch.protected) gaps.push('main not protected');
  if (gaps.length === 0) {
    try { await assertProtection(); } catch (error) {
      if (!Array.isArray(error.gaps)) throw error;
      gaps.push(...error.gaps);
    }
  }
  return gaps.length === 0 ? {enforced: true} : {enforced: false, insufficient: true, gaps};
}

const NOTICE_MARKER = '<!-- clouseau-protection-notice -->';

// What each bounded gap means and the one change that closes it. The gap classes come from this module and policy.cjs only.
const GAP_STEPS = Object.freeze({
  'auto-merge disabled': 'Enable auto-merge: `gh repo edit {repo} --enable-auto-merge`.',
  'main not protected': 'Protect the base branch with a ruleset or branch protection (Settings, Rules); `gh api repos/{repo}/rulesets` lists existing rulesets.',
  'required checks missing': 'Add the Clouseau verification and policy jobs as required status checks of the base branch ruleset.',
  'up-to-date missing': 'Turn on "Require branches to be up to date before merging" in the base branch ruleset.',
  'approval freshness missing': 'In the ruleset require one approving review, dismiss stale approvals on push, and require approval of the most recent push.',
  'force-push+deletion protection missing': 'Add the "Restrict deletions" and "Block force pushes" rules to the base branch ruleset.',
});

// Fixed text only: the bounded gap classes are the sole variable content, and an unknown one gets the generic step.
function protectionBody(gaps, repo) {
  const slug = `${repo.owner}/${repo.repo}`;
  const steps = gaps.map(gap => `${Object.hasOwn(GAP_STEPS, gap) ? GAP_STEPS[gap] : 'Make the base branch protection satisfy the Clouseau requirements.'} (${gap})`)
    .map(step => step.replaceAll('{repo}', slug));
  return `${NOTICE_MARKER}\nClouseau recorded its decision and approval, but did not arm or perform the merge.\n\n` +
    `**Cause:** \`merge_protection_insufficient\`: repository settings are insufficient: ${gaps.join(', ')}.\n\n` +
    `**Next steps:**\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n${steps.length + 1}. ` +
    'Re-run the failed Clouseau job, or push a new revision, so the merge is armed. Until then a maintainer merges manually.';
}

async function postProtectionNotice({github, repo, pull_number, gaps}) {
  const body = protectionBody(gaps, repo);
  const comments = await github.paginate(github.rest.issues.listComments, {...repo, issue_number: pull_number, per_page: 100});
  const existing = comments.find(comment => comment.user.type === 'Bot' && comment.body.startsWith(NOTICE_MARKER));
  if (!existing) await github.rest.issues.createComment({...repo, issue_number: pull_number, body});
  else if (existing.body !== body) await github.rest.issues.updateComment({...repo, comment_id: existing.id, body});
  return body;
}

module.exports = {assertMergeProtection, postProtectionNotice, protectionBody, GAP_STEPS};
