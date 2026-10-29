'use strict';

// Deterministic coverage from raw V8 process reports.
//
// Node's built-in coverage merge reads the per-process report directory in the
// order the filesystem lists it and folds each process into the previous result.
// V8 omits a block range whose count equals its parent's, so two processes can
// describe the same function with differently nested ranges, and the fold then
// yields a different (and sometimes falsely incomplete) result for different
// directory orders. This module instead turns every process into an execution
// count per source offset and adds those counts, which is order independent.

const fs = require('node:fs');
const path = require('node:path');
const {fileURLToPath} = require('node:url');

const PROCESS_REPORT = /^coverage-\d+-\d+-\d+\.json$/;
const SOURCE_FILE = /\.(?:cjs|js|mjs)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:cjs|js|mjs)$/;

function sourceFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(filename));
    else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) found.push(filename);
  }
  return found;
}

// Execution count of every character of one script in one process. Enclosing
// functions are painted before the functions nested in them; within a function
// V8 lists ranges from outermost to innermost, so later ranges refine earlier ones.
function paint(functions, length) {
  const counts = new Float64Array(length);
  const ordered = functions.slice()
    .sort((a, b) => b.ranges[0].endOffset - a.ranges[0].endOffset)
    .sort((a, b) => a.ranges[0].startOffset - b.ranges[0].startOffset);
  for (const fn of ordered) for (const range of fn.ranges) counts.fill(range.count, range.startOffset, Math.min(range.endOffset, length));
  return counts;
}

function collect(directory, files) {
  for (const name of fs.readdirSync(directory).filter(entry => PROCESS_REPORT.test(entry)).sort()) {
    for (const script of JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')).result) {
      const file = script.url.startsWith('file:') ? files.get(fileURLToPath(script.url)) : undefined;
      if (!file) continue;
      const painted = paint(script.functions, file.text.length);
      for (let index = 0; index < painted.length; index++) file.totals[index] += painted[index];
      for (const fn of script.functions) {
        if (fn.isBlockCoverage) for (const range of fn.ranges.slice(1)) file.branches.set(`${range.startOffset}:${range.endOffset}`, range);
      }
    }
  }
}

function measure(file) {
  const lines = [];
  let offset = 0;
  file.text.split('\n').forEach((text, index) => {
    let count = -1;
    for (let column = 0; column < text.length; column++) {
      if (/\S/.test(text[column])) count = Math.max(count, file.totals[offset + column]);
    }
    if (count >= 0) lines.push({number: index + 1, count});
    offset += text.length + 1;
  });
  const branches = [...file.branches.values()]
    .sort((a, b) => a.endOffset - b.endOffset)
    .sort((a, b) => a.startOffset - b.startOffset)
    .map(range => {
      const position = range.startOffset + Math.max(0, file.text.slice(range.startOffset, range.endOffset).search(/\S/));
      return {line: file.text.slice(0, position).split('\n').length, count: file.totals[position]};
    });
  return {path: file.path, lines, branches};
}

function evaluate({root, source, coverage}) {
  const files = new Map();
  for (const filename of sourceFiles(path.join(root, source))) {
    const text = fs.readFileSync(filename, 'utf8');
    files.set(fs.realpathSync(filename), {path: path.relative(root, filename).split(path.sep).join('/'), text,
      totals: new Float64Array(text.length), branches: new Map()});
  }
  if (!files.size) throw new Error(`No production source files under ${source}`);
  collect(coverage, files);
  return [...files.values()].map(measure);
}

const hit = items => items.filter(item => item.count > 0).length;
const percent = items => (items.length ? (100 * hit(items) / items.length).toFixed(2) : '100.00');
const complete = measured => measured.every(file => hit(file.lines) === file.lines.length && hit(file.branches) === file.branches.length);

function toLcov(measured) {
  return measured.map(file => [
    'TN:', `SF:${file.path}`,
    ...file.lines.map(line => `DA:${line.number},${line.count}`),
    `LF:${file.lines.length}`, `LH:${hit(file.lines)}`,
    ...file.branches.map((branch, index) => `BRDA:${branch.line},${index},0,${branch.count}`),
    `BRF:${file.branches.length}`, `BRH:${hit(file.branches)}`, 'end_of_record', ''].join('\n')).join('');
}

function toReport(measured) {
  const uncovered = items => items.filter(item => item.count === 0).map(item => item.number ?? item.line);
  const rows = measured.map(file => `${file.path} | line ${percent(file.lines)}% | branch ${percent(file.branches)}% | ` +
    `uncovered lines: ${uncovered(file.lines).join(',')} | uncovered branches at lines: ${uncovered(file.branches).join(',')}`);
  const verdict = complete(measured) ? 'Coverage is 100% for lines and branches.' : 'Coverage is below 100% for lines or branches.';
  return `${rows.join('\n')}\n${verdict}\n`;
}

function gate({root, source, coverage, lcov, stdout}) {
  const measured = evaluate({root, source, coverage});
  fs.writeFileSync(lcov, toLcov(measured));
  stdout.write(toReport(measured));
  return complete(measured) ? 0 : 1;
}

module.exports = {evaluate, gate, paint, toLcov, toReport};
