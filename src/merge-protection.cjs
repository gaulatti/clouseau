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

// Fixed text only: the bounded gap classes are the sole variable content.
async function postProtectionNotice({github, repo, pull_number, gaps}) {
  const body = `${NOTICE_MARKER}\nClouseau recorded its decision and approval, but did not arm or perform the merge ` +
    `because repository settings are insufficient: ${gaps.join(', ')}. Enable them to allow automatic merge; until then a maintainer merges manually.`;
  const comments = await github.paginate(github.rest.issues.listComments, {...repo, issue_number: pull_number, per_page: 100});
  const existing = comments.find(comment => comment.user.type === 'Bot' && comment.body.startsWith(NOTICE_MARKER));
  if (!existing) await github.rest.issues.createComment({...repo, issue_number: pull_number, body});
  else if (existing.body !== body) await github.rest.issues.updateComment({...repo, comment_id: existing.id, body});
  return body;
}

module.exports = {assertMergeProtection, postProtectionNotice};
