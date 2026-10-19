#!/usr/bin/env node
'use strict';
require('../src/local-cli.cjs').main(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.decision && result.decision !== 'auto_approve') process.exitCode = 2;
}).catch(error => {process.stderr.write(error.message + '\n'); process.exitCode = 1;});
