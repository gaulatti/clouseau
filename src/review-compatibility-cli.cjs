'use strict';
const fs = require('node:fs');
const path = require('node:path');
const semantics = require('./review-semantics.cjs');

// `check` fails when the compatibility statement does not describe this tree. `bump` rewrites it and demands the
// maintainer's decision: --compatible keeps receipts of the previous semantics acceptable, --incompatible retires them.
function main(args, {root = path.join(__dirname, '..'), out = text => process.stdout.write(text)} = {}) {
  const [command, decision, ...extra] = args;
  const live = semantics.semanticsDigest(root);
  const previous = semantics.readStatement(root);
  if (command === 'check' && args.length === 1) {
    if (previous.current === live) {out(`Compatibility statement is current for review semantics ${live}\n`); return 0;}
    out(`Compatibility statement is stale: it describes ${previous.current} but this tree is ${live}.\n` +
      'Run scripts/review-compatibility bump --compatible or --incompatible.\n');
    return 1;
  }
  if (command === 'bump' && ['--compatible', '--incompatible'].includes(decision) && extra.length === 0) {
    const statement = semantics.next(previous, live, decision === '--compatible');
    fs.writeFileSync(path.join(root, semantics.STATEMENT), semantics.render(statement));
    out(statement === previous ? `Review semantics unchanged (${live})\n` :
      `Review semantics ${live}; ${statement.compatible.length} earlier semantics accepted\n`);
    return 0;
  }
  out('usage: review-compatibility check | bump --compatible | bump --incompatible\n');
  return 2;
}

module.exports = {main};
