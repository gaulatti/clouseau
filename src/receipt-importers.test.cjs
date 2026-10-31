'use strict';

// A signed local receipt was held with "no supplied test imports changed production code: src/acceptance-controller.cjs,
// src/base-reconcile.cjs" although src/acceptance-controller.test.cjs and src/base-reconcile.test.cjs require them. The local
// snapshot holds only what the local reviewer fetched; the hosted review discovers importers in the repository. Both now use the
// same discovery. These tests run it against this repository's own layout and files.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {approvalHold, specifiersOf, resolveSpecifier, isTestPath, coveringTests} = require('./acceptance.cjs');
const {supplyTests} = require('./acceptance-sources.cjs');
const {receiptHold, withDiscovery} = require('./acceptance-controller.cjs');

const root = path.join(__dirname, '..');
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
function listing(directory) {
  return fs.readdirSync(path.join(root, directory)).filter(name => fs.statSync(path.join(root, directory, name)).isFile())
    .map(name => ({type: 'blob', path: `${directory}/${name}`, size: fs.statSync(path.join(root, directory, name)).size}));
}
const tree = [...listing('src'), ...listing('test')];
let reads = 0;
const github = {rest: {git: {getTree: async () => ({data: {truncated: false, tree}})}, repos: {getContent: async ({path: file}) => {
  reads++;
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  return {data: {content: Buffer.from(content).toString('base64'), encoding: 'base64', size: content.length}};
}}}};
const repo = {owner: 'gaulatti', repo: 'clouseau'};

// What the local reviewer fetched: only the changed production files at the head revision.
function localSnapshot(changed) {
  const sources = Object.fromEntries(changed.map((file, index) => [`head:${file}`, {path: file, ref: HEAD, kind: 'source', authority: 'untrusted', content: fs.readFileSync(path.join(root, file), 'utf8')}]));
  sources['local-request'] = {path: 'local-request', ref: 'r', kind: 'requirement', authority: 'untrusted', content: 'x'};
  return {base_sha: BASE, head_sha: HEAD, head_repository: repo, sources, paths: changed,
    files: changed.map(file => ({path: file, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b'}))};
}
const gates = {gates: [{name: 'test_integrity', state: 'satisfied'}, {name: 'review_completeness', state: 'satisfied'}]};

test("this repository's own CommonJS tests are found as importers for a signed local receipt (the #148 hold)", async () => {
  const changed = ['src/acceptance-controller.cjs', 'src/base-reconcile.cjs'];
  const local = localSnapshot(changed);
  assert.equal(approvalHold(gates, local), `no supplied test imports changed production code: ${changed.join(', ')}`, 'reproduced: the local snapshot alone holds');
  const discovered = structuredClone(local);
  await supplyTests({github, repo, snapshot: discovered, files: discovered.files.map(file => ({filename: file.path, status: file.status})), baseSha: BASE, headSha: HEAD});
  assert.equal(approvalHold(gates, discovered), null, 'with the shared discovery the receipt is held by the same rule as hosted CI, and passes');
  const covering = coveringTests(discovered);
  for (const file of changed) assert.ok(covering[file].length > 0 && covering[file].every(test => isTestPath(test)), `${file} is covered by ${covering[file]}`);
  assert.ok(reads < 120, `lazy and bounded: ${reads} reads`);
  assert.equal(local.test_imports, undefined, 'the signed record itself is not altered');
});

test('an orphan production file in this layout is still held after discovery (no weaker rule)', async () => {
  const orphan = localSnapshot(['src/incomplete.cjs']);
  orphan.files[0].path = 'src/zz-orphan-module.cjs'; orphan.sources['head:src/incomplete.cjs'].path = 'src/zz-orphan-module.cjs';
  await supplyTests({github, repo, snapshot: orphan, files: [{filename: 'src/zz-orphan-module.cjs', status: 'modified'}], baseSha: BASE, headSha: HEAD});
  assert.match(approvalHold(gates, orphan), /no supplied test imports changed production code: src\/zz-orphan-module\.cjs/);
});

test('CommonJS and ESM import forms, extensions and test-file names are all recognised', () => {
  const forms = `const a = require('./a');
const { b } = require('./b.cjs');
const c = require('./c.js'), d = require('./d.mjs');
const { createRequire } = require('node:module');
const req = createRequire(import.meta.url);
const e = req('./not-detected-alias');
const f = await import('./f.ts');
import g from './g.tsx';
import { h } from "./h.mjs";
export * from './i';
require('./j');
foo(require('./not-a-declaration'));
// const hidden = require('./comment');
test('const t = require("./title")', () => {});
`;
  assert.deepEqual(specifiersOf(forms).sort(), ['./a', './b.cjs', './c.js', './d.mjs', './f.ts', './g.tsx', './h.mjs', './i', './j', 'node:module'].sort());
  const known = ['src/a.cjs', 'src/b.cjs', 'src/c.js', 'src/d.mjs', 'src/f.ts', 'src/g.tsx', 'src/h.mjs', 'src/i/index.ts', 'src/j.js'];
  const from = 'src/x.test.cjs';
  for (const specifier of ['./a', './b.cjs', './c.js', './d.mjs', './f.ts', './g.tsx', './h.mjs', './i', './j']) {
    assert.equal(resolveSpecifier(from, specifier, known).length, 1, specifier);
  }
  for (const name of ['src/a.test.cjs', 'src/a.spec.mjs', 'test/helper.cjs', 'tests/unit/a.ts', 'src/__tests__/a.js', 'src/a.stories.tsx', 'pkg/test_a.py', 'a_test.go']) assert.ok(isTestPath(name), name);
  for (const name of ['src/a.cjs', 'src/contest.cjs', 'src/latest/a.cjs']) assert.ok(!isTestPath(name), name);
});

test('the controller check of a signed local receipt uses that discovery, for every role, without altering the record', async () => {
  const changed = ['src/acceptance-controller.cjs', 'src/base-reconcile.cjs'];
  const snapshot = localSnapshot(changed); const before = JSON.stringify(snapshot);
  const reviews = [{report: gates}, {report: gates}];
  const passing = await receiptHold({github, repo, snapshot, reviews});
  assert.equal(passing.hold, undefined, 'both roles pass: nothing holds the receipt');
  assert.ok(passing.discovery.test_imports.length > 0, 'and the discovery is returned to be stored in the record');
  assert.equal(JSON.stringify(snapshot), before, 'the signed snapshot is untouched');
  const orphan = localSnapshot(['src/incomplete.cjs']);
  orphan.files[0].path = 'src/zz-orphan-module.cjs'; orphan.sources['head:src/incomplete.cjs'].path = 'src/zz-orphan-module.cjs';
  assert.match((await receiptHold({github, repo, snapshot: orphan, reviews})).hold, /no supplied test imports changed production code: src\/zz-orphan-module\.cjs/);
  const unresolved = {gates: [{name: 'test_integrity', state: 'unresolved'}, {name: 'review_completeness', state: 'satisfied'}]};
  assert.equal((await receiptHold({github, repo, snapshot, reviews: [{report: gates}, {report: unresolved}]})).hold, 'test integrity is unresolved', 'the second role can hold it');
});

test('assessment and gate derive the same hold from the same stored inputs, and a lost discovery fails closed', async () => {
  const changed = ['src/acceptance-controller.cjs', 'src/base-reconcile.cjs'];
  const snapshot = localSnapshot(changed);
  const reviews = [{report: gates}, {report: gates}];
  const assessed = await receiptHold({github, repo, snapshot, reviews});
  // The gate sees the discovery only as stored in the record (JSON), never the repository.
  const stored = JSON.parse(JSON.stringify(assessed.discovery));
  const derivedAtGate = reviews.map(review => approvalHold(review.report, withDiscovery(snapshot, stored))).find(Boolean);
  assert.equal(derivedAtGate, assessed.hold, 'one function, one input, one answer');
  assert.equal(derivedAtGate, undefined);
  // A record whose discovery was dropped or emptied can no longer prove coverage: it holds, so the gate disagrees with an
  // 'auto_approve' assessment and refuses (a visible decision mismatch), never approving.
  for (const lost of [{test_imports: [], sources: {}}]) {
    const lostHold = reviews.map(review => approvalHold(review.report, withDiscovery(snapshot, lost))).find(Boolean);
    assert.match(lostHold, /no supplied test imports changed production code/);
  }
  assert.match(reviews.map(review => approvalHold(review.report, snapshot)).find(Boolean), /no supplied test imports/, 'and no discovery at all holds');
});
