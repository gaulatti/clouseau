'use strict';
// `"review_history": "pull_request"` is a reserved `.clouseau-local.json` key that no engine module acts on yet: every reader
// of the recipe accepts the key and does exactly what it does without it, and none of them runs gh (a recording gh first on
// PATH stays silent, test/gh-recorder.cjs). The CI assessment and gate of a receipt whose accepted recipe carries the key are
// in review-history-ci-gate.test.cjs.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readLocalConfig} = require('./local-git.cjs');
const {coverageParts, OPTIONAL_LOCAL_KEYS} = require('./coverage-plan.cjs');
const gate = require('./coverage-gate.cjs');
const {digest} = require('./acceptance.cjs');
const {silentGh} = require('../test/gh-recorder.cjs');
const {fixture} = require('../test/bootstrap-cli-fixture.cjs');
const cli = require('./installation-cli.cjs');
const bootstrap = require('./installation-bootstrap.cjs');
const attestation = require('./verification-attestation.cjs');
const receipts = require('./local-receipt.cjs');

const KEY = {review_history: 'pull_request'};
const v1 = {version: 1, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md', verification: [['npm', 'test']],
  coverage: {format: 'istanbul', report: 'cov.json', source_directory: 'src'}};
const v2 = {...v1, version: 2, coverage: [v1.coverage]};

test('readLocalConfig and the coverage plan accept review_history only as "pull_request", under both recipe versions', () => {
  assert.ok(OPTIONAL_LOCAL_KEYS.includes('review_history'));
  for (const recipe of [v1, v2]) {
    assert.equal(readLocalConfig({...recipe, ...KEY}).review_history, 'pull_request');
    assert.deepEqual(coverageParts({...recipe, ...KEY}), coverageParts(recipe));
    assert.deepEqual(coverageParts({...recipe, ...KEY}, {allowUnsupported: true}), coverageParts(recipe, {allowUnsupported: true}));
    for (const value of ['local', 'pull-request', '', true, null, 1, ['pull_request']]) {
      assert.throws(() => readLocalConfig({...recipe, review_history: value}),
        error => error.message === 'Invalid local-only Clouseau configuration: review_history must be "pull_request" when set', JSON.stringify(value));
    }
  }
  // A near-miss name stays an unknown version 2 field.
  assert.throws(() => readLocalConfig({...v2, reviewhistory: 'pull_request'}), /Invalid local-only Clouseau coverage configuration/);
});

const sh = (cwd, ...argv) => cp.execFileSync(argv[0], argv.slice(1), {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
const istanbul = (source, hits) => ({[source]: {path: source,
  statementMap: {0: {start: {line: 1, column: 0}, end: {line: 1, column: 9}}, 1: {start: {line: 2, column: 0}, end: {line: 2, column: 9}}},
  s: {0: 1, 1: hits}, branchMap: {0: {loc: {start: {line: 2}}, locations: [{start: {line: 2}}, {start: {line: 2}}]}}, b: {0: [1, hits]}}});

test('every coverage-gate subcommand that reads a recipe gives the same answer with and without review_history, and runs no gh', () => silentGh(() => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-history-gate-')));
  try {
    sh(directory, 'git', 'init', '-q', '-b', 'main'); sh(directory, 'git', 'config', 'user.email', 'a@example.test'); sh(directory, 'git', 'config', 'user.name', 'A');
    fs.mkdirSync(path.join(directory, 'src'));
    fs.writeFileSync(path.join(directory, 'src/a.js'), 'const a = 1;\nconst b = a ? 1 : 2;\n');
    fs.writeFileSync(path.join(directory, 'package.json'), '{}\n');
    sh(directory, 'git', 'add', '-A'); sh(directory, 'git', 'commit', '-qm', 'base');
    sh(directory, 'git', 'branch', 'base');
    fs.writeFileSync(path.join(directory, 'src/a.js'), 'const a = 1;\nconst b = a ? 3 : 2;\n');
    sh(directory, 'git', 'commit', '-qam', 'head');
    const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
    write('cov.json', istanbul(path.join(directory, 'src/a.js'), 1));
    write('baseline.json', {lines: [2, 2], branches: [2, 2]});
    write('clouseau.json', require('../examples/colombo.json'));
    write('plain.json', v2); write('keyed.json', {...v2, ...KEY});
    const run = argv => {
      let out = ''; let err = '';
      const status = gate.main(argv, {cwd: directory, stdout: text => {out += text;}, stderr: text => {err += text;}});
      return {status, out, err};
    };
    // Every subcommand that takes ACCEPTED_CONFIG (loadRecipe); `mode` reads the CI configuration, never the recipe.
    const commands = file => [['plan', file], ['plan', file, '.'], ['totals-plan', file], ['totals-plan', file, '.'],
      ['changed-plan', file, '.', 'base', 'baseline.json'], ['declared-plan', file, '.', 'base'], ['mode', 'clouseau.json']];
    const plain = commands('plain.json').map(run);
    assert.equal(plain[0].status, 0, plain[0].err);
    assert.equal(plain[4].status, 0, plain[4].err);
    assert.deepEqual(commands('keyed.json').map(run), plain);
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
}));

test('the installation readers accept review_history and act exactly as without it: candidate configuration, review and check', async () => {
  const outcomes = [];
  for (const localExtra of [{}, KEY]) {
    await silentGh(() => fixture(async f => {
      assert.deepEqual(f.local.review_history, localExtra.review_history);
      const candidate = bootstrap.candidateConfiguration(f.directory, f.head);
      assert.deepEqual(candidate.local, f.local);
      const reviewed = await cli.runReview(f.reviewArgs, f.reviewRuntime);
      const remote = await f.remote();
      const forbidden = () => {throw new Error('A read-only checker cannot execute contributor setup, AI or signing');};
      const checked = await cli.main(['installation-check', '--repository', f.manifest.repository, '--pull-request', '7'],
        {...remote.runtime, verify: forbidden, ask: forbidden, publish: forbidden, state: '/unavailable-private-identity-state'});
      const shas = text => text.replaceAll(f.head, 'HEAD').replaceAll(f.base, 'BASE');
      outcomes.push({review: reviewed.decision, verified: checked.installation_verified, owner: checked.manual_owner_acceptance_required,
        merge: checked.auto_merge_authorized, provider: checked.provider_api_calls,
        calls: remote.state.calls.map(call => `${call.method} ${shas(call.endpoint)}`)});
    }, {localExtra}));
  }
  assert.equal(outcomes[0].review, 'auto_approve');
  assert.equal(outcomes[0].verified, true);
  assert.ok(outcomes[0].calls.every(call => !/pulls\?head=/.test(call)));
  assert.deepEqual(outcomes[1], outcomes[0]);
});

test('verification attestation binds the accepted recipe by digest only: a recipe with review_history attests the same way', async t => {
  const BASE = 'b'.repeat(40);
  const pr = {number: 8, state: 'open', draft: false, base: {ref: 'main', sha: BASE}, head: {sha: 'a'.repeat(40)}};
  const config = {base_branch: 'main', local_review: {mode: 'optional', max_age_seconds: 3600, keys: []}};
  const github = {paginate: async () => [], rest: {pulls: {listFiles() {}}}};
  const verdict = async recipe => {
    const technical = {commands: [{argv: ['npm', 'test'], exit_code: 0}], verification_status: 'passed', local_config_digest: digest(recipe),
      coverage: {status: 'exact', passed: true, artifact_freshness: 'observed_current_run'}};
    technical.attestation = {version: 1, recipe: digest(recipe), commands: 1, coverage_mode: 'exact', gate: 'passed'};
    t.mock.method(receipts, 'screenReceipt', async () => ({ref: 'r'.repeat(40), bundle: {payload: {reviewer_sha: 'e'.repeat(40)}},
      verified: {record: {snapshot: {sources: {verification: {content: JSON.stringify(technical)},
        recipe: {path: '.clouseau-local.json', ref: BASE, content: JSON.stringify(recipe)}}}}}}));
    t.mock.method(receipts, 'screenSources', async () => null);
    return attestation.receiptAttests({github, repo: {owner: 'o', repo: 'r'}, pr, config, engine: null, explain: true});
  };
  await silentGh(async () => {
    const plain = await verdict(v2);
    assert.equal(plain.attests, true);
    assert.deepEqual(await verdict({...v2, ...KEY}), plain);
  });
  assert.notEqual(digest({...v2, ...KEY}), digest(v2), 'the recipe digest is the only difference');
});

test('the review_history key is read by no engine module besides the configuration readers', () => {
  const root = path.join(__dirname, '..');
  const mentions = fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.cjs') && !name.endsWith('.test.cjs'))
    .filter(name => fs.readFileSync(path.join(root, 'src', name), 'utf8').includes('review_history'));
  assert.deepEqual(mentions.sort(), ['coverage-plan.cjs', 'local-git.cjs']);
  const readers = mentions.filter(name => /\.review_history\b|'review_history'/.test(fs.readFileSync(path.join(root, 'src', name), 'utf8')));
  assert.deepEqual(readers.sort(), ['coverage-plan.cjs', 'local-git.cjs']);
  for (const name of [...fs.readdirSync(path.join(root, 'bin')).map(file => path.join('bin', file)), 'action.yml']) {
    assert.ok(!fs.readFileSync(path.join(root, name), 'utf8').includes('review_history'), name);
  }
});
