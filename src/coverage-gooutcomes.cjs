'use strict';
// Validate a native Go outcome report written by tools/goinstr against a complete Go source inventory.
//
// The report is measured, never inferred: tools/goinstr rewrites each application source so every executed
// statement and every taken outcome of a decision is written when it is taken. What is counted:
//   lines    = distinct source lines that start a statement; a line is covered only when every statement
//              starting on it executed.
//   branches = outcomes: if true/false (including the implicit false), each && / || operand true/false, loop
//              condition true/false, loop zero-entry, range enter, every switch/type-switch/select clause, the
//              switch no-match, and a switch default. See docs/go-instrumenter.md.
// Every inventoried application file must be reported and bound to its current bytes; a file excluded from every
// declared build, a stale or unknown file and any malformed field is an explicit error.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {fail, isObject, realPath, isInside, emptyCounts} = require('./coverage-util.cjs');
const {inventory, moduleOf} = require('./coverage-go.cjs');

const MAX_BUILDS = 16;
const word = /^[a-z0-9_]{1,40}$/;

const keysAre = (value, required, optional = []) => isObject(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : fail('Go outcome counts must be nonnegative safe integers');
const text = value => typeof value === 'string' && value.length > 0 && value.length < 300 ? value : fail('Go outcome fields must be nonempty strings');

function build(value) {
  if (!keysAre(value, ['goos', 'goarch', 'tags']) || !word.test(value.goos) || !word.test(value.goarch) || !Array.isArray(value.tags) ||
      value.tags.some(tag => typeof tag !== 'string' || !/^[A-Za-z0-9_.]{1,40}$/.test(tag))) {
    fail('Each Go outcome build requires goos, goarch and tags');
  }
}

function header(report, modulePath) {
  if (!keysAre(report, ['schema', 'version', 'go_version', 'module', 'builds', 'files'])) fail('Malformed Go outcome report');
  if (report.schema !== 'clouseau-go-outcomes' || report.version !== 1) fail('Unsupported Go outcome report schema or version');
  if (typeof report.go_version !== 'string' || !/^go1\.[0-9]+(?:\.[0-9]+)?(?:rc[0-9]+)?$/.test(report.go_version)) fail('Go outcome report has no Go version');
  if (report.module !== modulePath) fail('The Go outcome report belongs to another module');
  if (!Array.isArray(report.builds) || !report.builds.length || report.builds.length > MAX_BUILDS) fail('A Go outcome report requires one to 16 declared builds');
  report.builds.forEach(build);
  if (!Array.isArray(report.files)) fail('Malformed Go outcome report');
}

function sourceOf(entry, moduleRoot, root, sources, seen, cwd) {
  if (!keysAre(entry, ['path', 'sha256', 'lines', 'status', 'statements', 'outcomes'], ['reason'])) fail('Malformed Go outcome file entry');
  const relative = text(entry.path);
  if (relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    fail(`Unsafe Go outcome path: ${relative}`);
  }
  const file = realPath(path.join(moduleRoot, relative), cwd);
  if (!isInside(file, root)) fail(`Go outcome path escapes the source directory: ${relative}`);
  const source = sources.get(file);
  if (!source) fail(`Unexpected Go application outcomes: ${relative}`);
  if (seen.has(file)) fail(`Duplicate Go outcome entry: ${relative}`);
  seen.add(file);
  return {file, source, relative};
}

function bind(entry, file, source, relative) {
  if (entry.sha256 !== crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') || entry.lines !== source.limit) {
    fail(`Go outcome report is stale or from another source: ${relative}`);
  }
}

const lineOf = (value, limit) => {
  const line = count(value);
  return line >= 1 && line <= limit ? line : fail('A Go outcome lies beyond the source file');
};

function measure(entry, limit, counts) {
  if (!Array.isArray(entry.statements) || !Array.isArray(entry.outcomes)) fail('Malformed Go outcome file entry');
  const lines = new Map();
  for (const statement of entry.statements) {
    if (!keysAre(statement, ['line', 'hits'])) fail('Malformed Go statement entry');
    const line = lineOf(statement.line, limit);
    const ran = count(statement.hits) > 0;
    lines.set(line, (lines.get(line) ?? true) && ran);
  }
  const keys = new Set();
  const branches = [];
  for (const outcome of entry.outcomes) {
    if (!keysAre(outcome, ['line', 'construct', 'group', 'outcome', 'hits'])) fail('Malformed Go outcome entry');
    const line = lineOf(outcome.line, limit);
    const key = [text(outcome.construct), text(outcome.group), text(outcome.outcome)].join('\0');
    if (keys.has(key)) fail('Duplicate Go outcome');
    keys.add(key);
    branches.push({from: line, to: line, covered: count(outcome.hits) > 0});
  }
  counts.lines[0] += lines.size;
  counts.lines[1] += [...lines.values()].filter(Boolean).length;
  counts.branches[0] += branches.length;
  counts.branches[1] += branches.filter(branch => branch.covered).length;
  return {lines, branches};
}

function counters(report, sourceDirectory, cwd, detail) {
  const root = realPath(sourceDirectory, cwd);
  const {modulePath, moduleRoot} = moduleOf(root);
  const sources = inventory(root, cwd);
  header(report, modulePath);
  const counts = emptyCounts();
  const seen = new Set();
  const inactive = [];
  for (const entry of report.files) {
    const {file, source, relative} = sourceOf(entry, moduleRoot, root, sources, seen, cwd);
    bind(entry, file, source, relative);
    if (entry.status === 'inactive') {
      inactive.push(`${relative} (${typeof entry.reason === 'string' ? entry.reason : 'no reason given'})`);
    } else if (entry.status !== 'measured' || Object.hasOwn(entry, 'reason')) {
      fail(`Unknown Go outcome file status: ${relative}`);
    } else {
      const measured = measure(entry, source.limit, counts);
      if (detail) detail.set(file, measured);
    }
  }
  const missing = [...sources.keys()].filter(file => !seen.has(file));
  if (missing.length) fail('Go application sources missing from the outcome report: ' + missing.sort().join(', '));
  if (inactive.length) {
    fail('Go application sources excluded from every declared build or never loaded; declare a build that includes them (goinstr -goos/-goarch/-tags and report -run): ' + inactive.sort().join(', '));
  }
  return counts;
}

module.exports = {counters};
