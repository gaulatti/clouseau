'use strict';
const fs = require('node:fs');
const path = require('node:path');
const semantics = require('./review-semantics.cjs');
const {MANIFEST, DECLARATIONS, DECISIONS, parseManifest, renderManifest, declarationId, renderDeclaration, parseDeclaration, inspect, declare} = require('./compat-declarations.cjs');

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
const FOLD_REPOSITORY = 'gaulatti/clouseau';
const FOLD_REF = 'refs/heads/main';
const USAGE = 'usage: review-compatibility check | verify | declare --compatible|--incompatible | fold | bump --compatible|--incompatible\n';

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
    const {problems, changes, name} = declare(root, DECISIONS[choice]);
    if (problems.length) {out(`${problems.join('\n')}\n`); return 1;}
    if (!changes.length) {out('Nothing to declare: every changed semantic file is already declared\n'); return 0;}
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
