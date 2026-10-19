'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {compactSchema, invoke, askHarness} = require('./local-harness.cjs');

test('native output schema shares repeated choices without weakening proof ID constraints', () => {
  const choice = {type: 'string', enum: ['proof-1', 'proof-2'], description: 'controller supplied proofs'};
  const schema = {type: 'object', properties: {a: choice, b: {type: 'array', items: choice},
    fixed: {type: 'string', enum: ['one']}, empty: null}};
  const result = compactSchema(schema);
  assert.equal(Object.keys(result.$defs).length, 1);
  assert.equal(result.properties.a.$ref, result.properties.b.items.$ref);
  const reference = result.properties.a.$ref.split('/').at(-1);
  assert.deepEqual(result.$defs[reference].enum, ['proof-1', 'proof-2']);
  assert.equal(result.properties.a.description, choice.description);
  assert.deepEqual(schema.properties.a, choice);
});

test('native harness process transport captures results and bounds failures without exposing stderr', async () => {
  assert.equal(await invoke(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {input: 'fixture'}), 'fixture');
  await assert.rejects(invoke(process.execPath, ['-e', 'process.stderr.write("fictional-sensitive-diagnostic");process.exit(3)'],
    {input: ''}), error => error.message.includes('(3)') && !error.message.includes('fictional-sensitive-diagnostic'));
  await assert.rejects(invoke('/nonexistent-clouseau-harness', [], {input: ''}), /ENOENT/);
  await assert.rejects(invoke(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {input: '', timeoutMs: 20}), /failed/);
  await assert.rejects(invoke(process.execPath, ['-e', 'process.stdout.write("x".repeat(1000));setTimeout(()=>{},10000)'],
    {input: '', maxBytes: 10}), /failed/);
  assert.equal(await invoke('/usr/bin/true', [], {input: 'x'.repeat(1000000)}), '');
});

test('Codex and Claude adapters use fresh sessions, structured outputs and no CI provider environment', async () => {
  const previous = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fictional-never-forwarded';
  const paths = [];
  try {
    for (const harness of ['codex', 'claude']) {
      const response = await askHarness({harness, role: 'examiner', phase: 'investigation', schema: {type: 'object'}, prompt: 'fixture evidence',
        execute: async (program, args, options) => {
          paths.push(options.cwd);
          assert.equal(program, harness); assert.equal(options.env.DEEPSEEK_API_KEY, undefined);
          assert.equal(options.input, 'fixture evidence');
          if (harness === 'codex') {
            assert.ok(args.includes('--ephemeral')); assert.ok(args.includes('read-only'));
            const output = args[args.indexOf('--output-last-message') + 1];
            fs.writeFileSync(output, JSON.stringify({accepted: 'fictional fixture'}));
            return [JSON.stringify({type: 'thread.started', thread_id: 'fixture-codex'}),
              JSON.stringify({type: 'item.completed', item: {type: 'error', message: 'Fictional startup warning, not a tool call'}}),
              JSON.stringify({type: 'item.completed', item: {type: 'reasoning'}}),
              JSON.stringify({type: 'turn.completed'})].join('\n');
          }
          assert.ok(args.includes('--no-session-persistence')); assert.ok(args.includes('--json-schema'));
          return JSON.stringify({session_id: 'fixture-claude', structured_output: {accepted: 'fictional fixture'}});
        }});
      assert.equal(response.value.accepted, 'fictional fixture'); assert.equal(response.provenance.harness, harness);
    }
    await assert.rejects(askHarness({harness: 'unknown'}), /Supported/);
    await assert.rejects(askHarness({harness: 'claude', schema: {}, prompt: 'fixture',
      execute: async () => '{}'}), /structured result/);
    await assert.rejects(askHarness({harness: 'codex', schema: {}, prompt: 'fixture', execute: async (_, args) => {
      fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], '{}'); return '{}';
    }}), /session identity/);
    await assert.rejects(askHarness({harness: 'codex', schema: {}, prompt: 'fixture', execute: async (_, args) => {
      fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], '{}');
      return JSON.stringify({type: 'item.completed', item: {type: 'command_execution'}});
    }}), /used a tool/);
    assert.ok(paths.every(filename => !fs.existsSync(filename)));
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous;
  }
});
