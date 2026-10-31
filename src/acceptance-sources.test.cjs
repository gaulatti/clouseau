'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {proofCatalog, safePath, refresh, readSource, collectSnapshot, additionalSources} = require('./acceptance-sources.cjs');
const {packetFor} = require('./acceptance-grading.cjs');

test('controller proof IDs bind bounded immutable spans and remain stable when source context grows', () => {
  const snapshot = {sources: {blank: {content: '\n'}, code: {content: Array.from({length: 85}, (_, i) =>
    i < 40 ? '' : `statement ${i + 1}`).join('\n')}}};
  const proofs = proofCatalog(snapshot);
  assert.deepEqual(proofs, [{id: 'proof-1-41', source: 'code', start: 41, end: 80},
    {id: 'proof-1-81', source: 'code', start: 81, end: 85}]);
  snapshot.sources.other = {content: 'additional source'};
  assert.deepEqual(proofCatalog(snapshot).slice(0, 2), proofs);
});

function fixture() {
  const calls = [];
  const tree = {truncated: false, tree: [
    {type: 'blob', path: 'tests/upload.test.rs', size: 100}, {type: 'blob', path: 'tests/other.test.rs', size: 100},
    {type: 'blob', path: 'tests/upload.huge.test.rs', size: 70000}, {type: 'tree', path: 'tests/upload.dir.test.rs'},
    {type: 'blob', path: 'src/upload.rs', size: 10}, {type: 'blob', path: 'src/upload.test.rs', size: 100000}]};
  const github = {rest: {git: {getTree: async args => ({data: structuredClone(github.tree), args})}, repos: {
    getContent: async args => {calls.push(args); return {data: {content: Buffer.from('A complete fictional source.\n').toString('base64'), encoding: 'base64', size: 30}};},
    listCommits: async () => ({data: [{sha: 'b'.repeat(40), commit: {message: 'fix: preserve durable upload acceptance'}}]}),
  }}, graphql: async () => ({repository: {pullRequest: {closingIssuesReferences: {nodes: [{number: 1, title: 'Repair upload', body: 'Preserve acceptance.'}], pageInfo: {hasNextPage: false}}}}})};
  github.tree = tree;
  return {github, calls, repo: {owner: 'example', repo: 'upload-gateway'},
    pr: {number: 3, changed_files: 1, title: 'fix: preserve upload', body: 'Untrusted contributor claim.', base: {sha: 'b'.repeat(40)}, head: {sha: 'a'.repeat(40), repo: {owner: {login: 'external'}, name: 'fork'}}},
    files: [{filename: 'src/upload.rs', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new'}],
    config: {repository_policy: '.github/clouseau.md', readme: 'README.md'},
    technical: {run_id: 42, head_sha: 'a'.repeat(40), conclusion: 'success'}};
}

test('source collection binds complete base/head blobs, authority, precedent, tickets and runtime identity', async () => {
  const f = fixture();
  const snapshot = await collectSnapshot(f);
  assert.equal(snapshot.repository, 'example/upload-gateway');
  assert.equal(snapshot.head_sha, f.pr.head.sha); assert.equal(snapshot.base_sha, f.pr.base.sha);
  assert.match(snapshot.digest, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.sources[`${f.pr.base.sha}:README.md`].authority, 'trusted');
  assert.equal(snapshot.sources[`${f.pr.head.sha}:src/upload.rs`].authority, 'untrusted');
  assert.equal(snapshot.files[0].base_source, `${f.pr.base.sha}:src/upload.rs`);
  assert.equal(snapshot.sources.verification.authority, 'trusted');
  assert.equal(JSON.parse(snapshot.sources.verification.content).run_id, 42);
  assert.equal(snapshot.history[0].commits[0].message, 'fix: preserve durable upload acceptance');
  assert.equal(snapshot.tickets[0].number, 1);
  assert.equal(snapshot.claims.description, f.pr.body);
  const digest = snapshot.digest;
  await additionalSources({...f, snapshot, paths: ['src/naming.rs']});
  assert.notEqual(snapshot.digest, digest);
  assert.equal(snapshot.sources[`${f.pr.head.sha}:src/naming.rs`].authority, 'untrusted');
  const count = f.calls.length;
  await additionalSources({...f, snapshot, paths: ['src/naming.rs']});
  assert.equal(f.calls.length, count, 'immutable evidence is not refetched');
  assert.ok(f.calls.every(call => [f.pr.head.sha, f.pr.base.sha].includes(call.ref)));
  assert.ok(f.calls.filter(call => call.ref === f.pr.head.sha).every(call => call.owner === 'external' && call.repo === 'fork'));
  assert.ok(f.calls.filter(call => call.ref === f.pr.base.sha).every(call => call.owner === 'example'));
});

test('renamed, added and removed files use only their applicable immutable sources', async () => {
  for (const status of ['renamed', 'added', 'removed']) {
    const f = fixture(); f.files[0].status = status;
    if (status === 'renamed') f.files[0].previous_filename = 'src/old.rs';
    const snapshot = await collectSnapshot(f);
    assert.equal(Boolean(snapshot.files[0].base_source), status !== 'added');
    assert.equal(Boolean(snapshot.files[0].head_source), status !== 'removed');
    assert.equal(snapshot.history.length, status === 'added' ? 0 : 1);
    if (status === 'renamed') assert.ok(snapshot.files[0].base_source.endsWith(':src/old.rs'));
  }
});

test('linked requirements survive source collection, proof selection and atomic grading without gaining authority', async () => {
  const f = fixture();
  const request = {number: 27, title: 'Support the active native coverage consumer',
    body: 'The existing consumer produces Istanbul JSON. Preserve its complete source inventory.',
    url: 'https://github.com/example/upload-gateway/issues/27', author: {login: 'maintainer'}};
  f.github.graphql = async () => ({repository: {pullRequest: {closingIssuesReferences: {
    nodes: [request], pageInfo: {hasNextPage: false}}}}});
  const snapshot = await collectSnapshot(f);
  const proof = proofCatalog(snapshot).find(item => snapshot.sources[item.source].kind === 'requirement');
  assert.ok(proof, 'a linked request must be citable, not stranded outside the proof catalog');
  const source = snapshot.sources[proof.source];
  assert.equal(source.authority, 'untrusted', 'issue authorship cannot grant contract or execution authority');
  assert.deepEqual(JSON.parse(source.content), request);
  const location = {subject: request.title, obligation: 'Preserve exact native coverage', context: {},
    target: {reason: 'The linked request describes the active consumer limitation.', evidence: [proof.id]}};
  const report = {evidence: [proof]};
  const packet = packetFor(location, report, snapshot);
  assert.equal(packet.evidence[0].text, source.content);
  assert.equal(packet.evidence[0].authority, 'untrusted');
  assert.match(packet.evidence[0].text, /Preserve its complete source inventory/);
  request.body = 'Updated requirement; do not reuse the prior assessment.';
  const updated = await collectSnapshot(f);
  const next = proofCatalog(updated).find(item => updated.sources[item.source].kind === 'requirement');
  assert.notEqual(updated.digest, snapshot.digest);
  assert.notEqual(next.source, proof.source, 'changed issue content gets a new immutable source identity');
  assert.notEqual(updated.sources[next.source].ref, source.ref);
});

test('bounded source reader refuses path traversal, binary data, truncation and invalid UTF-8', async () => {
  for (const value of [null, '', '/tmp/code', '../code', 'a/../code', 'a/./code', '.git/config', 'a//b', 'a\\b', 'a\0b', 'x'.repeat(500)]) assert.equal(safePath(value), false);
  assert.equal(safePath('src/module.rs'), true);
  const f = fixture();
  await assert.rejects(readSource({...f, snapshot: {sources: {}}, filename: '../private', ref: f.pr.head.sha}), /Unsafe/);
  await assert.rejects(readSource({...f, snapshot: {sources: {}, head_sha: f.pr.head.sha}, filename: 'src/upload.rs', ref: f.pr.head.sha}), /head repository/);
  for (const data of [{}, {content: '', encoding: 'utf8'}, {content: '', encoding: 'base64', size: 300001},
    {content: Buffer.from('x'.repeat(300001)).toString('base64'), encoding: 'base64'},
    {content: Buffer.from('a\0b').toString('base64'), encoding: 'base64'},
    {content: Buffer.from([0xff]).toString('base64'), encoding: 'base64'}]) {
    f.github.rest.repos.getContent = async () => ({data});
    await assert.rejects(readSource({...f, snapshot: {sources: {}}, filename: 'src/module.rs', ref: f.pr.head.sha}));
  }
});

test('incomplete evidence, unsafe prior paths, oversized packets and truncated linked requirements fail closed', async () => {
  for (const mutate of [
    f => {f.files = [];}, f => {f.pr.changed_files = 2;}, f => {f.files[0].filename = '../code';},
    f => {f.files[0].patch = '';}, f => {f.files[0].status = 'binary';}, f => {f.files[0].previous_filename = '../code';},
    f => {f.pr.head.repo = null;}, f => {f.pr.head.repo.owner = null;}, f => {delete f.pr.head.repo.owner.login;},
    f => {delete f.pr.head.repo.name;},
    f => {f.github.graphql = async () => ({repository: {pullRequest: {closingIssuesReferences: {nodes: [], pageInfo: {hasNextPage: true}}}}});},
  ]) {
    const f = fixture(); mutate(f); await assert.rejects(collectSnapshot(f));
  }
  assert.throws(() => refresh({sources: {large: {content: 'x'.repeat(900001)}}}), /source budget/);
  for (const paths of [null, [], ['same', 'same'], Array(9).fill('file')]) {
    await assert.rejects(additionalSources({...fixture(), snapshot: {sources: {}}, paths}), /one to eight/);
  }
});

test('a review bot summary of the diff is not promoted into the contributor claim', async () => {
  const {contributorClaim} = require('./acceptance-sources.cjs');
  const body = 'Round days down.\n\n## Summary by Sourcery\n\nBug Fixes:\n- Prevent rounding up.\n\n## Notes\nKeep this.\n\n### Summary by CodeRabbit\n- more';
  assert.equal(contributorClaim(body), 'Round days down.\n\n## Notes\nKeep this.');
  assert.equal(contributorClaim(undefined), undefined);
  assert.equal(contributorClaim('Plain description.'), 'Plain description.');
  const f = fixture(); f.pr.body = body;
  assert.ok(!(await collectSnapshot(f)).claims.description.includes('Bug Fixes'));
});

test('existing tests that name a changed production module are supplied with it', async () => {
  const f = fixture();
  const snapshot = await collectSnapshot(f);
  const paths = Object.values(snapshot.sources).filter(source => source.kind === 'source').map(source => source.path).sort();
  assert.deepEqual(paths, ['src/upload.rs', 'src/upload.rs', 'tests/upload.test.rs'], 'only a small blob test whose name carries the module stem');
  assert.equal(snapshot.sources[`${f.pr.head.sha}:tests/upload.test.rs`].ref, f.pr.head.sha);
  const g = fixture(); g.files[0].filename = 'README.md';
  g.github.rest.git.getTree = async () => {throw new Error('documentation needs no test lookup');};
  await collectSnapshot(g);
  const h = fixture(); h.github.tree = {truncated: true, tree: []};
  await assert.rejects(collectSnapshot(h), /too large to locate the existing tests/);
  const budget = fixture();
  budget.github.tree = {truncated: false, tree: Array.from({length: 4}, (_, i) => ({type: 'blob', path: `t/upload${i}.test.rs`, size: 59000}))};
  const limited = await collectSnapshot(budget);
  assert.equal(Object.values(limited.sources).filter(source => source.path.startsWith('t/')).length, 2, 'the evidence budget bounds supplied tests');
});

const BLEECKER_TEST = `import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  formatCompactNumber,
  formatNumber,
  formatRelativeTime
} from '../../src/utils/format';
`;

function bleecker(files, tests = {'tests/unit/format.test.ts': BLEECKER_TEST}) {
  const f = fixture(); const {approvalHold} = require('./acceptance.cjs');
  f.files = files.map(filename => ({filename, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b'})); f.pr.changed_files = files.length;
  f.github.tree = {truncated: false, tree: Object.keys(tests).map(path => ({type: 'blob', path, size: tests[path].length}))};
  const getContent = f.github.rest.repos.getContent;
  f.github.rest.repos.getContent = async args => tests[args.path] !== undefined
    ? {data: {content: Buffer.from(tests[args.path]).toString('base64'), encoding: 'base64', size: tests[args.path].length}} : getContent(args);
  return {f, approvalHold};
}

test('bleecker layout: an unchanged multi-line-import test for a renamed local variable is supplied and links the module (issue 117)', async () => {
  const {f, approvalHold} = bleecker(['src/utils/format.ts']);
  const snapshot = await collectSnapshot(f);
  assert.ok(snapshot.sources[`${f.pr.head.sha}:tests/unit/format.test.ts`], 'the importing test is in the snapshot the reviewers see');
  const gates = [{name: 'test_integrity', state: 'satisfied'}, {name: 'review_completeness', state: 'satisfied'}];
  assert.equal(approvalHold({gates}, snapshot), null);
  for (const specifier of ["'../../src/utils/format.js'", "'@/utils/format'", "'../../src/utils/format.ts'", '"../../src/utils/format/index"']) {
    for (const source of Object.values(snapshot.sources)) if (source.path === 'tests/unit/format.test.ts') source.content = `import {\n  a,\n} from ${specifier};\n`;
    assert.equal(approvalHold({gates}, snapshot), null, specifier);
  }
  for (const source of Object.values(snapshot.sources)) if (source.path === 'tests/unit/format.test.ts') source.content = "import {a} from '../../src/utils/formatter';\n";
  assert.match(approvalHold({gates}, snapshot), /src\/utils\/format\.ts/);
});

test('bleecker layout: a fixtures-only change with an unresolved test gate is not held (issue 116)', async () => {
  const {f, approvalHold} = bleecker(['tests/fixtures/sample-feed-r1.json', 'tests/fixtures/helpers.ts', '__fixtures__/seed.js'], {});
  const snapshot = await collectSnapshot(f);
  assert.equal(approvalHold({gates: [{name: 'test_integrity', state: 'unresolved'}, {name: 'review_completeness', state: 'satisfied'}]}, snapshot), null);
  const completeness = {gates: [{name: 'test_integrity', state: 'satisfied'}, {name: 'review_completeness', state: 'unresolved'}]};
  assert.equal(approvalHold(completeness, snapshot), null, 'a vague unresolved completeness opinion without missing evidence holds nothing (issue 123)');
  snapshot.omitted_sources = [{path: 'x', reason: 'not found at the head revision'}];
  assert.equal(approvalHold(completeness, snapshot), null, 'a data-only change has nothing further to verify, however the reviewer words it (issue 123)');
  snapshot.files.push({path: 'src/app.ts', status: 'modified'});
  assert.match(approvalHold(completeness, snapshot), /review completeness/);
  delete snapshot.omitted_sources;
  assert.match(approvalHold({...completeness, coverage: {sources: [], dependencies: [{path: 'x', state: 'missing'}]}}, snapshot), /review completeness/);
});

test('bleecker layout: optional evidence that is missing, unreadable or over budget is omitted with a reason, never an aborted review (issues 115, 122)', async () => {
  const {f} = bleecker(['src/layout/feed-grid.tsx']);
  const snapshot = await collectSnapshot(f);
  const getContent = f.github.rest.repos.getContent;
  const big = Buffer.from('x'.repeat(100)).toString('base64');
  f.github.rest.repos.getContent = async args => {
    if (args.path.includes('feed-grid.test')) throw Object.assign(new Error('Not Found'), {status: 404});
    if (args.path === 'boom') throw Object.assign(new Error('Server error'), {status: 500});
    if (args.path === 'src') return {data: [{name: 'a'}]};
    if (args.path === 'package-lock.json') return {data: {encoding: 'base64', content: big, size: 400000}};
    if (args.path === 'logo.bin') return {data: {encoding: 'base64', content: Buffer.from('a\0b').toString('base64'), size: 3}};
    if (args.path === 'latin.txt') return {data: {encoding: 'base64', content: Buffer.from([0xff, 0xfe]).toString('base64'), size: 2}};
    if (args.path === 'big.ts') return {data: {encoding: 'base64', content: Buffer.from('y'.repeat(299000)).toString('base64'), size: 299000}};
    return getContent(args);
  };
  const before = snapshot.digest;
  await additionalSources({...f, snapshot, paths: ['tests/unit/feed-grid.test.tsx', 'src', 'package-lock.json', 'logo.bin', 'latin.txt', '../etc/passwd']});
  assert.deepEqual(snapshot.omitted_sources.map(item => item.path), ['tests/unit/feed-grid.test.tsx', 'src', 'package-lock.json', 'logo.bin', 'latin.txt', '../etc/passwd']);
  assert.match(snapshot.omitted_sources[0].reason, /not found/);
  assert.match(snapshot.omitted_sources[1].reason, /complete text/);
  assert.notEqual(snapshot.digest, before, 'the reviewer sees new information');
  await additionalSources({...f, snapshot, paths: ['tests/unit/feed-grid.test.tsx', 'src/real.ts']});
  assert.equal(snapshot.omitted_sources.filter(item => item.path === 'tests/unit/feed-grid.test.tsx').length, 1);
  assert.ok(snapshot.sources[`${f.pr.head.sha}:src/real.ts`]);
  await assert.rejects(additionalSources({...f, snapshot, paths: ['boom']}), /Server error/);
  snapshot.filler = 'z'.repeat(700000);
  await additionalSources({...f, snapshot, paths: ['big.ts', 'big2.ts']});
  assert.ok(snapshot.omitted_sources.some(item => item.path === 'big.ts' && /total evidence budget/.test(item.reason)), 'priority: what is already supplied stays, the addition is omitted');
  assert.ok(!snapshot.sources[`${f.pr.head.sha}:big.ts`]);
});

test('a changed file that cannot be read in full still fails closed', async () => {
  const f = fixture();
  f.github.rest.repos.getContent = async () => ({data: {encoding: 'base64', content: 'AAAA', size: 400000}});
  await assert.rejects(collectSnapshot(f), /unavailable within the evidence budget/);
});

test('a prefetched test that vanished between base and head is omitted, not fatal (base moved)', async () => {
  const f = fixture();
  const getContent = f.github.rest.repos.getContent;
  f.github.rest.repos.getContent = async args => {
    if (args.path === 'tests/upload.test.rs') throw Object.assign(new Error('Not Found'), {status: 404});
    return getContent(args);
  };
  const snapshot = await collectSnapshot(f);
  assert.deepEqual(snapshot.omitted_sources, [{path: 'tests/upload.test.rs', reason: 'not found at the head revision'}]);
});


test('bleecker layout (lab4): importers are found by content, through callers and barrels, and orphans stay held (issue 127)', async () => {
  const contents = {
    'tests/unit/utils.test.ts': "import { createAttentionColor } from '../../src/utils/attention-color';\n",
    'tests/unit/navigation-feed.test.tsx': "import { FeedItem } from '../../src/components/feed-item';\n",
    'tests/unit/barrel.test.ts': "import { Thing } from '../../src';\n",
    'src/index.ts': "export * from './components/thing';\n",
    'src/components/thing.tsx': 'export const Thing = 1;\n',
  };
  const gates = [{name: 'test_integrity', state: 'satisfied'}, {name: 'review_completeness', state: 'satisfied'}];
  const cases = [
    [['src/utils/attention-color.ts'], null],
    [['src/components/feed-item.tsx'], null],
    [['src/components/thing.tsx'], null],
    [['src/utils/orphan.ts'], /orphan\.ts/],
  ];
  for (const [files, expected] of cases) {
    const {f, approvalHold} = bleecker(files, contents);
    const snapshot = await collectSnapshot(f);
    const hold = approvalHold({gates}, snapshot);
    if (expected) assert.match(hold, expected); else assert.equal(hold, null, files.join());
  }
  const {f, approvalHold} = bleecker(['src/utils/helper.ts', 'src/components/feed-item.tsx'], {
    ...contents, 'src/components/feed-item.tsx': "import { resolveFallback } from '../utils/helper';\nexport const FeedItem = 1;\n"});
  f.files[0].status = 'added';
  const snapshot = await collectSnapshot(f);
  assert.deepEqual(snapshot.test_imports.map(item => item.path).sort(), ['tests/unit/barrel.test.ts', 'tests/unit/navigation-feed.test.tsx', 'tests/unit/utils.test.ts']);
  assert.equal(approvalHold({gates}, snapshot), null, 'an added helper is covered through the changed caller a test imports');
  assert.ok(!Object.values(snapshot.sources).some(source => source.path === 'tests/unit/utils.test.ts'), 'content-found importers keep only their specifiers in the reviewers evidence');
});

test('content discovery of importers skips tests that vanished or are not text, and fails on a real error', async () => {
  const names = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'];
  const run = async behaviours => {
    const {f} = bleecker(['src/utils/helper.ts'], {});
    f.github.tree = {truncated: false, tree: names.map(path => ({type: 'blob', path, size: 100}))};
    f.github.rest.repos.getContent = async args => {
      if (behaviours[args.path] === 404) throw Object.assign(new Error('Not Found'), {status: 404});
      if (behaviours[args.path] === 'big') return {data: {encoding: 'base64', content: 'AAAA', size: 400000}};
      if (behaviours[args.path] === 500) throw Object.assign(new Error('Server error'), {status: 500});
      return {data: {encoding: 'base64', content: Buffer.from("import {a} from '../src/utils/helper';\n").toString('base64'), size: 40}};
    };
    return collectSnapshot(f);
  };
  const snapshot = await run({'tests/a.test.ts': 404, 'tests/b.test.ts': 'big'});
  assert.deepEqual(snapshot.test_imports.map(item => item.path), ['tests/c.test.ts']);
  await assert.rejects(run({'tests/b.test.ts': 500}), /Server error/);
});

test('bleecker layout (lab5): extracted helper, private rename and type-only import split (issue 130)', async () => {
  const stories = Object.fromEntries(Array.from({length: 250}, (_, i) => [`src/components/widget-${String(i).padStart(3, '0')}.stories.tsx`, "import { Widget } from './widget';\n"]));
  const contents = {...stories,
    'tests/unit/utils.test.ts': "import { createAttentionColor } from '../../src/utils/attention-color';\n",
    'src/utils/attention-color.ts': "import { normalizeHue } from './normalize-hue';\nexport const createAttentionColor = 1;\n",
  };
  const gates = [{name: 'test_integrity', state: 'unresolved'}, {name: 'review_completeness', state: 'satisfied'}];
  // H1-2: normalizeHue moved to a NEW file imported by the changed attention-color.ts that utils.test.ts covers.
  const helper = bleecker(['src/utils/normalize-hue.ts', 'src/utils/attention-color.ts'], contents);
  helper.f.files[0].status = 'added';
  const extracted = await collectSnapshot(helper.f);
  assert.deepEqual(extracted.covering_tests, {'src/utils/normalize-hue.ts': ['tests/unit/utils.test.ts'], 'src/utils/attention-color.ts': ['tests/unit/utils.test.ts']});
  assert.equal(helper.approvalHold({gates: [{...gates[0], state: 'satisfied'}, gates[1]]}, extracted), null);
  assert.deepEqual(extracted.importer_scan, {tests_found: 251, tests_scanned: 1}, 'real tests are scanned before Storybook fixtures and the scan stops once everything is covered: 1 request, not 200');
  assert.ok(extracted.test_imports.some(item => item.path === 'tests/unit/utils.test.ts'), 'utils.test.ts sorts after 250 stories by path but is scanned first');
  // An orphan keeps the scan going, but it is bounded at 100 reads in total.
  const orphanScan = bleecker(['src/utils/orphan.ts'], contents);
  const scanned = await collectSnapshot(orphanScan.f);
  assert.deepEqual(scanned.importer_scan, {tests_found: 251, tests_scanned: 100});
  // P-REN-1: private rename inside attention-color.ts; its test has a different name.
  const rename = bleecker(['src/utils/attention-color.ts'], contents);
  assert.equal(rename.approvalHold({gates: [{...gates[0], state: 'satisfied'}, gates[1]]}, await collectSnapshot(rename.f)), null);
  // H3-1: splitting `import { Input, type InputProps }` changes only import lines: no runtime behaviour, no test needed.
  const split = bleecker(['src/components/search-input.tsx'], {});
  split.f.files[0].patch = "@@ -1 +1,2 @@\n-import { Input, type InputProps } from './input';\n+import type { InputProps } from './input';\n+import { Input } from './input';";
  const typeOnly = await collectSnapshot(split.f);
  assert.equal(split.approvalHold({gates}, typeOnly), null, 'neither the import hold nor the test gate applies');
  // Fail-closed: an orphan, and a behavioural edit of the same file, are still held.
  const orphan = bleecker(['src/utils/orphan.ts'], contents);
  assert.match(orphan.approvalHold({gates: [{...gates[0], state: 'satisfied'}, gates[1]]}, await collectSnapshot(orphan.f)), /orphan\.ts/);
  for (const patch of ["-import {clamp} from './safe';\n+import {clamp} from './evil';", "+import './side-effect';", "+import x from 'y'; doEvil()"]) {
    split.f.files[0].patch = `@@ -1 +1 @@\n${patch}`;
    const hold = split.approvalHold({gates}, await collectSnapshot(split.f));
    assert.match(hold, /test integrity is unresolved/, patch);
    assert.match(split.approvalHold({gates: [{...gates[0], state: 'satisfied'}, gates[1]]}, await collectSnapshot(split.f)), /no supplied test imports changed production code/, patch);
  }
  split.f.files[0].patch = "@@ -1 +1 @@\n-import { Input } from './input';\n+import { Input } from './input2';\n+export const behaviour = 1;";
  assert.match(split.approvalHold({gates}, await collectSnapshot(split.f)), /test integrity is unresolved/);
});
