'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {coverageParts} = require('./coverage-plan.cjs');
const {readLocalConfig, collectLocal, git} = require('./local-git.cjs');
const {repository} = require('../test/local-git-fixture.cjs');

const part = (root = 'src', report = 'coverage.json', format = 'istanbul') =>
  ({format, report, source_directory: root});
const recipe = coverage => ({version: 2, base_branch: 'main', readme: 'README.md',
  repository_policy: 'AGENTS.md', verification: [['node', '--version']], coverage});

test('v2 explicit native parts preserve the v1 single-artifact contract', () => {
  for (const format of ['llvm', 'istanbul', 'coveragepy']) {
    const coverage = {...part('src', 'native.json', format), legacy_metadata: true};
    const config = {...recipe(coverage), version: 1};
    assert.deepEqual(coverageParts(config), [coverage]);
    assert.equal(readLocalConfig(config), config);
  }
  const value = recipe([part('backend', 'backend.json', 'coveragepy'), part('frontend/app', 'frontend.json')]);
  assert.equal(readLocalConfig(value), value);
  assert.equal(coverageParts(value), value.coverage);
  assert.doesNotThrow(() => coverageParts(recipe([part('src'), part('src-other', 'other.json')])));
});

test('coverage configuration rejects unsafe paths, unknown policy fields and ambiguous native parts', () => {
  const invalid = [null, {version: 3}, recipe(null), recipe([]), recipe('not a plan'),
    recipe(Array.from({length: 33}, (_, index) => part('src' + index, `report${index}.json`))),
    recipe([null]), recipe([{...part(), format: 'go'}]), recipe([part('src', 'llvm.json', 'llvm')]),
    recipe([{...part(), report: '../outside.json'}]), recipe([{...part(), report: null}]),
    recipe([{...part(), source_directory: '/outside'}]), recipe([{...part(), source_directory: null}]),
    recipe([{...part(), excludes: ['uncovered.ts']}]),
    recipe([part('backend'), part('frontend', 'coverage.json')]),
    recipe([part('src'), part('src', 'other.json')]),
    recipe([part('src'), part('src/nested', 'other.json')]),
    recipe([part('src/nested'), part('src', 'other.json')])];
  for (const config of invalid) assert.throws(() => coverageParts(config), /Invalid local-only/);
});

test('the complete v2 plan comes from accepted base rather than the proposed recipe', () => repository(f => {
  const proposed = recipe([part('src', 'contributor.json')]);
  fs.writeFileSync(path.join(f.directory, '.clouseau-local.json'), JSON.stringify(proposed));
  git(f.directory, ['add', '.clouseau-local.json']);
  git(f.directory, ['commit', '-qm', 'ci: propose a different recipe']);
  const {localConfig, snapshot} = collectLocal({...f, request: 'Preserve verification policy.', technical: {exact: true}});
  assert.equal(localConfig.version, 2);
  assert.deepEqual(localConfig.coverage, [part('src', 'accepted.json')]);
  assert.ok(snapshot.sources[`${f.base}:.clouseau-local.json`].content.includes('accepted.json'));
}, directory => {
  fs.writeFileSync(path.join(directory, '.clouseau-local.json'), JSON.stringify(recipe([part('src', 'accepted.json')])));
}));
