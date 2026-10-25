import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {parse} from 'yaml';
import {data, Evaluator, Lexer, Parser} from '@actions/expressions';
const require = createRequire(import.meta.url);
const {collectGit, prepareConsumer, boundedFetch, COHORT, protocolResult} = require('../../test/evaluate-large-sources.cjs');
const {pagedFixture, responder} = require('../../test/paged-review-fixture.cjs');
const {localReview} = require('../../src/local-review.cjs');

test('qualification collector preserves actual Git added, renamed, modified and deleted bytes and missing paths fail closed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-cohort-test-'));
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const before = {app: 'export default 1;\n', removed: 'removed source\n', renamed: 'Unique original source\n'.repeat(50)};
  const after = {app: 'export default 2;\n', added: 'new source\n'};
  try {
    git('init', '--quiet'); git('config', 'user.name', 'Qualification Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    for (const [name, value] of Object.entries({...before, AGENTS: 'Frozen contract\n', README: 'Fixture only\n'})) fs.writeFileSync(path.join(directory, `${name}.${['AGENTS', 'README'].includes(name) ? 'md' : 'js'}`), value);
    git('add', '.'); git('commit', '--quiet', '-m', 'test: create frozen native source'); const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(directory, 'app.js'), after.app); fs.writeFileSync(path.join(directory, 'added.js'), after.added);
    fs.rmSync(path.join(directory, 'removed.js')); fs.renameSync(path.join(directory, 'renamed.js'), path.join(directory, 'moved.js'));
    git('add', '.'); git('commit', '--quiet', '-m', 'test: cover native source transitions'); const head = git('rev-parse', 'HEAD');
    const cohort = {repository: 'fixture/public-source', base, head, changed_paths: 4, changed_source_entries: 6,
      changed_source_bytes: Object.values({...before, renamed2: before.renamed, ...Object.fromEntries(Object.entries(after).map(([k,v]) => [`head_${k}`,v]))}).reduce((sum, text) => sum + Buffer.byteLength(text), 0)};
    const context = collectGit(directory, cohort);
    assert.deepEqual(context.files.map(file => file.status).sort(), ['added', 'modified', 'removed', 'renamed']);
    const {snapshot} = await prepareConsumer(directory, cohort);
    for (const file of snapshot.files) for (const id of [file.base_source, file.head_source].filter(Boolean)) {
      const source = snapshot.sources[id];
      assert.equal(source.content, execFileSync('git', ['-C', directory, 'show', `${source.ref}:${source.path}`], {encoding: 'utf8'}));
    }
    assert.ok(snapshot.claims.description.includes('moved.js')); assert.ok(!snapshot.claims.description.includes('removed.js'));
    const verification = JSON.parse(snapshot.sources.verification.content);
    assert.equal(verification.verification_status, 'unavailable'); assert.equal(verification.commands.length, 0);
    await assert.rejects(context.github.rest.repos.getContent({...context.repo, ref: head, path: 'absent.js'}), error => error.status === 404);
    await assert.rejects(context.github.rest.repos.getContent({...context.repo, ref: 'a'.repeat(40), path: 'app.js'}), /outside frozen/);
    await assert.rejects(context.github.rest.repos.getContent({owner: 'other', repo: 'source', ref: head, path: 'app.js'}));
    assert.throws(() => collectGit(directory, {...cohort, changed_source_bytes: 1}), /measurement changed/);
    assert.equal(git('status', '--porcelain'), '');
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});

test('large-source qualification never turns a negative verdict into approval and requires both full deliveries and independent grades', async () => {
  const fixture = await pagedFixture();
  const model = responder(fixture, value => {
    if (value.kind === 'report') value.report.gates.find(gate => gate.name === 'review_completeness').state = 'unresolved';
    return value;
  });
  const result = await localReview({snapshot: fixture.snapshot,
    ask: task => task.phase === 'investigation' ? model.ask(task) : fixture.ask(task),
    addSources: async () => {throw new Error('Unexpected source request');}});
  const summary = protocolResult(fixture.snapshot, result);
  assert.equal(summary.consumer_approval, false); assert.equal(summary.consumer_tests_executed, false);
  assert.equal(summary.decision, result.decision); assert.equal(summary.protocol_completed, true);
  assert.equal(summary.decision, 'review_incomplete');
  const incomplete = structuredClone(result); delete incomplete.reviews[0].grading;
  assert.equal(protocolResult(fixture.snapshot, incomplete).protocol_completed, false);
  assert.throws(() => protocolResult(fixture.snapshot, {...result, reviews: [result.reviews[0]]}));
  // A substituted delivery cannot pass merely because a final report exists.
  const changed = structuredClone(result); changed.reviews[0].source_view.rounds[0].pages_digest = 'f'.repeat(64);
  assert.throws(() => protocolResult(fixture.snapshot, changed), /substituted/);
});

test('qualification provider budget is finite, records metadata only and rejects foreign endpoints before transmission', async () => {
  const calls = [], events = [];
  const send = boundedFetch(async (...args) => {calls.push(args); return {ok: true};}, event => events.push(event), 1);
  const options = {headers: {Authorization: 'sensitive-test-only'}, body: JSON.stringify({model: 'deepseek-flash', messages: ['private-test-placeholder']})};
  await assert.rejects(send('https://other.example/request', options), /outside/); assert.equal(calls.length, 0);
  await send('https://api.deepseek.com/beta/chat/completions', options);
  assert.equal(events.length, 1); assert.equal(events[0].request, 1);
  assert.ok(!JSON.stringify(events).includes('sensitive')); assert.ok(!JSON.stringify(events).includes('private-test-placeholder'));
  await assert.rejects(send('https://api.deepseek.com/beta/chat/completions', options), /budget exhausted/); assert.equal(calls.length, 1);
  await assert.rejects(boundedFetch(async () => {throw new Error('must not transmit');}, () => {}, 1, 0)(
    'https://api.typesafe.ai/v1/systemone', options), /budget exhausted/);
  assert.throws(() => boundedFetch(null, null, 257));
});

test('actual manual qualification workflow is owner-only, read-only, exact-head and separate from existing qualification budgets and approval', () => {
  const workflow = parse(fs.readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs['qualify-large-sources'];
  assert.equal(job.needs, 'verify'); assert.deepEqual(job.permissions, {contents: 'read'});
  assert.equal(job.steps[0].with.ref, '${{ github.sha }}'); assert.equal(job.steps[0].with['persist-credentials'], false);
  assert.equal(job.steps[2].run, 'node test/evaluate-large-sources.cjs ci');
  assert.deepEqual(Object.keys(job.steps[2].env).sort(), ['DEEPSEEK_API_KEY', 'TYPESAFE_API_KEY']);
  assert.equal(workflow.on.workflow_dispatch.inputs.qualify_large_sources.default, false);
  assert.equal(job.steps[3].with.path, '.clouseau-work/large-qualification-ci/');
  assert.ok(!workflow.jobs['approve-and-merge'].needs.includes('qualify-large-sources'));
  assert.equal(COHORT.repository, 'gaulatti/alcantara'); assert.equal(COHORT.changed_source_bytes, 2308455);
  const typed = value => typeof value === 'string' ? new data.StringData(value) : typeof value === 'boolean' ? new data.BooleanData(value) :
    new data.Dictionary(...Object.entries(value).map(([key, value]) => ({key, value: typed(value)})));
  const condition = context => new Evaluator(new Parser(new Lexer(job.if).lex().tokens, ['github', 'inputs'], []).parse(), typed(context)).evaluate().value;
  const context = {github: {event_name: 'workflow_dispatch', repository: 'gaulatti/clouseau', actor: 'gaulatti', repository_owner: 'gaulatti'}, inputs: {qualify_large_sources: true}};
  assert.equal(condition(context), true);
  for (const mutate of [c => {c.github.event_name = 'pull_request';}, c => {c.github.repository = 'other/clouseau';},
    c => {c.github.actor = 'contributor';}, c => {c.inputs.qualify_large_sources = false;}]) {
    const copy = structuredClone(context); mutate(copy); assert.equal(condition(copy), false);
  }
});
