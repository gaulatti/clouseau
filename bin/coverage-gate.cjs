#!/usr/bin/env node
'use strict';
const {main} = require('../src/coverage-gate.cjs');

process.exitCode = main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
});
