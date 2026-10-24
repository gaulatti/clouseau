'use strict';

async function assertMergeProtection({github, repo, baseBranch, manual, assertProtection}) {
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
  if (!settings.allow_auto_merge || !branch.protected) throw new Error('Repository auto-merge and main protection must be enabled');
  await assertProtection();
  return {enforced: true};
}

module.exports = {assertMergeProtection};
