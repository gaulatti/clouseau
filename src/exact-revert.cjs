'use strict';

// Opt-in acceptance of an exact revert without a fresh AI review. See docs/exact-revert.md.
//
// A pull request is accepted here only when the tree it would leave on the base branch is byte-identical (the same git tree
// object id) to the tree of an earlier commit on the FIRST-PARENT history of the exact base commit the PR is based on,
// within a window set in protected configuration. Every input is read by the engine from the base repository through the
// GitHub API for immutable commit ids: the head tree id, the ancestry of the head, and the history of the base. Nothing is
// taken from the PR title, body, comments or commit messages. Unset, nothing here is called and behaviour is unchanged.

const {digest} = require('./acceptance.cjs');

const MAX_WINDOW = 200;
const PAGE = 100;
const MARKER = '<!-- clouseau-exact-revert:v1 -->';
const object = value => /^[a-f0-9]{40}$/.test(value) || /^[a-f0-9]{64}$/.test(value);

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'window' ||
      !Number.isInteger(value.window) || value.window < 2 || value.window > MAX_WINDOW) {
    throw new Error(`Invalid exact_revert configuration; use {"window": a whole number of base commits from 2 to ${MAX_WINDOW}}`);
  }
  return value;
}

// The first-parent chain of the base, newest first, from the commits listed for the base commit. A parent that was not
// listed ends the chain: it lies outside the window.
function chain(commits, tip) {
  const bySha = new Map(commits.map(commit => [commit.sha, commit]));
  const links = [];
  for (let commit = bySha.get(tip); commit; commit = bySha.get(commit.parents[0]?.sha)) links.push(commit);
  return links;
}

// A tree is rolled back when a later commit restored the tree that preceded it. Restoring it again would reinstate a state
// the history itself undid, so it needs a real review. A commit whose predecessor lies outside the window cannot be judged
// and is not eligible; a root commit has no predecessor to restore.
function eligible(links) {
  const trees = links.map(commit => commit.commit.tree.sha);
  const rolledBack = new Set();
  const unjudged = new Set();
  links.forEach((commit, index) => {
    if (index === 0 || commit.parents.length === 0) return;
    const before = links[index + 1];
    if (!before) unjudged.add(trees[index]);
    else if (trees.slice(0, index).includes(trees[index + 1])) rolledBack.add(trees[index]);
  });
  return {trees, rolledBack, unjudged};
}

// Decide one pull request. `reason` is a stable sentence for the notice; it never quotes repository content.
async function verify({github, repo, pr, window}) {
  const {data: head} = await github.rest.repos.getCommit({...repo, ref: pr.head.sha});
  if (head.sha !== pr.head.sha || !object(head.commit.tree.sha)) return {matched: false, reason: 'the head commit tree is unavailable'};
  const {data: compared} = await github.rest.repos.compareCommitsWithBasehead({...repo, basehead: `${pr.base.sha}...${pr.head.sha}`});
  if (compared.status !== 'ahead' || compared.merge_base_commit.sha !== pr.base.sha) {
    return {matched: false, reason: 'the pull request is not based on the current base commit; update the branch'};
  }
  const commits = [];
  for (let page = 1; commits.length < window; page++) {
    const {data} = await github.rest.repos.listCommits({...repo, sha: pr.base.sha, per_page: PAGE, page});
    commits.push(...data);
    if (data.length < PAGE) break;
  }
  const links = chain(commits.slice(0, window), pr.base.sha);
  if (links.length === 0 || !links.every(commit => object(commit.commit.tree.sha))) return {matched: false, reason: 'the base history is unavailable'};
  const {trees, rolledBack, unjudged} = eligible(links);
  const tree = head.commit.tree.sha;
  if (tree === trees[0]) return {matched: false, reason: 'the pull request changes nothing'};
  const index = trees.indexOf(tree);
  if (index === -1) return {matched: false, reason: 'the resulting tree is not a tree of the base history within the window'};
  if (rolledBack.has(tree)) return {matched: false, reason: 'the resulting tree was rolled back by a later base commit'};
  if (unjudged.has(tree)) return {matched: false, reason: 'the base history within the window cannot show that the tree was never rolled back'};
  return {matched: true, tree, matched_commit: links[index].sha, distance: index, window,
    head_sha: pr.head.sha, base_sha: pr.base.sha};
}

const text = verdict => `Exact revert accepted without an AI review: the resulting tree ${verdict.tree.slice(0, 12)} is byte-identical to the tree of ` +
  `base commit ${verdict.matched_commit.slice(0, 12)}, ${verdict.distance} commit(s) back on the first-parent history. CI AI calls: 0.`;

// Hosted assessment. Returns a complete assessment and writes the record, or null so the ordinary review continues. A
// change to protected review controls is accepted only with the exact-head owner confirmation, as everywhere else.
async function assess({github, repo, pr, files, comments, technical, legacy, config, engine, identity, recordPath, report}) {
  const note = line => {if (report) report(line);};
  const managed = await legacy.managedExemptions(github, repo, pr, files);
  const controls = legacy.scopeReason(files, pr, managed.exempt);
  if (controls && controls !== legacy.REVIEW_CONTROL_REASON) {
    note(`Exact revert not applied: ${controls}.`);
    return null;
  }
  const authorization = controls ? await legacy.purposeConfirmation(github, repo, pr, comments) : null;
  if (controls && !authorization) {
    note('Exact revert not applied: protected review controls changed and the exact-head owner confirmation is missing.');
    return null;
  }
  const verdict = await verify({github, repo, pr, window: config.exact_revert.window});
  if (!verdict.matched) {
    note(`Exact revert not applied: ${verdict.reason}.`);
    return null;
  }
  const record = {version: 2, ...(engine ? {engine} : {}), exact_revert: verdict, snapshot: {repository: `${repo.owner}/${repo.repo}`},
    controls: Boolean(controls), technical, ...(authorization ? {local_authorization: authorization} : {})};
  require('node:fs').writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  note(text(verdict));
  return {...identity, decision: authorization ? 'owner_decision' : 'auto_approve', record_digest: digest(record),
    review_source: 'exact_revert', provider_api_calls: 0,
    reason: `Exact revert: the tree is byte-identical to previously accepted base commit ${verdict.matched_commit}; no AI rerun.`};
}

// Everything the gate and the atomic write boundary re-derive from the trusted side, never from the stored verdict alone.
async function verifyRecord({github, repo, record, assessment, config, engine, numberFor, context, legacy}) {
  const expected = record.local_authorization ? 'owner_decision' : 'auto_approve';
  if (!config.exact_revert || assessment.version !== 2 || assessment.review_source !== 'exact_revert' ||
      digest(record) !== assessment.record_digest || assessment.record_reference_digest !== undefined ||
      assessment.decision !== expected || record.exact_revert.head_sha !== assessment.head_sha ||
      record.exact_revert.base_sha !== assessment.base_sha || record.exact_revert.window !== config.exact_revert.window ||
      record.snapshot.repository !== `${repo.owner}/${repo.repo}` ||
      (engine && (digest(record.engine) !== digest(engine) || digest(assessment.engine) !== digest(engine)))) {
    throw new Error('Stale or altered exact-revert record');
  }
  const {data: pr} = await require('./pull-read.cjs').readPull(github, repo, numberFor(context));
  const branchUpdate = require('./branch-update.cjs');
  if (branchUpdate.baseOnlyMoved(pr, assessment, config.base_branch)) {
    throw await branchUpdate.surface({github, repo, pr, assessment, baseBranch: config.base_branch});
  }
  if (pr.head.sha !== assessment.head_sha || pr.base.sha !== assessment.base_sha) throw new Error('PR changed after exact-revert investigation');
  const fresh = await verify({github, repo, pr, window: config.exact_revert.window});
  if (digest(fresh) !== digest(record.exact_revert)) throw new Error('Exact-revert evidence changed after investigation');
  const technical = await legacy.technicalRun(github, repo, pr, {receipt: true});
  if (digest(technical) !== digest(record.technical)) throw new Error('Verification changed after exact-revert investigation');
  const comments = await github.paginate(github.rest.issues.listComments, {...repo, issue_number: pr.number, per_page: 100});
  if (record.local_authorization && digest(record.local_authorization) !== digest(await legacy.purposeConfirmation(github, repo, pr, comments))) {
    throw new Error('Exact-revert owner authorization changed; confirm this exact revision again');
  }
  return {pr, comments, verdict: fresh};
}

async function gate({github, context, core, assessment, record, config, engine, legacy, numberFor, options}) {
  const repo = context.repo;
  const check = () => verifyRecord({github, repo, record, assessment, config, engine, numberFor, context, legacy});
  const {pr, comments, verdict} = await check();
  await require('./incomplete.cjs').resolvePending({github, context, number: assessment.number});
  const body = `${MARKER}\n## Clouseau exact revert\n\n${text(verdict)} The protected-control and verification rules were applied unchanged.`;
  const existing = comments.find(item => item.user?.login === 'github-actions[bot]' && item.body.startsWith(`${MARKER}\n`));
  if (existing) await github.rest.issues.updateComment({...repo, comment_id: existing.id, body});
  else await github.rest.issues.createComment({...repo, issue_number: pr.number, body});
  await core.summary.addRaw(body).write();
  return legacy.gate({github, context, core, ...options, verifyAcceptance: async () => {await check();},
    assessment: {...assessment, decision: assessment.decision === 'owner_decision' ? 'second_opinion' : 'auto_approve'}});
}

module.exports = {MAX_WINDOW, MARKER, validate, chain, eligible, verify, assess, verifyRecord, gate};
