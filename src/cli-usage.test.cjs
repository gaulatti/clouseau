'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fixture, harness} = require('../test/bootstrap-cli-fixture.cjs');
const normal = require('./local-cli.cjs');
const cli = require('./installation-cli.cjs');
const bootstrap = require('./installation-bootstrap.cjs');

test('help and every usage error list every command with one line each and name the accepted options', async () => {
  const {LOCAL, INSTALLATION} = require('./cli-usage.cjs');
  assert.deepEqual(Object.keys(INSTALLATION).sort(), Object.keys(cli.COMMANDS).sort(), 'every installation command is described');
  const help = await normal.main(['--help']);
  assert.equal(await normal.main(['-h']), help); assert.equal(await normal.main(['help']), help);
  for (const name of [...LOCAL.map(item => item[0]), ...Object.keys(cli.COMMANDS)]) {
    assert.equal(help.split('\n').filter(line => line.startsWith(`  ${name} `)).length, 1, `${name} has exactly one line`);
  }
  assert.match(help, /installation-review .*--harness/);
  await assert.rejects(normal.main(['ordinary-unknown']), error => { assert.equal(error.message, help); return true; });
  assert.throws(() => cli.options(['installation-review', '--agent', 'claude']), /installation-review accepts: --directory --manifest --grant-comment --harness/);
  assert.throws(() => cli.options(['installation-engine', '--x', 'y']), /accepts: no options/);
  assert.throws(() => cli.options(['installation-nope']), /valid commands: public-identity, installation-engine/);
  assert.throws(() => normal.options(['review', '--nope', 'x']), /accepted: --directory --base/);
});
