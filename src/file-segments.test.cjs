'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {patchOf} = require('./acceptance.cjs');
const {MARGIN, SegmentError, escaped, chunks, piecesOf, segmentCosts, segmentView} = require('./file-segments.cjs');

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
const source = (name, content, ref) => ({path: name, ref, authority: 'untrusted', kind: 'source', content});
const numbered = (count, prefix = 'line') => Array.from({length: count}, (_, index) => `${prefix} ${index + 1}`);

// A snapshot with one changed file, its sources and its patch.
function changeOf({name = 'a.txt', base = null, head = null, patch, status, stored}) {
  const sources = {};
  const file = {path: name, status: status ?? (base === null ? 'added' : head === null ? 'removed' : 'modified'), patch: stored ?? patch};
  if (base !== null) {sources.base = source(name, base, BASE); file.base_source = 'base';}
  if (head !== null) {sources.head = source(name, head, HEAD); file.head_source = 'head';}
  return {snapshot: {sources, files: [file], paths: [name]}, file};
}

// The real `git diff` of two texts, so the segments are tested on genuine unified diffs.
function diffOf(base, head, name = 'a.txt') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'segments-'));
  try {
    const run = args => cp.spawnSync('git', ['-C', directory, ...args], {encoding: 'utf8', maxBuffer: 1 << 28});
    run(['init', '-q']); run(['config', 'user.email', 'a@b']); run(['config', 'user.name', 'n']);
    if (base !== null) {fs.writeFileSync(path.join(directory, name), base); run(['add', '.']); run(['commit', '-q', '-m', 'base']);} else run(['commit', '-q', '--allow-empty', '-m', 'base']);
    const baseSha = run(['rev-parse', 'HEAD']).stdout.trim();
    if (head !== null) fs.writeFileSync(path.join(directory, name), head); else fs.rmSync(path.join(directory, name));
    run(['add', '-A']); run(['commit', '-q', '-m', 'head']);
    return run(['diff', '--no-ext-diff', '--no-textconv', baseSha, 'HEAD']).stdout;
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
}

const rowsOf = patch => patch.split('\n').filter(line => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line));

// Every changed row of the patch is in exactly one segment, in order, and every cited line is in its window.
function assertCovers({snapshot, file}, limit) {
  const count = segmentCosts(snapshot, file, limit).length;
  const original = rowsOf(patchOf(snapshot, file));
  const seen = [];
  for (let index = 0; index < count; index++) {
    const view = segmentView(snapshot, file, index, limit);
    const text = patchOf({sources: {...snapshot.sources, ...view.sources}}, view.file);
    seen.push(...rowsOf(text));
    assert.equal(view.file.segment.index, index); assert.equal(view.file.segment.count, count);
    for (const [id, window] of Object.entries(view.sources)) {
      const whole = snapshot.sources[window.segment.source].content.split('\n');
      const lines = window.content.split('\n');
      // Segment line k is combined line start_line + k - 1, as a whole line or, for a cut long line, a piece of it.
      lines.forEach((line, k) => {
        const original = whole[window.segment.start_line - 1 + k];
        assert.ok(original !== undefined && (k === 0 || k === lines.length - 1 ? original.includes(line) : original === line), `${id} line ${k + 1}`);
      });
      assert.equal(window.segment.index, index);
    }
  }
  // Pieces of one long line are one line again when the rows are read back as text.
  assert.equal(seen.map(row => row.slice(1)).join(''), original.map(row => row.slice(1)).join(''));
  return count;
}

test('chunks cut text by escaped size, never splitting a surrogate pair, and reassemble exactly', () => {
  assert.deepEqual(chunks('short', 64), ['short']);
  const text = 'x'.repeat(1000);
  const pieces = chunks(text, 100);
  assert.equal(pieces.length, 10);
  assert.equal(pieces.join(''), text);
  // Escape-dense text (a quote costs two) is cut by what it stores as, not by its length.
  const dense = '"'.repeat(300);
  const cut = chunks(dense, 100);
  assert.ok(cut.every(piece => escaped(piece) <= 100) && cut.length >= 6);
  assert.equal(cut.join(''), dense);
  // A control character costs six; a pair that straddles a cut stays together.
  assert.ok(chunks('\u0000'.repeat(40), 64).every(piece => escaped(piece) <= 64));
  const pairs = '😀'.repeat(100);
  const halves = chunks(pairs, 65);
  assert.equal(halves.join(''), pairs);
  assert.ok(halves.every(piece => !/^[\uDC00-\uDFFF]/.test(piece) && !/[\uD800-\uDBFF]$/.test(piece)));
  // A cut that would land inside a pair (the lone half is cheap enough to fit) moves one character back.
  const straddle = `${'x'.repeat(31)}${'😀'.repeat(20)}`;
  assert.equal(chunks(straddle, 64).join(''), straddle);
  assert.ok(chunks(straddle, 64).every(piece => !/[\uD800-\uDBFF]$/.test(piece)));
  // The smallest piece still progresses when every character is escaped.
  assert.equal(chunks('\u0001'.repeat(30), 6).join(''), '\u0001'.repeat(30));
  assert.equal(escaped('a"b\n'), 6);
});

test('pieces keep the line structure, cut a long line, and price windows', () => {
  const pieces = piecesOf('ab\ncdefghij\n', 4);
  assert.deepEqual(pieces.texts, ['ab', 'cdef', 'ghij', '']);
  assert.deepEqual(pieces.lines, [1, 2, 2, 3]);
  assert.deepEqual(pieces.first, [0, 1, 3]);
  assert.deepEqual(pieces.prefix, [0, 4, 8, 14, 14]);
  assert.equal(piecesOf('', 64).texts.length, 1);
});

test('a small change is one segment: its patch, and the lines around it with a margin', () => {
  const base = numbered(100).join('\n') + '\n';
  const headLines = numbered(100); headLines[49] = 'CHANGED 50'; headLines.splice(60, 0, 'inserted');
  const head = headLines.join('\n') + '\n';
  const change = changeOf({base, head, patch: diffOf(base, head)});
  const view = segmentView(change.snapshot, change.file, 0, 1000000);
  assert.deepEqual(segmentCosts(change.snapshot, change.file, 1000000).length, 1);
  assert.equal(view.file.patch, change.file.patch);
  assert.deepEqual(Object.keys(view.sources), ['base#s0', 'head#s0']);
  // Hunk lines 47-53 and 58-64, plus MARGIN lines each side, form one window per side.
  const head0 = view.sources['head#s0'];
  assert.equal(head0.segment.start_line, 47 - MARGIN);
  assert.equal(head0.content.split('\n')[0], 'line 35');
  assert.deepEqual(head0.segment, {source: 'head', index: 0, count: 1, start_line: 35});
  assert.ok(head0.content.includes('CHANGED 50') && head0.content.includes('inserted'));
  assert.equal(view.file.base_source, 'base#s0'); assert.equal(view.file.head_source, 'head#s0');
  assert.equal(assertCovers(change, 1000000), 1);
});

test('a large change is cut into segments, each with its own rows, sub-hunk headers and windows', () => {
  const base = numbered(600).join('\n') + '\n';
  const headLines = numbered(600).map((line, index) => (index % 7 === 0 ? `${line} edited` : line));
  const head = headLines.join('\n') + '\n';
  const change = changeOf({base, head, patch: diffOf(base, head)});
  const count = assertCovers(change, 2500);
  assert.ok(count >= 3);
  const costs = segmentCosts(change.snapshot, change.file, 2500);
  assert.ok(costs.every(cost => cost <= 2500));
  const second = segmentView(change.snapshot, change.file, 1, 2500);
  // A sub-hunk header counts exactly the rows it carries.
  for (const match of second.file.patch.matchAll(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@\n((?:[ +-].*\n)*)/g)) {
    const body = match[5].split('\n').filter(Boolean);
    assert.equal(Number(match[2]), body.filter(line => line[0] !== '+').length);
    assert.equal(Number(match[4]), body.filter(line => line[0] !== '-').length);
  }
  assert.ok(second.file.patch.startsWith('diff --git a/a.txt b/a.txt\n'));
});

test('segments are a function of the snapshot alone: the same segments from a fresh copy, cached per limit', () => {
  const base = numbered(300).join('\n') + '\n';
  const head = base.replaceAll('line 1', 'LINE 1');
  const change = changeOf({base, head, patch: diffOf(base, head)});
  const first = segmentCosts(change.snapshot, change.file, 3000);
  assert.deepEqual(segmentCosts(structuredClone(change.snapshot), structuredClone(change.file), 3000), first);
  assert.equal(segmentView(change.snapshot, change.file, 0, 3000).file.patch, segmentView(change.snapshot, change.file, 0, 3000).file.patch);
  assert.notDeepEqual(segmentCosts(change.snapshot, change.file, 1500), first);
});

test('a file added whole is split into line ranges and stored compactly, with its body once in the head window', () => {
  const head = numbered(400).join('\n') + '\n';
  const patch = diffOf(null, head);
  const change = changeOf({head, patch});
  const count = assertCovers(change, 2000);
  assert.ok(count >= 3);
  const middle = segmentView(change.snapshot, change.file, 1, 2000);
  assert.equal(middle.file.patch_body, 'head_source');
  assert.match(middle.file.patch, /@@ -0,0 \+\d+,\d+ @@\n$/);
  assert.ok(middle.sources['head#s1'].content.endsWith('\n'));
  assert.equal(middle.file.base_source, undefined);
  // The compact patch restores to the plain rows of that range.
  const restored = patchOf({sources: middle.sources}, middle.file);
  assert.equal(rowsOf(restored).join('\n'), middle.sources['head#s1'].content.replace(/\n$/, '').split('\n').map(line => `+${line}`).join('\n'));
  // A file without a final newline keeps git's marker on its last segment only.
  const open = changeOf({head: numbered(400).join('\n'), patch: diffOf(null, numbered(400).join('\n'))});
  const last = segmentView(open.snapshot, open.file, segmentCosts(open.snapshot, open.file, 2000).length - 1, 2000);
  assert.match(patchOf({sources: last.sources}, last.file), /\\ No newline at end of file\n$/);
  assert.doesNotMatch(patchOf({sources: middle.sources}, middle.file), /No newline/);
  // A file stored compactly by the collector (header only) is segmented from its restored patch.
  const stored = changeOf({head, patch, stored: patch.slice(0, patch.indexOf('\n@@ ') + 1) + patch.slice(patch.indexOf('\n@@ ') + 1, patch.indexOf('\n', patch.indexOf('\n@@ ') + 1) + 1)});
  stored.file.patch_body = 'head_source';
  assert.equal(segmentCosts(stored.snapshot, stored.file, 2000).length, count);
});

test('a file removed whole is split into line ranges of its base', () => {
  const base = numbered(300).join('\n') + '\n';
  const change = changeOf({base, patch: diffOf(base, null)});
  const count = assertCovers(change, 2000);
  assert.ok(count >= 2);
  const view = segmentView(change.snapshot, change.file, 1, 2000);
  assert.equal(view.file.head_source, undefined);
  assert.ok(view.file.base_source.endsWith('#s1') && view.file.patch_body === undefined);
  assert.match(view.file.patch, /@@ -\d+,\d+ \+0,0 @@/);
});

test('a pure addition inside a file frames the old side around the line before it', () => {
  const base = numbered(50).join('\n') + '\n';
  const head = [...numbered(50).slice(0, 20), 'new a', 'new b', ...numbered(50).slice(20)].join('\n') + '\n';
  const change = changeOf({base, head, patch: diffOf(base, head)});
  const view = segmentView(change.snapshot, change.file, 0, 100000);
  assert.ok(view.sources['base#s0'].content.includes('line 20'));
  assert.equal(assertCovers(change, 100000), 1);
  // The same at the very start (zero old lines before the hunk) and at the end of the file.
  for (const edit of [[...['first'], ...numbered(50)], [...numbered(50), 'last']]) {
    const edited = edit.join('\n') + '\n';
    assert.equal(assertCovers(changeOf({base, head: edited, patch: diffOf(base, edited)}), 100000), 1);
  }
  // A deletion-only hunk frames the new side the same way.
  const shorter = numbered(50).filter((_, index) => index !== 10 && index !== 11).join('\n') + '\n';
  assert.equal(assertCovers(changeOf({base, head: shorter, patch: diffOf(base, shorter)}), 100000), 1);
});

test('a single line larger than a fragment is cut into pieces, owned in order by consecutive segments', () => {
  const minified = `const a = "${'x'.repeat(20000)}";`;
  const base = `// header\n${minified}\n// footer\n`;
  const head = `// header\n${minified.replace('xxxx', 'yyyy')}\n// footer\n`;
  const change = changeOf({base, head, patch: diffOf(base, head)});
  const count = assertCovers(change, 3000);
  assert.ok(count >= 8);
  // A window that holds only pieces of the line says so by its start line, and the quote of any piece is a piece of that line.
  const window = segmentView(change.snapshot, change.file, 3, 3000).sources['base#s3'];
  assert.equal(window.segment.start_line, 2);
  assert.ok(base.includes(window.content.split('\n')[0]));
  // A cut line with escape-dense text keeps every piece within the fragment.
  const quoted = `${'"'.repeat(5000)}\n`;
  const dense = changeOf({base: quoted, head: `${'\\'.repeat(5000)}\n`, patch: diffOf(quoted, `${'\\'.repeat(5000)}\n`)});
  assert.ok(assertCovers(dense, 3000) >= 3);
});

test('a patch with no hunks (a rename without edits) still gets a window to cite', () => {
  const text = numbered(40).join('\n') + '\n';
  const patch = 'diff --git a/old.txt b/a.txt\nsimilarity index 100%\nrename from old.txt\nrename to a.txt\n';
  const change = changeOf({base: text, head: text, patch, status: 'renamed'});
  const view = segmentView(change.snapshot, change.file, 0, 100000);
  assert.equal(segmentCosts(change.snapshot, change.file, 100000).length, 1);
  assert.equal(view.file.patch, patch);
  assert.equal(view.sources['head#s0'].segment.start_line, 1);
  assert.ok(view.sources['head#s0'].content.startsWith('line 1\n'));
  assert.ok(view.sources['base#s0']);
  // An empty file added has no rows and no window to cut.
  const empty = changeOf({head: '', patch: 'diff --git a/a.txt b/a.txt\nnew file mode 100644\nindex 0000000..e69de29\n'});
  const none = segmentView(empty.snapshot, empty.file, 0, 100000);
  assert.equal(none.file.patch_body, undefined);
  assert.equal(none.sources['head#s0'].content, '');
});

test('markers and blank context lines stay with the rows they follow', () => {
  const base = 'a\n\nb\nc'; const head = 'a\n\nb\nd';
  const patch = diffOf(base, head);
  assert.match(patch, /\\ No newline at end of file/);
  const change = changeOf({base, head, patch});
  assert.equal(assertCovers(change, 100000), 1);
  // The marker is never first in a segment: a split puts it with the row before it.
  const long = numbered(300).join('\n'); const longHead = long.replace('line 299', 'line X');
  const cut = changeOf({base: long, head: longHead, patch: diffOf(long, longHead)});
  for (let index = 0; index < segmentCosts(cut.snapshot, cut.file, 1500).length; index++) {
    assert.doesNotMatch(segmentView(cut.snapshot, cut.file, index, 1500).file.patch.replace(/^[^@]*/, ''), /@@\n\\ No/);
  }
  // A context row that a stripped diff writes as an empty line is a blank context row.
  const stripped = changeOf({base: 'a\n\nb\n', head: 'a\n\nc\n', patch: '@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n'});
  assert.match(segmentView(stripped.snapshot, stripped.file, 0, 100000).file.patch, /\n \n-b\n\+c\n$/);
});

test('inconsistent evidence is an integrity error, never a silent guess', () => {
  const text = numbered(5).join('\n') + '\n';
  const bad = (patch, code) => {
    const change = changeOf({base: text, head: text, patch});
    assert.throws(() => segmentCosts(change.snapshot, change.file, 1000), error => error instanceof SegmentError && error.code === code && error.path === 'a.txt' && error.message.startsWith(`${code}: `));
  };
  bad('@@ -9,1 +9,1 @@\n-x\n+y\n', 'segment_inconsistent');
  bad('@@ -1,1 +1,1 @@\n?weird\n', 'segment_inconsistent');
  bad('@@ -0,0 +0,1 @@\n+y\n', 'segment_inconsistent');
  const change = changeOf({base: text, head: text, patch: diffOf(text, text.replace('line 1', 'L'))});
  assert.throws(() => segmentView(change.snapshot, change.file, 5, 1000), error => error.code === 'segment_unknown' && error.path === 'a.txt');
});

test('random edits of random files are covered completely by segments of any limit (property test)', () => {
  let state = 12345;
  const next = () => {state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296;};
  for (let round = 0; round < 25; round++) {
    const lines = Array.from({length: 20 + Math.floor(next() * 400)}, (_, index) => `row ${index} ${'v'.repeat(Math.floor(next() * 80))}${next() < 0.05 ? '"\\' : ''}`);
    const edited = lines.flatMap((line, index) => (next() < 0.08 ? [] : next() < 0.1 ? [line, `added ${index}`] : next() < 0.1 ? [`${line} changed`] : [line]));
    const base = lines.join('\n') + (next() < 0.8 ? '\n' : ''); const head = edited.join('\n') + (next() < 0.8 ? '\n' : '');
    const patch = diffOf(base, head);
    if (!patch) continue;
    const change = changeOf({base, head, patch});
    for (const limit of [900, 4000, 30000]) assertCovers(change, limit);
  }
});
