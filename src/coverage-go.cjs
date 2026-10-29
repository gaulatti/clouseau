'use strict';
// Validate a native Go cover profile against a complete Go source inventory.
//
// What is measured (Go's profile cannot yield anything finer):
//   lines    = statements: the sum of each block's statement count; a statement is covered
//              when its block was entered in any aggregated run.
//   branches = basic blocks: every profile block is one required entry; an `if` body, `case`
//              clause, loop body or function entry is a block. Implicit false/no-match exits and
//              short-circuit operands are NOT separate outcomes because Go does not record them.
const fs = require('node:fs');
const path = require('node:path');
const {fail, realPath, isInside, emptyCounts} = require('./coverage-util.cjs');

const EXCLUDED_DIRECTORIES = new Set(['vendor', 'testdata', 'node_modules']);
const ROW = /^(.+):([1-9][0-9]*)\.([1-9][0-9]*),([1-9][0-9]*)\.([1-9][0-9]*) ([0-9]+) ([0-9]+)$/;
const LINE_BREAKS = /\r\n|\n|\r/;

const excludedDirectory = name => name.startsWith('.') || name.startsWith('_') || EXCLUDED_DIRECTORIES.has(name);

// Remove comments, strings and runes so keyword scans see only code.
function lexGo(text, file) {
  let code = '';
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) fail(`Invalid Go application source: ${file}`);
      index = end + 2;
    } else if (char === '`') {
      const end = text.indexOf('`', index + 1);
      if (end < 0) fail(`Invalid Go application source: ${file}`);
      index = end + 1;
    } else if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < text.length && text[end] !== char && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
      if (text[end] !== char) fail(`Invalid Go application source: ${file}`);
      index = end + 1;
    } else {
      code += char;
      index++;
    }
  }
  return code;
}

// The module path and root directory of the nearest enclosing go.mod.
function moduleOf(root) {
  let directory = root;
  for (;;) {
    const candidate = path.join(directory, 'go.mod');
    if (fs.existsSync(candidate)) {
      const match = /^module\s+("?)([^\s"]+)\1\s*(?:\/\/.*)?$/m.exec(fs.readFileSync(candidate, 'utf8'));
      if (!match) fail('go.mod has no module path');
      return {modulePath: match[2], moduleRoot: directory};
    }
    const parent = path.dirname(directory);
    if (parent === directory) fail('No go.mod found for the Go source directory');
    directory = parent;
  }
}

function inventory(root, cwd) {
  const sources = new Map();
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (entry.name.endsWith('.go') || fs.statSync(file, {throwIfNoEntry: false})?.isDirectory()) fail(`Symbolic Go application source: ${file}`);
      } else if (entry.isDirectory()) {
        if (!excludedDirectory(entry.name) && !fs.existsSync(path.join(file, 'go.mod'))) walk(file);
      } else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
        let text;
        try {text = new TextDecoder('utf-8', {fatal: true}).decode(fs.readFileSync(file));}
        catch {fail(`Invalid Go application source: ${file}`);}
        const code = lexGo(text, file);
        const lines = text.split(LINE_BREAKS);
        if (lines[lines.length - 1] === '') lines.pop();
        sources.set(realPath(file, cwd), {limit: lines.length, mustAppear: /\bfunc\b/.test(code)});
      }
    }
  };
  walk(root);
  if (!sources.size) fail('No application Go sources found');
  return sources;
}

const integer = value => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fail('Go cover profile numbers must be safe integers');
};

// Parse rows into per-file block maps, merging repeated rows as the union of runs.
function blocks(text, modulePath, moduleRoot, root, sources, cwd) {
  const rows = text.split(LINE_BREAKS);
  if (rows[rows.length - 1] === '') rows.pop();
  if (!/^mode: (?:set|count|atomic)$/.test(rows[0] ?? '')) fail('Expected a native Go cover profile with a set, count or atomic mode line');
  const files = new Map();
  for (const row of rows.slice(1)) {
    const match = ROW.exec(row);
    if (!match) fail('Malformed Go cover profile row');
    const [, name, startLine, startColumn, endLine, endColumn, statements, count] = match;
    const block = {start: [integer(startLine), integer(startColumn)], end: [integer(endLine), integer(endColumn)],
      statements: integer(statements), hit: integer(count) > 0};
    if (block.start[0] > block.end[0] || (block.start[0] === block.end[0] && block.start[1] > block.end[1])) fail('Go cover block ends before it starts');
    if (!name.startsWith(modulePath + '/')) continue;
    const file = realPath(path.join(moduleRoot, name.slice(modulePath.length + 1)), cwd);
    if (!isInside(file, root)) continue;
    const source = sources.get(file);
    if (!source) fail(`Unexpected Go application coverage: ${name}`);
    if (block.end[0] > source.limit) fail(`Go cover block lies beyond the source file: ${name}`);
    const key = [...block.start, ...block.end].join(',');
    const known = files.get(file) ?? files.set(file, new Map()).get(file);
    const previous = known.get(key);
    if (previous && previous.statements !== block.statements) fail(`Conflicting Go cover rows for one block: ${name}`);
    known.set(key, previous ? {...previous, hit: previous.hit || block.hit} : block);
  }
  return files;
}

function counters(text, sourceDirectory, cwd) {
  if (typeof text !== 'string') fail('Expected a Go cover profile as text');
  const root = realPath(sourceDirectory, cwd);
  const {modulePath, moduleRoot} = moduleOf(root);
  const sources = inventory(root, cwd);
  const files = blocks(text, modulePath, moduleRoot, root, sources, cwd);
  const counts = emptyCounts();
  for (const [file, known] of files) {
    const ordered = [...known.values()].sort((a, b) => a.start[0] - b.start[0] || a.start[1] - b.start[1]);
    ordered.forEach((block, index) => {
      const before = ordered[index - 1];
      if (before && (before.end[0] > block.start[0] || (before.end[0] === block.start[0] && before.end[1] > block.start[1]))) {
        fail(`Overlapping Go cover blocks; the profile does not match the source: ${file}`);
      }
      counts.lines[0] += block.statements;
      if (block.hit) counts.lines[1] += block.statements;
      counts.branches[0]++;
      if (block.hit) counts.branches[1]++;
    });
  }
  const missing = [...sources].filter(([file, source]) => !files.has(file) && source.mustAppear).map(([file]) => file);
  if (missing.length) {
    fail('Go application sources missing from the profile (unloaded package, build constraint or GOOS/GOARCH suffix; use -coverpkg=./...): ' + missing.sort().join(', '));
  }
  return counts;
}

module.exports = {counters, inventory};
