'use strict';
const fs = require('node:fs');
const path = require('node:path');

const fail = message => {throw new Error(message);};
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Reading a field of anything that is not an object is a missing field, never an exception.
const get = (value, key) => isObject(value) ? value[key] : undefined;

// Resolve symlinks for the part of the path that exists and lexically join the rest.
function realPath(value, cwd) {
  const absolute = path.resolve(cwd, value);
  try {return fs.realpathSync(absolute);}
  catch {
    const parent = path.dirname(absolute);
    return path.join(realPath(parent, cwd), path.basename(absolute));
  }
}

function isInside(child, root) {
  const relative = path.relative(root, child);
  return relative === '' || !(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative));
}

// JSON.parse keeps the last of two equal keys; coverage evidence must never be ambiguous.
function rejectDuplicateKeys(text) {
  const stack = [];
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]/g)) {
    const top = stack[stack.length - 1];
    if (token === '{') stack.push({keys: new Set(), expectKey: true});
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') {if (top) top.expectKey = true;}
    else if (token === ':') top.expectKey = false;
    else if (top && top.expectKey) {
      const key = JSON.parse(token);
      if (top.keys.has(key)) fail(`Duplicate coverage JSON key: ${key}`);
      top.keys.add(key);
    }
  }
}

function loadReport(filename) {
  const text = fs.readFileSync(filename, 'utf8');
  const value = JSON.parse(text);
  rejectDuplicateKeys(text);
  return value;
}

const emptyCounts = () => ({lines: [0, 0], branches: [0, 0]});

const PART_KEYS = 'format,report,source_directory';
const plainDirectory = value => typeof value === 'string' && value.length > 0 && value.length < 500 && !value.startsWith('/') &&
  !value.includes('\\') && !value.includes('\0') && !value.split('/').some(part => !part || part === '.' || part === '..' || part === '.git');

// The repository-relative directory whose package.json declares a v2 part's coverage minimums (declared mode). It is the
// explicit `package_directory`, or the part's own source directory; never inferred from a parent. It must contain the
// part's source directory (`.` is the repository root). Returns the validated directory or throws.
function packageDirectory(part) {
  const directory = Object.hasOwn(part, 'package_directory') ? part.package_directory : part.source_directory;
  const source = part.source_directory;
  if (!(directory === '.' || plainDirectory(directory)) || !(source === '.' || plainDirectory(source)) ||
      !(directory === '.' || source === directory || source.startsWith(directory + '/'))) {
    fail('A coverage part package_directory must be an explicit repository-relative directory that contains its source_directory');
  }
  return directory;
}

// The source suffixes an lcov part may declare: one to eight distinct lowercase suffixes such as ".swift". Returns the
// validated array or throws. With no declaration the inventory stays the JS/TS list (applied by the source scope).
const SUFFIX = /^\.[a-z0-9]{1,8}$/;
function validateSourceSuffixes(value) {
  if (!Array.isArray(value) || !value.length || value.length > 8 || value.some(item => typeof item !== 'string' || !SUFFIX.test(item)) ||
      new Set(value).size !== value.length) {
    fail('source_suffixes must be a list of one to eight distinct suffixes such as ".swift" (lowercase letters and digits, at most eight)');
  }
  return value;
}

// A v2 part has exactly these fields; package_directory and source_suffixes are the optional ones. source_suffixes is
// meaningful only for the lcov format, whose report names files of any language; every other adapter owns its inventory.
function validPartShape(part) {
  if (!isObject(part)) return false;
  const keys = Object.keys(part);
  const optional = ['package_directory', 'source_suffixes'];
  if (!PART_KEYS.split(',').every(key => keys.includes(key)) || keys.some(key => !PART_KEYS.split(',').includes(key) && !optional.includes(key))) return false;
  if (!Object.hasOwn(part, 'source_suffixes')) return true;
  try {validateSourceSuffixes(part.source_suffixes);} catch {return false;}
  return part.format === 'lcov';
}


// Names the likely causes of missing JS/TS coverage and the repairs. The wording is fixed printable ASCII; only
// the two detections below depend on the missing paths, and nothing here changes whether the gate passes.
const TYPE_ONLY = /\.(?:types?|interfaces?)\.(?:ts|tsx)$/;
function missingSourceExplanation(files) {
  const detected = [];
  const typeOnly = files.filter(file => TYPE_ONLY.test(file)).length;
  if (typeOnly) detected.push(`${typeOnly} missing file(s) have type-only names (*.types.ts, *.interface.ts), which the Jest istanbul provider can omit.`);
  const vendored = files.filter(file => file.split(/[\\/]/).includes('.clouseau-ci')).length;
  if (vendored) detected.push(`${vendored} missing file(s) are under a .clouseau-ci directory, the vendored Clouseau engine checkout, which is not application source.`);
  return [...detected.map(line => `Detected: ${line}`),
    'Likely causes and repairs:',
    '1. Files that compile to no instrumented statements (for example type-only files) are omitted by the Jest istanbul provider: run Jest with --coverageProvider=v8, or list the files in collectCoverageFrom.',
    '2. The source directory contains a path that is not application source (for example .clouseau-ci): point source_directory at the real source directories, one part each (the version-2 multi-part recipe in docs/declared-coverage.md).',
    '3. No test imports the files: import them from a test.'].join('\n');
}


module.exports = {missingSourceExplanation, fail, isObject, get, realPath, isInside, loadReport, rejectDuplicateKeys, emptyCounts, packageDirectory, validPartShape, validateSourceSuffixes};
