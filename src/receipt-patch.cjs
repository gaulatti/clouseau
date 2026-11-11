'use strict';

const {patchOf, showsNoText} = require('./acceptance.cjs');
const {LOCKFILE_PATCH, isLockfile} = require('./lockfile-summary.cjs');
const crypto = require('node:crypto');
const {ReceiptRejected} = require('./receipt-rejection.cjs');

// CI recomputes nothing from the model: the patch the reviewers saw is compared with the
// patch GitHub reports for the same pull request. The file list is the one already fetched for
// the assessment, so this check costs no additional request.
// Extended git header lines. The three path-bearing lines are matched exactly against the pull request's own
// paths, so no free text can ride in them.
const HEADER = [
  /^(?:old|new) mode [0-7]{6}$/, /^(?:new|deleted) file mode [0-7]{6}$/, /^similarity index [0-9]{1,3}%$/,
  /^dissimilarity index [0-9]{1,3}%$/, /^rename (?:from|to) .+$/, /^index [a-f0-9]{7,64}\.\.[a-f0-9]{7,64}(?: [0-7]{6})?$/,
];
const headerLines = live => {
  const old = live.previous_filename ?? live.filename;
  return new Set([`diff --git a/${old} b/${live.filename}`, `--- a/${old}`, '--- /dev/null', `+++ b/${live.filename}`, '+++ /dev/null']);
};

class ReceiptPatchMismatch extends ReceiptRejected {
  constructor(path) {
    super('source', `receipt_patch_mismatch for ${String(path).slice(0, 200)}`);
    this.code = 'RECEIPT_PATCH_MISMATCH';
    this.path = String(path).slice(0, 200);
  }
}

// The local collector stores `git diff` text. GitHub's `patch` field is the same hunks without the
// extended header and without the final newline. Anything in the header must be a known git line and
// any rename it states must match the pull request, so the header cannot carry reviewer-visible prose.
function hostedForm(patch, live) {
  if (typeof patch !== 'string') return null;
  const lines = patch.split('\n');
  const found = lines.findIndex(line => line.startsWith('@@'));
  // A change that shows no text (an empty file, a pure rename) is a header and no hunk: the hosted patch is then empty.
  const start = found < 0 ? lines.length - Number(lines[lines.length - 1] === '') : found;
  const head = lines.slice(0, start); const allowed = headerLines(live);
  if ((found < 0 && !head.length) || !head.every(line => allowed.has(line) || HEADER.some(rule => rule.test(line))) ||
    new Set(head).size !== head.length) return null;
  const renamed = Object.fromEntries(lines.slice(0, start).map(line => /^rename (from|to) (.+)$/.exec(line)).filter(Boolean)
    .map(([, side, name]) => [side, name]));
  if (live.status === 'renamed' ? renamed.from !== live.previous_filename || renamed.to !== live.filename : Object.keys(renamed).length) return null;
  return found < 0 ? '' : lines.slice(start).join('\n').replace(/\n$/, '');
}

// git appends a function-name heading (`@@ -1,2 +1,2 @@ def run():`) to a hunk header when the local `git diff` runs;
// GitHub's `patch` omits it. The heading is derived text with no line numbers, so only the text after the second `@@`
// of a hunk header line is dropped, on both sides. A hunk body line always starts with a space, `+`, `-` or `\`, so
// no body line is ever touched, and line numbers, headers and bodies still have to match byte for byte.
const withoutHeading = patch => patch.replace(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*$/gm, '$1');

// `git diff` leaves two hunks apart when exactly one unchanged line separates their context; GitHub's `patch` joins them
// and shows that line. The signed patch is therefore compared by line, with its hunk numbering: every line must equal
// GitHub's at the same old and new position, and the only line GitHub may add is a single unchanged line between two
// signed hunks. Any other difference, including whitespace, remains a mismatch.
function lineEntries(patch) {
  const entries = [];
  let hunk = -1; let old = 0; let now = 0;
  for (const line of patch.split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (head) {hunk++; old = Number(head[1]); now = Number(head[2]); continue;}
    if (hunk < 0 || !' +-\\'.includes(line[0] ?? '#')) return null;
    entries.push({hunk, kind: line[0], old, now, line});
    if (line[0] !== '+' && line[0] !== '\\') old++;
    if (line[0] !== '-' && line[0] !== '\\') now++;
  }
  return entries;
}

const sameEntry = (a, b) => a && b && a.kind === b.kind && a.old === b.old && a.now === b.now && a.line === b.line;

function joinsSingleGaps(signed, hosted) {
  const a = lineEntries(signed); const b = lineEntries(hosted);
  if (!a || !b) return false;
  let next = 0;
  for (let index = 0; index < b.length; index++) {
    if (sameEntry(a[next], b[index])) {next++; continue;}
    const between = next > 0 && a[next] && a[next].hunk !== a[next - 1].hunk && b[index].kind === ' ' && sameEntry(a[next], b[index + 1]);
    if (!between) return false;
  }
  return next === a.length;
}

// A file added whole is stored as its header plus a marker that the body is its head source; the
// restored text is what the reviewers saw. A marker without that source restores nothing.
function signedPatch(snapshot, item) {
  try {return patchOf(snapshot, item);} catch {return null;}
}

// A lockfile carries no patch in the snapshot: its derived summary replaces the raw text and patch, and
// verifySources recomputes that summary from GitHub's base and head bytes. Only a known lockfile marked as
// summarized with exactly the fixed placeholder is exempt, so the exemption cannot carry other text.
const summarized = item => item.lockfile === true && isLockfile(item.path) && item.patch === LOCKFILE_PATCH;

// Under the protected `local_review.binding: "diff"` a receipt covers the change, not the trees: the SHA-256 of the
// normalized diff the reviewers signed must equal the SHA-256 of the normalized diff GitHub reports for the pull request.
// Normalized: per file, in path order, its path, status and (for a rename) previous path, and its hunks with every hunk
// header reduced to `@@`, so line numbers and git's trailing section text do not count. Every other hunk byte counts,
// context lines and whitespace included. GitHub joins two git hunks separated by exactly one unchanged line into one hunk
// whose context run between changes is 2 * 3 + 1 = 7 lines; git with its default 3 lines of context never emits such a run
// inside a hunk, so on both sides such a run is split back into its two hunks (the joining line is dropped).
const CONTEXT = 3;
function canonicalHunks(patch) {
  const lines = patch.split('\n');
  const out = [];
  let run = [];
  const flush = closing => {
    // A run of context lines between two change lines of one hunk; exactly 2 * CONTEXT + 1 of them is GitHub's join.
    if (closing && run.length === 2 * CONTEXT + 1 && out.length && /^[+-]/.test(out[out.length - 1])) {
      out.push(...run.slice(0, CONTEXT), '@@', ...run.slice(CONTEXT + 1));
    } else out.push(...run);
    run = [];
  };
  for (const line of lines) {
    if (line.startsWith('@@')) {flush(false); out.push('@@'); continue;}
    if (line.startsWith(' ')) {run.push(line); continue;}
    flush(/^[+-]/.test(line));
    out.push(line);
  }
  flush(false);
  return out.join('\n');
}

// The normalized entry of every changed file: a summarized lockfile is bound by its recomputed summary (verifySources), so
// it contributes its path, status and a fixed marker; a change that shows no text contributes an empty patch.
const entry = (path, status, previous, patch) => ({path, status, previous: status === 'renamed' ? previous : null, patch});
const diffDigest = entries => crypto.createHash('sha256').update(JSON.stringify(['clouseau.receipt-diff.v1',
  [...entries].sort((a, b) => a.path < b.path ? -1 : 1)])).digest('hex');

function verifyPatches({snapshot, files, binding = null}) {
  const signed = new Map(snapshot.files.map(file => [file.path, file]));
  // GitHub supplies no patch for very large or binary changes; the hosted collector refuses those and so does this.
  // It also supplies none for a change that shows no text, which the signed sources prove: an empty file added or
  // removed, or a rename of identical content. Then the signed patch must be a header with no hunk.
  const textless = live => {
    const item = signed.get(live.filename);
    const text = id => snapshot.sources?.[id]?.content;
    return Boolean(item) && item.status === live.status && hostedForm(signedPatch(snapshot, item), live) === '' &&
      showsNoText(item.status, text(item.base_source), text(item.head_source));
  };
  if (files.some(file => (typeof file.patch !== 'string' || !file.patch) &&
    !(signed.has(file.filename) && summarized(signed.get(file.filename))) && !textless(file))) {
    throw new Error('Changed-file evidence is incomplete');
  }
  for (const file of snapshot.files) if (!files.some(live => live.filename === file.path)) throw new ReceiptPatchMismatch(file.path);
  for (const live of files) {
    const item = signed.get(live.filename);
    if (item && item.lockfile === true && !summarized(item)) throw new ReceiptPatchMismatch(live.filename);
    if (item && summarized(item)) {
      if (item.status !== live.status) throw new ReceiptPatchMismatch(live.filename);
      continue;
    }
    if (!item || item.status !== live.status) throw new ReceiptPatchMismatch(live.filename);
    if (binding === 'diff') {
      if (canonicalHunks(hostedForm(signedPatch(snapshot, item), live) ?? '\0') !== canonicalHunks(live.patch ?? '')) throw new ReceiptPatchMismatch(live.filename);
      continue;
    }
    const signedText = withoutHeading(hostedForm(signedPatch(snapshot, item), live) ?? '');
    const hostedText = withoutHeading(live.patch ?? '');
    if (signedText !== hostedText && !joinsSingleGaps(signedText, hostedText)) throw new ReceiptPatchMismatch(live.filename);
  }
  if (binding !== 'diff') return null;
  // The binding itself: one SHA-256 over the signed patches and one over GitHub's, which the per-file comparison above proved equal.
  const previousOf = item => snapshot.sources?.[item.base_source]?.path ?? null;
  const signedDigest = diffDigest(snapshot.files.map(item => summarized(item) ? entry(item.path, item.status, null, 'lockfile-summary') :
    entry(item.path, item.status, previousOf(item), canonicalHunks(hostedForm(signedPatch(snapshot, item),
      {filename: item.path, status: item.status, previous_filename: item.status === 'renamed' ? previousOf(item) : undefined}) ?? '\0'))));
  const liveDigest = diffDigest(files.map(live => summarized(signed.get(live.filename)) ? entry(live.filename, live.status, null, 'lockfile-summary') :
    entry(live.filename, live.status, live.previous_filename ?? null, canonicalHunks(live.patch ?? ''))));
  if (signedDigest !== liveDigest) throw new ReceiptPatchMismatch(snapshot.files[0].path);
  return {signed: signedDigest, live: liveDigest};
}

module.exports = {ReceiptPatchMismatch, hostedForm, verifyPatches, canonicalHunks, diffDigest};
