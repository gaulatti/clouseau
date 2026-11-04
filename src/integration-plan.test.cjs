'use strict';

// Which seams the integration pass sees (integration-plan.cjs) and the excerpt helpers (seam-excerpts.cjs).

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {RANK, selectSeams, overflowEntry} = require('./integration-plan.cjs');
const {LIMITS, importerLines, calleeLines, removedLines, excerptOf} = require('./seam-excerpts.cjs');

const seam = (id, kind, exports) => ({id, kind, ...(exports ? {exports} : {})});

test('seams are ranked removed import, export consumer (more exports first), test subject, plain import, then by id', () => {
  const seams = [seam('s9', 'import'), seam('s8', 'test_subject'), seam('s7', 'export_consumer', ['a']), seam('s6', 'export_consumer', ['a', 'b']),
    seam('s5', 'removed_import'), seam('s4', 'unknown'), seam('s3', 'import'), seam('s2', 'export_consumer', ['c'])];
  const {reviewed, overflow} = selectSeams(seams, 100);
  assert.deepEqual(reviewed.map(item => item.id), ['s5', 's6', 's2', 's7', 's8', 's3', 's9', 's4']);
  assert.deepEqual(overflow, []);
  assert.deepEqual(Object.keys(RANK), ['removed_import', 'export_consumer', 'test_subject', 'import']);
});

test('the seams beyond the limit are overflow, least relevant last, and the input is not reordered in place', () => {
  const seams = [seam('s2', 'import'), seam('s1', 'removed_import'), seam('s3', 'import')];
  const {reviewed, overflow} = selectSeams(seams, 2);
  assert.deepEqual([reviewed.map(item => item.id), overflow.map(item => item.id)], [['s1', 's2'], ['s3']]);
  assert.deepEqual(seams.map(item => item.id), ['s2', 's1', 's3']);
  assert.deepEqual(overflowEntry(overflow, 2), {seams: ['s3'], unreviewed: true,
    dispositions: [{seam: 's3', state: 'missing', reason: 'Not examined: beyond the 2 most relevant seams the integration pass may be given.'}]});
});

test('importer lines are the import first, then the uses of consumed names, numbered and trimmed', () => {
  const content = "const a = 1;\n  import {read} from './store';\nread(a);\nconst readonly = 1;\n";
  assert.deepEqual(importerLines(content, './store', ['read']), ["2: import {read} from './store';", '3: read(a);']);
  assert.deepEqual(importerLines(content, './store', []), ["2: import {read} from './store';"]);
  assert.deepEqual(importerLines(content, './missing', []), []);
});

test('callee lines are the changed lines touching a consumed name, or the changed export lines when none is named', () => {
  const patch = '--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n context read\n-export function read() {}\n+export function read(id) {}\n+const hidden = 1;\n+module.exports = {read};\n';
  assert.deepEqual(calleeLines(patch, ['read']), ['-export function read() {}', '+export function read(id) {}', '+module.exports = {read};']);
  assert.deepEqual(calleeLines(patch, []), ['-export function read() {}', '+export function read(id) {}', '+module.exports = {read};']);
  assert.deepEqual(calleeLines(patch, ['absent']), []);
  assert.deepEqual(removedLines(patch), ['-export function read() {}']);
});

test('an excerpt keeps at most the line limit, cuts long lines and the character cap, and says so', () => {
  const snapshot = {sources: {}, files: []};
  const file = {path: 'a.ts', status: 'modified', patch: '@@ -1 +1,2 @@\n-old\n+new\n+newer\n'};
  const plain = excerptOf({snapshot, file, unit: 'u0', candidates: ['one', 'two'], excerptCap: 100});
  assert.deepEqual(plain, {path: 'a.ts', unit: 'u0', status: 'modified', added: 2, removed: 1, lines: ['one', 'two'], truncated: false});
  const many = excerptOf({snapshot, file, unit: 'u0', candidates: Array.from({length: LIMITS.excerptLines + 2}, (_, i) => `l${i}`), excerptCap: 1000});
  assert.equal(many.lines.length, LIMITS.excerptLines);
  assert.equal(many.truncated, true);
  const long = excerptOf({snapshot, file, unit: 'u0', candidates: ['x'.repeat(LIMITS.lineCap + 5)], excerptCap: 1000});
  assert.deepEqual([long.lines[0].length, long.truncated], [LIMITS.lineCap, true]);
  const capped = excerptOf({snapshot, file, unit: 'u0', candidates: ['aaaa', 'bbbb', 'cc'], excerptCap: 6});
  assert.deepEqual([capped.lines, capped.truncated], [['aaaa', 'cc'], true]);
  const few = excerptOf({snapshot, file, unit: 'u0', candidates: ['aa', 'bb', 'cc'], excerptCap: 1000, excerptLines: 2});
  assert.deepEqual([few.lines, few.truncated], [['aa', 'bb'], true]);
});
