'use strict';

// `clouseau refresh --pr N`: bring one open pull request of this repository up to its moved base and give it fresh review
// evidence, with one push (docs/local-review.md, "Refreshing a pull request after its base moved").
//
// The steps are the author's manual routine, in this order and no other: fetch the base, merge it (never a rebase), review
// the new head locally, publish the receipt, put its marker in the pull request body, push the branch once, last. The
// review reuses the answers of an earlier accepted review for every call whose evidence is byte-identical (review-reuse.cjs);
// everything else is asked again. Nothing here decides or signs anything: the review, receipt and publication are the
// ordinary ones, passed in as `review` and `publish`.
//
// Every refusal happens before anything is pushed, and several before anything is changed at all: a dirty worktree, a head
// that is not the pull request head, a pull request of another repository or branch, a missing harness and a merge conflict
// leave the checkout exactly as it was. A review that does not pass, or a passing one without a signed receipt, leaves the
// merge commit in the local branch and pushes nothing.
//
// When the base has not moved the answer is `up_to_date` only if the receipt in the pull request body still verifies for the
// head, judged as CI judges it (receipt-standing.cjs). A receipt that no longer does (expired, another base, an engine that does
// not accept it, a forged or missing marker) is renewed: no merge, the same review, publication and marker, and no push of the
// branch, whose head is unchanged.

const path = require('node:path');
const cp = require('node:child_process');
const {git, githubRepository, readLocalConfig, assertUnchanged} = require('./local-git.cjs');
const {AGENTS} = require('./local-agent.cjs');
const {assertHarness} = require('./local-harness.cjs');
const {readRequirement} = require('./review-requirement.cjs');

const MARKER = /<!-- clouseau-local-review:v1 [a-f0-9]{40} -->/;

const first = error => String(error.stderr).trim().split('\n')[0];

function ancestor(directory, candidate, descendant) {
  try {
    git(directory, ['merge-base', '--is-ancestor', candidate, descendant]);
    return true;
  } catch {
    return false;
  }
}

// The pull request body with exactly one marker, the new one: where the old marker was, else at the end.
function withMarker(body, marker) {
  if (!MARKER.test(body)) return `${body.replace(/\s+$/, '')}${body.trim() ? '\n\n' : ''}${marker}\n`;
  const global = new RegExp(MARKER.source, 'g');
  let seen = false;
  return body.replace(global, () => {
    if (seen) return '';
    seen = true;
    return marker;
  });
}

// Whether HEAD is the merge commit an interrupted refresh made: the pull request head and a commit of the base.
function resumable({directory, head, pullHead, remoteBase}) {
  const parents = git(directory, ['rev-list', '--parents', '-n', '1', head]).trim().split(' ');
  return parents.length === 3 && parents[1] === pullHead && ancestor(directory, parents[2], remoteBase);
}

// Whether the protected configuration of the fetched base binds receipts to their diff (receipt-patch.cjs).
function bindsDiff(directory, remoteBase) {
  try {
    return JSON.parse(git(directory, ['show', `${remoteBase}:.github/clouseau.json`])).local_review?.binding === 'diff';
  } catch {
    return false;
  }
}

// The base moved only in files the pull request does not change: merging it then leaves every changed file's patch, and so
// the diff a `binding: "diff"` receipt covers, exactly as it was. Renames count by both paths.
function baseLeavesDiff(directory, remoteBase) {
  const base = git(directory, ['merge-base', 'HEAD', remoteBase]).trim();
  const names = range => new Set(git(directory, ['diff', '--name-only', '--no-renames', range]).split('\n').filter(Boolean));
  const theirs = names(`${base}..${remoteBase}`);
  return [...names(`${base}..HEAD`)].every(name => !theirs.has(name));
}

function merge({directory, remoteBase, branch}) {
  try {
    git(directory, ['merge-tree', '--write-tree', '--name-only', 'HEAD', remoteBase]);
  } catch (error) {
    // After a conflict git prints the tree id, one conflicted path per line, a blank line, then its messages.
    const conflicted = String(error.stdout).split('\n').slice(1).join('\n').split('\n\n')[0].split('\n').filter(Boolean);
    const cause = conflicted.length ? `conflicts in ${conflicted.join(', ')}` : first(error);
    throw new Error(`${remoteBase} cannot be merged cleanly (${cause}). Nothing was changed; merge the base yourself, resolve it and review again.`);
  }
  try {
    git(directory, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${remoteBase} into ${branch}`, remoteBase]);
  } catch (error) {
    // The merge cannot conflict (checked above); this is a hook or an environment refusing it. Leave no half-made merge.
    cp.spawnSync('git', ['-C', directory, 'merge', '--abort'], {stdio: 'ignore'});
    throw new Error(`Merging ${remoteBase} failed (${first(error)}); the branch is unchanged and nothing was pushed`);
  }
}

async function refreshPull(args, {review, publish, standing, installed, state, execute = cp.execFileSync, available = name => cp.spawnSync(name, ['--version'], {stdio: 'ignore'}).status === 0}) {
  if (!/^[1-9][0-9]{0,8}$/.test(args.pr || '')) throw new Error('--pr takes a pull request number');
  if (Boolean(args.agent) === Boolean(args.harness)) throw new Error('Choose exactly one of --agent (inside an AI harness) or --harness (headless)');
  if (args.agent && !AGENTS.includes(args.agent)) throw new Error(`Supported agent harnesses: ${AGENTS.join(', ')}`);
  if (args.harness) {
    assertHarness(args.harness);
    if (!available(args.harness)) throw new Error(`The ${args.harness} harness is not installed or not on PATH; nothing was changed`);
  }
  const number = Number(args.pr);
  const directory = path.resolve(args.directory || process.cwd());
  const repo = githubRepository(directory);
  const slug = `${repo.owner}/${repo.repo}`;
  if (git(directory, ['status', '--porcelain']).trim()) {
    throw new Error('Refusing to refresh a worktree with uncommitted or untracked changes; commit or stash them first');
  }
  const branch = git(directory, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const readPull = () => JSON.parse(execute('gh', ['api', `repos/${slug}/pulls/${number}`, '--jq',
    '{number: .number, author: .user.login, state: .state, base: .base.ref, base_sha: .base.sha, head: .head.sha, ref: .head.ref, repository: .head.repo.full_name, title: .title, body: (.body // ""), changed_files: .changed_files}'], {encoding: 'utf8'}));
  const pull = readPull();
  if (pull.state !== 'open') throw new Error(`Pull request ${number} is not open`);
  if (pull.repository !== slug) throw new Error(`Pull request ${number} comes from ${pull.repository}; refresh pushes only to a branch of ${slug}`);
  if (branch !== pull.ref) throw new Error(`The checked-out branch ${branch} is not the pull request branch ${pull.ref}`);
  if (typeof pull.title !== 'string' || !pull.title.trim()) throw new Error(`Pull request ${number} has no title`);
  const config = readLocalConfig(JSON.parse(git(directory, ['show', 'HEAD:.clouseau-local.json'])));
  if (pull.base !== config.base_branch) throw new Error(`Pull request ${number} is against ${pull.base}, not the configured base ${config.base_branch}`);
  const remoteBase = `origin/${pull.base}`;
  const head = git(directory, ['rev-parse', 'HEAD']).trim();
  const resuming = head !== pull.head;
  if (resuming && !resumable({directory, head, pullHead: pull.head, remoteBase})) {
    // Local commits on top of the pull request head are the usual cause: name it and the step, instead of a bare mismatch.
    if (ancestor(directory, pull.head, head)) {
      const count = Number(git(directory, ['rev-list', '--count', `${pull.head}..${head}`]).trim());
      throw new Error(`Local HEAD ${head} is not the head of pull request ${number} (${pull.head}): the local branch has ${count} unpushed commit${count === 1 ? '' : 's'} ` +
        `that the pull request does not have. Refresh reviews only the head GitHub shows, so push first (git push origin HEAD:refs/heads/${pull.ref}), then refresh again; nothing was changed or pushed`);
    }
    throw new Error(`Local HEAD ${head} is not the head of pull request ${number} (${pull.head}), and the pull request head is not an ancestor of it; check out exactly that commit and refresh again`);
  }
  // A refresh interrupted after its merge (an agent-driven review awaiting an answer) continues on the base it began with.
  let renewal = null;
  if (!resuming) {
    git(directory, ['fetch', 'origin', `+refs/heads/${pull.base}:refs/remotes/${remoteBase}`]);
    if (ancestor(directory, remoteBase, 'HEAD')) {
      const judged = await standing({directory, base: remoteBase, repo, pull, execute, installed});
      if (!judged.applicable || judged.usable) {
        return {status: 'up_to_date', pull_request: number, head_sha: head, base_sha: git(directory, ['rev-parse', remoteBase]).trim(), pushed: false,
          note: `Pull request ${number} already contains ${remoteBase}${judged.applicable ? ' and its local review receipt still verifies' : ''}; nothing to refresh`};
      }
      renewal = judged;
      process.stderr.write(`Renewing the local review receipt of pull request ${number} (cause: ${renewal.cause}): ${renewal.sentence}\n`);
    } else if (bindsDiff(directory, remoteBase) && baseLeavesDiff(directory, remoteBase)) {
      // Under the protected `binding: "diff"` a receipt whose diff still equals the pull request's stands after a base move, as
      // CI judges it. When the base moved only outside the changed files, the merge provably keeps that diff, so the branch is
      // brought up to date (a controller-managed merge needs it strictly ahead of the base) with no review and no new receipt.
      const judged = await standing({directory, base: remoteBase, repo, pull, execute, installed});
      if (judged.usable) {
        merge({directory, remoteBase, branch});
        // A plain push, never forced: a pull request that moved meanwhile rejects it and nothing on GitHub changes.
        git(directory, ['push', 'origin', `HEAD:refs/heads/${pull.ref}`]);
        return {status: 'updated', pull_request: number, previous_head_sha: head, head_sha: git(directory, ['rev-parse', 'HEAD']).trim(),
          base_sha: git(directory, ['rev-parse', remoteBase]).trim(), pushed: true,
          note: `Merged ${remoteBase} into pull request ${number} and pushed it. Its local review receipt still covers the unchanged diff (protected binding: diff); nothing was reviewed or published`};
      }
    }
  }
  // Without a file, the requirement is the one of the last accepted review of this branch, if its head provably belongs to this
  // pull request alone: in the pull request's history and not in the base. (A branch name reused after an earlier pull request
  // merged has that pull request's head in the base too.) Nothing has been changed yet when this refuses.
  const requestFile = args['request-file'] || readRequirement({state, repository: slug, branch,
    contains: sha => ancestor(directory, sha, pull.head) && !ancestor(directory, sha, remoteBase)}).file;
  if (!resuming && !renewal) merge({directory, remoteBase, branch});
  const result = await review({directory, base: remoteBase, 'request-file': requestFile, harness: args.harness, agent: args.agent,
    identity: args.identity, 'additional-checks': args['additional-checks'], engine: args.engine}, {title: pull.title});
  // A review continued on a pinned engine runs this very command there, publishes and pushes; its result is the final one.
  if (result.status === 'refreshed') return result;
  const context = {pull_request: number, previous_head_sha: pull.head, pushed: false};
  if (result.status === 'awaiting_agent') {
    return {...result, ...context, then: 'Repeat the identical refresh command. It continues where it stopped (on the merge commit already made, if any) and on this pinned engine revision.'};
  }
  if (result.status) return {...result, ...context};
  if (result.decision !== 'auto_approve') return {...result, ...context, note: `The review did not pass; nothing was pushed.${renewal ? '' : ' The merge commit remains in the local branch.'}`};
  if (!result.receipt) {
    throw new Error('The review passed but produced no signed receipt (no enrolled signing identity was selected); nothing was pushed. Enroll or pass --identity and refresh again');
  }
  assertUnchanged(directory, {head_sha: result.head_sha});
  const published = await publish({directory, receipt: result.receipt});
  const live = readPull();
  if (live.state !== 'open' || live.head !== pull.head) {
    throw new Error(`Pull request ${number} changed during the refresh (head ${live.head}, expected ${pull.head}); nothing was pushed`);
  }
  const body = withMarker(live.body, published.marker);
  const patch = text => execute('gh', ['api', '-X', 'PATCH', `repos/${slug}/pulls/${number}`, '--input', '-'], {encoding: 'utf8', input: JSON.stringify({body: text})});
  // The marker goes into the body before the push, as the pull request is read on the push; the push is the last step.
  patch(body);
  const fields = {marker: published.marker, artifact_commit: published.artifact_commit, ...(published.warnings ? {warnings: published.warnings} : {})};
  if (renewal) return {...result, ...context, status: 'renewed', ...fields, cause: renewal.cause, reason: renewal.sentence};
  try {
    git(directory, ['push', 'origin', `HEAD:refs/heads/${pull.ref}`]);
  } catch (error) {
    patch(live.body);
    throw new Error(`The push failed (${first(error)}); the pull request body was restored and the branch on GitHub is unchanged`);
  }
  return {...result, ...context, status: 'refreshed', pushed: true, ...fields};
}

module.exports = {refreshPull, withMarker, merge, resumable, bindsDiff, baseLeavesDiff};
