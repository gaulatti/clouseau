'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {digest} = require('./acceptance.cjs');

// What a review MEANS, as one digest. See docs/receipt-compatibility.md.
//
// The semantics digest covers every engine file that can change what a signed review attests, and nothing else. It is
// computed from the same roots as the exact engine digest, but a file is semantic BY DEFAULT: a new or renamed file is
// part of the meaning until a person lists it below as receipt-neutral. This list is part of this file, and this file is
// itself semantic, so moving a file into the list changes the digest and forces the same explicit decision as editing it.
const DOMAIN = 'clouseau.review-semantics.v1';
const ROOTS = Object.freeze(['action.yml', 'src', 'policy', 'bin', 'skills', 'scripts']);
const STATEMENT = 'policy/review-compatibility.json';
const MAX_COMPATIBLE = 64;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Each entry must say why the file cannot change what a review attests. `presentation` marks the only kind of neutral
// file that semantic code may load (help text); every other neutral file must be unreferenced by semantic files, which
// review-semantics.test.cjs enforces.
const NEUTRAL = Object.freeze([
  {path: 'policy/review-compatibility.json', reason: 'the compatibility statement itself (it would otherwise depend on its own digest)'},
  {path: 'scripts/review-compatibility', reason: 'maintainer tool that edits the compatibility statement'},
  {path: 'src/review-compatibility-cli.cjs', reason: 'maintainer tool that edits the compatibility statement'},
  {path: 'src/cli-usage.cjs', presentation: true, reason: 'help text; changes no review input, rule or output'},
  {path: 'src/native-test-report.cjs', reason: 'verification trace tooling for the engine own CI'},
  {path: 'src/v8-coverage.cjs', reason: 'coverage merge tooling for the engine own CI'},
  {path: 'src/review-cost.cjs', reason: 'cost estimate printed after a review; not part of its record'},
  {path: 'scripts/v8-coverage-gate.cjs', reason: 'coverage command wrapper'},
  {path: 'scripts/verify-coverage', reason: 'the engine own coverage entry point'},
  {path: 'scripts/verify-archive', reason: 'the engine own distribution check'},
  {path: 'scripts/measure-chunked', reason: 'maintainer measurement tool'},
]);
const neutral = new Set(NEUTRAL.map(entry => entry.path));
const defaultRoot = () => path.join(__dirname, '..');

function files(root) {
  const entries = [];
  function visit(relative) {
    const filename = path.join(root, relative);
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error('Review engine source cannot contain symbolic links');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(filename).sort()) {
        if (name === '__pycache__' || /\.(test|spec)\.[cm]?js$/.test(name) || /^test_.*\.py$/.test(name)) continue;
        visit(path.join(relative, name));
      }
    } else entries.push([relative.split(path.sep).join('/'), stat.mode & 0o111, filename]);
  }
  for (const relative of ROOTS) visit(relative);
  return entries;
}

// Every engine file the digest could cover, with its class. Used by the tests and the maintainer tool.
function classify(root = defaultRoot()) {
  return files(root).map(([file, mode]) => ({path: file, mode, semantic: !neutral.has(file)}));
}

// The semantic files of the tree at `root` as [path, executable bits, sha256 of content], sorted by path.
function entries(root = defaultRoot()) {
  return files(root).filter(([file]) => !neutral.has(file)).map(([file, mode, filename]) =>
    [file, mode, crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')]);
}

const digestOf = list => digest([DOMAIN, list]);
const semanticsDigest = (root = defaultRoot()) => digestOf(entries(root));

function parseStatement(text) {
  let value;
  try {value = JSON.parse(text);} catch {throw new Error('Compatibility statement is not JSON');}
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'compatible,current,version' ||
      value.version !== 1 || !hash(value.current) || !Array.isArray(value.compatible) ||
      value.compatible.length > MAX_COMPATIBLE || !value.compatible.every(hash) ||
      new Set(value.compatible).size !== value.compatible.length || value.compatible.includes(value.current)) {
    throw new Error('Compatibility statement is malformed');
  }
  return value;
}

const readStatement = (root = defaultRoot()) => parseStatement(fs.readFileSync(path.join(root, STATEMENT), 'utf8'));
const render = statement => `${JSON.stringify({version: 1, current: statement.current, compatible: statement.compatible}, null, 2)}\n`;

// The statement for the tree at `root`, given the previous one. A tree whose semantics did not change keeps its
// statement. Otherwise the previous semantics are either declared compatible (older receipts stay valid) or not.
function next(previous, live, compatible) {
  if (previous.current === live) return previous;
  const carried = compatible ? [previous.current, ...previous.compatible].filter(item => item !== live).slice(0, MAX_COMPATIBLE) : [];
  return {version: 1, current: live, compatible: carried};
}

// The acceptance decision for a receipt issued under another engine revision: a function from the receipt's claimed
// semantics digest to true/false. It reads ONLY the engine checkout at `root` (the protected main this run resolved), and
// it answers false for everything it cannot positively establish: an unreadable or malformed statement, a statement that
// does not describe this very checkout, or a claim that is not a listed digest.
const accepted = new Map();
function acceptor(root = defaultRoot()) {
  const key = path.resolve(root);
  if (!accepted.has(key)) {
    let decide;
    try {
      const statement = readStatement(key);
      const live = semanticsDigest(key);
      decide = statement.current === live ? claim => hash(claim) && (claim === live || statement.compatible.includes(claim)) : () => false;
    } catch {decide = () => false;}
    accepted.set(key, decide);
  }
  return accepted.get(key);
}

module.exports = {DOMAIN, ROOTS, STATEMENT, MAX_COMPATIBLE, NEUTRAL, classify, entries, digestOf, semanticsDigest, parseStatement, readStatement, render, next, acceptor};
