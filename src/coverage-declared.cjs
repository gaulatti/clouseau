'use strict';
// Declared coverage mode: the opt-in gate that enforces the minimums the CLIENT repository itself declares.
//
// The minimums are read from `package.json` AT THE ACCEPTED BASE REVISION (`git cat-file blob BASE:package.json`), never from
// the pull request head, so a pull request cannot lower its own bar. A single-artifact gate reads the root package.json. A
// multi-artifact plan reads `<package directory>/package.json` for EACH part (`packageDirectory` in coverage-util.cjs) and
// holds every part to its own declaration. Like the mode itself, the declarations are protected controls: a change of any
// package.json's parsed declaration between base and head needs the exact-head owner confirmation (`protect`).
// Clouseau still measures coverage itself through its adapters; only the pass line comes from the declaration.
//
// Every shape the gate cannot read exactly fails closed with a stable cause class and numbered steps; nothing falls back to
// 100% or to zero. See docs/declared-coverage.md.
const cp = require('node:child_process');
const path = require('node:path');
const {fail, isObject, rejectDuplicateKeys, packageDirectory} = require('./coverage-util.cjs');
const {REF} = require('./coverage-changed.cjs');

const FILE = 'package.json';
const METRICS = ['lines', 'branches', 'functions', 'statements'];
// Clouseau measures lines and branches. A declared functions or statements minimum is read, compared for changes and
// reported as not enforced; it is never silently treated as met.
const ENFORCED = ['lines', 'branches'];
const SAMPLE = 20;
const PER_FILE_FORMATS = ['istanbul', 'lcov', 'coveragepy', 'gooutcomes'];
const has = (object, key) => Object.hasOwn(object, key);

const PART_FIX = 'In a monorepo, declare the minimum in the package.json of the part\'s package directory, and name that directory in the part\'s `package_directory` field of the accepted coverage recipe when it is not the part\'s source directory; the gate never falls back to another directory\'s package.json.';
const LAND = 'Land that change in its own pull request first. The gate reads package.json from the accepted base revision, so it takes effect only after it merges, and changing declared thresholds needs the exact-head `/approve-intent` of a maintainer.';
const OTHER_MODE = 'Or set `coverage.mode` to `exact` or `changed_lines` in `.github/clouseau.json` (also a protected control).';
const SHAPE = 'Use `jest.coverageThreshold.global`, or `c8` or `nyc` with `"check-coverage": true`, with `lines` and `branches` as plain decimal numbers from 0 to 100.';
const STEPS = Object.freeze({
  declared_missing: ['Declare the minimum in package.json: ' + SHAPE, PART_FIX, LAND, OTHER_MODE],
  declared_conflict: ['Keep exactly one value per metric: remove repeated JSON keys, and make every declaring tool state the same value and the same `per-file` setting.', LAND],
  declared_unsupported: [SHAPE + ' Path and glob Jest entries, negative or string values, Vitest thresholds and per-file thresholds on `go` or `llvm` reports cannot be read exactly.', LAND, OTHER_MODE],
  declared_below_threshold: ['Add tests until each metric named above reaches its declared minimum.',
    'Do not lower the declared threshold in this pull request to pass: the gate reads the base revision, so the edit would not apply to this run and would need the exact-head `/approve-intent`.'],
});

// `where` names the coverage part (and its declaration file) in a multi-artifact plan; without it the wording is unchanged.
class DeclaredError extends Error {
  constructor(cause, sentence, where = null) {
    super(`Declared coverage (cause: \`${cause}\`)${where ? ` for ${where}` : ''}: ${sentence}\n\n${STEPS[cause].map((step, index) => `${index + 1}. ${step}`).join('\n')}`);
    this.declared_cause = cause;
    this.sentence = sentence;
    this.where = where;
  }

  // Every failing part is reported, each under its own cause class and name.
  static combine(errors) {
    const [first] = errors;
    const combined = new DeclaredError(first.declared_cause, first.sentence, first.where);
    combined.message = errors.map(error => error.message).join('\n\n');
    combined.declared_parts = errors.map(error => ({part: error.where, cause: error.declared_cause}));
    return combined;
  }
}
const missing = sentence => new DeclaredError('declared_missing', sentence);
const conflict = sentence => new DeclaredError('declared_conflict', sentence);
const unsupported = sentence => new DeclaredError('declared_unsupported', sentence);

function threshold(label, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100 || /e/i.test(String(value))) {
    throw unsupported(`${label} must be a plain decimal number from 0 to 100; negative (Jest counts uncovered items), string, exponent and out-of-range values are not read`);
  }
  return value;
}

function jestDeclaration(jest) {
  if (!isObject(jest)) throw unsupported('"jest" in package.json must be an object');
  if (!has(jest, 'coverageThreshold')) return null;
  const entries = jest.coverageThreshold;
  if (!isObject(entries) || Object.keys(entries).join() !== 'global') {
    throw unsupported('jest.coverageThreshold supports only a "global" entry; path and glob entries are not read');
  }
  if (!isObject(entries.global) || !Object.keys(entries.global).length) throw unsupported('jest.coverageThreshold.global must declare at least one threshold');
  const values = {};
  for (const [key, value] of Object.entries(entries.global)) {
    if (!METRICS.includes(key)) throw unsupported(`jest.coverageThreshold.global.${key} is not a coverage metric`);
    values[key] = threshold(`jest.coverageThreshold.global.${key}`, value);
  }
  return {tool: 'jest', per_file: false, values};
}

// c8 and nyc share their key names. Both enforce thresholds only with check-coverage on.
function toolDeclaration(tool, object) {
  if (!isObject(object)) throw unsupported(`"${tool}" in package.json must be an object`);
  const flag = (kebab, camel) => {
    const names = [kebab, camel].filter(name => has(object, name));
    if (names.length > 1) throw conflict(`${tool} sets both ${kebab} and ${camel}`);
    if (names.length && typeof object[names[0]] !== 'boolean') throw unsupported(`${tool}.${names[0]} must be true or false`);
    return names.length > 0 && object[names[0]];
  };
  const values = {};
  for (const metric of METRICS.filter(name => has(object, name))) values[metric] = threshold(`${tool}.${metric}`, object[metric]);
  const check = flag('check-coverage', 'checkCoverage');
  const perFile = flag('per-file', 'perFile');
  if (!Object.keys(values).length) {
    if (check) throw unsupported(`${tool} sets check-coverage without explicit thresholds; its implicit defaults are not read`);
    return null;
  }
  if (!check) throw unsupported(`${tool} declares thresholds without "check-coverage": true, so ${tool} itself does not enforce them`);
  return {tool, per_file: perFile, values};
}

const VITEST_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

// The declaration of one package.json text: {tools, per_file, thresholds}; throws DeclaredError for every other outcome.
function parse(text) {
  let value;
  try {value = JSON.parse(text);} catch {throw unsupported('package.json is not valid JSON');}
  try {rejectDuplicateKeys(text);} catch {throw conflict('package.json repeats a JSON key, so a threshold could be declared twice');}
  if (!isObject(value)) throw unsupported('package.json is not a JSON object');
  const found = [has(value, 'jest') && jestDeclaration(value.jest), has(value, 'c8') && toolDeclaration('c8', value.c8),
    has(value, 'nyc') && toolDeclaration('nyc', value.nyc)].filter(Boolean);
  if (!found.length) {
    if (VITEST_FIELDS.some(field => isObject(value[field]) && has(value[field], 'vitest'))) {
      throw unsupported('this project uses Vitest, whose coverage thresholds live in its own configuration and cannot be declared in package.json');
    }
    throw missing('package.json declares no coverage threshold (no jest.coverageThreshold, c8 or nyc minimums)');
  }
  const thresholds = {};
  for (const metric of METRICS) {
    const given = found.filter(declaration => has(declaration.values, metric));
    if (new Set(given.map(declaration => declaration.values[metric])).size > 1) {
      throw conflict(`${metric} is declared with different values (${given.map(declaration => `${declaration.tool} ${declaration.values[metric]}`).join(', ')})`);
    }
    if (given.length) thresholds[metric] = given[0].values[metric];
  }
  if (new Set(found.map(declaration => declaration.per_file)).size > 1) {
    throw conflict(`${found.map(declaration => `${declaration.tool} per-file ${declaration.per_file}`).join(', ')} disagree on per-file`);
  }
  if (!ENFORCED.some(metric => has(thresholds, metric))) {
    throw missing('only functions or statements minimums are declared; the gate enforces lines and branches');
  }
  return {tools: found.map(declaration => declaration.tool), per_file: found[0].per_file, thresholds};
}

// `<package directory>/package.json` ('.' is the repository root).
const fileIn = packageDir => packageDir === '.' ? FILE : `${packageDir}/${FILE}`;

// The package.json of a package directory at the base revision. A missing file, a directory that is a symbolic link or
// absent there, or an unreachable revision is a missing declaration.
function readBase(directory, baseRef, run = cp.execFileSync, packageDir = '.') {
  if (typeof baseRef !== 'string' || !REF.test(baseRef) || baseRef.includes('..')) fail('Declared coverage requires a plain base revision');
  packageDirectory({source_directory: packageDir});
  const file = fileIn(packageDir);
  try {
    return run('git', ['cat-file', 'blob', `${baseRef}:${file}`], {cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024});
  } catch {throw missing(`${file} cannot be read at the base revision ${baseRef.slice(0, 12)} (absent there, or the checkout lacks its history)`);}
}

const declaration = (directory, baseRef, run, packageDir = '.') => parse(readBase(directory, baseRef, run, packageDir));

// A threshold as an exact fraction of integers: 87.5 -> 875/10.
function fraction(value) {
  const [whole, decimals = ''] = String(value).split('.');
  return [BigInt(whole + decimals), 10n ** BigInt(decimals.length)];
}
// covered/total >= value%, without floating point.
function meets([total, covered], value) {
  const [numerator, denominator] = fraction(value);
  return BigInt(covered) * 100n * denominator >= numerator * BigInt(total);
}
// The measured percent, floored to two decimals so that a shown value never reaches a minimum that the exact test missed.
function percent([total, covered]) {
  if (!total) return 'n/a';
  const hundredths = BigInt(covered) * 10000n / BigInt(total);
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}%`;
}
const show = ([total, covered]) => `${percent([total, covered])} (${covered}/${total})`;

function perFileCounts(entry) {
  const lines = [...entry.lines.values()];
  return {lines: [lines.length, lines.filter(Boolean).length], branches: [entry.branches.length, entry.branches.filter(item => item.covered).length]};
}

// Compare the measured totals (or each file's counts) with the declared minimums; throws declared_below_threshold.
function enforce({totals, detail, declared, directory}) {
  const metrics = ENFORCED.filter(metric => has(declared.thresholds, metric));
  const failures = [];
  const lines = [];
  if (declared.per_file) {
    for (const [file, entry] of [...detail].sort(([a], [b]) => a < b ? -1 : 1)) {
      const counts = perFileCounts(entry);
      for (const metric of metrics.filter(name => !meets(counts[name], declared.thresholds[name]))) {
        failures.push(`${path.relative(directory, file)}: ${metric} ${show(counts[metric])} is below the declared minimum ${declared.thresholds[metric]}%`);
      }
    }
    lines.push(`declared per file: ${detail.size} files checked against ${metrics.map(metric => `${metric} ${declared.thresholds[metric]}%`).join(', ')}`);
  } else {
    for (const metric of metrics) {
      const bad = !meets(totals[metric], declared.thresholds[metric]);
      (bad ? failures : lines).push(bad ? `${metric}: ${show(totals[metric])} is below the declared minimum ${declared.thresholds[metric]}%` :
        `declared ${metric}: ${show(totals[metric])}, minimum ${declared.thresholds[metric]}%`);
    }
  }
  if (failures.length) {
    throw new DeclaredError('declared_below_threshold', failures.slice(0, SAMPLE).join('; ') + (failures.length > SAMPLE ? `; and ${failures.length - SAMPLE} more` : ''));
  }
  const skipped = METRICS.filter(metric => !ENFORCED.includes(metric) && has(declared.thresholds, metric));
  if (skipped.length) lines.push(`declared but not enforced (Clouseau measures lines and branches): ${skipped.map(metric => `${metric} ${declared.thresholds[metric]}%`).join(', ')}`);
  return lines;
}

// Per-file minimums need per-file counts that agree with the totals; llvm summaries and Go blocks cannot supply them.
function requirePerFile(declared, format) {
  if (declared.per_file && !PER_FILE_FORMATS.includes(format)) {
    throw unsupported(`per-file minimums need per-file line and branch counts, which the ${format} coverage format does not provide`);
  }
}

// Normalised comparison of the declaration at two revisions. An absent file reads like an empty one.
function outcome(text) {
  try {return {declared: parse(text ?? '{}')};} catch (error) {return {cause: error.declared_cause, sentence: error.sentence};}
}
const differs = (baseText, headText) => JSON.stringify(outcome(baseText)) !== JSON.stringify(outcome(headText));

const isPackageFile = name => typeof name === 'string' && path.posix.basename(name) === FILE;
const CANDIDATE_LIMIT = 20;

// The protected-control hold for a changed declaration, in ANY package.json (a monorepo part declares in its own package
// directory). Each changed package.json (or one renamed away) is compared on its parsed declaration at base and head.
// Without `coverage.mode: declared` this reads nothing.
async function protect({github, repo, pr, files, config}) {
  const set = new Set();
  const notices = [];
  if (config.coverage?.mode !== 'declared') return {protect: set, notices};
  const candidates = [...new Set(files.flatMap(file => [file.filename, file.previous_filename]).filter(isPackageFile))].sort();
  if (!candidates.length) return {protect: set, notices};
  const hold = (file, reason) => {
    set.add(file);
    notices.push(`${file} is a protected-control hold: ${reason}.`);
  };
  if (candidates.length > CANDIDATE_LIMIT) {
    candidates.forEach(file => set.add(file));
    notices.push(`${candidates.length} package.json files changed, more than the ${CANDIDATE_LIMIT} whose declared coverage thresholds can be compared, so all are protected-control holds.`);
    return {protect: set, notices};
  }
  const headRepo = pr.head.repo;
  if (!headRepo?.owner?.login || !headRepo.name) {
    candidates.forEach(file => hold(file, 'the head repository is unavailable'));
    return {protect: set, notices};
  }
  const {fetchText} = require('./acceptance-sources.cjs');
  const snapshot = {head_sha: pr.head.sha, head_repository: {owner: headRepo.owner.login, repo: headRepo.name}};
  for (const file of candidates) {
    const read = async ref => {
      try {return await fetchText({github, repo, snapshot, filename: file, ref});}
      catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    };
    let baseText;
    let headText;
    try {
      baseText = await read(pr.base.sha);
      headText = await read(pr.head.sha);
    } catch (error) {
      if (!error.unavailable) throw error;
      hold(file, 'the base or head file is unavailable as complete text');
      continue;
    }
    if (differs(baseText, headText)) hold(file, 'the declared coverage thresholds changed');
  }
  return {protect: set, notices};
}

module.exports = {FILE, CANDIDATE_LIMIT, isPackageFile, fileIn, METRICS, STEPS, DeclaredError, threshold, parse, readBase, declaration, meets, percent, enforce, requirePerFile, outcome, differs, protect};
