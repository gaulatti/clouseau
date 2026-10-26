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

module.exports = {fail, isObject, get, realPath, isInside, loadReport, emptyCounts};
