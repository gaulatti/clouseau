import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {data, Evaluator, Lexer, Parser} from '@actions/expressions';
import {parse} from 'yaml';
import path from 'node:path';

const workflow = parse(readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
const prepare = workflow.jobs['prepare-installation'];
const assess = workflow.jobs['assess-installation'];
const gate = workflow.jobs['approve-and-merge'];
const revision = 'a'.repeat(40);
const typed = value => value == null ? new data.Null() : typeof value === 'boolean' ? new data.BooleanData(value) :
  typeof value === 'number' ? new data.NumberData(value) : typeof value === 'string' ? new data.StringData(value) :
    new data.Dictionary(...Object.entries(value).map(([key, value]) => ({key, value: typed(value)})));

function context(event = 'push', ref = 'refs/heads/policy-install/pr-19', result = 'success') {
  return {github: {event_name: event, ref, actor: 'gaulatti', repository_owner: 'gaulatti',
    event: {deleted: false, pull_request: {draft: false}}}, inputs: {pull_request: '', evaluate_acceptance: false},
  needs: {'prepare-installation': {result, outputs: {head: revision, number: '19'}},
    'assess-installation': {result, outputs: {assessment: JSON.stringify({record_digest: 'b'.repeat(64)}), engine_digest: 'b'.repeat(64)}},
    'assess-intent': {result: 'skipped', outputs: {assessment: ''}}}};
}

function evaluate(source, value) {
  const expression = source.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const ast = new Parser(new Lexer(expression).lex().tokens, Object.keys(value), []).parse();
  return new Evaluator(ast, typed(value)).evaluate();
}

async function guard(mutate = () => {}) {
  const state = {context: {actor: 'gaulatti', repo: {owner: 'gaulatti', repo: 'clouseau'},
    ref: 'refs/heads/policy-install/pr-19', sha: revision},
  pr: {state: 'open', draft: false, base: {ref: 'main'}, user: {login: 'gaulatti'},
    head: {sha: revision, repo: {full_name: 'gaulatti/clouseau'}}},
  comments: [{user: {type: 'User', login: 'gaulatti'}, body: `/approve-intent ${revision}`}], outputs: {}, reads: 0};
  mutate(state);
  const listComments = () => {};
  const github = {rest: {pulls: {get: async args => {
    state.reads++; assert.equal(args.pull_number, 19); return {data: state.pr};
  }}, issues: {listComments}}, paginate: async (method, args) => {
    assert.equal(method, listComments); assert.equal(args.issue_number, 19); return state.comments;
  }};
  await runInNewContext(`(async () => {${prepare.steps[0].with.script}\n})()`,
    {context: state.context, github, core: {setOutput: (key, value) => {state.outputs[key] = value;}}});
  return state;
}

test('the actual installer guard accepts only an owner-confirmed frozen same-repository PR', async () => {
  assert.deepEqual((await guard()).outputs, {head: revision, number: '19'});
  for (const mutate of [
    s => {s.context.actor = 'contributor';}, s => {s.context.ref = 'refs/heads/main';},
    s => {s.context.ref += '-extra';}, s => {s.context.sha = 'not-a-sha';},
    s => {s.context.ref = `refs/heads/policy-install/pr-${'9'.repeat(30)}`;},
    s => {s.pr.state = 'closed';}, s => {s.pr.draft = true;}, s => {s.pr.base.ref = 'other';},
    s => {s.pr.user.login = 'contributor';}, s => {s.pr.head.sha = 'c'.repeat(40);},
    s => {s.pr.head.repo.full_name = 'external/clouseau';}, s => {s.pr.head.repo = null;},
    s => {s.comments = [];}, s => {s.comments[0].user.type = 'Bot';},
    s => {s.comments[0].user.login = 'contributor';}, s => {s.comments[0].body = '/approve-intent stale';},
  ]) await assert.rejects(guard(mutate), /Only the repository owner|Installation requires/);
});

test('ordinary PRs always load main; installation requires successful read-only preparation and exact source selection', () => {
  assert.deepEqual(assess.needs, ['prepare-installation', 'verify']);
  assert.ok(Object.values(prepare.permissions).every(value => value === 'read'));
  assert.ok(Object.values(assess.permissions).every(value => value === 'read'));
  assert.equal(assess.steps[0].with.ref, '${{ needs.prepare-installation.outputs.head }}');
  assert.equal(assess.steps[0].with['persist-credentials'], false);
  assert.equal(workflow.jobs['assess-intent'].steps[0].with.ref, 'main');
  assert.ok(!JSON.stringify(prepare).includes('secrets.'));
  assert.ok(!JSON.stringify(gate).includes('secrets.'));
  for (const [event, ref] of [['pull_request', 'refs/pull/19/merge'], ['pull_request_target', 'refs/heads/main'],
    ['push', 'refs/heads/main'], ['push', 'refs/heads/fix/review'], ['workflow_dispatch', 'refs/heads/policy-install/pr-19'],
    ['issue_comment', 'refs/heads/main']]) {
    const c = context(event, ref);
    assert.equal(evaluate(prepare.if, c).value, false);
    if (event === 'pull_request_target') {
      c.needs['assess-intent'].result = 'success';
      c.needs['assess-intent'].outputs.assessment = JSON.stringify({record_digest: 'b'.repeat(64)});
      assert.equal(evaluate(gate.steps[1].with.ref, c).coerceString(), 'main');
      assert.equal(evaluate(gate.name, c).coerceString(), 'approve-and-merge');
    }
  }
  const selected = context();
  assert.equal(evaluate(prepare.if, selected).value, true);
  assert.equal(evaluate(gate.name, selected).coerceString(), 'approve-and-merge');
  assert.equal(evaluate(gate.steps[1].with.ref, selected).coerceString(), revision);
  assert.equal(gate.steps.at(-1).with['pull-request'], '${{ needs.prepare-installation.outputs.number }}');
});

test('failed installation cannot become a skipped green approval and deleting the promotion branch cannot run it', () => {
  assert.equal(gate.if, 'always()');
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const c = context('push', 'refs/heads/policy-install/pr-19', result);
    assert.equal(evaluate(gate.name, c).coerceString(), 'approve-and-merge');
    assert.equal(evaluate(gate.steps[0].if, c).value, true);
    assert.equal(gate.steps[0].run, 'exit 1');
  }
  const deleted = context(); deleted.github.event.deleted = true;
  assert.equal(evaluate(prepare.if, deleted).value, false);
  assert.equal(evaluate(gate.name, deleted).coerceString(), 'metadata-only-approval');
  assert.equal(evaluate(workflow.jobs.verify.name, deleted).coerceString(), 'metadata-only');
  assert.equal(evaluate(workflow.jobs.verify.steps[0].if, deleted).value, false);
});

test('authorized installation assessment and writer bind the same guarded candidate engine instead of an empty identity', async () => {
  const freeze = assess.steps.find(step => step.id === 'engine');
  assert.equal(freeze.env.AUTHORIZED_CLOUSEAU_INSTALLATION_SHA, '${{ needs.prepare-installation.outputs.head }}');
  assert.ok(assess.steps.indexOf(freeze) > 0);
  assert.ok(assess.steps.indexOf(freeze) < assess.steps.findIndex(step => step.id === 'assess'));
  const run = async fail => {
    const state = {env: {}, output: {}, calls: []};
    const root = '/fictional/authorized-installation';
    await runInNewContext(`(async () => {${freeze.with.script}\n})()`, {
      process: {env: {GITHUB_WORKSPACE: root, AUTHORIZED_CLOUSEAU_INSTALLATION_SHA: revision}},
      require: name => {
        if (name === 'node:path') return path;
        assert.equal(name, path.join(root, 'src/central-version.cjs'));
        return {identifyEngine: sha => {
          state.calls.push(sha); if (fail) throw new Error('Frozen candidate differs');
          return {sha, digest: 'b'.repeat(64)};
        }};
      }, core: {exportVariable: (key, value) => {state.env[key] = value;},
        setOutput: (key, value) => {state.output[key] = value;}},
    });
    return state;
  };
  assert.deepEqual(await run(false), {env: {CLOUSEAU_ENGINE_SHA: revision, CLOUSEAU_ENGINE_DIGEST: 'b'.repeat(64)},
    output: {digest: 'b'.repeat(64)}, calls: [revision]});
  await assert.rejects(run(true), /Frozen candidate differs/);
  assert.equal(assess.outputs.engine_digest, '${{ steps.engine.outputs.digest }}');
  const selected = context();
  selected.needs['resolve-clouseau'] = {result: 'skipped', outputs: {sha: 'c'.repeat(40), digest: 'd'.repeat(64)}};
  assert.equal(evaluate(gate.env.CLOUSEAU_ENGINE_SHA, selected).coerceString(), revision);
  assert.equal(evaluate(gate.env.CLOUSEAU_ENGINE_DIGEST, selected).coerceString(), 'b'.repeat(64));
  delete selected.needs['assess-installation'].outputs.engine_digest;
  assert.equal(evaluate(gate.env.CLOUSEAU_ENGINE_DIGEST, selected).coerceString(), '');
  selected.github.event_name = 'pull_request_target';
  assert.equal(evaluate(gate.env.CLOUSEAU_ENGINE_SHA, selected).coerceString(), 'c'.repeat(40));
  assert.equal(evaluate(gate.env.CLOUSEAU_ENGINE_DIGEST, selected).coerceString(), 'd'.repeat(64));
});
