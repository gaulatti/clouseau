'use strict';

const LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
const user = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/;

function pattern(value) {
  if (!value || /[!\[\]\\\0]/.test(value) || value.includes('***')) throw new Error('Unsupported CODEOWNERS pattern; manual ownership verification required');
  const rooted = value.startsWith('/');
  const directory = value.endsWith('/');
  const input = value.replace(/^\//, '').replace(/\/$/, '');
  // https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners
  // GitHub documents docs/* as non-recursive. Other terminal prefix globs
  // may refer to directories; do not fall through to a broader owner rule.
  if (!directory && /[*?]$/.test(input) && !['*', '**'].includes(input.split('/').at(-1))) throw new Error('Ambiguous CODEOWNERS prefix glob; manual ownership verification required');
  let expression = '';
  for (let i = 0; i < input.length; i++) {
    if (input.slice(i, i + 3) === '**/') { expression += '(?:.*/)?'; i += 2; }
    else if (input.slice(i, i + 2) === '**') { expression += '.*'; i++; }
    else if (input[i] === '*') expression += '[^/]*';
    else if (input[i] === '?') expression += '[^/]';
    else expression += input[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp((rooted || input.includes('/') ? '^' : '(?:^|/)') + expression +
    (directory ? '/.*$' : /[*?]$/.test(input) ? '$' : '(?:/.*)?$'));
}

function parse(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) >= 3000000) throw new Error('CODEOWNERS is missing or oversized');
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [glob, ...owners] = line.split(/\s+/);
    if (owners.some(owner => !/^@[a-zA-Z0-9][a-zA-Z0-9-]{0,38}(?:\/[a-zA-Z0-9_-]+)?$/.test(owner))) {
      throw new Error('Unverifiable CODEOWNERS identity; use GitHub usernames or teams');
    }
    entries.push({pattern: pattern(glob), owners});
  }
  return entries;
}

async function owns(github, repo, login, owners) {
  if (!user.test(login || '')) return false;
  const {data} = await github.rest.repos.getCollaboratorPermissionLevel({...repo, username: login});
  if (!['admin', 'maintain', 'write'].includes(data.permission)) return false;
  for (const owner of owners) {
    if (owner.toLowerCase() === `@${login}`.toLowerCase()) return true;
    const team = /^@([^/]+)\/(.+)$/.exec(owner);
    if (team && team[1].toLowerCase() === repo.owner.toLowerCase()) {
      const args = {org: team[1], team_slug: team[2], owner: repo.owner, repo: repo.repo};
      const {data: permission} = await github.rest.teams.checkPermissionsForRepoInOrg(args);
      if (permission.permissions?.push !== true) continue;
      const {data: membership} = await github.rest.teams.getMembershipForUserInOrg({org: team[1], team_slug: team[2], username: login});
      if (membership.state === 'active') return true;
    }
  }
  return false;
}

async function authority({github, repo, pr, files}) {
  try {
    let content;
    let location;
    for (const path of LOCATIONS) {
      try {
        const {data} = await github.rest.repos.getContent({...repo, path, ref: pr.base.sha});
        if (data.encoding !== 'base64' || typeof data.content !== 'string' || data.size >= 3000000) throw new Error('Incomplete CODEOWNERS source');
        content = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(data.content, 'base64'));
        location = path; break;
      } catch (error) { if (error.status !== 404) throw error; }
    }
    if (content === undefined) return {automatic: true, configured: false, groups: [], base_sha: pr.base.sha,
      reason: 'No CODEOWNERS exists on the protected base; the optional code-owner gate is inactive.'};
    if (!files.length || files.length !== pr.changed_files) throw new Error('Incomplete ownership path inventory');
    const entries = parse(content);
    const paths = [...new Set(files.flatMap(file => file.previous_filename ? [file.previous_filename, file.filename] : [file.filename]))];
    const groups = paths.map(path => ({path, owners: entries.filter(entry => entry.pattern.test(path)).at(-1)?.owners || []}));
    const owner = pr.user?.type === 'User' && groups.every(group => group.owners.length);
    let automatic = Boolean(owner);
    if (automatic) for (const group of groups) if (!await owns(github, repo, pr.user.login, group.owners)) {automatic = false; break;}
    return {automatic, groups, location, base_sha: pr.base.sha,
      reason: automatic ? 'The PR author owns every affected path on the protected base.' : 'A code owner must approve this exact revision and merge manually; automatic merge is disabled.'};
  } catch (error) { return {automatic: false, groups: [], reason: `Automatic merge denied: ${error.message}`}; }
}

async function approved({github, repo, pr, ownership}) {
  if (!ownership.groups.length || ownership.groups.some(group => !group.owners.length)) return false;
  const reviews = await github.paginate(github.rest.pulls.listReviews, {...repo, pull_number: pr.number, per_page: 100});
  const latest = new Map();
  for (const review of reviews) if (review.user?.type === 'User' && review.user.login !== pr.user.login && review.state !== 'COMMENTED') latest.set(review.user.login, review);
  const accepted = [...latest.values()].filter(review => review.state === 'APPROVED' && review.commit_id === pr.head.sha);
  for (const group of ownership.groups) {
    let covered = false;
    for (const review of accepted) {
      try { if (await owns(github, repo, review.user.login, group.owners)) {covered = true; break;} } catch { /* Unverifiable membership grants no authority. */ }
    }
    if (!covered) return false;
  }
  return true;
}

module.exports = {pattern, parse, owns, authority, approved};
