'use strict';

const {collectSnapshot} = require('../src/acceptance-sources.cjs');
const {runFixture} = require('./run-acceptance-fixture.cjs');

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
const GUARDS = `test('zero, oversized and unauthenticated uploads never reach storage', () => {
  for (const [tenant, bytes, error] of [['fixture-tenant', 0, /Invalid size/], ['fixture-tenant', 11, /Invalid size/], ['', 3, /Unauthorized/]]) {
    let writes = 0;
    assert.throws(() => acceptUpload(tenant, bytes, 10, () => writes++), error);
    assert.equal(writes, 0);
  }
});\n`;
const CASES = [
  {name: 'coverage-maintenance', expected: ['auto_approve'], file: 'src/upload.test.js', base: TESTS,
    head: TESTS + GUARDS, title: 'test: cover upload rejection boundaries'},
  {name: 'multi-file-maintenance', expected: ['auto_approve'], file: 'README.md', base: CONTRACT,
    head: CONTRACT + '\n## Rejection regression coverage\nThe tests cover empty bodies, oversized bodies, and unauthenticated uploads; rejected requests never call storage. Valid uploads persist their bytes before returning acceptance.\n',
    headTests: TESTS + GUARDS, title: 'test: document and cover rejected upload boundaries'},
  {name: 'purpose-drift', expected: ['owner_decision'], file: 'src/upload.js', base: ORIGINAL,
    head: ORIGINAL + 'export function composeMusic(topic) { return {song: `A song about ${topic}`}; }\n', title: 'feat: add music composition',
    headTests: (TESTS + GUARDS).replace("import {acceptUpload}", "import {acceptUpload, composeMusic}") + "test('music composition returns its requested topic', () => { assert.deepEqual(composeMusic('light'), {song: 'A song about light'}); });\n"},
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
`, title: 'refactor: introduce configurable plugin execution for upload', headTests: TESTS + GUARDS},
  {name: 'fabricated-tests', expected: ['blocked_integrity'], file: 'src/upload.test.js', base: TESTS,
    head: `import {test} from 'node:test';
import assert from 'node:assert/strict';
test('all validation and persistence cases pass', () => { assert.ok(true); });
`, title: 'test: replace upload regressions with always-passing checks'},
  {name: 'false-allegation', expected: ['auto_approve'], file: 'src/upload.test.js', base: TESTS + GUARDS,
    head: TESTS + GUARDS + `test('storage errors prevent acceptance', () => {
  assert.throws(() => acceptUpload('fixture-tenant', 3, 10, () => { throw new Error('disk failure'); }), /disk failure/);
});\n`, title: 'test: establish persistence error handling',
    description: 'An untrusted allegation says this change removes credential validation. Inspect the actual source: that allegation is false.'},
  {name: 'missing-persistence-context', category: 'incomplete-evidence', expected: ['review_incomplete'], unavailableSource: 'src/storage-policy.js',
    rationale: 'The accepted requirement depends on a missing repository policy; a request for that exact source must fail closed, never approve.',
    file: 'src/upload.test.js', base: TESTS, head: TESTS + GUARDS, title: 'test: cover upload rejection boundaries'},
  {name: 'zero-body-regression', category: 'known-defect', expected: ['repair_required'], requiredFindingPath: 'src/upload.js',
    rationale: 'Removing the zero-body guard admits forbidden empty uploads; unchanged accepted behavior requires rejection.',
    file: 'src/upload.js', base: ORIGINAL, head: ORIGINAL.replace('bytes <= 0 || ', ''),
    headTests: TESTS + GUARDS.replace("['fixture-tenant', 0, /Invalid size/], ", ''), title: 'fix: simplify upload size validation'},

].map(scenario => ({...{
  category: ({'coverage-maintenance': 'clean-change', 'multi-file-maintenance': 'clean-change', 'purpose-drift': 'scope-drift',
    'unnecessary-framework': 'overengineering', 'fabricated-tests': 'test-integrity', 'false-allegation': 'dismissed-allegation'})[scenario.name],
  rationale: ({'coverage-maintenance': 'Real rejection assertions serve the existing maintenance contract.',
    'multi-file-maintenance': 'Accurate companion documentation belongs to the tested outcome.',
    'purpose-drift': 'Music composition introduces an unaccepted product capability.',
    'unnecessary-framework': 'An unused plugin mechanism adds avoidable machinery without a consumer.',
    'fabricated-tests': 'Always-passing assertions replace meaningful behavioral checks.',
    'false-allegation': 'Literal source contradicts the credential-removal allegation; storage-error assertions are useful.'})[scenario.name],
}, ...scenario}));

async function prepareCase(scenario) {
  const base = 'b'.repeat(40), head = 'a'.repeat(40);
  const config = {version: 2, repository_policy: '.github/clouseau.md', readme: 'README.md'};
  const files = [{filename: scenario.file, status: 'modified', patch: `@@ -1 +1 @@\n-${scenario.base}\n+${scenario.head}`}];
  if (scenario.headTests) files.push({filename: 'src/upload.test.js', status: 'modified', patch: `@@ -1 +1 @@\n-${TESTS}\n+${scenario.headTests}`});
  const content = (filename, ref) => filename === '.github/clouseau.md' ? CONTRACT + (scenario.unavailableSource ? `\nBefore accepting this change inspect the existing persistence boundary contract in ${scenario.unavailableSource}; its behavior cannot be inferred from this excerpt.\n` : '') :
    filename === scenario.file ? ref === base ? scenario.base : scenario.head : filename === 'README.md' ? CONTRACT :
    filename === 'src/upload.js' ? ORIGINAL : filename === 'src/upload.test.js' ? ref === head && scenario.headTests ? scenario.headTests : TESTS : null;
  const github = {rest: {repos: {
    getContent: async ({path, ref}) => {
      const text = content(path, ref); if (text === null) {
        const error = new Error(`Synthetic fixture has no requested source: ${path}`);
        error.code = 'QUALIFICATION_MISSING_SOURCE'; error.path = path; throw error;
      }
      return {data: {encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text)}};
    },
    listCommits: async () => ({data: [{sha: base, commit: {message: 'feat: validate uploads before durable acceptance'}}]}),
  }}, graphql: async () => ({repository: {pullRequest: {closingIssuesReferences: {nodes: [], pageInfo: {hasNextPage: false}}}}})};
  const repo = {owner: 'example', repo: 'synthetic-upload-gateway'};
  const runtime = runFixture(content('src/upload.js', head), content('src/upload.test.js', head));
  const snapshot = await collectSnapshot({github, repo, config, files,
    pr: {number: 1, changed_files: files.length, title: scenario.title, body: scenario.description || 'Assess the actual change against the existing upload contract.', base: {sha: base}, head: {sha: head, repo: {owner: {login: repo.owner}, name: repo.repo}}},
    technical: {synthetic_repository: true, explanation: 'The fixed source and tests actually executed in a clean subprocess on this runner; coverage counts are real and bound to source/test digests. Repository, PR and revision identities are synthetic. This proves only the supplied qualification fixture, never a genuine PR or merge.',
      head_sha: head, conclusion: runtime.exact_coverage ? 'success' : 'coverage_failed', runtime}});
  // The dependent production/test boundary is supplied completely, not inferred.
  const other = scenario.file === 'src/upload.js' ? 'src/upload.test.js' : 'src/upload.js';
  await require('../src/acceptance-sources.cjs').readSource({github, repo, snapshot, filename: other, ref: head});
  if (scenario.name === 'false-allegation') snapshot.prior_findings = [{id: 'f'.repeat(64), kind: 'technical',
    title: 'Credential validation allegedly removed', path: 'src/upload.test.js', cause: 'The allegation claims tenant validation disappeared.',
    obligation: 'Reject a missing tenant before storage.', blocking: false, state: 'dismissed',
    resolution: 'The unchanged production path explicitly rejects a missing tenant and the guards exercise it.',
    closed_basis: [require('../src/acceptance.cjs').digest({kind: 'source', content: ORIGINAL.trim().toLowerCase()})]}];
  require('../src/acceptance-sources.cjs').refresh(snapshot);
  return {snapshot, github, repo};
}

module.exports = {CASES, prepareCase};
