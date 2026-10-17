'use strict';

// Load every production module so new, untested files cannot disappear from coverage.
const fs = require('node:fs');
const path = require('node:path');
function load(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) load(filename);
    else if (entry.name.endsWith('.cjs') && !entry.name.endsWith('.test.cjs')) require(filename);
  }
}
load(path.join(__dirname, '../src'));
