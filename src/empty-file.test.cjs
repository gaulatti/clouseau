'use strict';

// An empty file is a normal change: a Python package marker (`__init__.py`) is added empty in almost every
// repository. GitHub reports no `patch` for it, `git diff` prints a header without hunks, and it holds no line a
// reviewer could cite. These tests follow that file from the hosted collector and the local collector through the
// review template, validation, partition, unit views and seams to the check of a signed receipt.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {repository} = require('../test/local-git-fixture.cjs');
const {hostedFiles} = require('../test/hosted-files.cjs');
const {git, collectLocal} = require('./local-git.cjs');
const {collectSnapshot, proofCatalog, refresh} = require('./acceptance-sources.cjs');
const {template, modelTemplate, materialize, validateInspection, changedAnchor} = require('./acceptance-review.cjs');
const {approvalHold, patchOf, FACTORS} = require('./acceptance.cjs');
const {hostedForm, verifyPatches, ReceiptPatchMismatch} = require('./receipt-patch.cjs');
const {verifySources} = require('./local-receipt.cjs');
const {changeTable} = require('./change-table.cjs');
const {partition} = require('./review-partition.cjs');
const {createPolicy} = require('./policy.cjs');
const {unitView} = require('./review-units.cjs');
const {seamsOf} = require('./review-seams.cjs');
const {scopeReason} = createPolicy(require('../test/fixtures/config.json'));

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

// ---------------------------------------------------------------------------------------------------------------
// Hosted collection: GitHub lists the empty added file with no `patch`.

function hosted(files, contents) {
  const github = {rest: {git: {getTree: async () => ({data: {truncated: false, tree: []}})}, repos: {
    getContent: async ({path: name, ref}) => {
      const text = contents[`${ref === HEAD ? 'head' : 'base'}:${name}`];
      if (text === undefined) throw Object.assign(new Error('Not Found'), {status: 404});
      return {data: {encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text)}};
    },
    listCommits: async () => ({data: []}),
  }}, graphql: async () => ({repository: {pullRequest: {closingIssuesReferences: {nodes: [], pageInfo: {hasNextPage: false}}}}})};
  return {github, repo: {owner: 'o', repo: 'r'}, config: {repository_policy: 'POLICY.md', readme: 'README.md'}, technical: {ok: true},
    pr: {number: 4, changed_files: files.length, title: 'feat: add package', body: 'Add the package.', base: {sha: BASE},
      head: {sha: HEAD, repo: {owner: {login: 'o'}, name: 'r'}}}, files};
}
const base = {'base:POLICY.md': 'Keep behaviour.\n', 'base:README.md': 'A service.\n'};

test('hosted collection accepts an added empty file that GitHub reports without a patch', async () => {
  const f = hosted([
    {filename: 'pkg/__init__.py', status: 'added', sha: EMPTY_BLOB, changes: 0},
    {filename: 'pkg/mod.py', status: 'added', patch: '@@ -0,0 +1 @@\n+x = 1'},
  ], {...base, 'head:pkg/__init__.py': '', 'head:pkg/mod.py': 'x = 1\n'});
  const snapshot = await collectSnapshot(f);
  const empty = snapshot.files.find(file => file.path === 'pkg/__init__.py');
  assert.equal(empty.patch, '');
  assert.equal(snapshot.sources[empty.head_source].content, '');
  assert.deepEqual(snapshot.paths, ['pkg/__init__.py', 'pkg/mod.py']);
  assert.equal(patchOf(snapshot, empty), '');
});

test('hosted collection accepts a removed empty file and a renamed file with identical content that have no patch', async () => {
  const removed = hosted([{filename: 'pkg/gone.py', status: 'removed'}], {...base, 'base:pkg/gone.py': ''});
  assert.equal((await collectSnapshot(removed)).files[0].patch, '');
  const renamed = hosted([{filename: 'pkg/new.py', previous_filename: 'pkg/old.py', status: 'renamed'}],
    {...base, 'base:pkg/old.py': '', 'head:pkg/new.py': ''});
  assert.equal((await collectSnapshot(renamed)).files[0].patch, '');
  const moved = hosted([{filename: 'pkg/new.py', previous_filename: 'pkg/old.py', status: 'renamed'}],
    {...base, 'base:pkg/old.py': 'x = 1\n', 'head:pkg/new.py': 'x = 1\n'});
  assert.equal((await collectSnapshot(moved)).files[0].patch, '');
});

test('a missing patch still fails closed unless the file holds nothing a patch could show', async () => {
  const cases = [
    [{filename: 'pkg/big.py', status: 'added'}, {'head:pkg/big.py': 'x = 1\n'}],
    [{filename: 'pkg/big.py', status: 'removed'}, {'base:pkg/big.py': 'x = 1\n'}],
    [{filename: 'pkg/big.py', status: 'modified'}, {'base:pkg/big.py': '', 'head:pkg/big.py': ''}],
    [{filename: 'pkg/new.py', previous_filename: 'pkg/old.py', status: 'renamed'}, {'base:pkg/old.py': 'x = 1\n', 'head:pkg/new.py': 'x = 2\n'}],
    [{filename: 'pkg/big.py', status: 'added', patch: ''}, {'head:pkg/big.py': 'x = 1\n'}],
  ];
  for (const [file, contents] of cases) {
    await assert.rejects(collectSnapshot(hosted([file], {...base, ...contents})), /Changed-file evidence is incomplete/, JSON.stringify(file));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Review: an empty source has no citable line, so nothing may assume one.

function reviewSnapshot({empty = true, code = true, files} = {}) {
  const sources = {
    contract: {path: 'POLICY.md', ref: BASE, authority: 'trusted', kind: 'contract', content: 'Keep behaviour.\n'},
    verification: {path: 'verification', ref: HEAD, authority: 'trusted', kind: 'verification', content: '{"ok":true}'},
    ...(empty ? {'init.head': {path: 'pkg/__init__.py', ref: HEAD, authority: 'untrusted', kind: 'source', content: ''}} : {}),
    ...(code ? {'mod.head': {path: 'pkg/mod.py', ref: HEAD, authority: 'untrusted', kind: 'source', content: 'x = 1\n'}} : {}),
  };
  const list = files || [
    ...(empty ? [{path: 'pkg/__init__.py', status: 'added', patch: 'diff --git a/pkg/__init__.py b/pkg/__init__.py\nnew file mode 100644\nindex 0000000..e69de29\n', head_source: 'init.head'}] : []),
    ...(code ? [{path: 'pkg/mod.py', status: 'added', patch: '@@ -0,0 +1 @@\n+x = 1\n', head_source: 'mod.head'}] : []),
  ];
  return refresh({version: 2, review_manifest_version: 1, repository: 'o/r', number: 0, base_sha: BASE, head_sha: HEAD,
    head_repository: {owner: 'o', repo: 'r'}, paths: list.map(file => file.path).sort(), config_digest: 'c', policy_digest: 'p',
    sources, files: list, history: [], tickets: [], intent_confirmation: null, prior_findings: [], claims: {title: 't', description: 'd'}});
}

function conclude(snapshot, edit = () => {}) {
  const facts = modelTemplate(snapshot);
  facts.gates.forEach(gate => {gate.state = 'satisfied';});
  edit(facts);
  return materialize(facts, snapshot);
}

test('the review template and the model template cite only lines that exist, so an empty file does not crash them', () => {
  const snapshot = reviewSnapshot();
  const value = template(snapshot);
  assert.ok(value.evidence.every(entry => entry.start >= 1 && snapshot.sources[entry.source].content.trim()));
  const facts = modelTemplate(snapshot);
  const empty = facts.accounting.find(item => item.path === 'pkg/__init__.py');
  assert.ok(empty.evidence.length === 1 && empty.evidence[0].startsWith('proof-'));
  const coverage = facts.coverage.sources.find(item => item.source === 'init.head' || item.source === 2);
  assert.equal(coverage.state, 'excluded');
});

test('a template-shaped review of a change with an empty added file validates and needs no test for the empty file', () => {
  const snapshot = reviewSnapshot();
  const report = conclude(snapshot);
  validateInspection(report, snapshot);
  assert.equal(approvalHold(report, snapshot), 'no supplied test imports changed production code: pkg/mod.py', 'only the module with code needs a test');
  const only = reviewSnapshot({code: false});
  const alone = conclude(only);
  validateInspection(alone, only);
  assert.equal(approvalHold(alone, only), null, 'an empty package marker has no behaviour to test');
  assert.equal(alone.accounting.length, 1);
});

test('the citation waiver covers only a file whose sources are all blank', () => {
  const snapshot = reviewSnapshot({code: false});
  const report = conclude(snapshot);
  validateInspection(report, snapshot);
  const sourceless = structuredClone(snapshot); delete sourceless.files[0].head_source; refresh(sourceless); report.snapshot = sourceless.digest;
  assert.throws(() => validateInspection(report, sourceless), /accounting lacks direct changed-file evidence/);
  const filled = structuredClone(snapshot); filled.sources['init.head'].content = 'import os\n'; refresh(filled); report.snapshot = filled.digest;
  assert.throws(() => validateInspection(report, filled), /accounting lacks direct changed-file evidence/);
});

test('a file emptied by the change is accounted from its base source and an empty rename needs no citation', () => {
  const sources = {
    contract: {path: 'POLICY.md', ref: BASE, authority: 'trusted', kind: 'contract', content: 'Keep behaviour.\n'},
    verification: {path: 'verification', ref: HEAD, authority: 'trusted', kind: 'verification', content: '{"ok":true}'},
    'a.base': {path: 'pkg/a.py', ref: BASE, authority: 'untrusted', kind: 'source', content: 'x = 1\n'},
    'a.head': {path: 'pkg/a.py', ref: HEAD, authority: 'untrusted', kind: 'source', content: ''},
    'old.base': {path: 'pkg/old.py', ref: BASE, authority: 'untrusted', kind: 'source', content: ''},
    'new.head': {path: 'pkg/new.py', ref: HEAD, authority: 'untrusted', kind: 'source', content: ''},
  };
  const files = [
    {path: 'pkg/a.py', status: 'modified', patch: '@@ -1 +0,0 @@\n-x = 1\n', base_source: 'a.base', head_source: 'a.head'},
    {path: 'pkg/new.py', status: 'renamed', patch: 'diff --git a/pkg/old.py b/pkg/new.py\nsimilarity index 100%\nrename from pkg/old.py\nrename to pkg/new.py\n',
      base_source: 'old.base', head_source: 'new.head'},
  ];
  const snapshot = reviewSnapshot({files}); Object.assign(snapshot.sources, sources); refresh(snapshot);
  const report = conclude(snapshot);
  validateInspection(report, snapshot);
  const emptied = report.accounting.find(item => item.path === 'pkg/a.py');
  assert.ok(emptied.evidence.some(id => report.evidence.find(entry => entry.id === id).source === 'a.base'));
});

function withFinding(snapshot, facts) {
  const proof = proofCatalog(snapshot).find(entry => entry.source === 'contract').id;
  facts.findings.push({id: 'f1', title: 'A concern', cause: 'The module does the wrong thing.', trigger: 'Run it.', consequence: 'It breaks.',
    obligation: 'Fix it.', anchor: proof, blast_radius: 1, repair_paths: ['pkg/__init__.py'],
    opportunity: {mechanical: false, beneficial: false, within_scope: false, verified: false}, evidence: [proof],
    factors: Object.fromEntries(FACTORS.defect.map(name => [name, {reason: 'Observed.', evidence: [proof]}]))});
}

test('a finding that cannot be anchored in an empty file is anchored in the next changed file that has lines', () => {
  const snapshot = reviewSnapshot();
  assert.equal(snapshot.files[0].path, 'pkg/__init__.py');
  const report = conclude(snapshot, facts => withFinding(snapshot, facts));
  assert.equal(report.findings[0].path, 'pkg/mod.py');
  assert.deepEqual(report.findings[0].repair_paths, ['pkg/__init__.py']);
  validateInspection(report, snapshot);
});

test('the first changed line of a file is taken from its base when the change emptied it, and an empty file has none', () => {
  const emptied = reviewSnapshot({files: [{path: 'pkg/a.py', status: 'modified', patch: '@@ -1 +0,0 @@\n-x = 1\n', base_source: 'a.base', head_source: 'init.head'}]});
  emptied.sources['a.base'] = {path: 'pkg/a.py', ref: BASE, authority: 'untrusted', kind: 'source', content: 'x = 1\n'};
  const catalog = new Map(proofCatalog(emptied).map(entry => [entry.id, entry]));
  assert.deepEqual(changedAnchor(emptied.files[0], catalog), {source: 'a.base', start: 1, end: 2});
  assert.equal(changedAnchor({patch: '', head_source: 'init.head'}, catalog), null);
  assert.equal(changedAnchor({patch: ''}, catalog), null);
});

test('a change made only of empty files has nothing to anchor a finding to and the review is refused, not crashed', () => {
  const snapshot = reviewSnapshot({code: false});
  const report = conclude(snapshot);
  validateInspection(report, snapshot);
  assert.throws(() => conclude(snapshot, facts => withFinding(snapshot, facts)), /Technical findings require a concrete changed-source anchor/);
});

// ---------------------------------------------------------------------------------------------------------------
// Partition, unit views and seams.

test('an empty file is costed, partitioned, viewed and seamed like any other changed file', () => {
  const snapshot = reviewSnapshot();
  snapshot.covering_tests = {};
  const table = changeTable(snapshot);
  const row = table.find(item => item.path === 'pkg/__init__.py');
  assert.equal(row.head_size, 0);
  const plan = partition(table);
  const units = plan.units.map(unit => ({id: unit.id, owned: unit.owned, context_ids: []}));
  assert.ok(units.length >= 1);
  for (const unit of units) {
    const view = unitView(snapshot, unit, {units});
    assert.ok(view.change_manifest.some(item => item.path === 'pkg/__init__.py' && item.additions === 0 && item.deletions === 0));
  }
  assert.deepEqual(seamsOf({snapshot, plan: {scheme: plan.scheme, units}}), []);
  const split = {scheme: plan.scheme, units: [{id: 'u0', owned: ['pkg/__init__.py'], context_ids: []}, {id: 'u1', owned: ['pkg/mod.py'], context_ids: []}]};
  assert.deepEqual(seamsOf({snapshot, plan: split}), []);
});

// ---------------------------------------------------------------------------------------------------------------
// Receipt: a signed local snapshot against the hosted file list.

const header = status => `diff --git a/pkg/__init__.py b/pkg/__init__.py\n${status}\n`;

test('a header-only git diff of an empty file equals GitHub reporting no patch', () => {
  const live = {filename: 'pkg/__init__.py', status: 'added'};
  assert.equal(hostedForm(header('new file mode 100644\nindex 0000000..e69de29'), live), '');
  assert.equal(hostedForm(header('deleted file mode 100644\nindex e69de29..0000000'), {...live, status: 'removed'}), '');
  const sources = {'h': {content: ''}, 'b': {content: ''}};
  const snapshot = {sources, files: [{path: 'pkg/__init__.py', status: 'added', head_source: 'h',
    patch: header('new file mode 100644\nindex 0000000..e69de29')}]};
  verifyPatches({snapshot, files: [{filename: 'pkg/__init__.py', status: 'added'}]});
  verifyPatches({snapshot, files: [{filename: 'pkg/__init__.py', status: 'added', patch: ''}]});
  const mismatch = files => assert.throws(() => verifyPatches({snapshot, files}), error => error instanceof ReceiptPatchMismatch);
  mismatch([{filename: 'pkg/__init__.py', status: 'added', patch: '@@ -0,0 +1 @@\n+import os'}]);
  const incomplete = (shot, files) => assert.throws(() => verifyPatches({snapshot: shot, files}), /Changed-file evidence is incomplete/);
  incomplete(snapshot, [{filename: 'pkg/__init__.py', status: 'modified'}]);
  incomplete({...snapshot, sources: {h: {content: 'x = 1\n'}}}, [{filename: 'pkg/__init__.py', status: 'added'}]);
  incomplete({files: snapshot.files}, [{filename: 'pkg/__init__.py', status: 'added'}]);
  incomplete({sources, files: [{...snapshot.files[0], head_source: undefined}]}, [{filename: 'pkg/__init__.py', status: 'added'}]);
  incomplete({sources, files: [{...snapshot.files[0], patch: header('new file mode 100644\nindex 0000000..e69de29').concat('Binary files differ\n')}]},
    [{filename: 'pkg/__init__.py', status: 'added'}]);
});

test('a pure rename and a removal of an empty file verify without a hosted patch, and a changed rename does not', () => {
  const rename = 'diff --git a/pkg/old.py b/pkg/new.py\nsimilarity index 100%\nrename from pkg/old.py\nrename to pkg/new.py\n';
  const snapshot = (baseText, headText) => ({sources: {b: {content: baseText}, h: {content: headText}},
    files: [{path: 'pkg/new.py', status: 'renamed', base_source: 'b', head_source: 'h', patch: rename}]});
  const live = [{filename: 'pkg/new.py', previous_filename: 'pkg/old.py', status: 'renamed'}];
  verifyPatches({snapshot: snapshot('', ''), files: live});
  verifyPatches({snapshot: snapshot('x = 1\n', 'x = 1\n'), files: live});
  assert.throws(() => verifyPatches({snapshot: snapshot('x = 1\n', 'x = 2\n'), files: live}), /Changed-file evidence is incomplete/);
  const removal = {sources: {b: {content: ''}}, files: [{path: 'pkg/gone.py', status: 'removed', base_source: 'b',
    patch: 'diff --git a/pkg/gone.py b/pkg/gone.py\ndeleted file mode 100644\nindex e69de29..0000000\n'}]};
  verifyPatches({snapshot: removal, files: [{filename: 'pkg/gone.py', status: 'removed'}]});
  assert.throws(() => verifyPatches({snapshot: {...removal, sources: {b: {content: 'x'}}}, files: [{filename: 'pkg/gone.py', status: 'removed'}]}),
    /Changed-file evidence is incomplete/);
});

test('a signed local review of a real empty added file verifies against the hosted file list without a patch', () => repository(async f => {
  fs.mkdirSync(path.join(f.directory, 'pkg'));
  fs.writeFileSync(path.join(f.directory, 'pkg/__init__.py'), '');
  fs.writeFileSync(path.join(f.directory, 'pkg/mod.py'), 'x = 1\n');
  git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'feat: add package']);
  const {snapshot} = collectLocal({...f, request: 'Add the package.', technical: {}});
  const empty = snapshot.files.find(file => file.path === 'pkg/__init__.py');
  assert.equal(snapshot.sources[empty.head_source].content, '');
  assert.ok(!empty.patch.includes('@@'));
  const files = hostedFiles(snapshot);
  assert.equal(files.find(file => file.filename === 'pkg/__init__.py').patch, undefined, 'GitHub reports no patch for an empty added file');
  const blob = (ref, name) => git(f.directory, ['show', `${ref}:${name}`]);
  const github = {rest: {repos: {getContent: async ({path: name, ref}) => {
    const text = blob(ref, name);
    return {data: {type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), size: text.length}};
  }}}};
  const pr = {changed_files: files.length, base: {sha: snapshot.base_sha}, head: {sha: snapshot.head_sha, repo: {owner: {login: 'example'}, name: 'local-fixture'}}};
  const options = {github, repo: {owner: 'example', repo: 'local-fixture'}, pr, files, snapshot, config: {readme: 'README.md', repository_policy: 'AGENTS.md'}};
  await verifySources(options);
  const claimed = files.map(file => (file.filename === 'pkg/__init__.py' ? {...file, patch: '@@ -0,0 +1 @@\n+import os'} : file));
  await assert.rejects(verifySources({...options, files: claimed}), ReceiptPatchMismatch);
  fs.writeFileSync(path.join(f.directory, 'pkg/__init__.py'), 'import os\n');
  git(f.directory, ['commit', '-qam', 'feat: fill the package']);
  const filled = collectLocal({...f, request: 'Fill the package.', technical: {}}).snapshot;
  assert.ok(filled.files.find(file => file.path === 'pkg/__init__.py').patch.includes('@@'));
}));

// ---------------------------------------------------------------------------------------------------------------
// Legacy assessment scope check.

test('the assessment scope check accepts an added empty file by its empty blob and still holds an unexplained missing patch', () => {
  const pr = {changed_files: 2};
  const sized = {filename: 'a.py', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b'};
  assert.equal(scopeReason([{filename: 'pkg/__init__.py', status: 'added', sha: EMPTY_BLOB, changes: 0}, sized], pr), null);
  for (const empty of [{filename: 'x.py', status: 'added'}, {filename: 'x.py', status: 'added', sha: EMPTY_BLOB, changes: 1},
    {filename: 'x.py', status: 'modified', sha: EMPTY_BLOB}, {filename: 'x.py', status: 'added', sha: 'f'.repeat(40)}]) {
    assert.equal(scopeReason([empty, sized], pr), 'Incomplete patch or unsupported file change');
  }
});
