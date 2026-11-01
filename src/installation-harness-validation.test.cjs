'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fixture, harness} = require('../test/bootstrap-cli-fixture.cjs');
const normal = require('./local-cli.cjs');
const cli = require('./installation-cli.cjs');
const bootstrap = require('./installation-bootstrap.cjs');

test('a mistyped --harness fails naming the valid values before any attempt is recorded', () => fixture(async f => {
  const forbidden = async () => {throw new Error('Must not invoke a harness');};
  for (const harness of ['bogus', 'codexx']) {
    await assert.rejects(cli.runReview({...f.reviewArgs, harness}, {...f.reviewRuntime, ask: forbidden, verify: forbidden}),
      error => { assert.match(error.message, /Unsupported --harness .*codex, claude/); return true; });
  }
  assert.equal(fs.existsSync(path.join(f.state, 'installation-ledgers')), false, 'no attempt ledger may be written');
  assert.equal(fs.existsSync(path.join(f.state, 'installation-reviews')), false);
  const result = await cli.runReview({...f.reviewArgs, harness: 'claude'}, {...f.reviewRuntime, ask: harness()});
  assert.equal(result.decision, 'auto_approve', 'the head is not blocked by the rejected invocations');
  const history = fs.readdirSync(path.join(f.state, 'installation-ledgers')).map(name => JSON.parse(fs.readFileSync(path.join(f.state, 'installation-ledgers', name))));
  assert.equal(history[0].installation_attempts, 1);
}));
