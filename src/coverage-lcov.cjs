'use strict';
// Read an LCOV report against a complete source inventory: JS/TS by default, or the `source_suffixes` an lcov part declares
// (for example `.swift` for `llvm-cov export -format=lcov`, `.rs` for cargo-llvm-cov). Paths in `SF:` may be absolute or
// relative to the workspace; both resolve to the same real path as the inventory.
//
// A report with no BRDA record at all (llvm-cov lcov exports carry none) measures no branches: branches stay 0/0, the
// reader appends a note saying so, and the exact gate still refuses a plan with no measured branch. It is never 100%.
// lines    = distinct DA records; covered when the hit count is positive.
// branches = BRDA records; covered when the taken count is a positive integer ("-" is not taken).
// The LF/LH/BRF/BRH totals a producer writes are cross-checked, never trusted. One exception, only for a part that declares
// source_suffixes: `llvm-cov export -format=lcov` (Swift, and Rust through cargo-llvm-cov) writes LF/LH from its own summary,
// which differs from its DA records (measured: LF 35 against 31 DA records in one file). For that part LF/LH are not compared
// and the DA records alone are measured; BRF/BRH are still compared with the BRDA records.
const fs = require('node:fs');
const path = require('node:path');
const {missingSourceExplanation, fail, realPath, isInside, emptyCounts} = require('./coverage-util.cjs');
const {candidates, productionName} = require('./coverage-istanbul.cjs');
const {scopeFor, DEFAULT_SCOPE} = require('./coverage-scope.cjs');

const IGNORED = /^(?:TN:.*|FN:.*|FNDA:.*|FNF:.*|FNH:.*|)$/;

const integer = value => /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : fail('LCOV numbers must be nonnegative safe integers');

function parseRecord(rows, producerLines) {
  const lines = new Map();
  const branches = [];
  const branchLines = [];
  const totals = {};
  for (const row of rows) {
    const [tag, ...rest] = row.split(':');
    const value = rest.join(':');
    if (tag === 'DA') {
      const [number, hits] = value.split(',');
      const known = lines.get(integer(number)) ?? 0;
      lines.set(Number(number), Math.max(known, integer(hits)));
    } else if (tag === 'BRDA') {
      const [line, , , taken] = value.split(',');
      branches.push(taken === '-' ? 0 : integer(taken));
      branchLines.push(line);
    } else if (['LF', 'LH', 'BRF', 'BRH'].includes(tag)) totals[tag] = integer(value);
    else if (!IGNORED.test(row)) fail(`Unsupported LCOV record: ${tag}`);
  }
  const measured = {lines: [...lines.values()], branches};
  const covered = values => values.filter(count => count > 0).length;
  if (!producerLines && (totals.LF !== measured.lines.length || totals.LH !== covered(measured.lines)) ||
      totals.BRF !== branches.length || totals.BRH !== covered(branches)) fail('LCOV totals do not match its records');
  return {...measured, lineMap: lines, branchLines};
}

const NO_BRANCHES = 'the lcov report has no BRDA records, so branches are not measured and only lines are gated';

// `options.suffixes` declares the inventory (default JS/TS); `options.notes`, when given, receives plain-language notes.
function counters(text, sourceDirectory, cwd, detail, options = {}) {
  if (typeof text !== 'string') fail('Expected an LCOV report as text');
  const root = realPath(sourceDirectory, cwd);
  const scope = options.suffixes === undefined ? DEFAULT_SCOPE : scopeFor(options.suffixes, root);
  const found = candidates(root, scope);
  if (found.some(({file, symbolic}) => symbolic || !isInside(realPath(file, cwd), root))) fail(`Symbolic or escaped ${scope.label} application source`);
  const sources = new Set(found.map(({file}) => realPath(file, cwd)));
  if (!sources.size) fail(`No application ${scope.label} sources found`);
  for (const file of sources) {
    if (scope.ignorePattern.test(fs.readFileSync(file, 'utf8'))) fail(`Coverage ignore directives are not allowed: ${file}`);
  }
  const seen = new Set();
  const counts = emptyCounts();
  let name = null;
  let rows = [];
  const finish = () => {
    const file = realPath(name, cwd);
    const relative = path.relative(root, file);
    if (!isInside(file, root) || scope.excludesDirectories(relative.split(path.sep).slice(0, -1)) ||
        !productionName(path.basename(file))) return;
    if (!sources.has(file) || seen.has(file)) fail(`Unexpected or duplicate application coverage: ${name}`);
    seen.add(file);
    const measured = parseRecord(rows, scope.custom);
    if (detail) {
      detail.set(file, {lines: new Map([...measured.lineMap].map(([line, hits]) => [line, hits > 0])),
        branches: measured.branches.map((hits, index) => {
          const line = integer(measured.branchLines[index]);
          return {from: line, to: line, covered: hits > 0};
        })});
    }
    for (const metric of Object.keys(counts)) {
      counts[metric][0] += measured[metric].length;
      counts[metric][1] += measured[metric].filter(value => value > 0).length;
    }
  };
  for (const row of text.split(/\r\n|\n|\r/)) {
    if (row.startsWith('SF:')) {
      if (name !== null) fail('LCOV record is missing end_of_record');
      name = row.slice(3);
      rows = [];
    } else if (row === 'end_of_record') {
      if (name === null) fail('LCOV end_of_record has no source file');
      finish();
      name = null;
    } else if (name !== null) rows.push(row);
    else if (!IGNORED.test(row)) fail('LCOV data appears outside a source record');
  }
  if (name !== null) fail('LCOV record is missing end_of_record');
  if (!seen.size) fail('Expected a nonempty LCOV report');
  if (counts.branches[0] === 0 && options.notes) options.notes.push(NO_BRANCHES);
  const missing = [...sources].filter(file => !seen.has(file));
  if (missing.length) fail('Missing application source coverage: ' + missing.sort().join(', ') + '\n' + missingSourceExplanation(missing));
  return counts;
}

module.exports = {counters};
