'use strict';
// Changed-line coverage mode: the opt-in alternative to the repo-wide exact-100% gate.
//
// A pull request passes when every measured line and branch that it ADDS or MODIFIES (the diff against the base
// revision) is covered, and the repository-wide line and branch coverage did not fall below the base revision's.
// The mode is selected only by the protected `coverage.mode` of the repository configuration.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {fail, isObject, realPath} = require('./coverage-util.cjs');

const MODES = ['exact', 'changed_lines'];
const METRICS = ['lines', 'branches'];
const SAMPLE = 20;

// Exact 100% is the default and the only behaviour of a repository that does not opt in.
const modeOf = config => config?.coverage?.mode ?? 'exact';

// Wording for assessments and notices. The default mode keeps its original text byte for byte.
const WORDING = {
  exact: {waiting: 'exact 100% coverage', full: 'exact 100% line and branch coverage', brief: 'exact coverage'},
  changed_lines: {waiting: 'covered changed lines and branches with no coverage regression',
    full: 'full coverage of changed lines and branches with no repository-wide coverage regression', brief: 'changed-line coverage'},
};
const requirement = config => WORDING[modeOf(config)];

function validateMode(coverage) {
  if (!isObject(coverage) || Object.keys(coverage).join(',') !== 'mode' || !MODES.includes(coverage.mode)) {
    throw new Error('Invalid Clouseau coverage configuration; coverage.mode must be "exact" or "changed_lines"');
  }
}

// The added or modified lines of each file in a zero-context unified diff, keyed by repository-relative path.
function parseDiff(text) {
  const files = new Map();
  let current = null;
  // Body rows still owed by the current hunk. A row inside a hunk is content, never a file header, even when an
  // added line itself begins with "++ ".
  let owed = 0;
  for (const row of text.split('\n')) {
    if (owed > 0) {
      if (row.startsWith('-') || row.startsWith('+')) owed--;
    } else if (row.startsWith('+++ ')) {
      // git ends a header path that contains a space with a tab.
      const name = row.slice(4).replace(/\t$/, '');
      if (name.startsWith('"')) fail('Changed-line coverage cannot read a quoted path in the diff');
      current = name === '/dev/null' ? null : (files.get(name.slice(2)) ?? files.set(name.slice(2), new Set()).get(name.slice(2)));
    } else if (current && row.startsWith('@@ ')) {
      const [, old = '1', start, length = '1'] = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row) ?? fail('Malformed diff hunk header');
      owed = Number(old) + Number(length);
      for (let line = Number(start); line < Number(start) + Number(length); line++) current.add(line);
    }
  }
  return files;
}

const REF = /^(?:[0-9a-f]{40}|[A-Za-z0-9][A-Za-z0-9._/@-]{0,200})$/;

function changedLines(directory, baseRef, run = cp.execFileSync) {
  if (typeof baseRef !== 'string' || !REF.test(baseRef) || baseRef.includes('..')) fail('Changed-line coverage requires a plain base revision');
  let text;
  try {
    text = run('git', ['-c', 'core.quotepath=false', 'diff', '--unified=0', '--no-ext-diff', '--no-color', '--no-renames', '--relative',
      `${baseRef}...HEAD`, '--'], {cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024});
  } catch (error) {fail(`Changed-line coverage could not diff against ${baseRef}: ${String(error.stderr || error.message).trim()}`);}
  return new Map([...parseDiff(text)].map(([name, lines]) => [realPath(name, directory), lines]));
}

// Validated repository-wide totals from the base revision: {lines: [total, covered], branches: [total, covered]}.
function readBaseline(filename) {
  let value;
  try {value = JSON.parse(fs.readFileSync(filename, 'utf8'));}
  catch {fail('Changed-line coverage requires a readable JSON baseline of base totals');}
  if (!isObject(value) || Object.keys(value).sort().join(',') !== 'branches,lines') fail('The baseline must contain exactly lines and branches');
  for (const metric of METRICS) {
    const [total, covered, ...extra] = Array.isArray(value[metric]) ? value[metric] : [];
    if (extra.length || !Number.isSafeInteger(total) || !Number.isSafeInteger(covered) || total < 0 || covered < 0 || covered > total) {
      fail(`The baseline ${metric} must be [total, covered] of nonnegative integers`);
    }
  }
  return value;
}

// Whether `a/b` is below `c/d`, compared exactly without floating point.
const below = ([total, covered], [baseTotal, baseCovered]) => BigInt(covered) * BigInt(baseTotal) < BigInt(baseCovered) * BigInt(total);

// Compare the measured detail with the changed lines and the base totals; throws on any violation.
function enforceChanged({detail, changed, totals, baseline, directory}) {
  const out = {lines: [0, 0], branches: [0, 0]};
  const missed = [];
  for (const [file, {lines, branches}] of detail) {
    const touched = changed.get(file);
    if (!touched) continue;
    const name = path.relative(directory, file);
    for (const [line, covered] of lines) {
      if (!touched.has(line)) continue;
      out.lines[0]++;
      if (covered) out.lines[1]++;
      else missed.push(`${name}:${line} line`);
    }
    for (const {from, to, covered} of branches) {
      if (![...touched].some(line => line >= from && line <= to)) continue;
      out.branches[0]++;
      if (covered) out.branches[1]++;
      else missed.push(`${name}:${from} branch`);
    }
  }
  const failures = [];
  for (const metric of METRICS) {
    if (out[metric][0] !== out[metric][1]) failures.push(`${metric}: ${out[metric][0] - out[metric][1]} changed uncovered`);
    if (below(totals[metric], baseline[metric])) failures.push(`${metric}: repository-wide coverage fell below the base revision (base ${baseline[metric][1]}/${baseline[metric][0]}, now ${totals[metric][1]}/${totals[metric][0]})`);
  }
  if (failures.length) {
    fail(failures.join('; ') + (missed.length ? `; uncovered: ${missed.slice(0, SAMPLE).join(', ')}${missed.length > SAMPLE ? ', ...' : ''}` : ''));
  }
  return out;
}

module.exports = {MODES, modeOf, requirement, validateMode, parseDiff, changedLines, readBaseline, enforceChanged};
