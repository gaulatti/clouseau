'use strict';

// Inspect source as data. Do not load application code, Babel config or plugins.
const parser = require('../vendor/babel-parser/index.cjs');
const statementSites = new Set([
  'ExpressionStatement', 'BreakStatement', 'ContinueStatement', 'DebuggerStatement',
  'ReturnStatement', 'ThrowStatement', 'TryStatement', 'IfStatement', 'ForStatement',
  'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement',
  'SwitchStatement', 'WithStatement', 'LabeledStatement',
]);
const branchSites = new Set(['AssignmentPattern', 'ConditionalExpression', 'LogicalExpression',
  'IfStatement', 'SwitchStatement']);
const metadata = new Set(['loc', 'start', 'end', 'extra', 'comments', 'tokens',
  'leadingComments', 'trailingComments', 'innerComments', 'typeAnnotation',
  'returnType', 'typeParameters', 'typeArguments', 'superTypeParameters',
  'superTypeArguments', 'implements', 'predicate']);
const erasedDeclarations = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration',
  'TSDeclareFunction', 'TSDeclareMethod', 'TSNamespaceExportDeclaration']);

function* runtimeNodes(ast) {
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index--) pending.push(node[index]);
      continue;
    }
    // Ambient context erases the whole declaration tree, including literal
    // initializers nested in a declared namespace or class. Siblings remain.
    if (node.declare === true || erasedDeclarations.has(node.type)) continue;
    yield node;
    for (const [key, value] of Object.entries(node)) if (!metadata.has(key)) pending.push(value);
  }
}

// `decorators` (default off, #261): also parse TypeScript's experimental
// decorator syntax (Babel's `decorators-legacy`, the syntax Nest uses, including
// parameter decorators) in .ts/.tsx, still as data. A decorator is executed when
// its class is defined (TypeScript emits `X = __decorate([...], X)`), and every
// native producer measured for #261 emits statements for a decorated class, so
// a decorator is a statement site: an empty statement map for a decorated file
// is still a missing measurement. Runtime code inside decorator arguments is
// walked like any other expression.
// Any decorator anywhere in the tree, including inside declarations the runtime
// projection erases (TypeScript refuses decorators there, but the parser accepts
// them): the opt-in path never lets syntax it newly parses make a file look
// counter-free.
function hasDecorator(ast) {
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      pending.push(...node);
      continue;
    }
    if (node.type === 'Decorator') return true;
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'loc' && key !== 'comments' && key !== 'tokens') pending.push(value);
    }
  }
  return false;
}

function counterSites(source, extension, {decorators = false} = {}) {
  const typescript = extension === '.ts' || extension === '.tsx';
  const plugins = [];
  if (typescript) plugins.push('typescript');
  if (typescript && decorators) plugins.push('decorators-legacy');
  if (extension !== '.ts') plugins.push('jsx');
  const ast = parser.parse(source, {sourceType: 'unambiguous', allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true, plugins});
  const result = {statements: decorators && typescript && hasDecorator(ast), branches: false};
  for (const node of runtimeNodes(ast)) {
    if (statementSites.has(node.type) ||
        (node.type === 'VariableDeclarator' && node.init) ||
        ((node.type === 'ClassProperty' || node.type === 'ClassPrivateProperty') && node.value) ||
        (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement') ||
        node.type === 'Decorator') {
      result.statements = true;
    }
    if (branchSites.has(node.type)) result.branches = true;
  }
  return result;
}

module.exports = {counterSites};
if (require.main === module) {
  try {
    const fs = require('node:fs');
    process.stdout.write(JSON.stringify(counterSites(fs.readFileSync(0, 'utf8'), process.argv[2])) + '\n');
  } catch {
    process.stderr.write('Cannot inspect native Istanbul counter sites\n');
    process.exitCode = 1;
  }
}
