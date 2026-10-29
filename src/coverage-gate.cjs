'use strict';
// Require exact, nonempty application line and branch coverage.
const fs = require('node:fs');
const path = require('node:path');
const {fail, isObject, get, realPath, isInside, loadReport, emptyCounts} = require('./coverage-util.cjs');
const istanbul = require('./coverage-istanbul.cjs');
const coveragepy = require('./coverage-coveragepy.cjs');
const go = require('./coverage-go.cjs');

function llvmCounters(report, sourceDirectory, cwd) {
  if (get(report, 'type') !== 'llvm.coverage.json.export') fail('Expected an LLVM coverage export');
  const data = report.data;
  if (!Array.isArray(data) || !data.length) fail('Coverage data is missing');
  const root = realPath(sourceDirectory, cwd);
  const counts = emptyCounts();
  let sourceFiles = 0;
  for (const group of data) {
    const files = get(group, 'files');
    if (!Array.isArray(files) || !files.length) fail('Per-file coverage is missing');
    for (const file of files) {
      const filename = get(file, 'filename') ?? '';
      if (typeof filename !== 'string' || !isInside(realPath(filename, cwd), root) ||
          path.normalize(filename).split(path.sep).some(part => part === 'vendor' || part === '.cargo')) continue;
      sourceFiles++;
      for (const metric of Object.keys(counts)) {
        const summary = get(get(file, 'summary'), metric);
        const count = get(summary, 'count');
        const covered = get(summary, 'covered');
        if (!Number.isSafeInteger(count) || !Number.isSafeInteger(covered)) fail(`Missing integer ${metric} counts: ${filename}`);
        if (count < 0 || covered < 0 || covered > count) fail(`Invalid ${metric} counts: ${filename}`);
        counts[metric][0] += count;
        counts[metric][1] += covered;
      }
    }
  }
  if (!sourceFiles) fail('No application source coverage was measured');
  return counts;
}

// Go cover profiles are text; every other native report is JSON.
const readReport = (format, filename) => format === 'go' ? fs.readFileSync(filename, 'utf8') : loadReport(filename);

function counters(report, sourceDirectory, format, cwd) {
  if (format === 'istanbul') return istanbul.counters(report, sourceDirectory, cwd);
  if (format === 'coveragepy') return coveragepy.counters(report, sourceDirectory, cwd);
  if (format === 'go') return go.counters(report, sourceDirectory, cwd);
  if (format !== 'llvm') fail('Unknown coverage format; use llvm, istanbul, coveragepy or go');
  return llvmCounters(report, sourceDirectory, cwd);
}

// Validated native measurements without granting gate acceptance.
function measure(report, sourceDirectory, format, cwd) {
  const measured = counters(report, sourceDirectory, format, cwd);
  if (measured.lines[0] === 0) fail('No lines measured');
  return measured;
}

function enforce(counts) {
  const failures = [];
  for (const [metric, [count, covered]] of Object.entries(counts)) {
    if (count === 0) failures.push(`No ${metric} measured`);
    else if (count !== covered) failures.push(`${metric}: ${count - covered} uncovered; require exactly 100%`);
  }
  if (failures.length) fail(failures.join('; '));
  return counts;
}

const check = (report, sourceDirectory, format, cwd) => enforce(counters(report, sourceDirectory, format, cwd));

function planPath(directory, value, source) {
  if (source && value === '.') return directory;
  if (typeof value !== 'string' || !value || value.length >= 500 || value.includes('\\') || value.includes('\0') ||
      path.isAbsolute(value) || value.split('/').some(part => ['', '.', '..', '.git'].includes(part))) {
    fail('Coverage paths must be explicit repository-relative paths');
  }
  const target = realPath(path.join(directory, value), directory);
  if (!isInside(target, directory)) fail('Coverage paths cannot escape the application checkout');
  return target;
}

// Measure every native part; incomplete percentages are valid evidence.
function measurePlan(parts, directory) {
  if (!Array.isArray(parts) || !parts.length || parts.length > 32) fail('A coverage plan requires one to 32 native artifact parts');
  const root = realPath(path.resolve(directory), '/');
  const reports = new Set();
  const roots = [];
  const plan = [];
  for (const part of parts) {
    if (!isObject(part) || Object.keys(part).sort().join(',') !== 'format,report,source_directory' ||
        !['istanbul', 'coveragepy', 'go'].includes(part.format)) {
      fail('Each coverage part requires a supported native format, report and source_directory');
    }
    const report = planPath(root, part.report, false);
    const source = planPath(root, part.source_directory, true);
    if (!fs.statSync(source, {throwIfNoEntry: false})?.isDirectory()) fail('Every coverage part requires an existing application source directory');
    if (reports.has(report) || roots.some(other => isInside(source, other) || isInside(other, source))) {
      fail('Duplicate reports or overlapping application source directories are not allowed');
    }
    reports.add(report);
    roots.push(source);
    plan.push({part, report, source});
  }
  const totals = emptyCounts();
  const results = [];
  for (const {part, report, source} of plan) {
    const measured = counters(readReport(part.format, report), source, part.format, root);
    if (measured.lines[0] === 0) fail('Every coverage part requires nonempty application line counters');
    for (const metric of Object.keys(totals)) {
      totals[metric][0] += measured[metric][0];
      totals[metric][1] += measured[metric][1];
    }
    results.push({...part, counts: measured});
  }
  return {totals, parts: results};
}

function checkPlan(parts, directory) {
  const result = measurePlan(parts, directory);
  for (const part of result.parts) {
    for (const [metric, [total, covered]] of Object.entries(part.counts)) {
      if (total !== covered) fail(`${part.report} has uncovered ${metric}; require exactly 100% for every part`);
    }
  }
  // A genuinely branchless component is valid only alongside measured branches.
  enforce(result.totals);
  return result;
}

// Accepted recipes are data: their verification commands are never executed here.
function planMain(argv, cwd) {
  if (argv.length < 1 || argv.length > 2) fail('Usage: plan ACCEPTED_CONFIG [APPLICATION_DIRECTORY]');
  const config = loadReport(path.resolve(cwd, argv[0]));
  if (!isObject(config) || config.version !== 2) fail('A multi-artifact coverage recipe requires version 2');
  if (Object.keys(config).some(key => !['version', 'base_branch', 'readme', 'repository_policy', 'verification', 'coverage'].includes(key))) {
    fail('Unknown version 2 coverage recipe field');
  }
  return checkPlan(config.coverage, path.resolve(cwd, argv[1] ?? '.'));
}

// Command line: `check REPORT SOURCE_DIRECTORY [llvm|istanbul|coveragepy]` or `plan CONFIG [DIRECTORY]`.
function main(argv, {cwd, stdout, stderr}) {
  try {
    const [command, ...rest] = argv;
    if (command === 'plan') {
      stdout(JSON.stringify(planMain(rest, cwd)) + '\n');
    } else if (command === 'check' && (rest.length === 2 || rest.length === 3)) {
      const format = rest[2] ?? 'llvm';
      const counts = counters(readReport(format, path.resolve(cwd, rest[0])), path.resolve(cwd, rest[1]), format, cwd);
      for (const [metric, [count, covered]] of Object.entries(counts)) stdout(`${metric}: ${covered}/${count}\n`);
      if (format === 'go') stdout('note: go lines are statements and go branches are basic blocks\n');
      enforce(counts);
    } else fail('Usage: check REPORT SOURCE_DIRECTORY [llvm|istanbul|coveragepy|go] | plan ACCEPTED_CONFIG [APPLICATION_DIRECTORY]');
    return 0;
  } catch (error) {
    stderr(`Coverage gate failed: ${error.message}\n`);
    return 1;
  }
}

module.exports = {readReport, counters, measure, enforce, check, measurePlan, checkPlan, planMain, main};
