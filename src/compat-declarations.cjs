'use strict';
const fs = require('node:fs');
const path = require('node:path');
const semantics = require('./review-semantics.cjs');
const {digest} = require('./acceptance.cjs');

// The compatibility declarations of a tree (docs/receipt-compatibility.md, "Declare, then fold"): how the maintainer tool
// reads, judges and writes them. Its `check`, `verify`, `declare`, `fold` and `bump` commands, and `clouseau refresh` before an
// `updated` push, all judge a tree with this one `inspect` and write a declaration with this one `declare`.
//
// A pull request never writes the statement. It adds ONE declaration file (`declare`) that names the semantic files it
// changed, by content, and says whether the change is --compatible or --incompatible. Declarations are inert: the
// statement and `acceptor()` ignore them.
//
// The manifest records the semantic files the statement was last folded for, so that "which semantic files changed" is a
// pure comparison of two file lists with no Git history. `acceptor()` trusts nothing but the statement and the live digest
// of the checkout.
const MANIFEST = 'compat/manifest.json';
const DECLARATIONS = 'compat/declarations';
const DECLARATION_DOMAIN = 'clouseau.compat-declaration.v1';
const DECISIONS = ['compatible', 'incompatible'];
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const mode = value => Number.isInteger(value) && value >= 0 && value <= 0o111;
const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;

function parseManifest(text) {
  let value;
  try {value = JSON.parse(text);} catch {throw new Error('Compatibility manifest is not JSON');}
  if (!exactKeys(value, 'entries,version') || value.version !== 1 || !Array.isArray(value.entries) ||
      !value.entries.every(entry => Array.isArray(entry) && entry.length === 3 && typeof entry[0] === 'string' &&
        mode(entry[1]) && hash(entry[2])) || new Set(value.entries.map(entry => entry[0])).size !== value.entries.length) {
    throw new Error('Compatibility manifest is malformed');
  }
  return value;
}

// One entry per line, so that a reader of the diff sees exactly which files the fold moved.
const renderManifest = list => `{\n  "version": 1,\n  "entries": [\n${list.map(entry => `    ${JSON.stringify(entry)}`).join(',\n')}\n  ]\n}\n`;

// A declared change is {path, mode, sha256}; a deleted file is {mode: 0, sha256: null}.
const declarationId = (decision, changes) => digest([DECLARATION_DOMAIN, decision, changes]);
const renderDeclaration = (decision, changes) => `${JSON.stringify({version: 1, decision, changes}, null, 2)}\n`;

function parseDeclaration(name, text) {
  let value;
  try {value = JSON.parse(text);} catch {throw new Error('is not JSON');}
  if (!exactKeys(value, 'changes,decision,version') || value.version !== 1 || !DECISIONS.includes(value.decision) ||
      !Array.isArray(value.changes) || value.changes.length === 0 ||
      !value.changes.every((change, index) => exactKeys(change, 'mode,path,sha256') && typeof change.path === 'string' &&
        mode(change.mode) && (hash(change.sha256) || (change.sha256 === null && change.mode === 0)) &&
        (index === 0 || value.changes[index - 1].path < change.path))) {
    throw new Error('is malformed');
  }
  if (name !== `${declarationId(value.decision, value.changes)}.json`) throw new Error('is not named by the digest of its own content');
  return {name, decision: value.decision, changes: value.changes};
}

function readDeclarations(root, problems) {
  const directory = path.join(root, DECLARATIONS);
  if (!fs.existsSync(directory)) return [];
  const found = [];
  for (const name of fs.readdirSync(directory).sort()) {
    try {
      const filename = path.join(directory, name);
      if (!fs.lstatSync(filename).isFile() || !/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('is not a declaration');
      found.push(parseDeclaration(name, fs.readFileSync(filename, 'utf8')));
    } catch (error) {problems.push(`${DECLARATIONS}/${name} ${error.message}`);}
  }
  return found;
}

// Everything the tool and the test need to know about a tree, without writing anything: the statement and manifest it
// carries, the semantic files that differ from that manifest, the declarations that cover them, and every problem.
// `problems` are conditions that need a repair; `undeclared` are changed files that no declaration covers yet.
function inspect(root) {
  const problems = [];
  let statement, manifest, live;
  try {
    statement = semantics.readStatement(root);
    manifest = parseManifest(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
    live = semantics.entries(root);
  } catch (error) {return {problems: [error.message], stale: [], staleProblems: 0, undeclared: [], changed: new Map(), declarations: []};}
  if (semantics.digestOf(manifest.entries) !== statement.current) {
    problems.push(`${MANIFEST} does not describe the semantics ${statement.current} that ${semantics.STATEMENT} names; ` +
      'only the protected fold (or bump) writes them together, so restore both from main');
  }
  const before = new Map(manifest.entries.map(entry => [entry[0], entry]));
  const after = new Map(live.map(entry => [entry[0], entry]));
  const changed = new Map();
  for (const [file, entry] of after) {
    const old = before.get(file);
    if (!old || old[1] !== entry[1] || old[2] !== entry[2]) changed.set(file, {mode: entry[1], sha256: entry[2]});
  }
  for (const file of before.keys()) if (!after.has(file)) changed.set(file, {mode: 0, sha256: null});
  const declarations = readDeclarations(root, problems);
  const claimed = new Map();
  // Declarations that pin content this tree no longer has, by name: the one finding a refresh may repair by re-declaring.
  const stale = new Set(); let staleProblems = 0;
  for (const declaration of declarations) {
    for (const change of declaration.changes) {
      if (claimed.has(change.path)) problems.push(`${change.path} is declared by both ${claimed.get(change.path)} and ${declaration.name}`);
      else claimed.set(change.path, declaration.name);
      const actual = changed.get(change.path);
      if (!actual) problems.push(`${declaration.name} declares ${change.path}, which has not changed since the last fold`);
      else if (actual.mode !== change.mode || actual.sha256 !== change.sha256) {
        problems.push(`${declaration.name} declares ${change.path} with different content than this tree has; delete it and declare again`);
        stale.add(declaration.name); staleProblems++;
      }
    }
  }
  const undeclared = [...changed.keys()].filter(file => !claimed.has(file));
  const decision = declarations.some(declaration => declaration.decision === 'incompatible') ? 'incompatible' : 'compatible';
  return {problems, stale: [...stale], staleProblems, undeclared, changed, declarations, decision, statement, live};
}

// Write one declaration with `decision` over every changed semantic file that no declaration covers yet: the `declare`
// command, and a refresh re-pinning a stale declaration. Writes nothing when the tree has a problem (returned) or nothing
// is undeclared.
function declare(root, decision) {
  const state = inspect(root);
  if (state.problems.length) return {problems: state.problems, changes: []};
  if (!state.undeclared.length) return {problems: [], changes: []};
  const changes = state.undeclared.sort().map(file => ({path: file, ...state.changed.get(file)}));
  fs.mkdirSync(path.join(root, DECLARATIONS), {recursive: true});
  const name = `${declarationId(decision, changes)}.json`;
  fs.writeFileSync(path.join(root, DECLARATIONS, name), renderDeclaration(decision, changes));
  return {problems: [], changes, name};
}

module.exports = {MANIFEST, DECLARATIONS, DECISIONS, parseManifest, renderManifest, declarationId, renderDeclaration, parseDeclaration, inspect, declare};
