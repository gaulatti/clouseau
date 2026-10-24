import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync, cpSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {parse} from 'yaml';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const bootstrap = parse(readFileSync(path.join(root, 'scripts/resolve/action.yml'), 'utf8'));
const action = parse(readFileSync(path.join(root, 'action.yml'), 'utf8'));
const workflow = parse(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));

test('the actual stable bootstrap resolves only protected main and derives evidence from its frozen Git-free source', async t => {
  assert.equal(bootstrap.inputs, undefined);
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

test('protected self review uses one frozen engine while candidate tests and explicit installation retain their own boundaries', () => {
  const resolver = workflow.jobs['resolve-clouseau'];
  assert.match(resolver.steps[0].uses, /^gaulatti\/clouseau\/scripts\/resolve@[a-f0-9]{40}$/);
  for (const name of ['assess-intent', 'approve-and-merge', 'apply-repair', 'finalize-merge', 'request-reassessment']) {
    const job = workflow.jobs[name];
    assert.ok([job.needs].flat().includes('resolve-clouseau'), name);
    assert.equal(job.steps.find(s => s.with?.repository === 'gaulatti/clouseau').with.ref, '${{ needs.resolve-clouseau.outputs.sha }}');
    assert.ok(job.steps.some(s => s.uses === './.clouseau-ci'), name);
  }
  assert.ok(workflow.jobs.verify.steps.some(s => s.uses === './' && s.with.operation === 'test'));
  assert.equal(workflow.jobs['assess-installation'].steps[0].with.ref, '${{ needs.prepare-installation.outputs.head }}');
  const repair = action.runs.steps.find(s => s.name === 'Apply bounded repair with an independent author');
  assert.match(repair.with.script, /verifyRecord\(record, assessment, config,.*environmentEngine/);
  assert.ok(action.runs.steps[0].with.script.includes('environmentEngine'));
});
