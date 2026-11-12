'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readLocalConfig} = require('./local-git.cjs');

const base = {version: 1, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md', verification: [['npm', 'test']],
  coverage: {format: 'istanbul', report: 'coverage.json', source_directory: 'src'}};
test('review_reuse is optional and, when set, only "outcome"', () => {
  assert.equal(readLocalConfig(base), base);
  assert.equal(readLocalConfig({...base, review_reuse: 'outcome'}).review_reuse, 'outcome');
  for (const value of ['exact', '', true, null, 1]) {
    assert.throws(() => readLocalConfig({...base, review_reuse: value}), /review_reuse must be "outcome"/, JSON.stringify(value));
  }
});
