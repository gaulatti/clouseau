'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readLocalConfig} = require('./local-git.cjs');
const {coverageParts, OPTIONAL_LOCAL_KEYS} = require('./coverage-plan.cjs');
const {SAMPLES, everyOptional} = require('../test/local-optional-keys.cjs');

const base = {version: 1, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md', verification: [['npm', 'test']],
  coverage: {format: 'istanbul', report: 'coverage.json', source_directory: 'src'}};
const baseV2 = {...base, version: 2, coverage: [base.coverage]};

test('review_reuse is optional and, when set, only "outcome"', () => {
  for (const config of [base, baseV2]) {
    assert.equal(readLocalConfig(config), config);
    assert.equal(readLocalConfig({...config, review_reuse: 'outcome'}).review_reuse, 'outcome');
    for (const value of ['exact', '', true, null, 1]) {
      assert.throws(() => readLocalConfig({...config, review_reuse: value}), /review_reuse must be "outcome"/, `v${config.version} ${JSON.stringify(value)}`);
    }
  }
});

test('a version 2 recipe with "review_reuse": "outcome" passes the strict CI coverage plan too', () => {
  assert.deepEqual(coverageParts({...baseV2, review_reuse: 'outcome'}), baseV2.coverage);
});

test('a version 2 recipe still rejects an unrelated unknown top-level key, alone or next to review_reuse', () => {
  for (const extra of [{reuse: 'outcome'}, {review_reuse: 'outcome', reviewreuse: 'outcome'}]) {
    assert.throws(() => readLocalConfig({...baseV2, ...extra}), /Invalid local-only Clouseau coverage configuration/, JSON.stringify(extra));
    assert.throws(() => coverageParts({...baseV2, ...extra}), /Invalid local-only Clouseau coverage configuration/, JSON.stringify(extra));
  }
});

// Guard: every documented optional field must be accepted under both versions, by both coverageParts modes and by
// readLocalConfig. The gate's own recipe reader is guarded in coverage-changed.test.cjs, and `clouseau review` and
// `clouseau refresh` end to end in pr-refresh.test.cjs, all from the same samples.
test('every documented optional .clouseau-local.json field is accepted under version 1 and version 2', () => {
  assert.ok(OPTIONAL_LOCAL_KEYS.length);
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...OPTIONAL_LOCAL_KEYS].sort());
  for (const config of [base, baseV2]) {
    const value = {...config, ...everyOptional()};
    for (const key of OPTIONAL_LOCAL_KEYS) assert.equal(readLocalConfig(value)[key], SAMPLES[key], `v${config.version} ${key}`);
    assert.deepEqual(coverageParts(value), coverageParts(config), `v${config.version} strict`);
    assert.deepEqual(coverageParts(value, {allowUnsupported: true}), coverageParts(config, {allowUnsupported: true}), `v${config.version} lenient`);
  }
});
