#!/usr/bin/env node
'use strict';
// Directories an earlier run left in the system temp directory or the work directory (killed before it could clean up).
const temporaryDirectories = require('../src/temp-dirs.cjs');
temporaryDirectories.sweepStale();
temporaryDirectories.sweepStale({root: temporaryDirectories.workDirectory()});
require('../src/local-cli.cjs').main(process.argv.slice(2)).then(result => {
  process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result) + '\n');
  if (result.decision && result.decision !== 'auto_approve') process.exitCode = 2;
  if (result.status === 'failed') process.exitCode = 1;
  if (result.status === 'awaiting_agent') process.exitCode = 3;
}).catch(error => {process.stderr.write(error.message + '\n'); process.exitCode = 1;});
