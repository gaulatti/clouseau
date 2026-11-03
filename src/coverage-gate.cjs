'use strict';
// Require exact, nonempty application line and branch coverage.
const fs = require('node:fs');
const path = require('node:path');
const {fail, isObject, get, realPath, isInside, loadReport, emptyCounts} = require('./coverage-util.cjs');
const istanbul = require('./coverage-istanbul.cjs');
const coveragepy = require('./coverage-coveragepy.cjs');
const go = require('./coverage-go.cjs');
const lcov = require('./coverage-lcov.cjs');
const changed = require('./coverage-changed.cjs');
const declared = require('./coverage-declared.cjs');

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

// Go cover profiles and LCOV are text; every other native report is JSON.
const readReport = (format, filename) => format === 'go' || format === 'lcov' ? fs.readFileSync(filename, 'utf8') : loadReport(filename);

// `detail`, when given, receives per-file line and branch measurements for changed-line gating.
function counters(report, sourceDirectory, format, cwd, detail) {
  if (format === 'istanbul') return istanbul.counters(report, sourceDirectory, cwd, detail);
  if (format === 'coveragepy') return coveragepy.counters(report, sourceDirectory, cwd, detail);
  if (format === 'go') return go.counters(report, sourceDirectory, cwd, detail);
  if (format === 'lcov') return lcov.counters(report, sourceDirectory, cwd, detail);
  if (format !== 'llvm') fail('Unknown coverage format; use llvm, istanbul, coveragepy, lcov or go');
  if (detail) fail('Changed-line coverage needs per-line measurements; the llvm summary format does not provide them');
  return llvmCounters(report, sourceDirectory, cwd);
}

// Validated native measurements without granting gate acceptance.
function measure(report, sourceDirectory, format, cwd, detail) {
  const measured = counters(report, sourceDirectory, format, cwd, detail);
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
function measurePlan(parts, directory, detail) {
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
    const measured = counters(readReport(part.format, report), source, part.format, root, detail);
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
function loadRecipe(file, cwd) {
  const config = loadReport(path.resolve(cwd, file));
  if (!isObject(config) || config.version !== 2) fail('A multi-artifact coverage recipe requires version 2');
  if (Object.keys(config).some(key => !['version', 'base_branch', 'readme', 'repository_policy', 'verification', 'coverage'].includes(key))) {
    fail('Unknown version 2 coverage recipe field');
  }
  return config.coverage;
}

function planMain(argv, cwd) {
  if (argv.length < 1 || argv.length > 2) fail('Usage: plan ACCEPTED_CONFIG [APPLICATION_DIRECTORY]');
  return checkPlan(loadRecipe(argv[0], cwd), path.resolve(cwd, argv[1] ?? '.'));
}

// Changed-line mode: the PR's added or modified lines and branches must be covered and the repository-wide
// totals must not fall below `baselineFile`. `run` is the process runner used for `git diff`.
function changedCheck(report, sourceDirectory, format, cwd, baseRef, baselineFile, run) {
  const baseline = changed.readBaseline(baselineFile);
  const detail = new Map();
  const totals = measure(report, sourceDirectory, format, cwd, detail);
  return changed.enforceChanged({detail, changed: changed.changedLines(cwd, baseRef, run), totals, baseline, directory: cwd});
}

function changedPlan(parts, directory, baseRef, baselineFile, run) {
  const baseline = changed.readBaseline(baselineFile);
  const detail = new Map();
  const {totals} = measurePlan(parts, directory, detail);
  const root = realPath(path.resolve(directory), '/');
  return changed.enforceChanged({detail, changed: changed.changedLines(root, baseRef, run), totals, baseline, directory: root});
}

// Declared mode: the totals (or, for per-file minimums, each file) must reach the minimums that package.json declares at
// the base revision. Returns the report lines; throws a DeclaredError otherwise.
function declaredCheck(report, sourceDirectory, format, cwd, baseRef, run) {
  const minimums = declared.declaration(cwd, baseRef, run);
  declared.requirePerFile(minimums, format);
  const detail = new Map();
  const totals = measure(report, sourceDirectory, format, cwd, minimums.per_file ? detail : undefined);
  return declared.enforce({totals, detail, declared: minimums, directory: cwd});
}

function declaredPlan(parts, directory, baseRef, run) {
  const root = realPath(path.resolve(directory), '/');
  const minimums = declared.declaration(root, baseRef, run);
  const detail = new Map();
  const measured = measurePlan(parts, directory, minimums.per_file ? detail : undefined);
  measured.parts.forEach(part => declared.requirePerFile(minimums, part.format));
  const {totals} = measured;
  return declared.enforce({totals, detail, declared: minimums, directory: root});
}

const printChanged = (stdout, counts) => {
  for (const [metric, [count, covered]] of Object.entries(counts)) stdout(`changed ${metric}: ${covered}/${count}\n`);
};

// Command line: `check REPORT SOURCE_DIRECTORY [llvm|istanbul|coveragepy]` or `plan CONFIG [DIRECTORY]`.
function main(argv, {cwd, stdout, stderr}) {
  try {
    const [command, ...rest] = argv;
    if (command === 'plan') {
      stdout(JSON.stringify(planMain(rest, cwd)) + '\n');
    } else if (command === 'mode' && rest.length === 1) {
      stdout(changed.modeOf(require('./config.cjs').loadConfig(path.resolve(cwd, rest[0]))) + '\n');
    } else if (command === 'totals' && rest.length === 3) {
      stdout(JSON.stringify(measure(readReport(rest[2], path.resolve(cwd, rest[0])), path.resolve(cwd, rest[1]), rest[2], cwd)) + '\n');
    } else if (command === 'totals-plan' && (rest.length === 1 || rest.length === 2)) {
      stdout(JSON.stringify(measurePlan(loadRecipe(rest[0], cwd), path.resolve(cwd, rest[1] ?? '.')).totals) + '\n');
    } else if (command === 'changed-check' && rest.length === 5) {
      const [report, source, format, baseRef, baseline] = rest;
      printChanged(stdout, changedCheck(readReport(format, path.resolve(cwd, report)), path.resolve(cwd, source), format, cwd, baseRef, path.resolve(cwd, baseline)));
    } else if (command === 'changed-plan' && rest.length === 4) {
      const [file, directory, baseRef, baseline] = rest;
      printChanged(stdout, changedPlan(loadRecipe(file, cwd), path.resolve(cwd, directory), baseRef, path.resolve(cwd, baseline)));
    } else if (command === 'declared-check' && rest.length === 4) {
      const [report, source, format, baseRef] = rest;
      declaredCheck(readReport(format, path.resolve(cwd, report)), path.resolve(cwd, source), format, cwd, baseRef).forEach(line => stdout(line + '\n'));
    } else if (command === 'declared-plan' && rest.length === 3) {
      const [file, directory, baseRef] = rest;
      declaredPlan(loadRecipe(file, cwd), path.resolve(cwd, directory), baseRef).forEach(line => stdout(line + '\n'));
    } else if (command === 'check' && (rest.length === 2 || rest.length === 3)) {
      const format = rest[2] ?? 'llvm';
      const counts = counters(readReport(format, path.resolve(cwd, rest[0])), path.resolve(cwd, rest[1]), format, cwd);
      for (const [metric, [count, covered]] of Object.entries(counts)) stdout(`${metric}: ${covered}/${count}\n`);
      if (format === 'go') stdout('note: go lines are statements and go branches are basic blocks\n');
      enforce(counts);
    } else fail('Usage: check REPORT SOURCE_DIRECTORY [llvm|istanbul|coveragepy|lcov|go] | plan ACCEPTED_CONFIG [APPLICATION_DIRECTORY] | mode CLOUSEAU_CONFIG | totals REPORT SOURCE_DIRECTORY FORMAT | totals-plan ACCEPTED_CONFIG [APPLICATION_DIRECTORY] | changed-check REPORT SOURCE_DIRECTORY FORMAT BASE_REF BASELINE | changed-plan ACCEPTED_CONFIG APPLICATION_DIRECTORY BASE_REF BASELINE | declared-check REPORT SOURCE_DIRECTORY FORMAT BASE_REF | declared-plan ACCEPTED_CONFIG APPLICATION_DIRECTORY BASE_REF');
    return 0;
  } catch (error) {
    stderr(`Coverage gate failed: ${error.message}\n`);
    return 1;
  }
}

module.exports = {readReport, counters, measure, enforce, check, measurePlan, checkPlan, planMain, changedCheck, changedPlan, declaredCheck, declaredPlan, main};
