'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {validateConfig, validateBundle, planWiki} = require('./wiki.cjs');
const META = '.clouseau-deployment.json';
const check = (condition, message) => {if (!condition) throw new Error(message);};

function git(directory, args, input, env = process.env) {
  try {
    return execFileSync('git', ['-C', directory, ...args], {input, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']});
  } catch {
    throw new Error(`Wiki Git operation failed: ${args[0]}`);
  }
}
const filesAt = (directory, revision) => git(directory, ['ls-tree', '-rz', '--name-only', revision]).split('\0').filter(Boolean);
const forbidden = name => /(^|\/)(?:\.git|\.agents|AGENTS\.md)(\/|$)/i.test(name) ||
  (path.posix.basename(name).startsWith('.env') && path.posix.basename(name) !== '.env.example');

function snapshot({sourceDirectory, wikiDirectory, config, repository, revision, runId}) {
  validateConfig(config);
  check(git(sourceDirectory, ['rev-parse', 'HEAD']).trim() === revision, 'Source checkout does not match the deployment revision');
  check(!git(wikiDirectory, ['status', '--porcelain']).trim(), 'Wiki checkout is not clean');
  const base = git(wikiDirectory, ['rev-parse', 'HEAD']).trim();
  const identity = {repository, source_sha: revision, wiki_base_sha: base, deployment_run_id: runId};
  const selected = filesAt(sourceDirectory, revision).filter(name => config.source_paths.some(prefix =>
    prefix.endsWith('/') ? name.startsWith(prefix) : name === prefix));
  check(selected.length > 0 && selected.length <= 300, 'Invalid source snapshot size');
  const source = {};
  for (const name of selected) {
    check(!forbidden(name), 'Refusing sensitive or instruction source paths');
    const content = git(sourceDirectory, ['show', `${revision}:${name}`]);
    check(!content.includes('\0'), 'Documentation sources must be text');
    source[name] = content;
  }
  const wiki = {};
  const names = filesAt(wikiDirectory, base);
  for (const name of names.filter(name => name.endsWith('.md') && !forbidden(name))) {
    check(/^[A-Za-z0-9_][A-Za-z0-9 _-]{0,99}\.md$/.test(name), 'Only flat Markdown wiki pages are supported');
    wiki[name] = git(wikiDirectory, ['show', `${base}:${name}`]);
  }
  let previous = null;
  if (names.includes(META)) {
    previous = JSON.parse(git(wikiDirectory, ['show', `${base}:${META}`]));
    check(previous.version === 1 && /^[a-f0-9]{40}$/.test(previous.source_sha) && previous.repository === repository &&
      Number.isSafeInteger(previous.deployment_run_id) && previous.deployment_run_id > 0, 'Invalid wiki deployment receipt');
  }
  return {identity, source, wiki, previous};
}

async function verifyDeployment({github, context, config}) {
  validateConfig(config);
  const {data: run} = await github.rest.actions.getWorkflowRun({...context.repo, run_id: context.runId});
  check(run.head_sha === context.sha && run.head_branch === 'main' &&
    run.path === `.github/workflows/${config.deployment_workflow}`, 'Wiki publication requires the expected main deployment workflow');
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {...context.repo, run_id: context.runId, filter: 'latest', per_page: 100});
  const deployment = jobs.filter(job => job.name === config.deployment_job);
  check(deployment.length === 1 && deployment[0].status === 'completed' && deployment[0].conclusion === 'success', 'Wiki publication requires a completed successful deployment job');
}

async function prepareWiki({github, context, config, sourceDirectory, wikiDirectory, draft = false, complete, report}) {
  if (!draft) await verifyDeployment({github, context, config});
  const current = snapshot({sourceDirectory, wikiDirectory, config, repository: `${context.repo.owner}/${context.repo.repo}`, revision: context.sha, runId: context.runId});
  if (current.previous?.source_sha === context.sha) {
    return validateBundle({version: 1, ...current.identity, updates: []}, current.identity, current.wiki);
  }
  return planWiki({...current, complete, report});
}

async function publishWiki({github, context, config, sourceDirectory, wikiDirectory, bundle}) {
  await verifyDeployment({github, context, config});
  git(wikiDirectory, ['fetch', 'origin', config.wiki_branch]);
  check(git(wikiDirectory, ['rev-parse', 'FETCH_HEAD']).trim() === bundle.wiki_base_sha, 'Wiki changed while documentation was generated; regenerate without overwriting edits');
  const current = snapshot({sourceDirectory, wikiDirectory, config, repository: `${context.repo.owner}/${context.repo.repo}`, revision: context.sha, runId: context.runId});
  validateBundle(bundle, current.identity, current.wiki);
  if (current.previous?.source_sha === context.sha) return {commit: current.identity.wiki_base_sha, changedPages: 0, alreadyDocumented: true};
  const updates = bundle.updates.filter(page => current.wiki[page.path] !== page.content);
  const receipt = {version: 1, repository: current.identity.repository, source_sha: context.sha, deployment_run_id: context.runId};
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-wiki-index-'));
  const env = {...process.env, GIT_INDEX_FILE: path.join(temporary, 'index'),
    GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_COMMITTER_NAME: 'github-actions[bot]',
    GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com'};
  try {
    git(wikiDirectory, ['read-tree', current.identity.wiki_base_sha], undefined, env);
    for (const page of [...updates, {path: META, content: JSON.stringify(receipt, null, 2) + '\n'}]) {
      const blob = git(wikiDirectory, ['hash-object', '-w', '--stdin'], page.content, env).trim();
      git(wikiDirectory, ['update-index', '--add', '--cacheinfo', '100644', blob, page.path], undefined, env);
    }
    const tree = git(wikiDirectory, ['write-tree'], undefined, env).trim();
    const commit = git(wikiDirectory, ['commit-tree', tree, '-p', current.identity.wiki_base_sha], `docs: update wiki for ${context.sha.slice(0, 12)}\n`, env).trim();
    // A single non-force push publishes every page together or fails on a concurrent edit.
    git(wikiDirectory, ['push', 'origin', `${commit}:refs/heads/${config.wiki_branch}`], undefined, env);
    return {commit, changedPages: updates.length, alreadyDocumented: false};
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
}

module.exports = {snapshot, verifyDeployment, prepareWiki, publishWiki};
