'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {git} = require('./local-git.cjs');
const {digest} = require('./acceptance.cjs');
const {repository} = require('../test/local-git-fixture.cjs');
const {options, stateDirectory, initializeIdentity, executeVerification, installation, readHistory, runReview, publishReceipt, main} = require('./local-cli.cjs');
const fixtureInstallation = () => ({sha: 'e'.repeat(40), digest: require('./local-version.cjs').engineDigest(), clean: true});

function nativeFixture(directory, gap = false) {
  const location = {start: {line: 1, column: 0}, end: {line: 1, column: 10}};
  return Object.fromEntries(['handler.js', 'new.js'].map(filename => {
    const source = path.join(directory, 'src', filename);
    return [source, {path: source, statementMap: {0: location}, s: {0: 1}, fnMap: {}, f: {},
      branchMap: {0: {type: 'if', line: 1, loc: location, locations: [location, location]}}, b: {0: [1, gap ? 0 : 1]}}];
  }));
}

function fakeHarness(negative = false) {
  let calls = 0;
  return async task => {
    let value;
    if (task.phase === 'investigation') {
      const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
      const report = packet.template;
      report.gates.forEach(gate => {gate.state = negative && gate.name === 'test_integrity' ? 'violated' : 'satisfied';});
      value = {kind: 'report', report, request_sources: []};
    } else value = {answers: Object.fromEntries(Object.keys(task.schema.properties.answers.properties)
      .map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))};
    return {value, provenance: {harness: 'codex', role: task.role, phase: task.phase, session: `fictional-session-${++calls}`,
      request_digest: digest(task), response_digest: digest(value), transport_digest: digest({fixture_only: value})}};
  };
}

test('CLI argument and identity setup are explicit and never return private material', async t => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-identity-fixture-'));
  try {
    assert.equal(options(['review', '--directory', 'fixture']).directory, 'fixture');
    for (const argv of [['review', '--unknown', 'a'], ['review', '--directory'], ['review', 'directory', 'a'],
      ['review', '--directory', 'a', '--directory', 'b']]) assert.throws(() => options(argv), /Invalid/);
    assert.throws(() => initializeIdentity(state, 'invalid/user'), /actor/);
    assert.throws(() => initializeIdentity(state), /actor/);
    const identity = initializeIdentity(state, 'fixture-author');
    assert.equal(identity.public_identity.github_actor, 'fixture-author');
    assert.ok(!JSON.stringify(identity).includes('PRIVATE KEY'));
    assert.equal(fs.statSync(identity.identity_file).mode & 0o777, 0o600);
    // External action bundles have no .git metadata. Exercise the Git boundary
    // in a real temporary repository, independently of the engine's location.
    const runner = path.join(state, 'runner'); fs.mkdirSync(runner);
    git(runner, ['init', '-q', '-b', 'main']);
    git(runner, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'test: runner fixture']);
    const expectedSha = git(runner, ['rev-parse', 'HEAD']).trim();
    const execute = require('node:child_process').execFileSync;
    t.mock.method(require('node:child_process'), 'execFileSync', (program, args, settings) => {
      assert.equal(program, 'git');
      return execute(program, ['-C', runner, ...args.slice(2)], settings);
    });
    assert.equal(installation().sha, expectedSha); assert.equal(installation().clean, true);
    fs.writeFileSync(path.join(runner, 'uncommitted'), 'fixture');
    assert.equal(installation().clean, false);
    t.mock.restoreAll();
    assert.ok(stateDirectory().endsWith('/.local/share/clouseau'));
    const initialized = await main(['init-identity'], {identityDirectory: state, execute: () => 'fixture-author\n'});
    assert.equal(initialized.public_identity.github_actor, 'fixture-author');
    t.mock.method(require('node:child_process'), 'execFileSync', (program, args) => {
      assert.equal(program, 'gh'); assert.deepEqual(args, ['api', 'user', '--jq', '.login']); return 'fixture-author\n';
    });
    assert.equal((await main(['init-identity'], {identityDirectory: state})).public_identity.github_actor, 'fixture-author');
    t.mock.restoreAll();
    await assert.rejects(main(['unknown']), /Usage/);
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});

test('local verifier executes commands and the real shared parser, rejecting native coverage gaps', () => repository(f => {
  const config = JSON.parse(fs.readFileSync(path.join(f.directory, '.clouseau-local.json')));
  const report = path.join(f.directory, 'coverage.json');
  fs.writeFileSync(report, JSON.stringify(nativeFixture(f.directory)));
  const receipt = executeVerification({directory: f.directory, config});
  assert.deepEqual(receipt.exact_coverage, {lines: [2, 2], branches: [4, 4]});
  assert.equal(receipt.commands[0].exit_code, 0);
  assert.equal(receipt.coverage_reports, undefined, 'version 1 keeps its existing evidence shape');
  fs.writeFileSync(report, JSON.stringify(nativeFixture(f.directory, true)));
  assert.throws(() => executeVerification({directory: f.directory, config}), /coverage failed/);
  assert.throws(() => executeVerification({directory: f.directory,
    config: {...config, verification: [[process.execPath, '-e', 'process.exit(3)']]}}), /verification failed/);
  assert.throws(() => executeVerification({directory: f.directory,
    config: {...config, verification: [['/nonexistent-fixture-command']]}}), /verification failed/);
}));

test('v2 local verification binds every native artifact and allows only aggregate-measured branches', () => repository(f => {
  const original = JSON.parse(fs.readFileSync(path.join(f.directory, '.clouseau-local.json')));
  const frontend = path.join(f.directory, 'frontend'); fs.mkdirSync(frontend);
  const source = path.join(frontend, 'linear.js'); fs.writeFileSync(source, 'module.exports = 1;\n');
  const location = {start: {line: 1}, end: {line: 1}};
  const linear = {[source]: {path: source, statementMap: {0: location}, s: {0: 1}, fnMap: {}, f: {}, branchMap: {}, b: {}}};
  const first = path.join(f.directory, 'coverage.json');
  const second = path.join(f.directory, 'frontend.json');
  fs.writeFileSync(first, JSON.stringify(nativeFixture(f.directory)));
  fs.writeFileSync(second, JSON.stringify(linear));
  const config = {...original, version: 2, coverage: [original.coverage,
    {format: 'istanbul', report: 'frontend.json', source_directory: 'frontend'}]};
  const result = executeVerification({directory: f.directory, config});
  assert.deepEqual(result.exact_coverage, {lines: [3, 3], branches: [4, 4]});
  assert.equal(result.coverage_reports.length, 2);
  assert.deepEqual(result.coverage_reports[1].exact_coverage, {lines: [1, 1], branches: [0, 0]});
  assert.equal(result.coverage_reports[0].report_digest, digest(fs.readFileSync(first, 'utf8')));
  assert.equal(result.coverage_reports[1].report_digest, digest(fs.readFileSync(second, 'utf8')));
  assert.equal(result.local_config_digest, digest(config));
  assert.equal(result.report_digest, digest(result.coverage_reports.map(({exact_coverage, ...entry}) => entry)));
  linear[source].s[0] = 0; fs.writeFileSync(second, JSON.stringify(linear));
  assert.throws(() => executeVerification({directory: f.directory, config}), /coverage failed/);
  assert.throws(() => executeVerification({directory: f.directory,
    config: {...config, coverage: [config.coverage[1]]}}), /coverage failed/);
  let calls = 0;
  assert.throws(() => executeVerification({directory: f.directory,
    config: {...config, coverage: []}, run: () => {calls++;}}), /Invalid local-only/);
  assert.throws(() => executeVerification({directory: f.directory,
    config: {...config, exclude: ['frontend']}, run: () => {calls++;}}), /Invalid local-only/);
  assert.equal(calls, 0, 'invalid accepted recipe stops before executing any command');
}));

test('local native artifact loading rejects duplicate JSON keys before an approval record exists', () => repository(f => {
  const config = JSON.parse(fs.readFileSync(path.join(f.directory, '.clouseau-local.json')));
  const report = nativeFixture(f.directory);
  const name = Object.keys(report)[0];
  const duplicate = JSON.stringify(report).slice(0, -1) + ',' + JSON.stringify(name) + ':' + JSON.stringify(report[name]) + '}';
  fs.writeFileSync(path.join(f.directory, 'coverage.json'), duplicate);
  assert.throws(() => executeVerification({directory: f.directory, config}), /coverage failed/);
}));

test('agent-only local review needs no CI config or provider keys and does not resample unchanged findings', () => repository(async f => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-run-fixture-'));
  try {
    const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
    const args = {directory: f.directory, base: f.base, 'request-file': request, harness: 'claude'};
    const deps = {state, ask: fakeHarness(), verify: () => ({fixture_execution_only: true}), installed: fixtureInstallation};
    const report = await main(['review', '--directory', f.directory, '--base', f.base, '--request-file', request, '--harness', 'claude'], deps);
    assert.equal(report.decision, 'auto_approve'); assert.equal(report.receipt, null);
    assert.equal(report.provider_api_calls, 0); assert.equal(report.harness_invocations, 4);
    assert.equal(git(f.directory, ['status', '--porcelain']), '');
    await assert.rejects(runReview(args, deps), /already run/);
    await assert.rejects(runReview({directory: f.directory}, deps), /requirement file/);
    fs.writeFileSync(request, ''); await assert.rejects(runReview(args, deps), /nonempty/);
    fs.writeFileSync(request, 'Reject missing input.');
    await assert.rejects(runReview({...args, output: path.join(f.directory, 'report.json')},
      {...deps, state: path.join(state, 'other-cache')}), /outside the source/);
    await assert.rejects(runReview({...args, identity: 'unused'}, {...deps, installed: () => ({sha: 'e'.repeat(40), clean: false})}), /unmodified/);
    fs.writeFileSync(path.join(f.directory, 'src/new.js'), 'uncommitted');
    await assert.rejects(runReview(args, deps), /Commit/);
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}));

test('a completed negative local review retains evidence and never produces a signed passing receipt', () => repository(async f => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-negative-fixture-'));
  try {
    const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
    const result = await runReview({directory: f.directory, base: f.base, 'request-file': request},
      {state, ask: fakeHarness(true), verify: () => ({fixture_execution_only: true}), installed: fixtureInstallation});
    assert.equal(result.decision, 'blocked_integrity'); assert.equal(result.receipt, null);
    assert.equal(JSON.parse(fs.readFileSync(result.record)).result.reviews.length, 2);
    fs.writeFileSync(request, 'A renamed request cannot erase a failed review.');
    await assert.rejects(runReview({directory: f.directory, base: f.base, 'request-file': request},
      {state, ask: async () => {throw new Error('Do not resample');}, installed: fixtureInstallation}), /non-passing local review/);
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}));

test('a failed first harness request remains inspectable and cannot be blindly sampled again', () => repository(async f => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-transport-failure-'));
  try {
    const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
    const args = {directory: f.directory, base: f.base, 'request-file': request};
    let calls = 0;
    const deps = {state, verify: () => ({}), installed: fixtureInstallation, ask: async () => {calls++; throw new Error('Fixture transport unavailable');}};
    await assert.rejects(runReview(args, deps), /transport unavailable/);
    await assert.rejects(runReview(args, deps), /already run/);
    assert.equal(calls, 1);
    const cache = path.join(state, 'reviews', fs.readdirSync(path.join(state, 'reviews'))[0]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(cache, 'observations.jsonl'), 'utf8')).status, 'started');
    assert.equal(fs.existsSync(path.join(cache, 'receipt.json')), false);
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}));

test('signed local runner requires protected enrollment and publishes its artifact outside the reviewed commit', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-signed-fixture-'));
  try {
    const identity = initializeIdentity(state, 'fixture-author');
    const reviewerSha = 'e'.repeat(40);
    const config = {...require('../test/fixtures/config.json'), version: 2, repository_policy: 'AGENTS.md', readme: 'README.md',
      acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed', grading_model: 'deepseek-flash', repair_attempts: 2},
      local_review: {mode: 'required', reviewer_digest: 'e'.repeat(64), max_age_seconds: 3600, keys: [identity.public_identity]}};
    await repository(async f => {
      const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
      const args = {directory: f.directory, base: f.base, 'request-file': request, identity: identity.identity_file};
      const deps = {state, ask: fakeHarness(), verify: () => ({fixture_execution_only: true}),
        installed: () => ({sha: reviewerSha, digest: 'e'.repeat(64), clean: true})};
      const result = await runReview(args, deps);
      assert.ok(result.receipt); assert.equal(result.decision, 'auto_approve');
      const reused = await runReview({...args, identity: undefined}, {...deps,
        ask: async () => {throw new Error('A verified cached review must not call AI');}});
      assert.equal(reused.reused, true); assert.equal(reused.harness_invocations, 0);
      const bare = path.join(state, 'artifacts.git'); git(state, ['init', '-q', '--bare', bare]);
      git(f.directory, ['config', `url.${bare}.insteadOf`, 'https://github.com/example/local-fixture.git']);
      const published = await main(['publish', '--directory', f.directory, '--receipt', result.receipt]);
      assert.equal(published.artifact_commit.length, 40); assert.match(published.marker, /clouseau-local-review:v1/);
      assert.equal(JSON.parse(git(bare, ['show', `${published.artifact_commit}:clouseau-review.json`])).payload.record.snapshot.head_sha,
        result.head_sha);
      assert.equal(git(f.directory, ['rev-parse', 'HEAD']).trim(), result.head_sha);
      git(f.directory, ['config', '--unset', `url.${bare}.insteadOf`]);
      fs.chmodSync(identity.identity_file, 0o644);
      await assert.rejects(runReview(args, {...deps, state: path.join(state, 'fresh')}), /permissions must be private/);
      fs.chmodSync(identity.identity_file, 0o600);
      let installations = 0;
      await assert.rejects(runReview(args, {...deps, state: path.join(state, 'engine-changed'),
        installed: () => ({sha: installations++ ? 'f'.repeat(40) : reviewerSha, digest: 'e'.repeat(64), clean: true})}), /installation changed/);
    }, directory => {
      fs.mkdirSync(path.join(directory, '.github'));
      fs.writeFileSync(path.join(directory, '.github/clouseau.json'), JSON.stringify(config));
    });
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});

test('local history is bounded and a missing concern cannot disappear on a changed revision', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-history-fixture-'));
  try {
    const filename = path.join(state, 'ledger.json');
    fs.writeFileSync(filename, '{}'); assert.throws(() => readHistory(filename, 'example/repo', 'main'), /Invalid local finding history/);
    fs.writeFileSync(filename, 'x'.repeat(250001)); assert.throws(() => readHistory(filename, 'example/repo', 'main'), /budget/);
    await repository(async f => {
      const request = path.join(state, 'request.txt'); fs.writeFileSync(request, 'Reject missing input.');
      git(f.directory, ['update-ref', 'refs/remotes/origin/main', f.base]);
      const args = {'request-file': request};
      const cwd = process.cwd(); process.chdir(f.directory);
      try {
        const deps = {state, ask: fakeHarness(), verify: () => ({fixture_execution_only: true}), installed: fixtureInstallation};
        await runReview(args, deps);
        const ledger = path.join(state, 'ledgers', `${digest({repository: 'example/local-fixture', branch: 'main'})}.json`);
        const previous = JSON.parse(fs.readFileSync(ledger));
        previous.findings = [{id: 'a'.repeat(64), blocking: true, path: 'src/handler.js',
          title: 'Input guard', cause: 'Unvalidated input', obligation: 'Reject missing input'}];
        fs.writeFileSync(ledger, JSON.stringify(previous));
        git(f.directory, ['commit', '--allow-empty', '-qm', 'test: new fixture revision']);
        const held = await runReview(args, deps);
        assert.equal(held.decision, 'review_incomplete'); assert.equal(held.receipt, null);
        assert.equal(require('./local-receipt.cjs').reviewDecision(JSON.parse(fs.readFileSync(held.record))).decision, 'review_incomplete');
        assert.equal(JSON.parse(fs.readFileSync(held.record)).local_previous.findings[0].id, 'a'.repeat(64));
        previous.findings[0].path = '../escape'; fs.writeFileSync(ledger, JSON.stringify(previous));
        assert.throws(() => readHistory(ledger, previous.repository, previous.branch), /Invalid/);
      } finally {process.chdir(cwd);}
    });
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});

test('a workstation with multiple enrolled identities must explicitly choose its signer', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-many-identities-'));
  try {
    const identities = [initializeIdentity(state, 'fixture-author'), initializeIdentity(state, 'another-author')];
    const config = {...require('../test/fixtures/config.json'), version: 2,
      acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed', grading_model: 'deepseek-flash', repair_attempts: 2},
      local_review: {mode: 'optional', reviewer_digest: 'e'.repeat(64), max_age_seconds: 3600,
        keys: identities.map(item => item.public_identity)}};
    await repository(async f => {
      const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
      await assert.rejects(runReview({directory: f.directory, base: f.base, 'request-file': request}, {state, installed: fixtureInstallation}), /Multiple enrolled/);
    }, directory => {
      fs.mkdirSync(path.join(directory, '.github'));
      fs.writeFileSync(path.join(directory, '.github/clouseau.json'), JSON.stringify(config));
    });
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});

test('unregistered local signing and source changes stop before any receipt can be issued', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-denied-fixture-'));
  try {
    const identity = initializeIdentity(state, 'fixture-author');
    await repository(async f => {
      const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
      const args = {directory: f.directory, base: f.base, 'request-file': request, identity: identity.identity_file};
      const deps = {state, ask: async () => {throw new Error('Must not invoke a harness');}, verify: () => ({}),
        installed: () => ({sha: 'e'.repeat(40), clean: true})};
      await assert.rejects(runReview(args, deps), /already be enrolled/);
      await assert.rejects(runReview({...args, identity: undefined}, {...deps, verify: () => {
        git(f.directory, ['commit', '--allow-empty', '-qm', 'test: fixture source changed']); return {};
      }}), /Source changed during/);
    });
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});
