'use strict';
// A `gh` executable first on PATH that records every invocation and fails, for proving that a code path never runs gh. `run`
// executes with it in place; afterwards the recorder must be empty, or the call fails naming what ran.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function silentGh(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-gh-recorder-'));
  const log = path.join(directory, 'calls.log');
  fs.writeFileSync(path.join(directory, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 1\n`, {mode: 0o755});
  const previous = process.env.PATH;
  process.env.PATH = `${directory}${path.delimiter}${previous}`;
  try {
    const value = await run();
    assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '', 'gh was invoked');
    return value;
  } finally {
    process.env.PATH = previous;
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

module.exports = {silentGh};
