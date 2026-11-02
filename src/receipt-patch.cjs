'use strict';

const {patchOf} = require('./acceptance.cjs');
const {LOCKFILE_PATCH, isLockfile} = require('./lockfile-summary.cjs');
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
  const start = lines.findIndex(line => line.startsWith('@@'));
  const head = lines.slice(0, Math.max(start, 0)); const allowed = headerLines(live);
  if (start < 0 || !head.every(line => allowed.has(line) || HEADER.some(rule => rule.test(line))) ||
    new Set(head).size !== head.length) return null;
  const renamed = Object.fromEntries(lines.slice(0, start).map(line => /^rename (from|to) (.+)$/.exec(line)).filter(Boolean)
    .map(([, side, name]) => [side, name]));
  if (live.status === 'renamed' ? renamed.from !== live.previous_filename || renamed.to !== live.filename : Object.keys(renamed).length) return null;
  return lines.slice(start).join('\n').replace(/\n$/, '');
}

// git appends a function-name heading (`@@ -1,2 +1,2 @@ def run():`) to a hunk header when the local `git diff` runs;
// GitHub's `patch` omits it. The heading is derived text with no line numbers, so only the text after the second `@@`
// of a hunk header line is dropped, on both sides. A hunk body line always starts with a space, `+`, `-` or `\`, so
// no body line is ever touched, and line numbers, headers and bodies still have to match byte for byte.
const withoutHeading = patch => patch.replace(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*$/gm, '$1');

// A file added whole is stored as its header plus a marker that the body is its head source; the
// restored text is what the reviewers saw. A marker without that source restores nothing.
function signedPatch(snapshot, item) {
  try {return patchOf(snapshot, item);} catch {return null;}
}

// A lockfile carries no patch in the snapshot: its derived summary replaces the raw text and patch, and
// verifySources recomputes that summary from GitHub's base and head bytes. Only a known lockfile marked as
// summarized with exactly the fixed placeholder is exempt, so the exemption cannot carry other text.
const summarized = item => item.lockfile === true && isLockfile(item.path) && item.patch === LOCKFILE_PATCH;

function verifyPatches({snapshot, files}) {
  const signed = new Map(snapshot.files.map(file => [file.path, file]));
  // GitHub supplies no patch for very large or binary changes; the hosted collector refuses those and so does this.
  if (files.some(file => (typeof file.patch !== 'string' || !file.patch) && !(signed.has(file.filename) && summarized(signed.get(file.filename))))) {
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
    if (!item || item.status !== live.status || withoutHeading(hostedForm(signedPatch(snapshot, item), live) ?? '') !== withoutHeading(live.patch)) throw new ReceiptPatchMismatch(live.filename);
  }
}

module.exports = {ReceiptPatchMismatch, hostedForm, verifyPatches};
