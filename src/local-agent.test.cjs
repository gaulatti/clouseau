'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {git} = require('./local-git.cjs');
const {repository} = require('../test/local-git-fixture.cjs');
const {fixture} = require('../test/local-review-fixture.cjs');
const {localReview} = require('./local-review.cjs');
const {issueReceipt, verifyReceipt} = require('./local-receipt.cjs');
const {runReview, main} = require('./local-cli.cjs');
const {validateValue, respond} = require('./local-agent.cjs');
const fixtureInstallation = () => ({sha: 'e'.repeat(40), digest: require('./local-version.cjs').engineDigest(), clean: true});

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

async function withReview(run) {
  return repository(async f => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-agent-fixture-'));
    try {
      const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
      let verifications = 0;
      const deps = {state, verify: () => {verifications++; return {fixture_execution_only: true};}, installed: fixtureInstallation};
      const argv = ['review', '--directory', f.directory, '--base', f.base, '--request-file', request, '--agent', 'opencode'];
      await run({f, state, deps, argv, verifications: () => verifications});
    } finally {fs.rmSync(state, {recursive: true, force: true});}
  });
}

test('schema validation accepts the supported subset and fails closed on anything else', () => {
  const schema = {type: 'object', properties: {kind: {type: 'string', enum: ['a', 'b']}, items: {type: 'array', maxItems: 2, items: {type: 'integer', minimum: 0}},
    choice: {anyOf: [{type: 'null'}, {type: 'string'}]}}, required: ['kind', 'items', 'choice'], additionalProperties: false};
  validateValue(schema, {kind: 'a', items: [0, 1], choice: null});
  for (const bad of [{kind: 'c', items: [], choice: null}, {kind: 'a', items: [-1], choice: null}, {kind: 'a', items: [1, 2, 3], choice: null},
    {kind: 'a', items: [1.5], choice: null}, {kind: 'a', items: [], choice: 4}, {kind: 'a', items: []}, {kind: 'a', items: [], choice: null, extra: 1}, [], null]) {
    assert.throws(() => validateValue(schema, bad), Error, JSON.stringify(bad));
  }
  assert.throws(() => validateValue({type: 'string', pattern: '^a'}, 'a'), /Unsupported schema keyword pattern/);
  assert.throws(() => validateValue({type: 'bogus'}, 'a'), /Unsupported schema type/);
  assert.throws(() => validateValue({const: 1}, 2), /constant/);
});

test('an agent-driven review completes through separate commands, verifies once and records agent sessions', () => withReview(async ({f, state, deps, argv, verifications}) => {
  let answered = 0; let result;
  for (let step = 0; step < 12; step++) {
    result = await main(argv, deps);
    if (result.status !== 'awaiting_agent') break;
    assert.equal(result.agent, 'opencode'); assert.equal(result.sequence, answered + 1);
    assert.equal(result.provider_api_calls, 0); assert.match(result.respond, /clouseau respond --agent-request/);
    assert.ok(result.request_file.startsWith(state), 'exchange evidence stays outside the checkout');
    fs.writeFileSync(result.answer_file, JSON.stringify(subagent(JSON.parse(fs.readFileSync(result.request_file, 'utf8')))));
    const receipt = await main(['respond', '--agent-request', result.request_file, '--answer', result.answer_file,
      '--session', `opencode-subagent-${++answered}`], deps);
    assert.equal(receipt.status, 'answered');
  }
  assert.equal(answered, 4); assert.equal(verifications(), 1, 'real verification runs only once across resumes');
  assert.equal(result.decision, 'auto_approve'); assert.equal(result.harness_invocations, 4); assert.equal(result.receipt, null);
  const usage = JSON.parse(fs.readFileSync(result.record, 'utf8')).result.usage;
  assert.deepEqual([...new Set(usage.map(item => item.harness))], ['opencode']);
  assert.deepEqual([...new Set(usage.map(item => item.execution))], ['agent_session']);
  assert.equal(new Set(usage.map(item => item.session)).size, 4);
  const journal = fs.readFileSync(path.join(path.dirname(result.record), 'observations.jsonl'), 'utf8').trim().split('\n');
  assert.equal(journal.length, 8, 'each request and response is journaled exactly once');
  assert.equal(git(f.directory, ['status', '--porcelain']), '');
  await assert.rejects(main(argv, deps), /already run/);
}));

test('an agent answer is validated, bounded and cannot reuse a session', () => withReview(async ({state, deps, argv}) => {
  const first = await main(argv, deps);
  const request = JSON.parse(fs.readFileSync(first.request_file, 'utf8'));
  const other = path.join(state, 'elsewhere.json'); fs.writeFileSync(other, JSON.stringify(subagent(request)));
  assert.throws(() => respond({request: first.request_file, answer: other, session: 'opencode-subagent-1'}), /answer_file/);
  fs.writeFileSync(first.answer_file, JSON.stringify({kind: 'report'}));
  for (const attempt of [1, 2, 3]) {
    assert.throws(() => respond({request: first.request_file, answer: first.answer_file, session: 'opencode-subagent-1'}),
      new RegExp(`attempt ${attempt} of 3`));
  }
  assert.throws(() => respond({request: first.request_file, answer: first.answer_file, session: 'opencode-subagent-1'}), /rejected too many/);
  await assert.rejects(main(argv, deps), /rejected 3 times/);
}));

test('a session cannot answer two requests and a tampered request is detected', () => withReview(async ({deps, argv}) => {
  const first = await main(argv, deps);
  fs.writeFileSync(first.answer_file, JSON.stringify(subagent(JSON.parse(fs.readFileSync(first.request_file, 'utf8')))));
  respond({request: first.request_file, answer: first.answer_file, session: 'opencode-subagent-1'});
  assert.throws(() => respond({request: first.request_file, answer: first.answer_file, session: 'opencode-subagent-2'}), /already has an accepted response/);
  const second = await main(argv, deps);
  assert.equal(second.sequence, 2);
  fs.writeFileSync(second.answer_file, JSON.stringify(subagent(JSON.parse(fs.readFileSync(second.request_file, 'utf8')))));
  assert.throws(() => respond({request: second.request_file, answer: second.answer_file, session: 'opencode-subagent-1'}), /two requests/);
  assert.throws(() => respond({request: second.request_file, answer: second.answer_file, session: 'short'}), /session identifier/);
  const stored = JSON.parse(fs.readFileSync(first.request_file, 'utf8'));
  fs.writeFileSync(first.request_file, JSON.stringify({...stored, request_digest: 'f'.repeat(64)}));
  await assert.rejects(main(argv, deps), /diverged/);
}));

test('agent mode and headless harness mode are exclusive and agent names are explicit', () => withReview(async ({deps, argv}) => {
  await assert.rejects(main([...argv, '--harness', 'claude'], deps), /either --agent/);
  await assert.rejects(main([...argv.slice(0, -1), 'gemini'], deps), /Supported agent harnesses/);
  await assert.rejects(runReview({directory: '.', 'request-file': 'x', agent: 'opencode', harness: 'codex'}, deps), /either --agent/);
}));

test('signed receipts accept opencode agent sessions and still reject unknown harnesses or executions', async () => {
  const f = await fixture();
  const claim = overrides => async task => {
    const response = await f.ask(task);
    return {...response, provenance: {...response.provenance, ...overrides}};
  };
  f.record.result = await localReview({...f, ask: claim({harness: 'opencode', execution: 'agent_session'})});
  assert.equal(verifyReceipt(issueReceipt(f.issue), f.expected).decision, 'auto_approve');
  for (const overrides of [{harness: 'gemini'}, {harness: 'opencode', execution: 'headless'}]) {
    f.record.result = await localReview({...f, ask: claim(overrides)});
    assert.throws(() => verifyReceipt(issueReceipt(f.issue), f.expected), /independent harness/);
  }
});

test('a stored response that does not match its request is rejected on resume', () => withReview(async ({deps, argv}) => {
  const first = await main(argv, deps);
  fs.writeFileSync(first.answer_file, JSON.stringify(subagent(JSON.parse(fs.readFileSync(first.request_file, 'utf8')))));
  respond({request: first.request_file, answer: first.answer_file, session: 'opencode-subagent-1'});
  const responseFile = path.join(path.dirname(first.request_file), 'response-0001.json');
  const stored = JSON.parse(fs.readFileSync(responseFile, 'utf8')); stored.request_digest = '0'.repeat(64);
  fs.writeFileSync(responseFile, JSON.stringify(stored));
  await assert.rejects(main(argv, deps), /does not match its request/);
}));

test('source or evidence that changes after an exchange began is refused', () => withReview(async ({deps, argv}) => {
  const first = await main(argv, deps);
  fs.writeFileSync(path.join(path.dirname(first.request_file), 'snapshot.digest'), 'f'.repeat(64));
  await assert.rejects(main(argv, deps), /changed since this agent exchange began/);
}));

test('schema validation fails closed on unusable schemas and checks numbers, booleans and bounds', () => {
  for (const schema of [null, [], 'text', {anyOf: []}, {anyOf: 'x'}]) assert.throws(() => validateValue(schema, 1), /Unsupported schema/);
  validateValue({type: ['string', 'null']}, null);
  validateValue({type: 'boolean'}, true);
  validateValue({type: 'number', maximum: 2}, 1.5);
  assert.throws(() => validateValue({type: 'number', maximum: 1}, 2), /above its maximum/);
  assert.throws(() => validateValue({type: 'number', minimum: 1}, 0), /below its minimum/);
  assert.throws(() => validateValue({type: 'boolean'}, 1), /must be boolean/);
  validateValue({type: 'object'}, {});
  assert.throws(() => validateValue({type: 'object', properties: {a: {type: 'string'}}, required: ['a']}, {}), /required/);
  assert.throws(() => validateValue({type: 'object', additionalProperties: false}, {extra: 1}), /not allowed/);
});

test('respond refuses malformed requests and unreadable answers', () => withReview(async ({state, deps, argv}) => {
  assert.throws(() => respond({}), /respond requires/);
  assert.throws(() => respond({request: path.join(state, 'other.json'), answer: 'a', session: 'opencode-subagent-1'}), /agent request file/);
  const first = await main(argv, deps);
  const directory = path.dirname(first.request_file);
  const stored = JSON.parse(fs.readFileSync(first.request_file, 'utf8'));
  const alter = change => {
    const forged = path.join(directory, 'request-0009.json');
    fs.writeFileSync(forged, JSON.stringify({...stored, ...change(stored)}));
    return forged;
  };
  for (const change of [() => ({version: 2}), () => ({answer_file: path.join(directory, 'answer-0001.json')}), () => ({agent: 'unknown', answer_file: path.join(directory, 'answer-0009.json')}),
    () => ({answer_file: undefined})]) {
    assert.throws(() => respond({request: alter(change), answer: first.answer_file, session: 'opencode-subagent-1'}), /Invalid agent request file/);
  }
  fs.writeFileSync(first.answer_file, 'x'.repeat(3000001));
  assert.throws(() => respond({request: first.request_file, answer: first.answer_file, session: 'opencode-subagent-2'}), /size budget/);
  fs.writeFileSync(first.answer_file, '{not json');
  assert.throws(() => respond({request: first.request_file, answer: first.answer_file, session: 'opencode-subagent-3'}), /not valid JSON/);
}));

test('an unsupported agent harness is refused before any exchange starts', () => withReview(async ({deps, argv}) => {
  await assert.rejects(main([...argv.slice(0, -1), 'unknown'], deps), /Supported agent harnesses/);
}));
