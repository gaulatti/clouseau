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

function counterSites(source, extension) {
  const plugins = [];
  if (extension === '.ts' || extension === '.tsx') plugins.push('typescript');
  if (extension !== '.ts') plugins.push('jsx');
  const ast = parser.parse(source, {sourceType: 'unambiguous', allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true, plugins});
  const result = {statements: false, branches: false};
  for (const node of runtimeNodes(ast)) {
    if (statementSites.has(node.type) ||
        (node.type === 'VariableDeclarator' && node.init) ||
        ((node.type === 'ClassProperty' || node.type === 'ClassPrivateProperty') && node.value) ||
        (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement')) {
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
