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
const PART_KEYS_WITH_PACKAGE = 'format,package_directory,report,source_directory';
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

// A v2 part has exactly these fields; package_directory is the one optional field.
const validPartShape = part => isObject(part) && [PART_KEYS, PART_KEYS_WITH_PACKAGE].includes(Object.keys(part).sort().join(','));

module.exports = {fail, isObject, get, realPath, isInside, loadReport, rejectDuplicateKeys, emptyCounts, packageDirectory, validPartShape};
