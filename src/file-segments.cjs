'use strict';

// Bounded segments of ONE changed file whose evidence is larger than a review unit can hold (the chunked review
// never refuses a change for its size). A segment owns a contiguous run of the file's patch rows, so every changed
// line belongs to exactly one segment, and it carries just enough source around those rows to be cited.
//
// Pure and deterministic: the same snapshot file and limit give the same segments in any process, so CI recomputes
// them from the signed evidence. Nothing here decides anything; `review-units.cjs` turns a segment into a unit view
// and maps the unit's citations back to the combined snapshot.
//
// Source windows keep the original line structure: the first line of a window is line `start_line` of the combined
// source (so segment line k is combined line start_line + k - 1), whole lines except where one line alone is larger
// than a fragment, which is cut into consecutive pieces of at most `fragment` escaped characters (no line is ever
// refused for being long). A citation that is valid in the window is therefore valid in the whole source, because a
// quote is always a piece of the lines it cites.
const {patchOf} = require('./acceptance.cjs');

const MARGIN = 12;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const HIGH_SURROGATE = /[\uD800-\uDBFF]/;
const HUNK_OVERHEAD = 40;

class SegmentError extends Error {
  constructor(code, message, path) {
    super(`${code}: ${message}`);
    this.name = 'SegmentError';
    this.code = code;
    this.path = path;
  }
}

// Length of a string as the JSON of a snapshot stores it (escapes included).
const escaped = text => JSON.stringify(text).length - 2;

// Pieces of `text` whose escaped length is at most `budget` (at least 64), never cutting a surrogate pair.
function chunks(text, budget) {
  if (escaped(text) <= budget) return [text];
  const out = [];
  for (let at = 0; at < text.length;) {
    let size = Math.min(budget, text.length - at);
    while (escaped(text.slice(at, at + size)) > budget) size >>= 1;
    if (size > 1 && at + size < text.length && HIGH_SURROGATE.test(text[at + size - 1])) size--;
    out.push(text.slice(at, at + size));
    at += size;
  }
  return out;
}

// A text as consecutive pieces: `lines[i]` is the 1-based line of piece i, `first[n - 1]` the first piece of line n,
// `prefix[i]` the escaped cost of pieces before i (each followed by its newline when the next piece starts a line).
function piecesOf(text, budget) {
  const texts = []; const lines = []; const first = [];
  text.split('\n').forEach((line, index) => {
    first.push(texts.length);
    for (const part of chunks(line, budget)) {texts.push(part); lines.push(index + 1);}
  });
  const prefix = [0];
  texts.forEach((part, index) => prefix.push(prefix[index] + escaped(part) + (lines[index + 1] > lines[index] ? 2 : 0)));
  return {texts, lines, first, prefix};
}

function pieceAt(pieces, line, fragment, path) {
  if (!Number.isSafeInteger(line) || line < 1 || line > pieces.first.length) {
    throw new SegmentError('segment_inconsistent', `the patch of ${path} names line ${line}, outside the source`, path);
  }
  const next = line < pieces.first.length ? pieces.first[line] : pieces.texts.length;
  return Math.min(pieces.first[line - 1] + fragment, next - 1);
}

const windowCost = (pieces, low, high) => pieces.prefix[high + 1] - pieces.prefix[low];
const windowText = (pieces, low, high) => pieces.texts.slice(low, high + 1)
  .map((part, index) => part + (low + index < high && pieces.lines[low + index + 1] > pieces.lines[low + index] ? '\n' : '')).join('');

// Rows of a patch: sign, text (long text cut into continuation rows), the old/new line each belongs to and the
// counters before it, so a sub-hunk header can be written for any run of rows.
function parsePatch(patch, budget, path) {
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const start = lines.findIndex(line => HUNK.test(line));
  const split = start < 0 ? lines.length : start;
  const hunks = [];
  const rows = [];
  let old = 0; let current = 0;
  for (const line of lines.slice(split)) {
    const match = HUNK.exec(line);
    if (match) {
      const [, oldStart, oldCount = '1', newStart, newCount = '1', context] = match;
      hunks.push({context});
      old = Number(oldCount) === 0 ? Number(oldStart) + 1 : Number(oldStart);
      current = Number(newCount) === 0 ? Number(newStart) + 1 : Number(newStart);
      continue;
    }
    const sign = line === '' ? ' ' : line[0];
    if (!' +-\\'.includes(sign)) throw new SegmentError('segment_inconsistent', `unrecognized patch line in ${path}`, path);
    const text = line === '' ? '' : line.slice(1);
    const before = {old, new: current};
    const hasOld = sign === ' ' || sign === '-'; const hasNew = sign === ' ' || sign === '+';
    const parts = sign === '\\' ? [text] : chunks(text, budget);
    parts.forEach((part, fragment) => rows.push({sign, text: part, hunk: hunks.length - 1, fragment, before,
      ...(hasOld ? {old: before.old} : {}), ...(hasNew ? {new: before.new} : {})}));
    if (hasOld) old++;
    if (hasNew) current++;
  }
  return {header: lines.slice(0, split), hunks, rows};
}

// Header of the sub-hunk made of `run` (consecutive rows of one original hunk).
function hunkHeader(run, hunk) {
  const olds = new Set(run.filter(row => row.old !== undefined).map(row => row.old));
  const news = new Set(run.filter(row => row.new !== undefined).map(row => row.new));
  const start = (set, key) => (set.size ? Math.min(...set) : Math.max(0, run[0].before[key] - 1));
  return `@@ -${start(olds, 'old')},${olds.size} +${start(news, 'new')},${news.size} @@${hunk.context}`;
}

function analyze(snapshot, file, limit) {
  const path = file.path;
  const fragment = Math.max(64, Math.floor(limit / 8));
  const base = file.base_source ? piecesOf(snapshot.sources[file.base_source].content, fragment) : null;
  const head = file.head_source ? piecesOf(snapshot.sources[file.head_source].content, fragment) : null;
  const {header, hunks, rows} = parsePatch(patchOf(snapshot, file), fragment, path);
  // An added file is stored compactly in a view (its body is the head window), so its rows add nothing.
  const whole = file.status === 'added' || file.status === 'removed';
  const reserve = whole ? 0 : Math.floor(limit / 16);
  const fixed = header.reduce((total, line) => total + escaped(line) + 2, 0);

  const touched = row => ({
    old: base && row.old !== undefined ? pieceAt(base, row.old, row.fragment, path) : null,
    new: head && row.new !== undefined ? pieceAt(head, row.new, row.fragment, path) : null});
  const extend = (range, index) => (index === null ? range : range ? [Math.min(range[0], index), Math.max(range[1], index)] : [index, index]);
  const price = total => fixed + total.rows + total.hunks * HUNK_OVERHEAD + total.context +
    (base ? reserve + (total.old ? windowCost(base, ...total.old) : 0) : 0) + (head ? reserve + (total.new ? windowCost(head, ...total.new) : 0) : 0);
  // What the group would be with `row` added (a pure computation, so a rejected row costs nothing).
  const grown = (group, row, at) => {
    const known = group.hunkSet.has(row.hunk);
    return {rows: group.rows + (file.status === 'added' ? 0 : escaped(row.text) + 3), context: group.context + (known ? 0 : escaped(hunks[row.hunk].context)),
      hunks: group.hunkSet.size + (known ? 0 : 1), old: extend(group.old, at.old), new: extend(group.new, at.new)};
  };
  const fresh = () => ({rows: 0, context: 0, hunkSet: new Set(), old: null, new: null, list: []});
  const add = (group, row, at) => {
    const next = grown(group, row, at);
    group.hunkSet.add(row.hunk); group.list.push(row);
    Object.assign(group, {rows: next.rows, context: next.context, old: next.old, new: next.new});
  };

  const groups = [];
  let group = fresh();
  for (const row of rows) {
    const at = touched(row);
    if (group.list.length && row.sign !== '\\' && price(grown(group, row, at)) > limit) {groups.push(group); group = fresh();}
    add(group, row, at);
  }
  groups.push(group);

  const segments = groups.map((item, index) => {
    // A side the rows do not touch (a pure addition has no old lines) is framed around the line before the change.
    const anchor = (pieces, key) => pieceAt(pieces, Math.min(Math.max(1, item.list.length ? item.list[0].before[key] - 1 : 1), pieces.first.length), 0, path);
    const frame = (pieces, range, key) => {
      if (!pieces) return null;
      let [low, high] = range || [anchor(pieces, key), anchor(pieces, key)];
      if (!whole) {
        const room = Math.floor(limit / 16);
        for (let step = 0, used = 0; step < MARGIN && low > 0 && used + windowCost(pieces, low - 1, low - 1) <= room; step++) {
          used += windowCost(pieces, low - 1, low - 1); low--;
        }
        for (let step = 0, used = 0; step < MARGIN && high < pieces.texts.length - 1 && used + windowCost(pieces, high + 1, high + 1) <= room; step++) {
          used += windowCost(pieces, high + 1, high + 1); high++;
        }
      }
      return {low, high};
    };
    return {index, cost: price({...item, hunks: item.hunkSet.size}), rows: item.list, base: frame(base, item.old, 'old'), head: frame(head, item.new, 'new')};
  });
  return {header, hunks, base, head, segments};
}

const memo = new WeakMap();
function analysis(snapshot, file, limit) {
  const cache = memo.get(file) || new Map();
  memo.set(file, cache);
  if (!cache.has(limit)) cache.set(limit, analyze(snapshot, file, limit));
  return cache.get(limit);
}

// The raw cost (escaped characters) of every segment of `file`, each at most `limit` unless one patch row alone is larger.
function segmentCosts(snapshot, file, limit) {
  return analysis(snapshot, file, limit).segments.map(segment => segment.cost);
}

// The unit-view pieces of segment `index`: a file entry for the view and the window sources it cites.
function segmentView(snapshot, file, index, limit) {
  const {header, hunks, base, head, segments} = analysis(snapshot, file, limit);
  const segment = segments[index];
  if (!segment) throw new SegmentError('segment_unknown', `${file.path} has no segment ${index}`, file.path);
  const sources = {};
  const window = (side, pieces, range) => {
    if (!range) return undefined;
    const id = `${file[`${side}_source`]}#s${index}`;
    const last = index === segments.length - 1;
    let content = windowText(pieces, range.low, range.high);
    // An added segment is stored compactly (header only, body from the head window), which needs a final newline.
    if (side === 'head' && file.status === 'added' && !last && !content.endsWith('\n')) content += '\n';
    sources[id] = {...snapshot.sources[file[`${side}_source`]], content,
      segment: {source: file[`${side}_source`], index, count: segments.length, start_line: pieces.lines[range.low]}};
    return id;
  };
  const baseId = window('base', base, segment.base);
  const headId = window('head', head, segment.head);
  const runs = [];
  for (const row of segment.rows) {
    const last = runs[runs.length - 1];
    if (last && last.hunk === row.hunk) last.rows.push(row);
    else runs.push({hunk: row.hunk, rows: [row]});
  }
  const compact = file.status === 'added' && segment.rows.length > 0;
  const lines = [...header];
  for (const run of runs) {
    lines.push(hunkHeader(run.rows, hunks[run.hunk]));
    if (!compact) lines.push(...run.rows.map(row => `${row.sign}${row.text}`));
  }
  const entry = {...file, patch: `${lines.join('\n')}\n`, segment: {index, count: segments.length}};
  delete entry.base_source; delete entry.head_source; delete entry.patch_body;
  if (baseId) entry.base_source = baseId;
  if (headId) entry.head_source = headId;
  if (compact) entry.patch_body = 'head_source';
  return {file: entry, sources};
}

module.exports = {MARGIN, SegmentError, escaped, chunks, piecesOf, segmentCosts, segmentView};
