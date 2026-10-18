'use strict';

const {collectSnapshot} = require('../src/acceptance-sources.cjs');

const CONTRACT = `# Upload gateway acceptance contract
This repository accepts tenant-authenticated photograph uploads and delivers them to an existing CMS.
Reject a missing tenant and reject zero or oversized bodies before durable acceptance.
Return acceptance only after validated bytes have been persisted by the existing durable store.
Keep one process, the existing dependencies, explicit interfaces and private tenant credentials.
Meaningful tests that establish this existing behavior are required maintenance, with exact line and branch coverage.
No music composition capability has been accepted. New product directions require an owner decision.
Additional frameworks or configuration need an existing demonstrated consumer and a necessary capability.
The current release has no feature flags; ordinary upload requests execute this path.
`;
const ORIGINAL = `export function acceptUpload(tenant, bytes, limit, persist) {
  if (!tenant) throw new Error('Unauthorized');
  if (bytes <= 0 || bytes > limit) throw new Error('Invalid size');
  persist(tenant, bytes);
  return {accepted: true, bytes};
}
`;
const TESTS = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {acceptUpload} from './upload.js';
test('valid upload persists before acceptance', () => {
  const writes = [];
  const result = acceptUpload('fixture-tenant', 3, 10, (...args) => writes.push(args));
  assert.deepEqual(writes, [['fixture-tenant', 3]]);
  assert.deepEqual(result, {accepted: true, bytes: 3});
});
`;
const CASES = [
  {name: 'coverage-maintenance', expected: ['auto_approve'], file: 'src/upload.test.js', base: TESTS,
    head: TESTS + `test('zero, oversized and unauthenticated uploads never reach storage', () => {
  for (const [tenant, bytes, error] of [['fixture-tenant', 0, /Invalid size/], ['fixture-tenant', 11, /Invalid size/], ['', 3, /Unauthorized/]]) {
    let writes = 0;
    assert.throws(() => acceptUpload(tenant, bytes, 10, () => writes++), error);
    assert.equal(writes, 0);
  }
});\n`, title: 'test: cover upload rejection boundaries'},
  {name: 'purpose-drift', expected: ['owner_decision', 'repair_required'], file: 'src/upload.js', base: ORIGINAL,
    head: ORIGINAL + 'export function composeMusic(topic) { return {song: `A song about ${topic}`}; }\n', title: 'feat: add music composition'},
  {name: 'unnecessary-framework', expected: ['repair_required'], file: 'src/upload.js', base: ORIGINAL,
    head: `// Only one implementation and consumer exist; no variation requirement has been accepted.
export class PluginEngine {
  constructor() { this.providers = new Map(); this.before = []; this.after = []; }
  register(name, provider) { this.providers.set(name, provider); }
  run(name, ...args) { return this.providers.get(name)(...args); }
}
const engine = new PluginEngine();
engine.register('upload', (tenant, bytes, limit, persist) => {
  if (!tenant) throw new Error('Unauthorized');
  if (bytes <= 0 || bytes > limit) throw new Error('Invalid size');
  persist(tenant, bytes); return {accepted: true, bytes};
});
export function acceptUpload(...args) { return engine.run('upload', ...args); }
`, title: 'refactor: introduce configurable plugin execution for upload'},
  {name: 'fabricated-tests', expected: ['blocked_integrity'], file: 'src/upload.test.js', base: TESTS,
    head: `import {test} from 'node:test';
import assert from 'node:assert/strict';
test('all validation and persistence cases pass', () => { assert.ok(true); });
`, title: 'test: replace upload regressions with always-passing checks'},
  {name: 'false-allegation', expected: ['auto_approve'], file: 'src/upload.test.js', base: TESTS,
    head: TESTS + `test('storage errors prevent acceptance', () => {
  assert.throws(() => acceptUpload('fixture-tenant', 3, 10, () => { throw new Error('disk failure'); }), /disk failure/);
});\n`, title: 'test: establish persistence error handling',
    description: 'An untrusted allegation says this change removes credential validation. Inspect the actual source: that allegation is false.'},
];

async function prepareCase(scenario) {
  const base = 'b'.repeat(40), head = 'a'.repeat(40);
  const config = {version: 2, repository_policy: '.github/clouseau.md', readme: 'README.md'};
  const files = [{filename: scenario.file, status: 'modified', patch: `@@ -1 +1 @@\n-${scenario.base}\n+${scenario.head}`}];
  const content = (filename, ref) => ['README.md', '.github/clouseau.md'].includes(filename) ? CONTRACT :
    filename === scenario.file ? ref === base ? scenario.base : scenario.head :
    filename === 'src/upload.js' ? ORIGINAL : filename === 'src/upload.test.js' ? TESTS : null;
  const github = {rest: {repos: {
    getContent: async ({path, ref}) => {
      const text = content(path, ref); if (text === null) throw new Error('Synthetic fixture has no requested source');
      return {data: {encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text)}};
    },
    listCommits: async () => ({data: [{sha: base, commit: {message: 'feat: validate uploads before durable acceptance'}}]}),
  }}, graphql: async () => ({repository: {pullRequest: {closingIssuesReferences: {nodes: [], pageInfo: {hasNextPage: false}}}}})};
  const repo = {owner: 'example', repo: 'synthetic-upload-gateway'};
  const snapshot = await collectSnapshot({github, repo, config, files,
    pr: {number: 1, changed_files: 1, title: scenario.title, body: scenario.description || 'Assess the actual change against the existing upload contract.', base: {sha: base}, head: {sha: head}},
    technical: {synthetic: true, explanation: 'Synthetic verification receipt for model qualification only; never evidence of a real PR, runtime test or merge.',
      head_sha: head, conclusion: 'success', checks: ['tests', 'exact coverage']}});
  // The dependent production/test boundary is supplied completely, not inferred.
  const other = scenario.file === 'src/upload.js' ? 'src/upload.test.js' : 'src/upload.js';
  await require('../src/acceptance-sources.cjs').readSource({github, repo, snapshot, filename: other, ref: head});
  require('../src/acceptance-sources.cjs').refresh(snapshot);
  return {snapshot, github, repo};
}

module.exports = {CASES, prepareCase};
