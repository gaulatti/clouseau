'use strict';

// The planner's input, read from the STORED combined snapshot (design: chunked review). A size is the larger of the
// character count and the JSON-escaped length without the planner's 3 percent, so text that escapes heavily (quotes,
// control characters) is costed by what a unit view will really hold. A file too large for one unit also carries the
// costs of its segments, computed from its patch rows by file-segments.cjs, so the plan, CI's recomputation and the unit
// views all see the same split. A compact added file counts its patch header (its body lives once, in the head source)
// and a lockfile its derived summary.
const {escaped, segmentCosts} = require('./file-segments.cjs');
const {parameters, cost, threshold} = require('./review-partition.cjs');

const weight = text => Math.max(text.length, Math.ceil(escaped(text) / 1.03));

// The raw size (escaped characters) a segment may have so that the planner's cost for it stays within the unit ceiling.
function segmentLimit(overrides = {}) {
  const params = parameters(overrides);
  return Math.max(1, Math.floor((params.unit_ceiling - params.file_overhead) / 1.03));
}

function changeTable(snapshot, overrides = {}) {
  const params = parameters(overrides);
  const limit = segmentLimit(overrides);
  const size = id => weight(snapshot.sources[id].content);
  return snapshot.files.map(file => {
    const previous = file.base_source && snapshot.sources[file.base_source].path !== file.path ? snapshot.sources[file.base_source].path : null;
    const row = {path: file.path, previous, base_size: file.base_source ? size(file.base_source) : 0,
      head_size: file.head_source ? size(file.head_source) : 0, patch_chars: weight(file.patch),
      ...(file.lockfile ? {derived_size: size(file.head_source)} : {})};
    return !file.lockfile && cost({...row, segments: undefined}, params) > threshold(params) ? {...row, segments: segmentCosts(snapshot, file, limit)} : row;
  });
}

module.exports = {weight, segmentLimit, changeTable};
