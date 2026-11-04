'use strict';
// A real Git change shaped like a changed-file table (test/fixtures/alcantara-02618a9.json), for end-to-end tests of the
// chunked local review. Only sizes and paths come from the table; the content is deterministic fictional filler.
const fs = require('node:fs');
const path = require('node:path');
const {git} = require('../src/local-git.cjs');
const {filler} = require('./chunked-measure.cjs');
const lock = require('./fixtures/lockfiles.cjs');

const isLockfile = row => row.derived_size !== undefined;
const write = (directory, name, text) => {
  fs.mkdirSync(path.dirname(path.join(directory, name)), {recursive: true});
  fs.writeFileSync(path.join(directory, name), text);
};
const lockfiles = row => {
  const entry = lock.largePnpm(100).length / 100;
  return {base: lock.largePnpm(Math.round(row.base_size / entry)), head: lock.largePnpm(Math.round(row.head_size / entry), 150)};
};

// Files that exist before the change (for `setup` of test/local-git-fixture.cjs).
function writeBase(directory, table) {
  for (const row of table.files) {
    if (row.base_size === 0) continue;
    write(directory, row.path, isLockfile(row) ? lockfiles(row).base : filler(`${row.path}@base`, row.base_size));
  }
}

// The change itself, committed on top of the fixture's own head commit.
function commitHead(directory, table) {
  for (const row of table.files) write(directory, row.path, isLockfile(row) ? lockfiles(row).head : filler(`${row.path}@head`, row.head_size));
  git(directory, ['add', '.']);
  git(directory, ['commit', '-qm', 'test: add a fictional large change']);
}

module.exports = {writeBase, commitHead};
