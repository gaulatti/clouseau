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

const path = require('node:path');
const cp = require('node:child_process');
const {git, githubRepository, readLocalConfig, assertUnchanged} = require('./local-git.cjs');
const {AGENTS} = require('./local-agent.cjs');
const {assertHarness} = require('./local-harness.cjs');

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

async function refreshPull(args, {review, publish, execute = cp.execFileSync, available = name => cp.spawnSync(name, ['--version'], {stdio: 'ignore'}).status === 0}) {
  if (!/^[1-9][0-9]{0,8}$/.test(args.pr || '')) throw new Error('--pr takes a pull request number');
  if (!args['request-file']) throw new Error('An explicit requirement file is required: pass the file the earlier review used, because reuse needs byte-identical input');
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
    '{state: .state, base: .base.ref, head: .head.sha, ref: .head.ref, repository: .head.repo.full_name, body: (.body // "")}'], {encoding: 'utf8'}));
  const pull = readPull();
  if (pull.state !== 'open') throw new Error(`Pull request ${number} is not open`);
  if (pull.repository !== slug) throw new Error(`Pull request ${number} comes from ${pull.repository}; refresh pushes only to a branch of ${slug}`);
  if (branch !== pull.ref) throw new Error(`The checked-out branch ${branch} is not the pull request branch ${pull.ref}`);
  const config = readLocalConfig(JSON.parse(git(directory, ['show', 'HEAD:.clouseau-local.json'])));
  if (pull.base !== config.base_branch) throw new Error(`Pull request ${number} is against ${pull.base}, not the configured base ${config.base_branch}`);
  const remoteBase = `origin/${pull.base}`;
  const head = git(directory, ['rev-parse', 'HEAD']).trim();
  const resuming = head !== pull.head;
  if (resuming && !resumable({directory, head, pullHead: pull.head, remoteBase})) {
    throw new Error(`Local HEAD ${head} is not the head of pull request ${number} (${pull.head}); check out exactly that commit and refresh again`);
  }
  // A refresh interrupted after its merge (an agent-driven review awaiting an answer) continues on the base it began with.
  if (!resuming) {
    git(directory, ['fetch', 'origin', `+refs/heads/${pull.base}:refs/remotes/${remoteBase}`]);
    if (ancestor(directory, remoteBase, 'HEAD')) {
      return {status: 'up_to_date', pull_request: number, head_sha: head, base_sha: git(directory, ['rev-parse', remoteBase]).trim(), pushed: false,
        note: `Pull request ${number} already contains ${remoteBase}; nothing to refresh`};
    }
    merge({directory, remoteBase, branch});
  }
  const result = await review({directory, base: remoteBase, 'request-file': args['request-file'], harness: args.harness, agent: args.agent,
    identity: args.identity, 'additional-checks': args['additional-checks'], engine: args.engine});
  const context = {pull_request: number, previous_head_sha: pull.head, pushed: false};
  if (result.status === 'awaiting_agent') {
    return {...result, ...context, then: 'Repeat the identical refresh command. It continues on the merge commit already made and on this pinned engine revision.'};
  }
  if (result.status) return {...result, ...context};
  if (result.decision !== 'auto_approve') return {...result, ...context, note: 'The review did not pass; nothing was pushed. The merge commit remains in the local branch.'};
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
  try {
    git(directory, ['push', 'origin', `HEAD:refs/heads/${pull.ref}`]);
  } catch (error) {
    patch(live.body);
    throw new Error(`The push failed (${first(error)}); the pull request body was restored and the branch on GitHub is unchanged`);
  }
  return {...result, ...context, status: 'refreshed', pushed: true, marker: published.marker, artifact_commit: published.artifact_commit,
    ...(published.warnings ? {warnings: published.warnings} : {})};
}

module.exports = {refreshPull, withMarker, merge, resumable};
