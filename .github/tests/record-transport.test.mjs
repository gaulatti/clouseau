import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {data, Evaluator, Lexer, Parser} from '@actions/expressions';
import {parse} from 'yaml';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const action = parse(readFileSync(path.join(root, 'action.yml'), 'utf8'));
const transport = require('../../src/record-transport.cjs');
const {digest} = require('../../src/acceptance.cjs');
const {RECORD} = require('../../src/acceptance-controller.cjs');
const assess = action.runs.steps.find(step => step.id === 'assess');
const gate = action.runs.steps.find(step => step.name === 'Approve and ensure auto-merge');
const repair = action.runs.steps.find(step => step.name === 'Apply bounded repair with an independent author');
const typed = value => value === null ? new data.Null() : typeof value === 'boolean' ? new data.BooleanData(value) :
  typeof value === 'number' ? new data.NumberData(value) : typeof value === 'string' ? new data.StringData(value) :
    Array.isArray(value) ? new data.Array(...value.map(typed)) :
      new data.Dictionary(...Object.entries(value).map(([key, value]) => ({key, value: typed(value)})));

function inputs(overrides = {}) {
  return {...Object.fromEntries(Object.entries(action.inputs).map(([key, value]) => [key, value.default || ''])), ...overrides};
}

function environment(step, values) {
  const context = {inputs: inputs(values), github: {action_path: root}};
  return Object.fromEntries(Object.entries(step.env).map(([key, source]) => {
    const expression = source.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    const ast = new Parser(new Lexer(expression).lex().tokens, Object.keys(context), []).parse();
    return [key, new Evaluator(ast, typed(context)).evaluate().coerceString()];
  }));
}

function fixture() {
  const record = {version: 2, snapshot: {repository: 'example/radio', head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40)}, result: {reviews: []}};
  const assessment = {version: 2, number: 3, decision: 'auto_approve', head_sha: record.snapshot.head_sha,
    base_sha: record.snapshot.base_sha, record_digest: digest(record)};
  const context = {repo: {owner: 'example', repo: 'radio'}, runId: 456};
  const payload = transport.encode({assessment, record, repair: null, context, runAttempt: '2'});
  return {record, assessment, context, payload};
}

async function execute(step, options = {}) {
  const f = fixture();
  const state = {outputs: {}, logs: [], assess: 0, gate: 0, verify: 0, repair: 0};
  const original = process.cwd(); const dir = mkdtempSync(path.join(tmpdir(), 'clouseau-action-transport-'));
  const processEnv = {...environment(step, {'record-transport': 'job-output', ...options.inputs}),
    GITHUB_RUN_ATTEMPT: '2', ...options.env};
  const assessment = options.assessment || f.assessment;
  const record = options.record || f.record;
  const policy = {
    async assess(args) {
      state.assess++; state.receiptOnly = args.receiptOnly; state.ignoreReceipt = args.ignoreReceipt;
      mkdirSync('work', {recursive: true}); writeFileSync(RECORD, JSON.stringify(record));
      if (options.bundle) writeFileSync(`${RECORD}.repair.json`, JSON.stringify(options.bundle));
      if (options.diagnostic) writeFileSync(`${RECORD}.diagnostic.json`, options.diagnostic);
      if (options.failure) throw new Error('investigation stopped');
      return assessment;
    },
    async assessWhenReady(args) {state.waited = true; return policy.assess(args);},
    async gate(args) {
      state.gate++;
      assert.deepEqual(JSON.parse(readFileSync(RECORD)), record);
      assert.equal(args.nativeGate, true);
    },
  };
  const controller = {RECORD, verifyRecord: (actual, actualAssessment) => {
    state.verify++; assert.deepEqual(JSON.parse(JSON.stringify(actual)), record); assert.deepEqual(JSON.parse(JSON.stringify(actualAssessment)), assessment);
  }};
  const github = {paginate: async () => [], rest: {issues: {listComments() {}}}, constructor: class {}};
  const core = {setOutput: (key, value) => {state.outputs[key] = value;}, info: line => state.logs.push(line), warning: line => (state.warnings ??= []).push(line)};
  try {
    process.chdir(dir);
    if (options.before) options.before({state, f, processEnv});
    await runInNewContext(`(async () => {${step.with.script}\n})()`, {
      process: {env: processEnv}, context: options.context || f.context, core, github,
      require: filename => {
        if (filename === path.join(root, 'src/config.cjs')) return {loadConfig: () => ({})};
        if (filename === path.join(root, 'src/policy.cjs')) return {createPolicy: () => policy};
        if (filename === path.join(root, 'src/acceptance-controller.cjs')) return controller;
        if (filename === path.join(root, 'src/acceptance-repair.cjs')) return {
          history: () => [], apply: async ({record: actual}) => {
            state.repair++; assert.deepEqual(JSON.parse(JSON.stringify(actual)), record); return {head_sha: 'c'.repeat(40)};
          },
        };
        return require(filename);
      },
    });
    return state;
  } catch (error) {error.transportState = state; throw error;}
  finally {process.chdir(original); rmSync(dir, {recursive: true, force: true});}
}

test('packaged action defaults to artifacts and rejects ambiguous transport combinations before scripts', () => {
  assert.equal(action.inputs['record-transport'].default, 'artifact');
  assert.equal(action.outputs['review-record'].value, '${{ steps.assess.outputs.review-record }}');
  const validation = action.runs.steps[0];
  for (const [values, success] of [
    [{operation: 'gate'}, true], [{operation: 'assess', 'record-transport': 'job-output'}, true],
    [{operation: 'gate', 'record-transport': 'job-output', 'review-record': 'present'}, true],
    [{operation: 'repair', 'record-transport': 'job-output', 'review-record': 'present'}, true],
    [{operation: 'gate', 'review-record': 'present'}, false],
    [{operation: 'gate', 'record-transport': 'job-output'}, false],
    [{operation: 'assess', 'record-transport': 'job-output', 'review-record': 'present'}, false],
    [{operation: 'test', 'record-transport': 'job-output'}, false],
    [{operation: 'gate', 'record-transport': 'Artifact'}, false],
    [{operation: 'unknown'}, false],
    [{operation: 'assess', 'ignore-receipt': 'true'}, true], [{operation: 'assess', 'ignore-receipt': 'false'}, true],
    [{operation: 'verify-local', 'ignore-receipt': 'true'}, false], [{operation: 'gate', 'ignore-receipt': 'true'}, false],
    [{operation: 'assess', 'ignore-receipt': 'yes'}, false],
  ]) {
    const result = spawnSync('bash', ['-e', '-c', validation.run], {env: environment(validation, values), encoding: 'utf8'});
    assert.equal(result.status === 0, success, JSON.stringify(values));
  }
});

test('actual Actions expressions keep a 400k record in four bounded env values and reject malformed shapes', () => {
  const parts = ['a'.repeat(100000), 'b'.repeat(100000), 'c'.repeat(100000), 'd'.repeat(100000)];
  for (const step of [gate, repair]) {
    const env = environment(step, {'record-transport': 'job-output', 'review-record': JSON.stringify(parts)});
    assert.equal(env.CLOUSEAU_RECORD_CANONICAL, 'true');
    assert.deepEqual([0, 1, 2, 3].map(index => env[`CLOUSEAU_RECORD_PART_${index}`]), parts);
    assert.ok(Object.values(env).every(value => value.length <= 100000));
    assert.equal(transport.joinParts(parts, true).length, 400000);
    for (const payload of ['not JSON', 'null', '3', '[]', '["a"]', '[null,"","",""]',
      '[1,"","",""]', '[false,"","",""]', '[[],"","",""]', '[{},"","",""]',
      '["a","","","","extra"]', '["a", "", "", ""]',
      JSON.stringify(['a\n\"; throw new Error("injection");//', '', '', ''])]) {
      assert.throws(() => {
        const bad = environment(step, {'record-transport': 'job-output', 'review-record': payload});
        const encoded = transport.joinParts([0, 1, 2, 3].map(index => bad[`CLOUSEAU_RECORD_PART_${index}`]),
          bad.CLOUSEAU_RECORD_CANONICAL === 'true');
        transport.decode({...fixture(), runAttempt: '2', payload: encoded});
      }, undefined, payload);
    }
  }
});

test('actual packaged assessment emits a record reusable only by the same run and attempt', async () => {
  const produced = await execute(assess);
  assert.equal(produced.assess, 1); assert.equal(produced.waited, true);
  assert.equal(produced.receiptOnly, false);
  const value = produced.outputs['review-record'];
  assert.equal(JSON.parse(value).length, 4);
  const passed = await execute(gate, {inputs: {'assessment': produced.outputs.assessment, 'review-record': value}});
  assert.equal(passed.gate, 1);
  for (const options of [{env: {GITHUB_RUN_ATTEMPT: '3'}}, {context: {...fixture().context, runId: 457}},
    {context: {repo: {owner: 'foreign', repo: 'radio'}, runId: 456}}]) {
    await assert.rejects(execute(gate, {...options, inputs: {assessment: produced.outputs.assessment, 'review-record': value}}),
      error => {assert.equal(error.transportState.gate, 0); return /foreign or stale/.test(error.message);});
  }
  const local = await execute(assess, {env: {CLOUSEAU_RECEIPT_ONLY: 'true', CLOUSEAU_WAIT_FOR_VERIFICATION: 'false'}});
  assert.equal(local.receiptOnly, true); assert.equal(local.waited, undefined);
  assert.equal(local.ignoreReceipt, false, 'the receipt-only route still reads the receipt');
  const hosted = await execute(assess, {inputs: {operation: 'assess', 'ignore-receipt': 'true'}});
  assert.equal(hosted.ignoreReceipt, true); assert.equal(hosted.receiptOnly, false);
  assert.equal(produced.ignoreReceipt, false, 'the ordinary hosted route is unchanged by default');
  const confined = await execute(assess, {inputs: {operation: 'verify-local', 'ignore-receipt': 'true'}});
  assert.equal(confined.ignoreReceipt, false, 'only assess can ignore a receipt');
});

test('packaged artifact mode leaves the existing artifact path and gate unchanged', async () => {
  const state = await execute(assess, {inputs: {'record-transport': 'artifact'}});
  assert.equal(state.outputs['review-record'], undefined);
  const f = fixture();
  const passed = await execute(gate, {inputs: {'record-transport': 'artifact', assessment: JSON.stringify(f.assessment)},
    before: () => {mkdirSync('work', {recursive: true}); writeFileSync(RECORD, JSON.stringify(f.record));}});
  assert.equal(passed.gate, 1);
});

test('packaged repair transports its bound bundle before the existing verifier and independent-author boundary', async () => {
  const f = fixture(); const bundle = {proposal: {edits: []}};
  const assessment = {...f.assessment, repair_digest: digest(bundle)};
  const produced = await execute(assess, {assessment, bundle});
  const values = {assessment: produced.outputs.assessment, 'review-record': produced.outputs['review-record']};
  await assert.rejects(execute(repair, {inputs: values, assessment}), error => {
    assert.equal(error.transportState.verify, 1); assert.equal(error.transportState.repair, 0);
    return /independent GitHub author credential/.test(error.message);
  });
  const passed = await execute(repair, {inputs: {...values, 'repair-token': 'fictional-author-token'}, assessment});
  assert.equal(passed.verify, 1); assert.equal(passed.repair, 1);
  const artifact = await execute(repair, {assessment, inputs: {'record-transport': 'artifact', assessment: JSON.stringify(assessment),
    'repair-token': 'fictional-author-token'}, before: () => {
    mkdirSync('work', {recursive: true}); writeFileSync(RECORD, JSON.stringify(f.record));
    writeFileSync(`${RECORD}.repair.json`, JSON.stringify(bundle));
  }});
  assert.equal(artifact.verify, 1); assert.equal(artifact.repair, 1);
});

test('failed or incomplete assessment diagnostics are logged losslessly without a second large output', async () => {
  const diagnostic = '{"failure":"negative review is retained"}\n';
  const f = fixture(); const assessment = {...f.assessment, decision: 'review_incomplete'};
  delete assessment.record_digest;
  const failed = await execute(assess, {assessment, diagnostic});
  assert.ok(failed.logs.some(line => line.startsWith('CLOUSEAU_DIAGNOSTIC_GZIP_BASE64URL_BEGIN')));
  assert.deepEqual(Object.keys(failed.outputs).sort(), ['assessment', 'review-record']);
  assert.match(failed.warnings[0], /^Clouseau review incomplete \(evidence_incomplete\): /, 'an incomplete review raises a visible annotation');
  await assert.rejects(execute(assess, {diagnostic, failure: true}), error => {
    assert.ok(error.transportState.logs.some(line => line.endsWith('BASE64URL_END')));
    return /investigation stopped/.test(error.message);
  });
  await assert.rejects(execute(assess, {diagnostic: 'x'.repeat(transport.MAX_EXPANDED_BYTES + 1)}), error => {
    assert.deepEqual(error.transportState.outputs, {}, 'diagnostic overflow cannot emit approval-eligible data');
    const retained = error.transportState.logs[0].match(/at (.*?) sha256=/)[1];
    try {assert.equal(readFileSync(retained).length, transport.MAX_EXPANDED_BYTES + 1);}
    finally {rmSync(path.dirname(retained), {recursive: true});}
    return /Worker-local private evidence/.test(error.message);
  });
});
