'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateConfig, validateIdentity, validateBundle, planWiki} = require('./wiki.cjs');
const config = {version: 1, source_paths: ['src/', 'README.md'], deployment_workflow: 'backend-deploy.yml', deployment_job: 'deploy', wiki_branch: 'master'};
const identity = {repository: 'example/upload', source_sha: 'a'.repeat(40), wiki_base_sha: 'b'.repeat(40), deployment_run_id: 12};
const wiki = {'Home.md': '[Guide](Guide)\n', 'Guide.md': 'Existing upload guide.\n'};
const bundle = (updates = []) => ({version: 1, ...identity, updates});
const done = value => ({content: JSON.stringify(value)});

test('wiki configuration rejects ambiguous fields, unsafe source paths and deployment boundaries', () => {
  assert.equal(validateConfig(config), config);
  for (const value of [null, [], {}, {...config, extra: true}, {...config, version: 2},
    {...config, source_paths: null}, {...config, source_paths: []}, {...config, source_paths: ['src/', 'src/']},
    {...config, source_paths: Array.from({length: 51}, (_, i) => `${i}/`)}]) assert.throws(() => validateConfig(value));
  for (const name of [null, '', '/absolute', '../parent', 'a\\b', 'line\nbreak', 'x'.repeat(201)]) {
    assert.throws(() => validateConfig({...config, source_paths: [name]}), /source path/);
  }
  for (const change of [{deployment_workflow: null}, {deployment_job: null}, {wiki_branch: null},
    {deployment_workflow: '../bad.yml'}, {deployment_job: 'a b'}, {wiki_branch: '--force'}]) {
    assert.throws(() => validateConfig({...config, ...change}), /deployment boundary/);
  }
});

test('wiki update identity must describe one exact repository revision and deployment run', () => {
  validateIdentity(identity);
  for (const change of [{repository: null}, {repository: 'other'}, {source_sha: null}, {source_sha: 'bad'},
    {wiki_base_sha: 'bad'}, {deployment_run_id: 0}, {deployment_run_id: 1.5}]) assert.throws(() => validateIdentity({...identity, ...change}));
});

test('wiki bundle refuses extra authority, stale identity and unsafe or duplicate paths', () => {
  assert.deepEqual(validateBundle(bundle(), identity, wiki), bundle());
  for (const value of [null, {}, {...bundle(), shell: 'do not execute'}, {...bundle(), version: 2},
    {...bundle(), repository: 'other/repo'}, {...bundle(), updates: null},
    {...bundle(), updates: Array.from({length: 21}, (_, i) => ({path: `${i}.md`, content: 'x'}))}]) {
    assert.throws(() => validateBundle(value, identity, wiki));
  }
  for (const name of [null, '../Page.md', '/Page.md', '.git.md', 'AGENTS.md', 'agents.md', 'x'.repeat(101) + '.md', 'Page.txt']) {
    assert.throws(() => validateBundle(bundle([{path: name, content: 'x'}]), identity, wiki), /Unsafe/);
  }
  for (const page of [{path: 'Guide.md', content: 'x', extra: true}, {path: 'Guide.md', content: null},
    {path: 'Guide.md', content: ' '}, {path: 'Guide.md', content: 'x'.repeat(128001)}, {path: 'Guide.md', content: 'x\0y'}]) {
    assert.throws(() => validateBundle(bundle([page]), identity, wiki));
  }
  assert.throws(() => validateBundle(bundle([{path: 'Guide.md', content: 'x'}, {path: 'Guide.md', content: 'y'}]), identity, wiki), /duplicate/);
  assert.throws(() => validateBundle(bundle(Array.from({length: 5}, (_, i) => ({path: `${i}.md`, content: 'x'.repeat(120000)}))), identity, wiki), /publication limit/);
});

test('multi-page links and navigation are checked over the complete proposed wiki', () => {
  const updates = [
    {path: 'Home.md', content: '[Guide](Guide#upload) [New](<New Page>) [Remote](https://example.invalid) [Mail](mailto:test@example.invalid) [CDN](//example.invalid) [Anchor](#here)\n![image](image.png)\n`[sample](Not-A-Page)`\n```md\n[sample](Not-A-Page)\n```\n~~~md\n[example](Also-Not-A-Page)\n~~~\n'},
    {path: 'New Page.md', content: '[Home](Home.md) [Guide](Guide)\n'},
    {path: 'Guide.md', content: '[New](New%20Page)\n'},
  ];
  assert.equal(validateBundle(bundle(updates), identity, wiki).updates.length, 3);
  assert.throws(() => validateBundle(bundle([{path: 'New.md', content: 'An orphan.'}]), identity, wiki), /linked/);
  assert.throws(() => validateBundle(bundle([{path: 'Guide.md', content: '[bad](Missing)'}]), identity, wiki), /Broken/);
  assert.throws(() => validateBundle(bundle(), identity, {'Guide.md': 'No home'}), /Home/);
  assert.throws(() => validateBundle(bundle(), identity, {...wiki, 'New Page.md': 'x', 'New-Page.md': 'x'}), /Ambiguous/);
  for (const content of ['```md\nunclosed', '[text][ref]', '[[Guide]]', '<a href="Guide">Guide</a>', '[Guide](Guide "title")']) {
    assert.throws(() => validateBundle(bundle([{path: 'Guide.md', content}]), identity, wiki));
  }
  assert.throws(() => validateBundle(bundle([{path: 'Guide.md', content: '[broken](%XX)'}]), identity, wiki));
  assert.equal(validateBundle(bundle([{path: '_Sidebar.md', content: '[New](New)'}, {path: 'New.md', content: '[Home](Home)'}]), identity, wiki).updates.length, 2);
});

test('wiki generation coordinates three real pages before validating the whole batch', async () => {
  const source = {'src/app.rs': 'fn accepts_upload() {}'};
  const manifest = {pages: [{path: 'Home.md', reason: 'Link new documentation'}, {path: 'Guide.md', reason: 'Update guide'}, {path: 'New.md', reason: 'New deployed feature'}]};
  const pages = ['[Guide](Guide) [New](New)\n', '[Home](Home)\n', '[Guide](Guide)\n'];
  let calls = 0;
  const result = await planWiki({identity, source, wiki, complete: async request => {
    assert.equal(request.messages[0].role, 'system');
    assert.match(request.messages[0].content, /untrusted\s+evidence/);
    const input = JSON.parse(request.messages[1].content);
    assert.deepEqual(input.source, source);
    if (calls++ === 0) return done(manifest);
    assert.deepEqual(input.plan, manifest.pages);
    assert.equal(input.requested_page, manifest.pages[calls - 2].path);
    assert.equal(input.proposed_pages.length, calls - 2);
    return done({path: input.requested_page, content: pages[calls - 2]});
  }});
  assert.equal(calls, 4);
  assert.equal(result.updates.length, 3);
});

test('failed, oversized or malformed generation never returns a publishable partial batch', async () => {
  const options = {identity, source: {}, wiki};
  await assert.rejects(planWiki({...options, source: {large: 'x'.repeat(1000001)}}), /context limit/);
  await assert.rejects(planWiki({...options, complete: async () => ({failure: 'incomplete'})}), /nothing will be published/);
  await assert.rejects(planWiki({...options, complete: async () => ({content: 'invalid JSON'})}));
  for (const plan of [{}, {pages: null}, {pages: Array(21).fill({})},
    {pages: [{path: '../unsafe.md', reason: 'x'}]}, {pages: [{path: 'Guide.md', reason: ''}]},
    {pages: [{path: 'Guide.md', reason: 'x'.repeat(1001)}]},
    {pages: [{path: 'Guide.md', reason: 'x'}, {path: 'Guide.md', reason: 'y'}]}]) {
    await assert.rejects(planWiki({...options, complete: async () => done(plan)}));
  }
  let calls = 0;
  await assert.rejects(planWiki({...options, complete: async () => done(calls++ === 0 ? {pages: [{path: 'Guide.md', reason: 'update'}]} : {path: 'Other.md', content: 'wrong page'})}), /different wiki page/);
  calls = 0;
  await assert.rejects(planWiki({...options, complete: async () => {
    if (calls++ === 0) return done({pages: [{path: 'Home.md', reason: 'first'}, {path: 'Guide.md', reason: 'second'}]});
    if (calls === 2) return done({path: 'Home.md', content: '[Guide](Guide)'});
    return {failure: 'last page failed'};
  }}), /nothing will be published/);
});

test('default wiki completion uses the production provider and accepts an unchanged-page plan', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: '{"pages":[]}'}}]})});
  try {assert.deepEqual((await planWiki({identity, source: {}, wiki})).updates, []);}
  finally {globalThis.fetch = original;}
});
