'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {digest, MAX_CITATION_LINES} = require('./acceptance.cjs');

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

function refresh(snapshot) {
  const value = {...snapshot}; delete value.digest;
  if (JSON.stringify(value).length > 900000) throw new Error('Complete review evidence exceeds the source budget');
  snapshot.digest = digest(value);
  return snapshot;
}

async function readSource({github, repo, snapshot, filename, ref, authority = 'untrusted', kind = 'source'}) {
  if (!safePath(filename)) throw new Error('Unsafe repository evidence path');
  const id = `${ref}:${filename}`;
  if (snapshot.sources[id]) return id;
  const sourceRepo = ref === snapshot.head_sha ? snapshot.head_repository : repo;
  if (!sourceRepo) throw new Error('The immutable head repository is unavailable');
  const {data} = await github.rest.repos.getContent({...sourceRepo, path: filename, ref});
  if (data.encoding !== 'base64' || typeof data.content !== 'string' || data.size > 300000) {
    throw new Error('Complete textual source is unavailable within the evidence budget');
  }
  const content = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(data.content, 'base64'));
  if (content.includes('\0') || content.length > 300000) throw new Error('Binary or oversized source is not reviewable');
  snapshot.sources[id] = {path: filename, ref, authority, kind, content};
  return id;
}

async function collectSnapshot({github, repo, pr, files, config, technical, intentConfirmation = null}) {
  if (!files.length || files.length !== pr.changed_files || files.some(file =>
    !safePath(file.filename) || !file.patch || !['added', 'modified', 'removed', 'renamed'].includes(file.status))) {
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
    if (file.status !== 'added') {
      const filename = file.previous_filename || file.filename;
      item.base_source = await readSource({github, repo, snapshot, filename, ref: pr.base.sha});
      const {data} = await github.rest.repos.listCommits({...repo, path: filename, sha: pr.base.sha, per_page: 3});
      snapshot.history.push({path: filename, commits: data.map(commit => ({sha: commit.sha, message: commit.commit.message}))});
    }
    if (file.status !== 'removed') item.head_source = await readSource({github, repo, snapshot, filename: file.filename, ref: pr.head.sha});
    snapshot.files.push(item);
  }
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
  snapshot.claims = {title: pr.title, description: pr.body};
  return refresh(snapshot);
}

async function additionalSources({github, repo, snapshot, paths}) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 8 || new Set(paths).size !== paths.length) {
    throw new Error('Additional evidence requires one to eight distinct repository paths');
  }
  for (const filename of paths) await readSource({github, repo, snapshot, filename, ref: snapshot.head_sha});
  return refresh(snapshot);
}

module.exports = {proofCatalog, safePath, refresh, readSource, collectSnapshot, additionalSources};
