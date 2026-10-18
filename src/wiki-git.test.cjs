'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {snapshot, verifyDeployment, publishWiki} = require('./wiki-git.cjs');
const {planWiki} = require('./wiki.cjs');
const config = {version: 1, source_paths: ['README.md', 'src/', '.env.example'], deployment_workflow: 'deploy.yml', deployment_job: 'deploy', wiki_branch: 'master'};
const g = (dir, args, input) => execFileSync('git', ['-C', dir, ...args], {input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}).trim();
function write(dir, name, content) {fs.mkdirSync(path.dirname(path.join(dir, name)), {recursive: true}); fs.writeFileSync(path.join(dir, name), content);}
function commit(dir, files) {
  for (const [name, content] of Object.entries(files)) write(dir, name, content);
  g(dir, ['add', '--all']); g(dir, ['commit', '-m', 'fixture']); return g(dir, ['rev-parse', 'HEAD']);
}
function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-contract-'));
  const sourceDirectory = path.join(temp, 'source'), wikiDirectory = path.join(temp, 'wiki'), remote = path.join(temp, 'remote.git');
  fs.mkdirSync(sourceDirectory);
  g(sourceDirectory, ['init', '-b', 'main']);
  g(sourceDirectory, ['config', 'user.name', 'Fixture']); g(sourceDirectory, ['config', 'user.email', 'fixture@example.invalid']);
  const revision = commit(sourceDirectory, {'README.md': '# Upload\n', 'src/app.rs': 'fn accept() {}\n', '.env.example': 'PORT=8080\n', 'unselected.txt': 'not evidence'});
  fs.mkdirSync(remote); g(remote, ['init', '--bare', '-b', 'master']);
  g(temp, ['clone', remote, wikiDirectory]);
  g(wikiDirectory, ['config', 'user.name', 'Fixture']); g(wikiDirectory, ['config', 'user.email', 'fixture@example.invalid']);
  commit(wikiDirectory, {'Home.md': '[Guide](Guide)\n', 'Guide.md': 'Original guide.\n', 'AGENTS.md': 'Fictional instructions excluded from model context.\n'});
  g(wikiDirectory, ['push', 'origin', 'master']);
  const context = {repo: {owner: 'example', repo: 'upload'}, sha: revision, runId: 12};
  const state = {run: {head_sha: revision, head_branch: 'main', path: '.github/workflows/deploy.yml'}, jobs: [{name: 'deploy', status: 'completed', conclusion: 'success'}]};
  const github = {rest: {actions: {getWorkflowRun: async args => {assert.equal(args.run_id, 12); return {data: state.run};}, listJobsForWorkflowRun: () => {}}},
    paginate: async (_, args) => {assert.equal(args.filter, 'latest'); return state.jobs;}};
  const options = {sourceDirectory, wikiDirectory, config, repository: 'example/upload', revision, runId: 12};
  const read = () => snapshot(options);
  const publish = bundle => publishWiki({github, context, config, sourceDirectory, wikiDirectory, bundle});
  return {temp, sourceDirectory, wikiDirectory, remote, context, state, github, options, read, publish,
    close() {fs.rmSync(temp, {recursive: true, force: true});}};
}
const empty = s => ({version: 1, ...s.identity, updates: []});

test('committed snapshots select explicit source paths and exclude wiki agent instructions', () => {
  const f = fixture();
  try {
    const s = f.read();
    assert.deepEqual(Object.keys(s.source).sort(), ['.env.example', 'README.md', 'src/app.rs']);
    assert.equal(s.source['README.md'], '# Upload\n');
    assert.equal(s.wiki['AGENTS.md'], undefined);
    assert.equal(s.previous, null);
    assert.throws(() => snapshot({...f.options, revision: 'a'.repeat(40)}), /deployment revision/);
    write(f.wikiDirectory, 'untracked.md', 'human edit');
    assert.throws(() => f.read(), /not clean/);
  } finally {f.close();}
});

test('source collection fails closed on absent, oversized, sensitive or binary input', () => {
  const f = fixture();
  try {
    assert.throws(() => snapshot({...f.options, config: {...config, source_paths: ['missing/']}}), /snapshot size/);
    for (const name of ['.env', 'AGENTS.md']) {
      f.options.revision = commit(f.sourceDirectory, {[name]: 'fictional private fixture'});
      assert.throws(() => snapshot({...f.options, config: {...config, source_paths: [name]}}), /sensitive/);
    }
    f.options.revision = commit(f.sourceDirectory, {'src/binary': Buffer.from([0, 1, 2])});
    assert.throws(() => f.read(), /must be text/);
    const files = Object.fromEntries(Array.from({length: 301}, (_, i) => [`many/${i}`, 'x']));
    f.options.revision = commit(f.sourceDirectory, files);
    assert.throws(() => snapshot({...f.options, config: {...config, source_paths: ['many/']}}), /snapshot size/);
    assert.throws(() => snapshot({...f.options, wikiDirectory: f.temp}), /Git operation failed/);
  } finally {f.close();}
});

test('wiki snapshot validates layout and existing deployment receipts', () => {
  const f = fixture();
  try {
    commit(f.wikiDirectory, {'folder/Nested.md': 'nested'});
    assert.throws(() => f.read(), /flat Markdown/);
    fs.rmSync(path.join(f.wikiDirectory, 'folder'), {recursive: true}); g(f.wikiDirectory, ['add', '--all']); g(f.wikiDirectory, ['commit', '-m', 'remove fixture']);
    for (const value of [{version: 2}, {version: 1, source_sha: 'bad'}, {version: 1, source_sha: f.context.sha, repository: 'wrong/repo'},
      {version: 1, source_sha: f.context.sha, repository: 'example/upload', deployment_run_id: 0}]) {
      commit(f.wikiDirectory, {'.clouseau-deployment.json': JSON.stringify(value)});
      assert.throws(() => f.read(), /receipt/);
    }
    commit(f.wikiDirectory, {'.clouseau-deployment.json': 'not JSON'});
    assert.throws(() => f.read());
    commit(f.wikiDirectory, {'.clouseau-deployment.json': JSON.stringify({version: 1, source_sha: f.context.sha, repository: 'example/upload', deployment_run_id: 12})});
    assert.equal(f.read().previous.source_sha, f.context.sha);
  } finally {f.close();}
});

test('only the exact successful main deployment job permits wiki publication', async () => {
  const f = fixture();
  try {
    const check = () => verifyDeployment({github: f.github, context: f.context, config});
    await check();
    for (const change of [{head_sha: 'a'.repeat(40)}, {head_branch: 'feature'}, {path: '.github/workflows/other.yml'}]) {
      const original = {...f.state.run}; Object.assign(f.state.run, change);
      await assert.rejects(check(), /expected main/); f.state.run = original;
    }
    for (const jobs of [[], [f.state.jobs[0], f.state.jobs[0]], [{name: 'deploy', status: 'in_progress', conclusion: null}],
      [{name: 'deploy', status: 'completed', conclusion: 'failure'}]]) {
      const original = f.state.jobs; f.state.jobs = jobs;
      await assert.rejects(check(), /successful deployment/); f.state.jobs = original;
    }
  } finally {f.close();}
});

test('real Git publication commits coordinated pages and a deployment receipt atomically', async () => {
  const f = fixture();
  try {
    const s = f.read(); let calls = 0;
    const pages = [{path: 'Home.md', reason: 'link new page'}, {path: 'Guide.md', reason: 'update behavior'}, {path: 'New.md', reason: 'new docs'}];
    const content = ['[Guide](Guide) [New](New)\n', '[Home](Home) Updated guide.\n', '[Guide](Guide) New docs.\n'];
    const bundle = await planWiki({...s, complete: async () => ({content: JSON.stringify(calls++ === 0 ? {pages} : {path: pages[calls - 2].path, content: content[calls - 2]})})});
    const before = g(f.remote, ['rev-parse', 'master']);
    const result = await f.publish(bundle);
    assert.equal(result.changedPages, 3); assert.equal(result.alreadyDocumented, false);
    assert.equal(g(f.remote, ['rev-parse', 'master^']), before);
    assert.equal(g(f.remote, ['rev-parse', 'master']), result.commit);
    assert.equal(g(f.remote, ['show', 'master:New.md']), '[Guide](Guide) New docs.');
    const receipt = JSON.parse(g(f.remote, ['show', 'master:.clouseau-deployment.json']));
    assert.equal(receipt.source_sha, f.context.sha); assert.equal(receipt.deployment_run_id, 12);
    assert.equal(fs.readFileSync(path.join(f.wikiDirectory, 'Guide.md'), 'utf8'), 'Original guide.\n');
    assert.equal(g(f.wikiDirectory, ['status', '--porcelain']), '');
  } finally {f.close();}
});

test('unchanged pages record a truthful audit receipt and repeated source revisions are idempotent', async () => {
  const f = fixture();
  try {
    const s = f.read(); const b = empty(s); b.updates = [{path: 'Guide.md', content: s.wiki['Guide.md']}];
    const result = await f.publish(b);
    assert.equal(result.changedPages, 0);
    assert.equal(g(f.remote, ['diff', '--name-only', 'master^', 'master']), '.clouseau-deployment.json');
    g(f.wikiDirectory, ['fetch', 'origin', 'master']); g(f.wikiDirectory, ['reset', '--hard', 'FETCH_HEAD']);
    const repeated = await f.publish(empty(f.read()));
    assert.equal(repeated.alreadyDocumented, true);
    assert.equal(repeated.commit, result.commit);
    assert.equal(g(f.remote, ['rev-parse', 'master']), result.commit);
  } finally {f.close();}
});

test('concurrent human wiki edits are preserved rather than rebased or overwritten', async () => {
  const f = fixture();
  try {
    const b = empty(f.read()); b.updates = [{path: 'Guide.md', content: 'generated text'}];
    const peer = path.join(f.temp, 'peer'); g(f.temp, ['clone', f.remote, peer]);
    g(peer, ['config', 'user.name', 'Human']); g(peer, ['config', 'user.email', 'human@example.invalid']);
    commit(peer, {'Guide.md': 'Important human correction.\n'}); g(peer, ['push', 'origin', 'master']);
    await assert.rejects(f.publish(b), /Wiki changed/);
    assert.equal(g(f.remote, ['show', 'master:Guide.md']), 'Important human correction.');
  } finally {f.close();}
});

test('publication revalidates artifacts and a rejected push publishes no partial pages', async () => {
  const f = fixture();
  try {
    const s = f.read();
    await assert.rejects(f.publish({...empty(s), repository: 'wrong/repo'}), /identity/);
    await assert.rejects(f.publish({...empty(s), updates: [{path: '../bad.md', content: 'bad'}]}), /Unsafe/);
    write(f.remote, 'hooks/pre-receive', '#!/bin/sh\nexit 1\n'); fs.chmodSync(path.join(f.remote, 'hooks/pre-receive'), 0o700);
    const before = g(f.remote, ['rev-parse', 'master']);
    await assert.rejects(f.publish({...empty(s), updates: [{path: 'Guide.md', content: 'new page text'}]}), /Git operation failed: push/);
    assert.equal(g(f.remote, ['rev-parse', 'master']), before);
    assert.equal(g(f.remote, ['show', 'master:Guide.md']), 'Original guide.');
    assert.equal(g(f.wikiDirectory, ['status', '--porcelain']), '');
  } finally {f.close();}
});

test('draft generation never requires or implies deployment, while normal preparation does', async () => {
  const {prepareWiki} = require('./wiki-git.cjs');
  const f = fixture();
  try {
    const options = {github: f.github, context: f.context, config, sourceDirectory: f.sourceDirectory, wikiDirectory: f.wikiDirectory,
      complete: async () => ({content: '{"pages":[]}'})};
    assert.deepEqual((await prepareWiki(options)).updates, []);
    f.state.jobs = [];
    await assert.rejects(prepareWiki(options), /successful deployment/);
    assert.deepEqual((await prepareWiki({...options, draft: true})).updates, []);
    commit(f.wikiDirectory, {'.clouseau-deployment.json': JSON.stringify({version: 1, repository: 'example/upload', source_sha: f.context.sha, deployment_run_id: 11})});
    const repeated = await prepareWiki({...options, draft: true, complete: () => assert.fail('same source revision must not spend model credits')});
    assert.equal(repeated.updates.length, 0);
  } finally {f.close();}
});

test('private Git index prevents a wiki symlink from writing outside the documentation tree', async () => {
  const f = fixture();
  try {
    const sentinel = path.join(f.temp, 'sentinel.txt'); fs.writeFileSync(sentinel, 'human data');
    fs.rmSync(path.join(f.wikiDirectory, 'Guide.md')); fs.symlinkSync(sentinel, path.join(f.wikiDirectory, 'Guide.md'));
    g(f.wikiDirectory, ['add', '--all']); g(f.wikiDirectory, ['commit', '-m', 'symlink fixture']); g(f.wikiDirectory, ['push', 'origin', 'master']);
    const result = await f.publish({...empty(f.read()), updates: [{path: 'Guide.md', content: 'Safe Markdown replacement.\n'}]});
    assert.equal(result.changedPages, 1);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'human data');
    assert.equal(g(f.remote, ['show', 'master:Guide.md']), 'Safe Markdown replacement.');
    assert.match(g(f.remote, ['ls-tree', 'master', 'Guide.md']), /^100644/);
  } finally {f.close();}
});
