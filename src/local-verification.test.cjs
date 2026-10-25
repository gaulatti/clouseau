'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {executeVerification} = require('./local-cli.cjs');
const {digest} = require('./acceptance.cjs');

// These deliberately small native-format fixtures test parsing and provenance;
// their counters are not an application execution or coverage qualification.
function fixture(run, {branchless = false} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-verification-boundary-'));
  fs.mkdirSync(path.join(directory, 'src'));
  const source = path.join(directory, 'src', 'handler.js');
  fs.writeFileSync(source, branchless ? 'module.exports = 1;\n' :
    'module.exports = value => { if (!value) throw Error("Missing input"); return value; };\n');
  const location = {start: {line: 1, column: 0}, end: {line: 1, column: 20}};
  const report = (hits = [1, 1]) => ({[source]: {path: source,
    statementMap: {0: location}, s: {0: 1}, fnMap: {}, f: {},
    branchMap: branchless ? {} : {0: {type: 'if', line: 1, loc: location, locations: [location, location]}},
    b: branchless ? {} : {0: hits}}});
  const config = {version: 1, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md',
    verification: [[process.execPath, '-e', 'process.stdout.write("verification completed\\n")']],
    coverage: {format: 'istanbul', report: 'coverage.json', source_directory: 'src'}};
  const filename = path.join(directory, 'coverage.json');
  try {return run({directory, config, filename, report, source});}
  finally {fs.rmSync(directory, {recursive: true, force: true});}
}

function measuringWith(measure) {
  return (program, argv, settings) => program === 'python3' ? measure(program, argv, settings) : cp.spawnSync(program, argv, settings);
}

test('partial native counters and a coverage command exit remain separate honest evidence', () => fixture(f => {
  const native = f.report([1, 0]);
  const code = `require('node:assert').equal(require('./src/handler')('news'), 'news');` +
    `require('node:fs').writeFileSync('coverage.json', ${JSON.stringify(JSON.stringify(native))});` +
    `console.log('Fixture counters contain one unhit branch'); process.exitCode = 1;`;
  const result = executeVerification({...f, config: {...f.config, verification: [[process.execPath, '-e', code]]}});
  assert.equal(result.verification_status, 'failed');
  assert.equal(result.commands[0].exit_code, 1);
  assert.match(result.commands[0].stdout, /one unhit branch/);
  assert.equal(result.commands[0].stdout_digest, digest(result.commands[0].stdout));
  assert.deepEqual(result.exact_coverage, {lines: [1, 1], branches: [2, 1]});
  assert.equal(result.coverage.status, 'below_threshold');
  assert.equal(result.coverage.passed, false);
  assert.equal(result.coverage.artifact_freshness, 'observed_current_run');
}));

test('a genuine assertion failure is preserved and cannot be relabeled a coverage-only failure', () => fixture(f => {
  fs.writeFileSync(f.filename, JSON.stringify(f.report([1, 0])));
  const verification = [[process.execPath, '-e', "require('node:assert').equal(require('./src/handler')('news'), 'wrong')"]];
  const result = executeVerification({...f, config: {...f.config, verification}});
  assert.equal(result.verification_status, 'failed');
  assert.equal(result.commands[0].exit_code, 1);
  assert.match(result.commands[0].stderr, /AssertionError/);
  assert.equal(result.commands[0].stderr_digest, digest(result.commands[0].stderr));
  assert.equal(result.coverage.artifact_freshness, 'unverified');
  assert.equal(result.coverage.passed, false);
}));

test('an unchanged pre-existing passing report is not presented as this run coverage', () => fixture(f => {
  fs.writeFileSync(f.filename, JSON.stringify(f.report()));
  const result = executeVerification(f);
  assert.equal(result.verification_status, 'passed');
  assert.equal(result.coverage.status, 'exact');
  assert.equal(result.coverage.artifact_freshness, 'unverified');
  assert.equal(result.coverage.passed, false);
}));

test('regenerated native data has observed freshness while a genuine branchless source stays exact', () => fixture(f => {
  const native = JSON.stringify(f.report());
  const verification = [[process.execPath, '-e', `require('node:fs').writeFileSync('coverage.json', ${JSON.stringify(native)})`]];
  const result = executeVerification({...f, config: {...f.config, verification}});
  assert.deepEqual(result.exact_coverage, {lines: [1, 1], branches: [0, 0]});
  assert.equal(result.coverage.status, 'exact');
  assert.equal(result.coverage.artifact_freshness, 'observed_current_run');
  assert.equal(result.coverage.passed, true);
}, {branchless: true}));

test('missing, malformed, unsupported and empty native coverage remain unavailable rather than invented counts', () => {
  for (const kind of ['missing', 'malformed', 'unsupported', 'empty', 'empty-lines']) fixture(f => {
    let config = f.config;
    if (kind === 'malformed') fs.writeFileSync(f.filename, '{not json');
    if (kind === 'unsupported') {
      fs.writeFileSync(f.filename, JSON.stringify(f.report()));
      config = {...config, coverage: {...config.coverage, format: 'unsupported-native'}};
    }
    if (kind === 'empty') fs.writeFileSync(f.filename, '{}');
    if (kind === 'empty-lines') {
      const native = f.report(); native[f.source].statementMap = {}; native[f.source].s = {};
      fs.writeFileSync(f.filename, JSON.stringify(native));
    }
    const result = executeVerification({...f, config});
    assert.equal(result.coverage.status, 'unavailable', kind);
    assert.equal(result.coverage.passed, false, kind);
    assert.equal(result.exact_coverage, null, kind);
    assert.ok(result.coverage.error, kind);
    assert.equal(result.commands[0].exit_code, 0, kind);
  });
});

test('coverage symlinks outside the checkout and directory artifacts are never read by the measurement subprocess', () => {
  for (const kind of ['outside-symlink', 'directory']) fixture(f => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-outside-artifact-'));
    try {
      const content = 'EXTERNAL-FIXTURE-CONTENT-MUST-NOT-ENTER-EVIDENCE';
      const filename = path.join(external, 'outside.json'); fs.writeFileSync(filename, content);
      if (kind === 'outside-symlink') fs.symlinkSync(filename, f.filename);
      else fs.mkdirSync(f.filename);
      let measurements = 0;
      const run = measuringWith(() => {measurements++; throw new Error('Unsafe artifact must not reach parser');});
      const result = executeVerification({...f, run});
      assert.equal(measurements, 0);
      assert.equal(result.coverage.status, 'unavailable');
      assert.equal(result.report_digest, null);
      assert.equal(JSON.stringify(result).includes(content), false);
      assert.match(result.coverage.error, kind === 'outside-symlink' ? /escapes/ : /regular file/);
    } finally {fs.rmSync(external, {recursive: true, force: true});}
  });
});

test('spawn failures and interrupted commands are explicit failures while remaining verification still executes', () => fixture(f => {
  fs.writeFileSync(f.filename, JSON.stringify(f.report()));
  const verification = [['throw-fixture'], ['error-fixture'], ['no-result-fixture'], ['signal-fixture'], [process.execPath, '-e', 'console.log("last check ran")']];
  const run = (program, argv, settings) => {
    if (program === 'throw-fixture') throw Object.assign(new Error('fixture spawn throw'), {code: 'EACCES'});
    if (program === 'error-fixture') return {status: null, error: new Error('fixture spawn error')};
    if (program === 'no-result-fixture') return undefined;
    if (program === 'signal-fixture') return {status: null, signal: 'SIGTERM', stderr: 'fixture process interrupted'};
    return cp.spawnSync(program, argv, settings);
  };
  const result = executeVerification({...f, config: {...f.config, verification}, run});
  assert.equal(result.verification_status, 'failed');
  assert.deepEqual(result.commands.map(item => item.exit_code), [null, null, null, null, 0]);
  assert.equal(result.commands[0].error.code, 'EACCES');
  assert.equal(result.commands[1].error.code, null);
  assert.match(result.commands[2].error.message, /no result/);
  assert.equal(result.commands[3].signal, 'SIGTERM');
  assert.match(result.commands[4].stdout, /last check ran/);
}));

test('measurement process and wire failures yield unavailable coverage without terminating verification evidence', () => {
  const outputs = [
    () => {throw new Error('fixture parser spawn throw');},
    () => ({status: null, error: new Error('fixture parser transport error')}),
    () => ({status: 9}),
    () => ({status: 0, stdout: '{malformed'}),
    () => ({status: 0, stdout: JSON.stringify({lines: [0, 0], branches: [0, 0]})}),
    () => ({status: 0, stdout: JSON.stringify({lines: [1, 2], branches: [2, 2]})}),
    () => undefined,
  ];
  for (const measure of outputs) fixture(f => {
    fs.writeFileSync(f.filename, JSON.stringify(f.report()));
    const result = executeVerification({...f, run: measuringWith(measure)});
    assert.equal(result.coverage.status, 'unavailable');
    assert.equal(result.exact_coverage, null);
    assert.equal(result.commands[0].exit_code, 0);
    assert.equal(result.coverage.passed, false);
  });
});

test('additional checks cannot replace or even rewrite the accepted report after native measurement', () => {
  for (const kind of ['changed', 'same-bytes']) fixture(f => {
    fs.writeFileSync(f.filename, JSON.stringify(f.report()));
    const code = kind === 'changed' ? 'require("node:fs").appendFileSync("coverage.json", " "); process.exitCode=7' :
      'const fs=require("node:fs");fs.writeFileSync("coverage.json",fs.readFileSync("coverage.json"));fs.utimesSync("coverage.json",new Date(),new Date(Date.now()+1000))';
    assert.throws(() => executeVerification({...f, additional: [[process.execPath, '-e', code]]}), /changed accepted coverage artifacts/);
  });
});

test('private signing material in process output never becomes review evidence', () => fixture(f => {
  const marker = '-----BEGIN PRIVATE KEY-----\nfictional non-key fixture\n-----END PRIVATE KEY-----';
  const verification = [[process.execPath, '-e', `console.log(${JSON.stringify(marker)})`]];
  assert.throws(() => executeVerification({...f, config: {...f.config, verification}}), error =>
    /Private signing material/.test(error.message) && !error.message.includes('fictional non-key fixture'));
}));


test('opaque native artifact I/O errors remain unavailable observations rather than a fabricated report', t => fixture(f => {
  fs.writeFileSync(f.filename, JSON.stringify(f.report()));
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (filename, ...args) => {
    if (filename === f.filename) throw new Error('fixture opaque I/O failure');
    return read(filename, ...args);
  });
  const result = executeVerification(f);
  assert.equal(result.coverage.status, 'unavailable');
  assert.equal(result.coverage.error, 'Coverage artifact is unavailable');
  assert.equal(result.report_digest, null);
  assert.equal(result.exact_coverage, null);
}));


test('normal verification and native measurement inherit only the existing safe local environment boundary', () => fixture(f => {
  const previousKey = process.env.CLOUSEAU_FIXTURE_PROVIDER_KEY;
  const previousVisible = process.env.CLOUSEAU_FIXTURE_VISIBLE;
  process.env.CLOUSEAU_FIXTURE_PROVIDER_KEY = 'fixture-only-must-not-enter-model-evidence';
  process.env.CLOUSEAU_FIXTURE_VISIBLE = 'preserved-nonsecret-fixture';
  try {
    fs.writeFileSync(f.filename, JSON.stringify(f.report()));
    const verification = [[process.execPath, '-e', 'const a=require("node:assert/strict");a.equal(process.env.CLOUSEAU_FIXTURE_PROVIDER_KEY,undefined);a.equal(process.env.CLOUSEAU_FIXTURE_VISIBLE,"preserved-nonsecret-fixture");a.ok(process.env.PATH);console.log("credential boundary preserved")']];
    let parserChecks = 0;
    const run = (program, argv, settings) => {
      if (program === 'python3') {
        const checked = cp.spawnSync(program, ['-c', 'import os; assert "CLOUSEAU_FIXTURE_PROVIDER_KEY" not in os.environ; assert os.environ["CLOUSEAU_FIXTURE_VISIBLE"] == "preserved-nonsecret-fixture"'], settings);
        assert.equal(checked.status, 0); parserChecks++;
      }
      return cp.spawnSync(program, argv, settings);
    };
    const result = executeVerification({...f, config: {...f.config, verification}, run});
    assert.equal(result.verification_status, 'passed');
    assert.equal(parserChecks, 1);
    assert.match(result.commands[0].stdout, /credential boundary preserved/);
    assert.equal(JSON.stringify(result).includes('fixture-only-must-not-enter-model-evidence'), false);
  } finally {
    if (previousKey === undefined) delete process.env.CLOUSEAU_FIXTURE_PROVIDER_KEY; else process.env.CLOUSEAU_FIXTURE_PROVIDER_KEY = previousKey;
    if (previousVisible === undefined) delete process.env.CLOUSEAU_FIXTURE_VISIBLE; else process.env.CLOUSEAU_FIXTURE_VISIBLE = previousVisible;
  }
}));
