import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync, cpSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {parse} from 'yaml';
import {data, Evaluator, Lexer, Parser} from '@actions/expressions';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const bootstrap = parse(readFileSync(path.join(root, 'scripts/resolve/action.yml'), 'utf8'));
const action = parse(readFileSync(path.join(root, 'action.yml'), 'utf8'));

test('the actual stable bootstrap resolves only protected main and derives evidence from its frozen Git-free source', async t => {
  assert.deepEqual(Object.keys(bootstrap.inputs), ['provenance']);
  assert.equal(bootstrap.inputs.provenance.default, 'artifact');
  const checkout = bootstrap.runs.steps.find(s => s.with?.repository);
  assert.equal(checkout.with.repository, 'gaulatti/clouseau');
  assert.equal(checkout.with.ref, '${{ steps.resolve.outputs.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const temp = mkdtempSync(path.join(tmpdir(), 'bootstrap-contract-'));
  t.after(() => rmSync(temp, {recursive: true, force: true}));
  const frozen = path.join(temp, '.clouseau-selection'); mkdirSync(frozen);
  for (const entry of ['src', 'policy', 'bin', 'skills', 'scripts', 'action.yml']) cpSync(path.join(root, entry), path.join(frozen, entry), {recursive: true});
  const selected = 'a'.repeat(40);
  const outputs = {}; const summary = [];
  const core = {setOutput: (key, value) => {outputs[key] = value;}, summary: {
    addRaw(value) {summary.push(value); return this;}, async write() {}}};
  const github = {rest: {repos: {getBranch: async args => {
    assert.deepEqual(JSON.parse(JSON.stringify(args)), {owner: 'gaulatti', repo: 'clouseau', branch: 'main'});
    return {data: {name: 'main', protected: true, commit: {sha: selected}}};
  }}}};
  const cwd = process.cwd(); process.chdir(temp); t.after(() => process.chdir(cwd));
  const environment = {CLOUSEAU_BOOTSTRAP: path.join(root, 'scripts/resolve'), CLOUSEAU_SELECTED_SHA: selected};
  const invoke = step => runInNewContext(`(async () => {${step.with.script}\n})()`, {require, github, core, process: {env: environment}});
  await invoke(bootstrap.runs.steps.find(s => s.id === 'resolve'));
  assert.equal(outputs.sha, selected);
  await invoke(bootstrap.runs.steps.find(s => s.id === 'identify'));
  const evidence = JSON.parse(readFileSync('work/clouseau-engine.json', 'utf8'));
  assert.equal(evidence.sha, selected);
  assert.equal(evidence.digest, require(path.join(root, 'src/local-version.cjs')).engineDigest(frozen));
  assert.equal(outputs.digest, evidence.digest);
  assert.ok(summary[0].includes(evidence.sha) && summary[0].includes(evidence.digest));
  const retained = bootstrap.runs.steps.at(-1);
  assert.equal(retained.with.path, 'work/clouseau-engine.json');
  assert.match(retained.with.name, /github.run_id.*github.run_attempt/);
});

test('actual provenance retention validation rejects unknown modes before resolving and preserves mandatory outputs', () => {
  const validation = bootstrap.runs.steps[0];
  assert.equal(validation.shell, 'bash');
  assert.equal(validation.env.CLOUSEAU_PROVENANCE, '${{ inputs.provenance }}');
  const upload = bootstrap.runs.steps.at(-1);
  const ast = new Parser(new Lexer(upload.if).lex().tokens, ['inputs'], []).parse();
  for (const mode of ['artifact', 'summary', '', 'unsupported', 'summary\nartifact']) {
    const result = spawnSync('bash', ['-e', '-c', validation.run], {env: {PATH: process.env.PATH, CLOUSEAU_PROVENANCE: mode}});
    assert.equal(result.status, ['artifact', 'summary'].includes(mode) ? 0 : 1);
    const context = new data.Dictionary({key: 'inputs', value: new data.Dictionary({key: 'provenance', value: new data.StringData(mode)})});
    assert.equal(new Evaluator(ast, context).evaluate().value, mode === 'artifact');
  }
  for (const id of ['resolve', 'identify']) assert.equal(bootstrap.runs.steps.find(step => step.id === id).if, undefined);
  assert.equal(bootstrap.outputs.sha.value, '${{ steps.resolve.outputs.sha }}');
  assert.equal(bootstrap.outputs.digest.value, '${{ steps.identify.outputs.digest }}');
});

