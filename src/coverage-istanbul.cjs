'use strict';
// Read native Istanbul counters and require a complete JS/TS source inventory.
const fs = require('node:fs');
const path = require('node:path');
const {fail, isObject, get, realPath, isInside, emptyCounts} = require('./coverage-util.cjs');

const SOURCE_SUFFIXES = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs']);
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'vendor', 'test', 'tests', '__tests__']);

const productionName = name => !(name.endsWith('.d.ts') || /\.(?:test|spec)\.(?:ts|tsx|js|jsx|cjs|mjs)$/.test(name));

// Every production candidate under root. Symbolic links are listed, never followed.
function candidates(root) {
  const found = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) walk(file);
      } else if (SOURCE_SUFFIXES.has(path.extname(entry.name)) && productionName(entry.name) &&
          (entry.isSymbolicLink() ? fs.statSync(file, {throwIfNoEntry: false})?.isFile() : entry.isFile())) {
        found.push({file, symbolic: entry.isSymbolicLink()});
      }
    }
  };
  walk(root);
  return found;
}

const hit = value => Number.isSafeInteger(value) && value >= 0 ? value : fail('Coverage hits must be nonnegative integers');

function pairedMaps(entry, locations, hits) {
  const left = get(entry, locations);
  const right = get(entry, hits);
  if (!isObject(left) || !isObject(right) || Object.keys(left).sort().join('\0') !== Object.keys(right).sort().join('\0')) {
    fail(`Missing or inconsistent Istanbul ${locations}/${hits}`);
  }
  return left;
}

function measureEntry(entry) {
  const lines = new Map();
  const statements = pairedMaps(entry, 'statementMap', 's');
  for (const [key, location] of Object.entries(statements)) {
    if (!isObject(location) || location.skip) fail('Invalid or skipped statement');
    const line = get(location.start, 'line');
    if (!Number.isSafeInteger(line) || line < 1) fail('Invalid Istanbul source line');
    lines.set(line, Math.max(lines.get(line) ?? 0, hit(entry.s[key])));
  }
  const branchHits = [];
  for (const [key, location] of Object.entries(pairedMaps(entry, 'branchMap', 'b'))) {
    const values = entry.b[key];
    if (!isObject(location) || location.skip || !Array.isArray(location.locations) ||
        !Array.isArray(values) || !values.length || values.length !== location.locations.length) {
      fail('Invalid or skipped branch measurement');
    }
    branchHits.push(...values.map(hit));
  }
  return {lines: [...lines.values()], branches: branchHits};
}

function counters(report, sourceDirectory, cwd) {
  const root = realPath(sourceDirectory, cwd);
  const found = candidates(root);
  if (found.some(({file, symbolic}) => symbolic || !isInside(realPath(file, cwd), root))) fail('Symbolic or escaped JS/TS application source');
  const sources = new Set(found.map(({file}) => realPath(file, cwd)));
  if (!sources.size) fail('No application JS/TS sources found');
  for (const file of sources) {
    if (/\b(?:c8|istanbul|v8)\s+ignore\b/.test(fs.readFileSync(file, 'utf8'))) fail(`Coverage ignore directives are not allowed: ${file}`);
  }
  if (!isObject(report) || !Object.keys(report).length) fail('Expected a nonempty Istanbul coverage map');
  const seen = new Set();
  const counts = emptyCounts();
  for (const [filename, entry] of Object.entries(report)) {
    const file = realPath(filename, cwd);
    const relative = path.relative(root, file);
    if (!isInside(file, root) || relative.split(path.sep).slice(0, -1).some(part => EXCLUDED_DIRECTORIES.has(part)) ||
        !productionName(path.basename(file))) continue;
    if (!sources.has(file) || seen.has(file)) fail(`Unexpected or duplicate application coverage: ${filename}`);
    if (!isObject(entry) || entry.path !== filename) fail(`Mismatched Istanbul source path: ${filename}`);
    seen.add(file);
    const measured = measureEntry(entry);
    for (const metric of Object.keys(counts)) {
      counts[metric][0] += measured[metric].length;
      counts[metric][1] += measured[metric].filter(value => value > 0).length;
    }
  }
  const missing = [...sources].filter(file => !seen.has(file));
  if (missing.length) fail('Missing application source coverage: ' + missing.sort().join(', '));
  return counts;
}

module.exports = {counters, candidates, productionName, EXCLUDED_DIRECTORIES};
