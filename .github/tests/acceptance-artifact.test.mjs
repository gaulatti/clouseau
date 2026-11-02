import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {data, Evaluator, Lexer, Parser} from '@actions/expressions';
import {parse} from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = parse(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
const consumers = ['approve-and-merge', 'apply-repair'];
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const typed = value => value == null ? new data.Null() : typeof value === 'boolean' ? new data.BooleanData(value) :
  typeof value === 'string' ? new data.StringData(value) : new data.Dictionary(...Object.entries(value)
    .map(([key, value]) => ({key, value: typed(value)})));
const evaluate = (expression, context) => new Evaluator(
  new Parser(new Lexer(expression.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '')).lex().tokens, Object.keys(context), []).parse(), typed(context)).evaluate().value;

function steps(job) {
  const all = workflow.jobs[job].steps;
  const locate = all.findIndex(step => step.id === 'acceptance-artifact');
  return {all, locate, download: all.findIndex(step => step.uses === 'actions/download-artifact@v4')};
}

test('the consumers resolve the acceptance artifact by run id instead of embedding the current attempt', () => {
  for (const job of consumers) {
    const {all, locate, download} = steps(job);
    assert.ok(locate >= 0 && locate < download, `${job} locates before it downloads`);
    assert.equal(all[locate].uses, 'actions/github-script@v7');
    assert.equal(all[download].with.name, '${{ steps.acceptance-artifact.outputs.name }}');
    assert.ok(!/run_attempt/.test(JSON.stringify(all[download])), 'the download cannot depend on the current attempt');
    const engine = all.findIndex(step => step.with?.path === '.clouseau-ci');
    assert.ok(engine >= 0 && engine < locate, `${job} loads the frozen engine before the lookup uses it`);
  }
  assert.equal(workflow.jobs['approve-and-merge'].steps[steps('approve-and-merge').download].if, "steps.acceptance-artifact.outcome == 'success'");
  // Every producer still writes one artifact per attempt so a full re-run never collides with an earlier upload.
  const producers = Object.values(workflow.jobs).flatMap(job => job.steps ?? []).filter(step => /^clouseau-acceptance-/.test(step.with?.name ?? ''));
  assert.equal(producers.length, 2);
  for (const step of producers) assert.equal(step.with.name, 'clouseau-acceptance-${{ github.run_id }}-${{ github.run_attempt }}');
});

test('the locate step runs only where the download ran, with the same trusted-event guard', () => {
  const {all, locate} = steps('approve-and-merge');
  const guard = (event, deleted, ref, draft, intent, installation, intentDigest, installationDigest) => evaluate(all[locate].if, {
    github: {event_name: event, ref, event: {deleted, pull_request: {draft}}},
    needs: {'assess-intent': {result: intent, outputs: {assessment: JSON.stringify({record_digest: intentDigest})}},
      'assess-installation': {result: installation, outputs: {assessment: JSON.stringify({record_digest: installationDigest})}}}});
  assert.equal(guard('pull_request_target', false, 'refs/heads/main', false, 'success', 'skipped', 'a'.repeat(64), ''), true);
  assert.equal(guard('pull_request_target', false, 'refs/heads/main', true, 'success', 'skipped', 'a'.repeat(64), ''), false);
  assert.equal(guard('pull_request_target', false, 'refs/heads/main', false, 'success', 'skipped', '', ''), false);
  assert.equal(guard('pull_request_target', false, 'refs/heads/main', false, 'failure', 'skipped', 'a'.repeat(64), ''), false);
  assert.equal(guard('push', false, 'refs/heads/policy-install/pr-3', false, 'skipped', 'success', '', 'b'.repeat(64)), true);
  assert.equal(guard('push', true, 'refs/heads/policy-install/pr-3', false, 'skipped', 'success', '', 'b'.repeat(64)), false);
  assert.equal(guard('push', false, 'refs/heads/main', false, 'skipped', 'success', '', 'b'.repeat(64)), false);
  assert.equal(evaluate(all[locate].env.ENGINE_ROOT, {github: {event_name: 'push'}}), '.');
  assert.equal(evaluate(all[locate].env.ENGINE_ROOT, {github: {event_name: 'pull_request_target'}}), '.clouseau-ci');
});

async function lookup(job, {artifacts, runId = 41479159933, attempt = '2', sha = 'c'.repeat(40)}) {
  const {all, locate} = steps(job);
  const outputs = {};
  // The job checks the frozen engine out at .clouseau-ci; a push event runs the engine at the workspace root.
  const workspace = mkdtempSync(path.join(tmpdir(), 'clouseau-artifact-lookup-'));
  symlinkSync(root, path.join(workspace, '.clouseau-ci'), 'dir');
  const env = {GITHUB_WORKSPACE: workspace, GITHUB_RUN_ATTEMPT: attempt, ENGINE_ROOT: '.clouseau-ci'};
  const github = {rest: {actions: {listWorkflowRunArtifacts: () => {}}}, paginate: async () => artifacts};
  const previous = {...process.env}; Object.assign(process.env, env);
  try {
    await new AsyncFunction('github', 'context', 'core', 'require', all[locate].with.script)(github,
      {repo: {owner: 'gaulatti', repo: 'guggiana'}, runId, sha}, {setOutput: (name, value) => {outputs[name] = value;}}, createRequire());
  } finally {process.env = previous; rmSync(workspace, {recursive: true, force: true});}
  return outputs;
}
import {createRequire as makeRequire} from 'node:module';
const createRequire = () => makeRequire(path.join(root, 'package.json'));

test('the actual workflow script finds the first attempt artifact after a failed-jobs re-run and refuses foreign ones', async () => {
  const sha = 'c'.repeat(40);
  const own = {name: 'clouseau-acceptance-41479159933-1', expired: false, workflow_run: {id: 41479159933, head_sha: sha}};
  for (const job of consumers) {
    assert.deepEqual(await lookup(job, {artifacts: [own]}), {name: 'clouseau-acceptance-41479159933-1'});
    const hostile = [
      {...own, name: 'clouseau-acceptance-41479159934-1', workflow_run: {id: 41479159934, head_sha: sha}},
      {...own, workflow_run: {id: 41479159934, head_sha: sha}},
      {...own, workflow_run: {id: 41479159933, head_sha: 'd'.repeat(40)}},
      {...own, name: 'clouseau-acceptance-41479159933-3'},
    ];
    await assert.rejects(lookup(job, {artifacts: hostile}), /No acceptance artifact of run 41479159933 \(attempts up to 2\)/);
  }
});
