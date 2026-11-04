'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {weight, segmentLimit, changeTable} = require('./change-table.cjs');
const {escaped} = require('./file-segments.cjs');
const {DEFAULTS} = require('./review-partition.cjs');

const source = (path, content) => ({path, ref: 'r', authority: 'untrusted', kind: 'source', content});

test('a size is the larger of the characters and the escaped length without the planner margin', () => {
  assert.equal(weight('abc'), 3);
  const quotes = '"'.repeat(1000);
  assert.equal(escaped(quotes), 2000);
  assert.equal(weight(quotes), Math.ceil(2000 / 1.03));
  assert.equal(weight(''), 0);
});

test('the segment limit keeps a segment, once inflated and given its entry overhead, within the unit ceiling', () => {
  const limit = segmentLimit();
  assert.equal(limit, Math.floor((DEFAULTS.unit_ceiling - DEFAULTS.file_overhead) / 1.03));
  assert.ok(Math.ceil(1.03 * limit) + DEFAULTS.file_overhead <= DEFAULTS.unit_ceiling);
  assert.equal(segmentLimit({unit_ceiling: 1000, file_overhead: 0}), 970);
  assert.throws(() => segmentLimit({unit_ceiling: 0}), /invalid partition parameter/);
});

test('the table is read from the stored snapshot: renames, derived summaries, and segments only for files too large for a unit', () => {
  const lines = Array.from({length: 3000}, (_, index) => `line ${index}`).join('\n') + '\n';
  const edited = lines.replace('line 5\n', 'line five\n').replace('line 2500\n', 'line 2500x\n');
  const sources = {
    'old.base': source('src/old.txt', 'old\n'), 'new.head': source('src/new.txt', 'new\n'),
    'big.base': source('big.txt', lines), 'big.head': source('big.txt', edited),
    'lock.head': {path: 'pnpm-lock.yaml', ref: 'r', authority: 'derived', kind: 'lockfile-summary', content: 'summary\n'},
  };
  const files = [
    {path: 'src/new.txt', status: 'renamed', patch: '@@ -1,1 +1,1 @@\n-old\n+new\n', base_source: 'old.base', head_source: 'new.head'},
    {path: 'big.txt', status: 'modified', base_source: 'big.base', head_source: 'big.head',
      patch: '@@ -5,1 +5,1 @@\n-line 5\n+line five\n@@ -2500,1 +2500,1 @@\n-line 2500\n+line 2500x\n'},
    {path: 'pnpm-lock.yaml', status: 'modified', lockfile: true, patch: '# replaced\n', base_source: 'lock.head', head_source: 'lock.head'},
  ];
  const snapshot = {sources, files, paths: files.map(file => file.path)};
  const params = {unit_ceiling: 6000, shared: 100, budget: 20000, reserve: 5000, file_overhead: 0};
  const rows = changeTable(snapshot, params);
  assert.deepEqual(rows[0], {path: 'src/new.txt', previous: 'src/old.txt', base_size: 5, head_size: 5, patch_chars: 29});
  assert.equal(rows[1].previous, null);
  assert.equal(rows[1].base_size, weight(lines));
  assert.ok(rows[1].segments.length >= 2 && rows[1].segments.every(size => size <= segmentLimit(params)));
  assert.deepEqual(rows[2], {path: 'pnpm-lock.yaml', previous: null, base_size: 9, head_size: 9, patch_chars: 12, derived_size: 9});
  // With the default parameters the same change is small enough for one unit and carries no segments.
  assert.equal(changeTable(snapshot)[1].segments, undefined);
});
