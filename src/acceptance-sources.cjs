'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {LockfileError, MAX_BYTES, LOCKFILE_PATCH, isLockfile, lockfileEvidence, lockfileError} = require('./lockfile-summary.cjs');
const {digest, MAX_CITATION_LINES, isCodePath, isTestPath, moduleStem, specifiersOf, coveringTests} = require('./acceptance.cjs');

function proofCatalog(snapshot) {
  return Object.entries(snapshot.sources).flatMap(([source, value], index) => {
    const lines = value.content.split('\n'); const entries = [];
    for (let start = 1; start <= lines.length; start += MAX_CITATION_LINES) {
      const end = Math.min(lines.length, start + MAX_CITATION_LINES - 1);
      if (lines.slice(start - 1, end).join('\n').trim()) entries.push({id: `proof-${index}-${start}`, source, start, end});
    }
    return entries;
  });
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 500 &&
    !path.posix.isAbsolute(value) && !value.includes('\\') && !value.includes('\0') &&
    !value.split('/').some(part => !part || part === '.' || part === '..' || part === '.git');
}

const BUDGET = 900000;
function evidenceSize(snapshot) {
  const value = {...snapshot}; delete value.digest;
  return JSON.stringify(value).length;
}

function refresh(snapshot) {
  const value = {...snapshot}; delete value.digest;
  if (JSON.stringify(value).length > BUDGET) {
    // A lockfile that could not be summarized is the specific reason when the raw evidence no longer fits.
    const failed = snapshot.lockfile_failures?.[0];
    throw failed ? lockfileError(failed.path, failed.reason) : new Error('Complete review evidence exceeds the source budget');
  }
  snapshot.digest = digest(value);
  return snapshot;
}

async function fetchText({github, repo, snapshot, filename, ref, limit = 300000}) {
  if (!safePath(filename)) throw Object.assign(new Error('Unsafe repository evidence path'), {unavailable: true, path: String(filename)});
  const sourceRepo = ref === snapshot.head_sha ? snapshot.head_repository : repo;
  if (!sourceRepo) throw new Error('The immutable head repository is unavailable');
  const {data} = await github.rest.repos.getContent({...sourceRepo, path: filename, ref});
  if (data.encoding !== 'base64' || typeof data.content !== 'string' || data.size > limit) {
    throw Object.assign(new Error('Complete textual source is unavailable within the evidence budget'), {unavailable: true, path: filename, reason: 'size'});
  }
  let content;
  try {content = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(data.content, 'base64'));}
  catch {throw Object.assign(new Error('Source is not valid UTF-8 text'), {unavailable: true, path: filename, reason: 'text'});}
  if (content.includes('\0') || content.length > limit) throw Object.assign(new Error('Binary or oversized source is not reviewable'), {unavailable: true, path: filename, reason: 'text'});
  return content;
}

// The derived dependency summary replaces a lockfile's raw text and patch. When the lockfile cannot be
// summarized completely the result names the specific reason and the caller keeps the raw evidence.
async function summarizeChangedLockfile({github, repo, snapshot, file, baseSha, headSha}) {
  try {
    const baseText = file.status === 'added' ? null :
      await fetchText({github, repo, snapshot, filename: file.previous_filename || file.filename, ref: baseSha, limit: MAX_BYTES});
    const headText = file.status === 'removed' ? null :
      await fetchText({github, repo, snapshot, filename: file.filename, ref: headSha, limit: MAX_BYTES});
    return lockfileEvidence({file, baseSha, headSha, baseText, headText});
  } catch (error) {
    const reason = error instanceof LockfileError ? error.reason : error.unavailable ? (error.reason === 'size' ? 'too_large' : 'not_text') : null;
    if (!reason) throw error;
    return {reason};
  }
}

async function readSource({github, repo, snapshot, filename, ref, authority = 'untrusted', kind = 'source'}) {
  const id = `${ref}:${filename}`;
  if (snapshot.sources[id]) return id;
  snapshot.sources[id] = {path: filename, ref, authority, kind, content: await fetchText({github, repo, snapshot, filename, ref})};
  return id;
}

// A review bot rewrites the PR body with its own "Summary by <bot>" section that
// restates the diff as intent (for example "Bug Fixes: ..."). That text is a
// model's reading of the change, not the contributor's claim, and carries no
// authority; it must not be able to supply the justification for what it summarizes.
function contributorClaim(body) {
  if (typeof body !== 'string') return body;
  return body.replace(/^#{1,6} +Summary by [^\n]*(?:\n(?!#{1,6} )[^\n]*)*/gim, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Optional evidence (an existing test, a source a reviewer asked for) that is missing, not
// textual, too large or beyond the evidence budget is omitted with a stated reason that the
// reviewers see. Files that actually changed never take this path: they fail closed.
async function readOptional({github, repo, snapshot, filename}) {
  try {
    const id = await readSource({github, repo, snapshot, filename, ref: snapshot.head_sha});
    if (evidenceSize(snapshot) > BUDGET) {delete snapshot.sources[id]; throw Object.assign(new Error('over budget'), {omitted: 'would exceed the total evidence budget'});}
  } catch (error) {
    const reason = error.omitted || (error.status === 404 ? 'not found at the head revision' : error.unavailable ? 'not available as complete text within the evidence budget' : null);
    if (!reason) throw error;
    snapshot.omitted_sources = [...(snapshot.omitted_sources || []).filter(item => item.path !== filename), {path: filename, reason}];
  }
}

// Supplies what pins the changed code: tests that name a changed module, importers found by content, and barrels.
// `files` are {filename, status}. The hosted review and the check of a signed local receipt use this one
// discovery, so neither applies a weaker or a stronger rule.
async function supplyTests({github, repo, snapshot, files, baseSha, headSha}) {
  // Existing tests are not part of the change, so a reviewer cannot see what pins a changed
  // module unless the controller supplies them. Tests whose path names a changed production
  // module are read at the head revision; a model's later source_request may add the rest.
  const code = files.filter(file => file.status !== 'removed' && isCodePath(file.filename));
  if (code.length) {
    const {data: tree} = await github.rest.git.getTree({...repo, tree_sha: baseSha, recursive: 'true'});
    if (tree.truncated) throw new Error('Repository tree is too large to locate the existing tests');
    const changed = new Set(files.map(file => file.filename));
    let budget = 150000;
    for (const entry of tree.tree.filter(item => item.type === 'blob' && isTestPath(item.path) && !changed.has(item.path) &&
      item.size < 60000 && code.some(file => item.path.split('/').pop().includes(moduleStem(file.filename)))).slice(0, 8)) {
      if (entry.size > budget) break;
      budget -= entry.size;
      await readOptional({github, repo, snapshot, filename: entry.path});
    }
    // Tests rarely carry the module's name (utils.test.ts imports attention-color), so importers are
    // also found by content: other small tests are read once and only their import specifiers are
    // kept, which keeps the reviewers' evidence small. Barrels that re-export a changed module's
    // directory are supplied in full so that a chain through them can be followed.
    const supplied = new Set(Object.values(snapshot.sources).map(source => source.path));
    // Real tests first, then Storybook fixtures. Each file read costs a request from the shared budget, so the
    // scan is lazy: it stops as soon as every changed code file is covered, reads real tests before stories,
    // and is bounded; the extent is stated to the reviewers.
    const story = item => /\.stories\.|(?:^|\/)stories\//.test(item.path);
    const others = tree.tree.filter(item => item.type === 'blob' && isTestPath(item.path) && !changed.has(item.path) &&
      !supplied.has(item.path) && item.size < 60000).sort((a, b) => Number(story(a)) - Number(story(b)));
    snapshot.test_imports = []; let scanned = 0;
    const uncovered = () => Object.values(coveringTests(snapshot)).some(list => !list.length);
    for (const group of [others.filter(item => !story(item)), others.filter(story)]) {
      for (let offset = 0; offset < group.length && scanned < 100 && uncovered(); offset += 10) {
        const batch = group.slice(offset, offset + Math.min(10, 100 - scanned));
        scanned += batch.length;
        const found = await Promise.all(batch.map(async entry => {
          try {return {path: entry.path, specifiers: specifiersOf(await fetchText({github, repo, snapshot, filename: entry.path, ref: headSha}))};}
          catch (error) {if (error.status === 404 || error.unavailable) return null; throw error;}
        }));
        snapshot.test_imports.push(...found.filter(item => item && item.specifiers.length));
      }
    }
    snapshot.importer_scan = {tests_found: others.length, tests_scanned: scanned};
    const directories = new Set(code.flatMap(file => file.filename.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, parts.length - i).join('/'))));
    for (const entry of tree.tree.filter(item => item.type === 'blob' && !changed.has(item.path) && /(?:^|\/)index\.[cm]?[jt]sx?$/.test(item.path) &&
      directories.has(item.path.split('/').slice(0, -1).join('/')) && item.size < 60000).slice(0, 6)) {
      await readOptional({github, repo, snapshot, filename: entry.path});
    }
  }
  snapshot.covering_tests = coveringTests(snapshot);
  return snapshot;
}

async function collectSnapshot({github, repo, pr, files, config, technical, intentConfirmation = null}) {
  if (!files.length || files.length !== pr.changed_files || files.some(file =>
    !safePath(file.filename) || (!file.patch && !isLockfile(file.filename)) || !['added', 'modified', 'removed', 'renamed'].includes(file.status))) {
    throw new Error('Changed-file evidence is incomplete');
  }
  const policy = fs.readFileSync(path.join(__dirname, '../policy/change-acceptance.md'), 'utf8');
  if (!pr.head.repo?.owner?.login || !pr.head.repo.name) throw new Error('The immutable head repository is unavailable');
  const snapshot = {version: 2, review_manifest_version: 1, repository: `${repo.owner}/${repo.repo}`, number: pr.number,
    base_sha: pr.base.sha, head_sha: pr.head.sha, paths: files.map(file => file.filename).sort(),
    head_repository: {owner: pr.head.repo.owner.login, repo: pr.head.repo.name},
    config_digest: digest(config), policy_digest: digest(policy), sources: {}, files: [], history: [], tickets: []};
  snapshot.sources['verification'] = {authority: 'trusted', kind: 'verification', path: 'verification', ref: pr.head.sha,
    content: JSON.stringify(technical, null, 2)};
  for (const filename of [config.repository_policy, config.readme]) {
    await readSource({github, repo, snapshot, filename, ref: pr.base.sha, authority: 'trusted', kind: 'contract'});
  }
  snapshot.intent_confirmation = intentConfirmation;
  if (intentConfirmation) {
    const ref = digest(intentConfirmation);
    snapshot.sources[`intent:${ref}`] = {path: `pulls/${pr.number}/intent/${intentConfirmation.comment_id}`, ref,
      authority: 'trusted', kind: 'contract', content: JSON.stringify(intentConfirmation, null, 2)};
  }
  for (const file of files) {
    const item = {path: file.filename, status: file.status, patch: file.patch};
    const lockfile = isLockfile(file.filename) ?
      await summarizeChangedLockfile({github, repo, snapshot, file, baseSha: pr.base.sha, headSha: pr.head.sha}) : null;
    if (lockfile?.reason) {
      snapshot.lockfile_failures = [...(snapshot.lockfile_failures || []), {path: file.filename, reason: lockfile.reason}];
      if (!file.patch) throw lockfileError(file.filename, lockfile.reason);
    }
    if (lockfile?.id) {
      snapshot.sources[lockfile.id] = lockfile.source;
      Object.assign(item, {patch: LOCKFILE_PATCH, lockfile: true});
    }
    try {
      if (file.status !== 'added') {
        const filename = file.previous_filename || file.filename;
        if (lockfile?.id) item.base_source = lockfile.id;
        else item.base_source = await readSource({github, repo, snapshot, filename, ref: pr.base.sha});
        const {data} = await github.rest.repos.listCommits({...repo, path: filename, sha: pr.base.sha, per_page: 3});
        snapshot.history.push({path: filename, commits: data.map(commit => ({sha: commit.sha, message: commit.commit.message}))});
      }
      if (file.status !== 'removed') {
        if (lockfile?.id) item.head_source = lockfile.id;
        else item.head_source = await readSource({github, repo, snapshot, filename: file.filename, ref: pr.head.sha});
      }
    } catch (error) {
      // The raw lockfile is the fallback evidence; when it does not fit either, say why the lockfile failed.
      if (error.unavailable && lockfile?.reason) throw lockfileError(file.filename, lockfile.reason);
      throw error;
    }
    snapshot.files.push(item);
  }
  await supplyTests({github, repo, snapshot, files, baseSha: pr.base.sha, headSha: pr.head.sha});
  const linked = await github.graphql(`query($owner:String!,$repo:String!,$number:Int!) {
    repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
      closingIssuesReferences(first:10) { nodes { number title body url author { login } } pageInfo { hasNextPage } }
    } }
  }`, {...repo, number: pr.number});
  const tickets = linked.repository.pullRequest.closingIssuesReferences;
  if (tickets.pageInfo.hasNextPage) throw new Error('Linked requirement evidence is incomplete');
  snapshot.tickets = tickets.nodes;
  for (const ticket of snapshot.tickets) {
    const ref = digest(ticket);
    snapshot.sources[`ticket:${ticket.number}:${ref}`] = {path: `issues/${ticket.number}`, ref,
      authority: 'untrusted', kind: 'requirement', content: JSON.stringify(ticket, null, 2)};
  }
  snapshot.claims = {title: pr.title, description: contributorClaim(pr.body)};
  return refresh(snapshot);
}

async function additionalSources({github, repo, snapshot, paths}) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 8 || new Set(paths).size !== paths.length) {
    throw new Error('Additional evidence requires one to eight distinct repository paths');
  }
  for (const filename of paths) await readOptional({github, repo, snapshot, filename});
  snapshot.covering_tests = coveringTests(snapshot);
  return refresh(snapshot);
}

module.exports = {fetchText, supplyTests, contributorClaim, proofCatalog, safePath, refresh, readSource, collectSnapshot, additionalSources};
