'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {digest} = require('./acceptance.cjs');

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

async function readSource({github, repo, snapshot, filename, ref, authority = 'untrusted'}) {
  if (!safePath(filename)) throw new Error('Unsafe repository evidence path');
  const id = `${ref}:${filename}`;
  if (snapshot.sources[id]) return id;
  const {data} = await github.rest.repos.getContent({...repo, path: filename, ref});
  if (data.encoding !== 'base64' || typeof data.content !== 'string' || data.size > 300000) {
    throw new Error('Complete textual source is unavailable within the evidence budget');
  }
  const content = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(data.content, 'base64'));
  if (content.includes('\0') || content.length > 300000) throw new Error('Binary or oversized source is not reviewable');
  snapshot.sources[id] = {path: filename, ref, authority, content};
  return id;
}

async function collectSnapshot({github, repo, pr, files, config, technical}) {
  if (!files.length || files.length !== pr.changed_files || files.some(file =>
    !safePath(file.filename) || !file.patch || !['added', 'modified', 'removed', 'renamed'].includes(file.status))) {
    throw new Error('Changed-file evidence is incomplete');
  }
  const policy = fs.readFileSync(path.join(__dirname, '../policy/change-acceptance.md'), 'utf8');
  const snapshot = {version: 2, repository: `${repo.owner}/${repo.repo}`, number: pr.number,
    base_sha: pr.base.sha, head_sha: pr.head.sha, paths: files.map(file => file.filename).sort(),
    config_digest: digest(config), policy_digest: digest(policy), sources: {}, files: [], history: [], tickets: []};
  snapshot.sources['verification'] = {authority: 'trusted', path: 'verification', ref: pr.head.sha,
    content: JSON.stringify(technical, null, 2)};
  for (const filename of [config.repository_policy, config.readme]) {
    await readSource({github, repo, snapshot, filename, ref: pr.base.sha, authority: 'trusted'});
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
      closingIssuesReferences(first:10) { nodes { number title body url } pageInfo { hasNextPage } }
    } }
  }`, {...repo, number: pr.number});
  const tickets = linked.repository.pullRequest.closingIssuesReferences;
  if (tickets.pageInfo.hasNextPage) throw new Error('Linked requirement evidence is incomplete');
  snapshot.tickets = tickets.nodes;
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

module.exports = {safePath, refresh, readSource, collectSnapshot, additionalSources};
