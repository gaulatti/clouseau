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
  'leadingComments', 'trailingComments', 'innerComments']);

function counterSites(source, extension) {
  const plugins = [];
  if (extension === '.ts' || extension === '.tsx') plugins.push('typescript');
  if (extension !== '.ts') plugins.push('jsx');
  const ast = parser.parse(source, {sourceType: 'unambiguous', allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true, plugins});
  const result = {statements: false, branches: false};
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (statementSites.has(node.type) ||
        (node.type === 'VariableDeclarator' && node.init) ||
        ((node.type === 'ClassProperty' || node.type === 'ClassPrivateProperty') && node.value) ||
        (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement')) {
      result.statements = true;
    }
    if (branchSites.has(node.type)) result.branches = true;
    for (const [key, value] of Object.entries(node)) if (!metadata.has(key)) visit(value);
  }
  visit(ast);
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
