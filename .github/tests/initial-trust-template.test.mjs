import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {data, Evaluator, Lexer, Parser} from '@actions/expressions';
import {parse} from 'yaml';

// The consumer-facing initial-trust workflow lives in the installation guide.
const guide = readFileSync(new URL('../../docs/initial-installation.md', import.meta.url), 'utf8');
const block = [...guide.matchAll(/```yaml\n([\s\S]*?)```/g)].map(match => match[1])
  .find(text => text.startsWith('name: Initial Clouseau trust verification'));
const job = parse(block).jobs['initial-trust'];
const MARKER = '<!-- clouseau-installation-review:v1 ' + 'a'.repeat(40) + ' -->';

const string = value => value === null ? new data.Null() : new data.StringData(value);
function runs(body) {
  const source = job.if.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const context = {github: {event: {pull_request: {body}}}};
  const typed = new data.Dictionary({key: 'github', value: new data.Dictionary({key: 'event',
    value: new data.Dictionary({key: 'pull_request', value: new data.Dictionary({key: 'body', value: string(body)})})})});
  const ast = new Parser(new Lexer(source).lex().tokens, Object.keys(context), []).parse();
  return new Evaluator(ast, typed).evaluate().value;
}

test('the initial-trust job is guarded so it runs only for the installation PR', () => {
  assert.ok(job, 'the template defines the initial-trust job');
  assert.equal(typeof job.if, 'string', 'the job must carry an explicit if guard');
  assert.equal(runs(`Installs Clouseau.\n\n${MARKER}`), true);
  for (const body of ['An ordinary change', '', null]) assert.equal(runs(body), false, `later PR body ${JSON.stringify(body)} must skip the job`);
});

test('the guarded job is the only initial-trust job and still checks installation trust', () => {
  assert.deepEqual(Object.keys(parse(block).jobs), ['initial-trust']);
  assert.ok(job.steps.some(step => /installation-check/.test(step.run ?? '')));
});
