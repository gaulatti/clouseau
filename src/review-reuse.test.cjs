'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createReuse, keyOf, neutral, PREFIX} = require('./review-reuse.cjs');

const BASE = 'b'.repeat(40); const HEAD = 'a'.repeat(40); const DIGEST = 'd'.repeat(64);
const subsOf = ({base = BASE, head = HEAD, digest = DIGEST} = {}) => [[base, '<<clouseau-reuse:base>>'], [head, '<<clouseau-reuse:head>>'], [digest, '<<clouseau-reuse:digest-0>>']];
const verification = commands => JSON.stringify({commands, report_digest: 'f'.repeat(64), coverage: {status: 'exact'},
  coverage_reports: [{report: 'x.json', report_digest: 'e'.repeat(64), exact_coverage: {lines: [1, 1]}}]});
const packetOf = ({base = BASE, head = HEAD, digest = DIGEST, body = 'export const a = 1;\n', title = 'feat: a', commands} = {}) => ({
  review_context: {stage: 'local_pre_pr'},
  evidence: {digest, base_sha: base, head_sha: head, claims: {title, description: 'Reject missing input.'}, partition_of: digest,
    sources: {[`${head}:src/a.js`]: {path: 'src/a.js', ref: head, kind: 'source', content: body},
      verification: {kind: 'verification', ref: head, content: verification(commands || [{argv: ['npm', 'test'], exit_code: 0, stdout: 'ok in 12ms', stderr: '', stdout_digest: '1'.repeat(64), stderr_digest: '2'.repeat(64)}])}}}});
const taskOf = (packet, extra = {}) => ({role: 'examiner', phase: 'investigation', schema: {type: 'object', enum: [DIGEST]}, prompt: `Policy text.\n${JSON.stringify(packet)}`, ...extra});
const keyFor = (task, options = {}) => keyOf(task, {subs: subsOf(options.run), semantics: options.semantics || 's'.repeat(64)});

test('the key names the evidence, not the revision: ids, digests, the head subject and passing output do not change it', () => {
  const original = keyFor(taskOf(packetOf()));
  assert.match(original, /^[a-f0-9]{64}$/);
  const moved = {base: 'c'.repeat(40), head: '9'.repeat(40), digest: '8'.repeat(64)};
  const next = taskOf(packetOf({...moved, title: 'Merge origin/main into feature',
    commands: [{argv: ['npm', 'test'], exit_code: 0, stdout: 'ok in 99ms', stderr: 'warn', stdout_digest: '3'.repeat(64), stderr_digest: '4'.repeat(64)}]}));
  next.schema = {type: 'object', enum: [moved.digest]};
  assert.equal(keyFor(next, {run: moved}), original);
});

test('every other byte of the evidence is part of the key: sources, patches, request, policy text, schema, role, phase, engine semantics', () => {
  const original = keyFor(taskOf(packetOf()));
  const differs = (task, options) => assert.notEqual(keyFor(task, options), original);
  differs(taskOf(packetOf({body: 'export const a = 2;\n'})));
  differs(taskOf({...packetOf(), evidence: {...packetOf().evidence, claims: {title: 'feat: a', description: 'A different request.'}}}));
  differs({...taskOf(packetOf()), prompt: `Other policy.\n${JSON.stringify(packetOf())}`});
  differs(taskOf(packetOf(), {role: 'challenger'}));
  differs(taskOf(packetOf(), {phase: 'grading'}));
  differs(taskOf(packetOf(), {schema: {type: 'string'}}));
  differs(taskOf(packetOf()), {semantics: 't'.repeat(64)});
  // A failed command keeps every byte (its diagnosis is evidence); so does a passing command's argv and exit code.
  const failing = commands => taskOf(packetOf({commands}));
  const failedA = failing([{argv: ['npm', 'test'], exit_code: 1, stdout: 'boom', stderr: 'a'}]);
  const failedB = failing([{argv: ['npm', 'test'], exit_code: 1, stdout: 'boom', stderr: 'b'}]);
  assert.notEqual(keyFor(failedA), keyFor(failedB));
  assert.notEqual(keyFor(failing([{argv: ['npm', 'run', 'x'], exit_code: 0}])), keyFor(failing([{argv: ['npm', 'test'], exit_code: 0}])));
  assert.notEqual(keyFor(failing([{argv: ['npm', 'test'], exit_code: 0, error: {code: 'E'}}])), keyFor(failing([{argv: ['npm', 'test'], exit_code: 0, error: {code: 'F'}}])));
  assert.notEqual(keyFor(failing([{argv: ['npm', 'test'], exit_code: 0, signal: 'SIGTERM'}])), keyFor(failing([{argv: ['npm', 'test'], exit_code: 0}])));
});

test('the recent history of a file compares by its own commit ids, even when the base tip is one of them', () => {
  const withHistory = (base, commits) => {
    const packet = packetOf({base, head: HEAD});
    packet.evidence.history = [{path: 'src/a.js', commits}];
    return taskOf(packet);
  };
  const tip = 'c'.repeat(40); const old = '5'.repeat(40);
  // Run 1: the base tip touched the file. Run 2: the base moved on and the same commit is now merely history.
  const first = keyOf(withHistory(old, `${old} feat: a`), {subs: subsOf({base: old}), semantics: 's'});
  const second = keyOf(withHistory(tip, `${old} feat: a`), {subs: subsOf({base: tip}), semantics: 's'});
  assert.equal(second, first);
  assert.notEqual(keyOf(withHistory(tip, `${tip} feat: a`), {subs: subsOf({base: tip}), semantics: 's'}), first, 'another commit in the history is another input');
});

test('a task that cannot be keyed safely has no key', () => {
  assert.equal(keyFor({role: 'examiner', phase: 'investigation', schema: {}, prompt: 'no packet here'}), null);
  assert.equal(keyFor({role: 'examiner', phase: 'investigation', schema: {}, prompt: '{"unterminated'}), null);
  assert.equal(keyFor(taskOf(packetOf({body: `a ${PREFIX}base>> b`}))), null, 'text that already holds a placeholder could collide');
});

test('neutral leaves non-verification data and a verification without commands alone, and survives a record that is not a command list', () => {
  assert.deepEqual(neutral([1, null, 'x']), [1, null, 'x']);
  assert.deepEqual(neutral({kind: 'source', content: 'x', claims: {description: 'no title here'}}), {kind: 'source', content: 'x', claims: {description: 'no title here'}});
  assert.equal(neutral({kind: 'verification', content: '{"fixture_execution_only":true}'}).content, '{"fixture_execution_only":true}');
  const odd = neutral({kind: 'verification', content: JSON.stringify({commands: ['not-a-command', null], coverage: {status: 'exact'}})});
  assert.deepEqual(JSON.parse(odd.content).commands, ['not-a-command', null]);
  assert.throws(() => neutral({kind: 'verification', content: 'not json'}));
  assert.equal(neutral({kind: 'verification', content: 12}).content, 12);
});

function store() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-reuse-'));
  return {directory: path.join(directory, 'unit-reuse'), cleanup: () => fs.rmSync(directory, {recursive: true, force: true})};
}
const answer = (value = {kind: 'report'}) => ({value, provenance: {session: 's', request_digest: '7'.repeat(64)}});
const options = (directory, extra = {}) => ({directory, semantics: 's'.repeat(64), literals: () => ({base: BASE, head: HEAD, digests: [DIGEST]}), ...extra});

test('only an accepted review leaves answers, and only a reading review takes them', async () => {
  const s = store();
  try {
    const task = taskOf(packetOf());
    let asked = 0;
    const ask = async () => {asked++; return answer({kind: 'report', snapshot: DIGEST, head: HEAD});};
    // Not accepted: nothing is written, not even the directory.
    const rejected = createReuse(options(s.directory));
    await rejected.wrap(ask)(task);
    assert.equal(rejected.commit('repair_required'), 0);
    assert.equal(fs.existsSync(s.directory), false);
    // Nothing to write is not a write either.
    assert.equal(createReuse(options(s.directory)).commit('auto_approve'), 0);
    assert.equal(fs.existsSync(s.directory), false);
    // Accepted: recorded, but a recording-only review still asks.
    const writer = createReuse(options(s.directory));
    await writer.wrap(ask)(task);
    assert.equal(writer.commit('auto_approve'), 1);
    assert.equal(fs.statSync(s.directory).mode & 0o777, 0o700);
    const [file] = fs.readdirSync(s.directory);
    assert.equal(fs.statSync(path.join(s.directory, file)).mode & 0o777, 0o600);
    const stored = fs.readFileSync(path.join(s.directory, file), 'utf8');
    assert.ok(!stored.includes(HEAD) && !stored.includes(DIGEST), 'revision values are stored as placeholders');
    const passive = createReuse(options(s.directory));
    await passive.wrap(ask)(task);
    assert.equal(asked, 3); assert.equal(passive.stats.reused, 0);
    // A reading review on a moved revision takes the answer and puts the new revision values into it.
    const moved = {base: 'c'.repeat(40), head: '9'.repeat(40), digest: '8'.repeat(64)};
    const reader = createReuse(options(s.directory, {read: true, literals: () => ({base: moved.base, head: moved.head, digests: [moved.digest]})}));
    const next = taskOf(packetOf(moved), {schema: {type: 'object', enum: [moved.digest]}});
    let checked = 0;
    const hit = await reader.wrap(ask)({...next, check: value => {checked++; assert.equal(value.snapshot, moved.digest);}});
    assert.equal(asked, 3, 'the reviewer was not asked'); assert.equal(checked, 1); assert.equal(reader.stats.reused, 1);
    assert.deepEqual(hit.value, {kind: 'report', snapshot: moved.digest, head: moved.head});
    assert.deepEqual(hit.provenance, answer().provenance);
    // Changed evidence is a miss; so is a task with no check (a grading call) that finds nothing.
    await reader.wrap(ask)(taskOf(packetOf({...moved, body: 'changed'}), {schema: {type: 'object', enum: [moved.digest]}}));
    assert.equal(asked, 4);
    // A grading call has no check and takes its answer as is.
    const grading = taskOf(packetOf(), {phase: 'grading'});
    const writing = createReuse(options(s.directory));
    await writing.wrap(ask)(grading); writing.commit('auto_approve');
    const reading = createReuse(options(s.directory, {read: true}));
    await reading.wrap(ask)(grading);
    assert.equal(asked, 5); assert.equal(reading.stats.reused, 1);
  } finally {s.cleanup();}
});

test('a stored answer that no longer validates, is damaged, is another version or another key is not used', async () => {
  const s = store();
  try {
    const task = taskOf(packetOf());
    let asked = 0;
    const ask = async () => {asked++; return answer();};
    const writer = createReuse(options(s.directory));
    await writer.wrap(ask)(task); writer.commit('auto_approve');
    const [name] = fs.readdirSync(s.directory); const file = path.join(s.directory, name);
    const good = fs.readFileSync(file, 'utf8');
    const run = async check => {
      const reader = createReuse(options(s.directory, {read: true}));
      await reader.wrap(ask)({...task, check});
      return reader.stats.reused;
    };
    assert.equal(await run(() => {throw new Error('invalid under the new snapshot');}), 0); assert.equal(asked, 2);
    for (const damaged of ['not json', JSON.stringify({...JSON.parse(good), version: 2}), JSON.stringify({...JSON.parse(good), key: 'x'.repeat(64)})]) {
      fs.writeFileSync(file, damaged);
      assert.equal(await run(undefined), 0);
    }
    assert.equal(asked, 5);
    fs.writeFileSync(file, good);
    assert.equal(await run(undefined), 1);
    // A task without a key is asked and never stored; an answer holding a placeholder is never stored.
    const unkeyed = createReuse(options(s.directory, {read: true}));
    await unkeyed.wrap(ask)({role: 'examiner', phase: 'investigation', schema: {}, prompt: 'plain'});
    const tricky = createReuse(options(s.directory, {read: true}));
    await tricky.wrap(async () => answer({note: `${PREFIX}head>>`}))(taskOf(packetOf({body: 'other'})));
    assert.equal(unkeyed.commit('auto_approve') + tricky.commit('auto_approve'), 0);
  } finally {s.cleanup();}
});

test('outcome keying names complete coverage by its outcome, keeps incomplete counters, and never shares keys with the exact keying', () => {
  const withCoverage = (lines, branches, reports = lines) => taskOf({...packetOf(), evidence: {...packetOf().evidence, sources: {...packetOf().evidence.sources,
    verification: {kind: 'verification', ref: HEAD, content: JSON.stringify({commands: [{argv: ['npm', 'test'], exit_code: 0}], exact_coverage: {lines, branches},
      coverage_reports: [{report: 'x.json', report_digest: 'e'.repeat(64), exact_coverage: {lines: reports, branches}}]})}}}});
  const outcome = task => keyOf(task, {subs: subsOf(), semantics: 's'.repeat(64), outcome: true});
  // Main added code elsewhere: the counters moved, coverage stayed complete. Same outcome key; different exact keys.
  assert.equal(outcome(withCoverage([10, 10], [4, 4])), outcome(withCoverage([12, 12], [5, 5])));
  assert.notEqual(keyFor(withCoverage([10, 10], [4, 4])), keyFor(withCoverage([12, 12], [5, 5])));
  // Coverage that is not complete keeps its counters, at the top level and per report.
  assert.notEqual(outcome(withCoverage([9, 10], [4, 4])), outcome(withCoverage([10, 10], [4, 4])));
  assert.notEqual(outcome(withCoverage([10, 10], [4, 4], [9, 10])), outcome(withCoverage([10, 10], [4, 4])));
  assert.notEqual(outcome(withCoverage([9, 10], [4, 4])), outcome(withCoverage([8, 10], [4, 4])));
  // A malformed coverage object is kept as it is.
  for (const odd of [null, 'x', {lines: [1, 1]}, {lines: [1, 1], branches: [1]}, {lines: [1.5, 1.5], branches: [1, 1]}, {lines: [1, 1], branches: [1, 1], extra: 1}]) {
    const task = taskOf({...packetOf(), evidence: {...packetOf().evidence, sources: {...packetOf().evidence.sources,
      verification: {kind: 'verification', ref: HEAD, content: JSON.stringify({commands: [], exact_coverage: odd})}}}});
    assert.deepEqual(JSON.parse(neutral(JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1)), true).evidence.sources.verification.content).exact_coverage, odd);
  }
  // The keying is part of the key: an answer stored under one is never read under the other; without the option the key is today's.
  const task = withCoverage([10, 10], [4, 4]);
  assert.notEqual(outcome(task), keyFor(task));
  assert.equal(keyOf(task, {subs: subsOf(), semantics: 's'.repeat(64), outcome: false}), keyFor(task));
});

test('a reading review under outcome keying takes answers stored under it, and an exact-keyed store is not read', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-reuse-outcome-'));
  try {
    const task = taskOf(packetOf());
    const literals = () => ({base: BASE, head: HEAD, digests: [DIGEST]});
    const answer = {value: {kind: 'report'}};
    const exact = createReuse({directory, semantics: 's'.repeat(64), literals});
    await exact.wrap(async () => answer)(task); exact.commit('auto_approve');
    const reader = createReuse({directory, read: true, outcome: true, semantics: 's'.repeat(64), literals});
    let asked = 0;
    await reader.wrap(async () => {asked++; return answer;})(task);
    assert.equal(asked, 1, 'an exact-keyed answer is not an outcome-keyed one'); reader.commit('auto_approve');
    const again = createReuse({directory, read: true, outcome: true, semantics: 's'.repeat(64), literals});
    await again.wrap(async () => {asked++; return answer;})(task);
    assert.equal(asked, 1); assert.equal(again.stats.reused, 1);
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});
