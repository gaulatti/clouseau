'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fixture, harness} = require('../test/bootstrap-cli-fixture.cjs');
const normal = require('./local-cli.cjs');
const cli = require('./installation-cli.cjs');
const bootstrap = require('./installation-bootstrap.cjs');

// Stand-in for a fresh subagent: answers each frozen request from its own prompt and schema files.
function subagent(request) {
  const prompt = fs.readFileSync(request.prompt_file, 'utf8');
  const schema = JSON.parse(fs.readFileSync(request.schema_file, 'utf8'));
  if (request.phase === 'investigation') {
    const report = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)).template;
    report.gates.forEach(gate => {gate.state = 'satisfied';});
    return {kind: 'report', report, request_sources: []};
  }
  return {answers: Object.fromEntries(Object.keys(schema.properties.answers.properties)
    .map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))};
}
const answer = (waiting, session) => {
  fs.writeFileSync(waiting.answer_file, JSON.stringify(subagent(JSON.parse(fs.readFileSync(waiting.request_file, 'utf8')))));
  return require('./local-agent.cjs').respond({request: waiting.request_file, answer: waiting.answer_file, session});
};

test('installation-review runs agent-driven: one verification, one attempt, resumable, and a verifiable installation receipt', () => fixture(async f => {
  let verifications = 0;
  const runtime = {...f.reviewRuntime, ask: async () => {throw new Error('Agent mode must not use a headless harness');},
    verify: () => {verifications++; return {fixture_only: true, exact_coverage: {lines: [1, 1], branches: [2, 2]}};}};
  const argv = ['installation-review', '--directory', f.directory, '--manifest', f.manifestFile,
    '--grant-comment', String(f.grant.comment_id), '--agent', 'claude'];
  let result; let answered = 0;
  for (let step = 0; step < 12; step++) {
    result = await normal.main(argv, runtime);
    if (result.status !== 'awaiting_agent') break;
    assert.equal(result.agent, 'claude'); assert.equal(result.installation_only, true); assert.equal(result.provider_api_calls, 0);
    assert.match(result.respond, /clouseau respond --agent-request/);
    assert.ok(result.request_file.startsWith(f.state), 'exchange evidence stays outside the checkout');
    assert.equal(answer(result, `claude-subagent-${++answered}`).status, 'answered');
    if (answered === 1) { // an interrupted command repeats without spending the attempt or the verification again
      assert.equal((await normal.main(argv, runtime)).status, 'awaiting_agent');
    }
  }
  assert.equal(answered, 2); assert.equal(verifications, 1);
  assert.equal(result.decision, 'auto_approve'); assert.equal(result.installation_only, true); assert.equal(result.harness_invocations, 2);
  const bundle = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal((await bootstrap.verifyInstallationReceipt(bundle, f.options())).decision, 'auto_approve');
  const usage = JSON.parse(fs.readFileSync(result.record, 'utf8')).result.usage;
  assert.deepEqual([...new Set(usage.map(item => item.execution))], ['agent_session']);
  const [ledger] = fs.readdirSync(path.join(f.state, 'installation-ledgers'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, 'installation-ledgers', ledger))).installation_attempts, 1);
  await assert.rejects(normal.main(argv, runtime), /already ran|unchanged revision/, 'a completed exchange is never reopened');
}));

test('installation-review agent mode is exclusive with --harness, names its agents and refuses changed evidence', () => fixture(async f => {
  const argv = ['installation-review', '--directory', f.directory, '--manifest', f.manifestFile, '--grant-comment', String(f.grant.comment_id)];
  await assert.rejects(normal.main([...argv, '--agent', 'claude', '--harness', 'codex'], f.reviewRuntime), /either --agent .* not both/);
  await assert.rejects(normal.main([...argv, '--agent', 'gemini'], f.reviewRuntime), /supported agent harnesses: claude, codex, opencode/);
  assert.equal(fs.existsSync(path.join(f.state, 'installation-ledgers')), false, 'rejected invocations record nothing');
  const first = await normal.main([...argv, '--agent', 'claude'], f.reviewRuntime);
  assert.equal(first.status, 'awaiting_agent');
  fs.writeFileSync(path.join(path.dirname(first.request_file), 'snapshot.digest'), 'f'.repeat(64));
  await assert.rejects(normal.main([...argv, '--agent', 'claude'], f.reviewRuntime), /changed since this agent exchange began/);
}));
