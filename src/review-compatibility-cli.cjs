'use strict';
const fs = require('node:fs');
const path = require('node:path');
const semantics = require('./review-semantics.cjs');
const {digest} = require('./acceptance.cjs');

// Maintainer tool for the compatibility statement. See docs/receipt-compatibility.md ("Declare, then fold").
//
// A pull request never writes the statement. It adds ONE declaration file (`declare`) that names the semantic files it
// changed, by content, and says whether the change is --compatible or --incompatible. Declarations are inert: the
// statement and `acceptor()` ignore them. After the pull request is merged, the protected fold (`fold`, run only on
// protected main) turns the declarations into a new statement and manifest and deletes them.
//
// The manifest records the semantic files the statement was last folded for, so that "which semantic files changed" is a
// pure comparison of two file lists with no Git history. It is only consulted by this tool and its test; `acceptor()`
// trusts nothing but the statement and the live digest of the checkout.
const MANIFEST = 'compat/manifest.json';
const DECLARATIONS = 'compat/declarations';
const DECLARATION_DOMAIN = 'clouseau.compat-declaration.v1';
const DECISIONS = ['compatible', 'incompatible'];
const FOLD_REPOSITORY = 'gaulatti/clouseau';
const FOLD_REF = 'refs/heads/main';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const mode = value => Number.isInteger(value) && value >= 0 && value <= 0o111;
const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;
const USAGE = 'usage: review-compatibility check | verify | declare --compatible|--incompatible | fold | bump --compatible|--incompatible\n';

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
  } catch (error) {return {problems: [error.message], undeclared: [], changed: new Map(), declarations: []};}
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
  for (const declaration of declarations) {
    for (const change of declaration.changes) {
      if (claimed.has(change.path)) problems.push(`${change.path} is declared by both ${claimed.get(change.path)} and ${declaration.name}`);
      else claimed.set(change.path, declaration.name);
      const actual = changed.get(change.path);
      if (!actual) problems.push(`${declaration.name} declares ${change.path}, which has not changed since the last fold`);
      else if (actual.mode !== change.mode || actual.sha256 !== change.sha256) {
        problems.push(`${declaration.name} declares ${change.path} with different content than this tree has; delete it and declare again`);
      }
    }
  }
  const undeclared = [...changed.keys()].filter(file => !claimed.has(file));
  const decision = declarations.some(declaration => declaration.decision === 'incompatible') ? 'incompatible' : 'compatible';
  return {problems, undeclared, changed, declarations, decision, statement, live};
}

const failures = state => [...state.problems, ...state.undeclared.map(file =>
  `Undeclared review-semantics change: ${file}. Run scripts/review-compatibility declare --compatible ` +
  '(the change cannot alter what a review attests) or declare --incompatible (receipts issued earlier must be reviewed again).')];

// Rewrite the statement and the manifest for the tree as it is, and consume every declaration. Both a fold and a manual
// bump go through here, so the three files can never be written apart.
function apply(root, state, decision) {
  const live = semantics.digestOf(state.live);
  const statement = semantics.next(state.statement, live, decision === 'compatible');
  fs.mkdirSync(path.join(root, DECLARATIONS), {recursive: true});
  fs.writeFileSync(path.join(root, semantics.STATEMENT), semantics.render(statement));
  fs.writeFileSync(path.join(root, MANIFEST), renderManifest(state.live));
  for (const name of fs.readdirSync(path.join(root, DECLARATIONS))) fs.rmSync(path.join(root, DECLARATIONS, name), {force: true});
  return statement;
}

function main(args, {root = path.join(__dirname, '..'), out = text => process.stdout.write(text), env = process.env} = {}) {
  const [command, decision, ...extra] = args;
  const state = inspect(root);
  const pending = state.changed.size;
  const choice = DECISIONS.map(name => `--${name}`).indexOf(decision);
  if (['check', 'verify'].includes(command) && args.length === 1) {
    const found = failures(state);
    if (found.length) {out(`${found.join('\n')}\n`); return 1;}
    if (!pending) {out(`Compatibility statement is current for review semantics ${state.statement.current}\n`); return 0;}
    out(`${pending} semantic file(s) changed and declared; the protected fold has not recorded them yet\n`);
    return command === 'verify' ? 0 : 1;
  }
  if (command === 'declare' && choice >= 0 && extra.length === 0) {
    if (state.problems.length) {out(`${state.problems.join('\n')}\n`); return 1;}
    if (!state.undeclared.length) {out('Nothing to declare: every changed semantic file is already declared\n'); return 0;}
    const changes = state.undeclared.sort().map(file => ({path: file, ...state.changed.get(file)}));
    fs.mkdirSync(path.join(root, DECLARATIONS), {recursive: true});
    const name = `${declarationId(DECISIONS[choice], changes)}.json`;
    fs.writeFileSync(path.join(root, DECLARATIONS, name), renderDeclaration(DECISIONS[choice], changes));
    out(`Declared ${changes.length} file(s) ${DECISIONS[choice]} in ${DECLARATIONS}/${name}\n`);
    return 0;
  }
  if (command === 'fold' && args.length === 1) {
    if (env.GITHUB_REPOSITORY !== FOLD_REPOSITORY || env.GITHUB_REF !== FOLD_REF) {
      out(`The fold runs only on protected ${FOLD_REPOSITORY} ${FOLD_REF}\n`); return 1;
    }
    const found = failures(state);
    if (found.length) {out(`${found.join('\n')}\nNothing was folded\n`); return 1;}
    if (!pending) {out('Nothing to fold: the statement is current\n'); return 0;}
    const statement = apply(root, state, state.decision);
    out(`Folded ${pending} semantic file(s) ${state.decision}; review semantics ${statement.current}, ${statement.compatible.length} earlier semantics accepted\n`);
    return 0;
  }
  if (command === 'bump' && choice >= 0 && extra.length === 0) {
    if (state.problems.length) {out(`${state.problems.join('\n')}\n`); return 1;}
    const statement = apply(root, state, DECISIONS[choice]);
    out(statement === state.statement ? `Review semantics unchanged (${statement.current})\n` :
      `Review semantics ${statement.current}; ${statement.compatible.length} earlier semantics accepted\n`);
    return 0;
  }
  out(USAGE);
  return 2;
}

module.exports = {main, inspect, parseManifest, renderManifest, parseDeclaration, renderDeclaration, declarationId, MANIFEST, DECLARATIONS};
