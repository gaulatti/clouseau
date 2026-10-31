'use strict';

// CI recomputes nothing from the model: the patch the reviewers saw is compared with the
// patch GitHub reports for the same pull request. The file list is the one already fetched for
// the assessment, so this check costs no additional request.
const HEADER = [
  /^diff --git .+$/, /^(?:old|new) mode [0-7]{6}$/, /^(?:new|deleted) file mode [0-7]{6}$/, /^similarity index [0-9]{1,3}%$/,
  /^dissimilarity index [0-9]{1,3}%$/, /^rename (?:from|to) .+$/, /^index [a-f0-9]{7,64}\.\.[a-f0-9]{7,64}(?: [0-7]{6})?$/,
  /^--- .+$/, /^\+\+\+ .+$/,
];

class ReceiptPatchMismatch extends Error {
  constructor(path) {
    super(`Invalid local review receipt: receipt_patch_mismatch for ${String(path).slice(0, 200)}`);
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
  if (start < 0 || !lines.slice(0, start).every(line => HEADER.some(rule => rule.test(line)))) return null;
  const renamed = Object.fromEntries(lines.slice(0, start).map(line => /^rename (from|to) (.+)$/.exec(line)).filter(Boolean)
    .map(([, side, name]) => [side, name]));
  if (live.status === 'renamed' ? renamed.from !== live.previous_filename || renamed.to !== live.filename : Object.keys(renamed).length) return null;
  return lines.slice(start).join('\n').replace(/\n$/, '');
}

function verifyPatches({snapshot, files}) {
  // GitHub supplies no patch for very large or binary changes; the hosted collector refuses those and so does this.
  if (files.some(file => typeof file.patch !== 'string' || !file.patch)) throw new Error('Changed-file evidence is incomplete');
  const signed = new Map(snapshot.files.map(file => [file.path, file]));
  for (const file of snapshot.files) if (!files.some(live => live.filename === file.path)) throw new ReceiptPatchMismatch(file.path);
  for (const live of files) {
    const item = signed.get(live.filename);
    if (!item || item.status !== live.status || hostedForm(item.patch, live) !== live.patch) throw new ReceiptPatchMismatch(live.filename);
  }
}

module.exports = {ReceiptPatchMismatch, hostedForm, verifyPatches};
