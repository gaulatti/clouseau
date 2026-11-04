'use strict';

// Which seams the integration pass of a chunked review looks at (chunked review cost). The integration pass used to
// pack every seam, with whole hunks, into 250,000-character shards: the cost grew with the size of the change and the
// pass ran even when no unit imports another. Now the cost grows with the number of seams only:
//
//   * no seams: no integration session at all. The seams are recomputed from the signed evidence by CI, so an empty
//     list is a verifiable fact, not a claim, and the record then needs (and has) no integration entries;
//   * seams are ranked by how likely they are to hide a defect and at most `maxSeams` go to the model, `perCall` to a
//     session (more seams, more sessions);
//   * the seams beyond `maxSeams` are not dropped: each is recorded as `missing`, which leaves review completeness
//     unresolved and so holds approval exactly as an unexamined seam does.
//
// Pure and model-free, so the verifier can recompute it.

// A removed import is a certain break if unhandled; a consumed export may break; a lost test assertion weakens
// coverage; a plain import of a changed file is the weakest signal.
const RANK = Object.freeze({removed_import: 0, export_consumer: 1, test_subject: 2, import: 3});

const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const weight = seam => [RANK[seam.kind] ?? Object.keys(RANK).length, -(seam.exports?.length ?? 0)];

function relevance(a, b) {
  const [ra, ea] = weight(a); const [rb, eb] = weight(b);
  return ra - rb || ea - eb || compare(a.id, b.id);
}

// {reviewed, overflow}: `reviewed` is the most relevant `maxSeams` seams, most relevant first.
function selectSeams(seams, maxSeams) {
  const ranked = [...seams].sort(relevance);
  return {reviewed: ranked.slice(0, maxSeams), overflow: ranked.slice(maxSeams)};
}

// The record entry for seams that were not sent to a session: every one is `missing`, with the reason.
function overflowEntry(overflow, maxSeams) {
  return {seams: overflow.map(seam => seam.id), unreviewed: true,
    dispositions: overflow.map(seam => ({seam: seam.id, state: 'missing',
      reason: `Not examined: beyond the ${maxSeams} most relevant seams the integration pass may be given.`}))};
}

module.exports = {RANK, selectSeams, overflowEntry};
