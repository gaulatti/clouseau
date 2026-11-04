'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {digest} = require('./acceptance.cjs');
const {boundedTail, compactSchema, invoke, askHarness} = require('./local-harness.cjs');

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
    {input: ''}), error => error.message.includes('(3)') && !error.message.includes('fictional-sensitive-diagnostic') &&
      error.harnessDiagnostic.stderr === 'fictional-sensitive-diagnostic' && error.harnessDiagnostic.exit_code === 3);
  await assert.rejects(invoke('/nonexistent-clouseau-harness', [], {input: ''}), /ENOENT/);
  await assert.rejects(invoke(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {input: '', timeoutMs: 20}), error =>
    error.message.includes('failed') && error.harnessDiagnostic.controller_kill_reasons.includes('native_timeout') &&
      error.harnessDiagnostic.timeout_ms === 20);
  await assert.rejects(invoke(process.execPath, ['-e', 'process.stdout.write("x".repeat(1000));setTimeout(()=>{},10000)'],
    {input: '', maxBytes: 10}), error => error.message.includes('failed') &&
      error.harnessDiagnostic.controller_kill_reasons.includes('native_output_limit') &&
      error.harnessDiagnostic.stdout_characters > 10 && error.harnessDiagnostic.max_characters === 10);
  assert.equal(await invoke('/usr/bin/true', [], {input: 'x'.repeat(1000000)}), '');
});

test('failed native stdout is retained privately with bounded tails, full counts and digest', async () => {
  const stdout = 'fictional-private-output-'.repeat(150) + JSON.stringify({type: 'result', subtype: 'fictional-error', is_error: true});
  const stderr = 'fictional-private-stderr-'.repeat(150);
  await assert.rejects(invoke(process.execPath, ['-e',
    `process.stdout.write(${JSON.stringify(stdout)}, () => process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(1)))`],
  {input: ''}), error => {
    const diagnostic = error.harnessDiagnostic;
    assert.equal(diagnostic.stdout_tail, stdout.slice(-2000));
    assert.equal(diagnostic.stderr, stderr.slice(-2000));
    assert.equal(diagnostic.stdout_characters, stdout.length);
    assert.equal(diagnostic.stdout_bytes, Buffer.byteLength(stdout));
    assert.equal(diagnostic.stdout_digest, digest(stdout));
    assert.deepEqual(diagnostic.controller_kill_reasons, []);
    assert.equal(diagnostic.timeout_ms, 300000);
    assert.equal(diagnostic.max_characters, 3000000);
    assert.ok(diagnostic.elapsed_ms >= 0);
    assert.ok(!error.message.includes('fictional-private'));
    assert.ok(error.message.includes(digest(diagnostic)));
    return true;
  });
});

test('failed non-ASCII output keeps whole code points in bounded tails and distinct byte counts', async () => {
  const stdout = 'x' + '💡'.repeat(1500) + 'العربية';
  const stderr = '💡'.repeat(1500);
  await assert.rejects(invoke(process.execPath, ['-e',
    `process.stdout.write(${JSON.stringify(stdout)}, () => process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(1)))`],
  {input: ''}), error => {
    const diagnostic = error.harnessDiagnostic;
    assert.ok(diagnostic.stdout_tail.length <= 2000 && diagnostic.stderr.length <= 2000);
    for (const tail of [diagnostic.stdout_tail, diagnostic.stderr]) {
      assert.ok(!/^[\uDC00-\uDFFF]/.test(tail) && !/[\uD800-\uDBFF]$/.test(tail));
      assert.equal(Buffer.from(tail, 'utf8').toString('utf8'), tail);
    }
    assert.equal(diagnostic.stdout_characters, stdout.length);
    assert.equal(diagnostic.stdout_bytes, Buffer.byteLength(stdout));
    assert.notEqual(diagnostic.stdout_bytes, diagnostic.stdout_characters);
    assert.equal(diagnostic.stdout_digest, digest(stdout));
    return true;
  });
});

test('bounded tails drop only a leading low surrogate', () => {
  assert.equal(boundedTail('abcdef', 3), 'def');
  assert.equal(boundedTail('a💡b', 2), 'b');
  assert.equal(boundedTail('💡b', 3), '💡b');
});

test('native transport preserves UTF-8 characters split across process writes', async () => {
  const text = 'fictional 💡 العربية';
  const script = `const bytes=Buffer.from(${JSON.stringify(text)}); let index=0;
    function next(){if(index<bytes.length) process.stdout.write(bytes.subarray(index,index+1),()=>{index++;setTimeout(next,5);});} next();`;
  assert.equal(await invoke(process.execPath, ['-e', script], {input: ''}), text);
});

test('an oversized Codex prompt stops before invoking the transport without truncating evidence', async () => {
  let calls = 0;
  await assert.rejects(askHarness({harness: 'codex', prompt: 'x'.repeat(1048577), schema: {},
    execute: async () => {calls++;}}), /1048576-character transport limit/);
  assert.equal(calls, 0);
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
