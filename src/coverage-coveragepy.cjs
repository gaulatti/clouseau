'use strict';
// Validate native coverage.py JSON decision exits and complete Python sources.
const fs = require('node:fs');
const path = require('node:path');
const {fail, isObject, get, realPath, isInside, emptyCounts} = require('./coverage-util.cjs');

const DEPENDENCY_DIRECTORIES = new Set(['.git', '.venv', 'venv', '.tox', '.nox', '__pycache__', 'node_modules']);
const EXCLUDED_DIRECTORIES = new Set([...DEPENDENCY_DIRECTORIES, 'test', 'tests']);
const PYTHON_INTERPRETER = /^python(?:[0-9]+(?:\.[0-9]+)*)?$/;
const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

// Concrete test and dependency conventions are excluded, never application globs.
const productionName = name => !(['tests.py', 'conftest.py'].includes(name) || name.startsWith('test_') || name.endsWith('_test.py'));

const isInt = value => Number.isSafeInteger(value);

// POSIX shell word splitting, enough for a shebang line.
function shellWords(line) {
  const words = [];
  let word = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (char === "'" || char === '"') {
      const end = line.indexOf(char, index + 1);
      if (end < 0) fail('No closing quotation');
      word = (word ?? '') + line.slice(index + 1, end);
      index = end;
    } else if (char === '\\') {
      if (index + 1 >= line.length) fail('No escaped character');
      word = (word ?? '') + line[++index];
    } else word = (word ?? '') + char;
  }
  if (word !== null) words.push(word);
  return words;
}

// Classify an extensionless regular file without executing its interpreter.
function pythonShebang(file) {
  const descriptor = fs.openSync(file, 'r');
  let first;
  try {
    const head = Buffer.alloc(2);
    if (fs.readSync(descriptor, head, 0, 2, 0) !== 2 || head.toString('latin1') !== '#!') return false;
    const buffer = Buffer.alloc(4097);
    const length = fs.readSync(descriptor, buffer, 0, 4097, 2);
    const newline = buffer.subarray(0, length).indexOf(10);
    first = buffer.subarray(0, newline < 0 ? length : newline + 1);
  } finally {fs.closeSync(descriptor);}
  if (first.length > 4096) fail(`Overlong application shebang: ${file}`);
  let words;
  try {words = shellWords(new TextDecoder('utf-8', {fatal: true}).decode(first));}
  catch {fail(`Malformed application shebang: ${file}`);}
  if (!words.length) fail(`Malformed application shebang: ${file}`);
  const interpreter = words[0];
  if (path.basename(interpreter) === 'env') {
    words = words.slice(1);
    if (words[0] === '-S') words = words.slice(1);
    if (!words.length) fail(`Malformed application shebang: ${file}`);
    if (!PYTHON_INTERPRETER.test(path.basename(words[0]))) {
      if (words.some(word => PYTHON_INTERPRETER.test(path.basename(word)))) fail(`Unsupported Python application shebang: ${file}`);
      return false;
    }
    if (words[0].includes('/') && !path.isAbsolute(words[0])) fail(`Nonabsolute Python application shebang: ${file}`);
  } else if (!PYTHON_INTERPRETER.test(path.basename(interpreter))) return false;
  if (!path.isAbsolute(interpreter)) fail(`Nonabsolute Python application shebang: ${file}`);
  return true;
}

// A small lexical pass. It finds real comments and whether anything but bare string
// literals appears. Anything it cannot classify counts as executable, which is the
// strict direction: such a file must then report at least one measured statement.
function lexPython(text, file) {
  const comments = [];
  const breaks = new RegExp(LINE_BREAKS.source, 'g');
  let executable = false;
  for (let index = 0; index < text.length;) {
    const char = text[index];
    const prefix = /^[A-Za-z]{1,2}(?=["'])/.exec(text.slice(index, index + 3))?.[0];
    if (char === '#') {
      breaks.lastIndex = index;
      const end = breaks.exec(text)?.index ?? text.length;
      comments.push(text.slice(index, end));
      index = end;
    } else if (/\s/.test(char)) index++;
    else if (char === '"' || char === "'" || prefix !== undefined) {
      const start = index + (prefix?.length ?? 0);
      const quote = text[start];
      const delimiter = text.startsWith(quote.repeat(3), start) ? quote.repeat(3) : quote;
      if (!/^[rRuU]*$/.test(prefix ?? '')) executable = true;
      index = start + delimiter.length;
      for (;;) {
        if (index >= text.length || (delimiter.length === 1 && text[index] === '\n')) fail(`Invalid Python application source: ${file}`);
        if (text[index] === '\\') index += text.startsWith('\r\n', index + 1) ? 3 : 2;
        else if (text.startsWith(delimiter, index)) break;
        else index++;
      }
      index += delimiter.length;
    } else {
      executable = true;
      index++;
    }
  }
  return {comments, executable};
}

function inventory(root, cwd) {
  const sources = new Map();
  const visit = (file, relative) => {
    const name = path.basename(file);
    const parts = relative.split(path.sep);
    const suffix = path.extname(name);
    const stat = fs.lstatSync(file);
    const directory = stat.isDirectory() || (stat.isSymbolicLink() && fs.statSync(file, {throwIfNoEntry: false})?.isDirectory());
    if (!['', '.py'].includes(suffix) || parts.slice(0, -1).some(part => EXCLUDED_DIRECTORIES.has(part)) || !productionName(name)) return;
    if (EXCLUDED_DIRECTORIES.has(name) && directory) return;
    if (stat.isSymbolicLink()) fail(`Symbolic Python application source: ${file}`);
    if (stat.isDirectory()) return;
    if (!stat.isFile() || (suffix !== '.py' && !pythonShebang(file))) return;
    let text;
    try {text = new TextDecoder('utf-8', {fatal: true}).decode(fs.readFileSync(file));}
    catch {fail(`Invalid Python application source: ${file}`);}
    const {comments, executable} = lexPython(text, file);
    if (comments.some(comment => /^#\s*pragma\s*:?\s*no\s*(?:cover|branch)/i.test(comment))) fail(`Coverage ignore directives are not allowed: ${file}`);
    const lines = text.split(LINE_BREAKS);
    if (lines[lines.length - 1] === '') lines.pop();
    sources.set(realPath(file, cwd), {limit: lines.length, executable});
  };
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name);
      visit(file, path.relative(root, file));
      if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) walk(file);
    }
  };
  walk(root);
  if (!sources.size) fail('No application Python sources found');
  return sources;
}

function lineSet(value, limit) {
  if (!Array.isArray(value) || value.some(line => !isInt(line) || line < 1 || line > limit)) fail('Invalid coverage.py line numbers');
  if (new Set(value).size !== value.length) fail('Duplicate coverage.py line numbers');
  return new Set(value);
}

function arcSet(value, limit) {
  if (!Array.isArray(value)) fail('Missing coverage.py branch decision exits');
  const arcs = new Map();
  for (const arc of value) {
    if (!Array.isArray(arc) || arc.length !== 2 || !arc.every(isInt) || arc[0] < 1 || arc[0] > limit ||
        arc[1] === 0 || arc[1] < -limit || arc[1] > limit || arc[0] === arc[1]) fail('Invalid coverage.py branch decision exit');
    const key = arc.join(',');
    if (arcs.has(key)) fail('Duplicate coverage.py branch decision exit');
    arcs.set(key, arc);
  }
  return arcs;
}

function nativeCounts(entry, {limit, executable}) {
  if (!isObject(entry)) fail('Missing coverage.py file measurements');
  const executed = lineSet(entry.executed_lines, limit);
  const missing = lineSet(entry.missing_lines, limit);
  if (lineSet(entry.excluded_lines, limit).size) fail('Excluded Python application lines are not allowed');
  if ([...executed].some(line => missing.has(line)) || (executable && !(executed.size + missing.size))) {
    fail('Inconsistent or empty executable Python line measurements');
  }
  const taken = arcSet(entry.executed_branches, limit);
  const untaken = arcSet(entry.missing_branches, limit);
  const exits = new Map([...taken, ...untaken]);
  const decisions = new Map();
  for (const [, [origin]] of exits) decisions.set(origin, (decisions.get(origin) ?? 0) + 1);
  const known = line => executed.has(line) || missing.has(line);
  if ([...taken.keys()].some(key => untaken.has(key)) || [...taken.values()].some(([origin]) => !executed.has(origin)) ||
      [...untaken.values()].some(([origin]) => !known(origin)) || [...decisions.values()].some(total => total < 2)) {
    fail('Inconsistent coverage.py branch decision exits');
  }
  const summary = entry.summary;
  if (!isObject(summary) || !isInt(summary.num_statements) || !isInt(summary.covered_lines) ||
      summary.covered_lines < 0 || summary.covered_lines > executed.size ||
      summary.num_statements !== summary.covered_lines + missing.size || (executable && summary.num_statements === 0)) {
    fail('Coverage.py native summary disagrees with executable line measurements');
  }
  const expected = {
    missing_lines: missing.size, excluded_lines: 0, covered_branches: taken.size, num_branches: exits.size,
    missing_branches: untaken.size, num_partial_branches: [...untaken.values()].filter(([origin]) => executed.has(origin)).length,
  };
  if (Object.entries(expected).some(([key, count]) => !isInt(summary[key]) || summary[key] !== count)) {
    fail('Coverage.py native summary disagrees with exact line/branch measurements');
  }
  return {lines: [summary.num_statements, summary.covered_lines], branches: [exits.size, taken.size]};
}

function counters(report, sourceDirectory, cwd) {
  const root = realPath(sourceDirectory, cwd);
  const sources = inventory(root, cwd);
  const meta = get(report, 'meta');
  if (!isObject(meta) || meta.format !== 3 || meta.branch_coverage !== true || typeof meta.version !== 'string' || !meta.version) {
    fail('Expected branch-aware native coverage.py JSON format 3');
  }
  const files = report.files;
  if (!isObject(files) || !Object.keys(files).length) fail('Missing native coverage.py file measurements');
  const counts = emptyCounts();
  const seen = new Set();
  for (const [filename, entry] of Object.entries(files)) {
    if (!filename || filename.split('/').includes('..')) fail('Unsafe coverage.py source path');
    const joined = path.join(root, filename);
    const candidate = path.isAbsolute(filename) ? filename : fs.existsSync(joined) ? joined : path.resolve(cwd, filename);
    if (fs.lstatSync(candidate, {throwIfNoEntry: false})?.isSymbolicLink()) fail('Symbolic coverage.py source path');
    const file = realPath(candidate, cwd);
    if (!isInside(file, root)) continue;
    if (!sources.has(file) || seen.has(file)) fail(`Unexpected or duplicate Python application coverage: ${filename}`);
    seen.add(file);
    const measured = nativeCounts(entry, sources.get(file));
    for (const metric of Object.keys(counts)) {
      counts[metric][0] += measured[metric][0];
      counts[metric][1] += measured[metric][1];
    }
  }
  const missing = [...sources.keys()].filter(file => !seen.has(file));
  if (missing.length) fail('Missing application Python source coverage: ' + missing.sort().join(', '));
  return counts;
}

module.exports = {counters, inventory};
