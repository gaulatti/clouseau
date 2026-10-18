import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {data, Evaluator, Lexer, Parser} from '@actions/expressions';
import {truthy} from '@actions/expressions/result';
import {parse} from 'yaml';

const workflow = parse(readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
const repair = workflow.jobs['apply-repair'];
const typed = value => value === null ? new data.Null() : typeof value === 'boolean' ? new data.BooleanData(value) :
  typeof value === 'string' ? new data.StringData(value) :
    new data.Dictionary(...Object.entries(value).map(([key, value]) => ({key, value: typed(value)})));

function eligible({repository = 'gaulatti/clouseau', draft = false, event = 'pull_request_target', proposal = true,
  assessment = 'success', approval = 'failure'} = {}) {
  const context = {
    github: {event_name: event, repository: 'gaulatti/clouseau', event: {pull_request: {
      draft, head: {repo: repository === null ? null : {full_name: repository}},
    }}},
    needs: {'assess-intent': {result: assessment, outputs: {assessment: JSON.stringify({repair_digest: proposal ? 'a'.repeat(64) : ''})}},
      'approve-and-merge': {result: approval}},
  };
  const always = {name: 'always', minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(true)};
  const ast = new Parser(new Lexer(repair.if).lex().tokens, Object.keys(context), [always]).parse();
  return truthy(new Evaluator(ast, typed(context), new Map([['always', always]])).evaluate());
}

test('the actual repair job excludes forks and deleted head repositories before providing author credentials', () => {
  assert.equal(eligible(), true, 'a verified internal repair with a failed gate remains eligible');
  assert.equal(eligible({repository: 'external/contribution'}), false);
  assert.equal(eligible({repository: null}), false);
  for (const options of [{draft: true}, {event: 'pull_request'}, {event: 'issue_comment'}, {event: 'workflow_dispatch'},
    {proposal: false}, {assessment: 'failure'}, {approval: 'success'}]) assert.equal(eligible(options), false);
  assert.equal(repair.steps.find(step => step.with?.operation === 'repair').with['repair-token'], '${{ secrets.DEPLOYMENT_TOKEN }}');
  assert.equal(repair.steps[0].with.ref, 'main');
  assert.equal(repair.steps[0].with['persist-credentials'], false);
});

test('the fork guard and the credential boundary cannot silently disappear from the workflow', () => {
  const original = repair.if;
  try {
    repair.if = original.replace('github.event.pull_request.head.repo.full_name == github.repository &&', '');
    assert.equal(eligible({repository: 'external/contribution'}), true, 'negative control detects removal of the actual guard');
  } finally {repair.if = original;}
  const config = JSON.parse(readFileSync(new URL('../clouseau.json', import.meta.url), 'utf8'));
  assert.ok(config.verification.steps.includes('Test workflow security'));
  const step = workflow.jobs.verify.steps.find(step => step.name === 'Test workflow security');
  assert.match(step.run, /npm test/);
  assert.equal(step.if, workflow.jobs.verify.steps[0].if);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== 'apply-repair') assert.ok(!JSON.stringify(job).includes('secrets.DEPLOYMENT_TOKEN'), name);
  }
});
