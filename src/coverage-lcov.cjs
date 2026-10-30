'use strict';
// Read an LCOV report against a complete JS/TS source inventory.
//
// lines    = distinct DA records; covered when the hit count is positive.
// branches = BRDA records; covered when the taken count is a positive integer ("-" is not taken).
// The LF/LH/BRF/BRH totals a producer writes are cross-checked, never trusted.
const fs = require('node:fs');
const path = require('node:path');
const {fail, realPath, isInside, emptyCounts} = require('./coverage-util.cjs');
const {candidates, productionName, EXCLUDED_DIRECTORIES} = require('./coverage-istanbul.cjs');

const IGNORED = /^(?:TN:.*|FN:.*|FNDA:.*|FNF:.*|FNH:.*|)$/;

const integer = value => /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : fail('LCOV numbers must be nonnegative safe integers');

function parseRecord(rows) {
  const lines = new Map();
  const branches = [];
  const totals = {};
  for (const row of rows) {
    const [tag, ...rest] = row.split(':');
    const value = rest.join(':');
    if (tag === 'DA') {
      const [number, hits] = value.split(',');
      const known = lines.get(integer(number)) ?? 0;
      lines.set(Number(number), Math.max(known, integer(hits)));
    } else if (tag === 'BRDA') {
      const [, , , taken] = value.split(',');
      branches.push(taken === '-' ? 0 : integer(taken));
    } else if (['LF', 'LH', 'BRF', 'BRH'].includes(tag)) totals[tag] = integer(value);
    else if (!IGNORED.test(row)) fail(`Unsupported LCOV record: ${tag}`);
  }
  const measured = {lines: [...lines.values()], branches};
  const covered = values => values.filter(count => count > 0).length;
  if (totals.LF !== measured.lines.length || totals.LH !== covered(measured.lines) ||
      totals.BRF !== branches.length || totals.BRH !== covered(branches)) fail('LCOV totals do not match its records');
  return measured;
}

function counters(text, sourceDirectory, cwd) {
  if (typeof text !== 'string') fail('Expected an LCOV report as text');
  const root = realPath(sourceDirectory, cwd);
  const found = candidates(root);
  if (found.some(({file, symbolic}) => symbolic || !isInside(realPath(file, cwd), root))) fail('Symbolic or escaped JS/TS application source');
  const sources = new Set(found.map(({file}) => realPath(file, cwd)));
  if (!sources.size) fail('No application JS/TS sources found');
  for (const file of sources) {
    if (/\b(?:c8|istanbul|v8)\s+ignore\b/.test(fs.readFileSync(file, 'utf8'))) fail(`Coverage ignore directives are not allowed: ${file}`);
  }
  const seen = new Set();
  const counts = emptyCounts();
  let name = null;
  let rows = [];
  const finish = () => {
    const file = realPath(name, cwd);
    const relative = path.relative(root, file);
    if (!isInside(file, root) || relative.split(path.sep).slice(0, -1).some(part => EXCLUDED_DIRECTORIES.has(part)) ||
        !productionName(path.basename(file))) return;
    if (!sources.has(file) || seen.has(file)) fail(`Unexpected or duplicate application coverage: ${name}`);
    seen.add(file);
    const measured = parseRecord(rows);
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
  const missing = [...sources].filter(file => !seen.has(file));
  if (missing.length) fail('Missing application source coverage: ' + missing.sort().join(', '));
  return counts;
}

module.exports = {counters};
