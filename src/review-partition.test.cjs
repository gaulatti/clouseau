'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {SCHEME, DEFAULTS, PartitionRefusal, atomKey, cost, checkOwnership, partition, render, main} = require('./review-partition.cjs');

const file = (name, size = 1000, extra = {}) => ({path: name, base_size: 0, head_size: size, patch_chars: 0, ...extra});
const table = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/fixtures/alcantara-02618a9.json'), 'utf8'));
const refusal = (code, run) => assert.throws(run, error => error instanceof PartitionRefusal && error.code === code && error.message.startsWith(`${code}: `));

// Small seeded generator so the property tests are reproducible.
function random(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
const shuffled = (items, next) => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const pick = Math.floor(next() * (index + 1));
    [copy[index], copy[pick]] = [copy[pick], copy[index]];
  }
  return copy;
};
function randomTree(next) {
  const directories = ['a', 'a/b', 'src', 'src/x', 'zeta', 'docs', 'ünï'];
  const markers = ['', '', '.spec', '.test', '.stories'];
  const extensions = ['.ts', '.tsx', '.md', '.json', ''];
  const files = new Map();
  for (let count = Math.floor(next() * 60); count > 0; count--) {
    const name = `${directories[Math.floor(next() * directories.length)]}/f${Math.floor(next() * 12)}${markers[Math.floor(next() * 5)]}${extensions[Math.floor(next() * 5)]}`;
    files.set(name, {path: name, base_size: Math.floor(next() * 40000), head_size: Math.floor(next() * 40000),
      patch_chars: Math.floor(next() * 5000), ...(next() < 0.1 ? {previous: `old/${name}`} : {})});
  }
  return [...files.values()];
}

test('the plan digest is independent of input order (property test on random trees)', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const next = random(seed);
    const files = randomTree(next);
    const reference = partition(files, {unit_ceiling: 150000, max_units: 64});
    for (let round = 0; round < 3; round++) {
      const again = partition(shuffled(files, next), {unit_ceiling: 150000, max_units: 64});
      assert.equal(again.plan_digest, reference.plan_digest);
      assert.deepEqual(again.units, reference.units);
    }
  }
});

test('I1 holds on random trees: every changed path is owned by exactly one unit, units respect the ceiling', () => {
  for (let seed = 1000; seed < 1150; seed++) {
    const next = random(seed);
    const files = randomTree(next);
    const plan = partition(files, {unit_ceiling: 120000, max_units: 64});
    const owned = plan.units.flatMap(unit => unit.owned);
    assert.deepEqual([...owned].sort(), files.map(entry => entry.path).sort());
    assert.equal(new Set(owned).size, owned.length);
    assert.equal(checkOwnership(plan, files.map(entry => entry.path)), true);
    for (const unit of plan.units) {
      // A unit exceeds C only when one atom alone is bigger than C.
      const atoms = new Set(unit.owned.map(atomKey));
      assert.ok(unit.cost <= 120000 || atoms.size === 1);
      assert.equal(unit.cost, unit.owned.reduce((sum, name) => sum + unit.costs[name], 0));
      // Atoms are never split across units.
      for (const other of plan.units) if (other !== unit) for (const name of other.owned) assert.ok(!atoms.has(atomKey(name)));
    }
  }
  assert.deepEqual(partition([]).units, []);
});

test('the plan digest changes with parameters, membership and costs', () => {
  const base = [file('a.ts', 1000), file('b.ts', 1000)];
  const reference = partition(base);
  assert.equal(reference.scheme, SCHEME);
  assert.match(reference.plan_digest, /^[0-9a-f]{64}$/);
  assert.notEqual(partition(base, {unit_ceiling: 449999}).plan_digest, reference.plan_digest);
  assert.notEqual(partition([...base, file('c.ts')]).plan_digest, reference.plan_digest);
  assert.notEqual(partition([file('a.ts', 1000), file('b.ts', 1001)]).plan_digest, reference.plan_digest);
  assert.deepEqual(partition(base, {}).params, DEFAULTS);
});

test('a file stays with its tests and stories, and a rename is keyed by its new path', () => {
  assert.equal(atomKey('src/foo.ts'), 'src/foo');
  assert.equal(atomKey('src/foo.spec.ts'), 'src/foo');
  assert.equal(atomKey('src/foo.test.tsx'), 'src/foo');
  assert.equal(atomKey('src/foo.stories.tsx'), 'src/foo');
  assert.equal(atomKey('foo.ts'), 'foo');
  assert.equal(atomKey('src/foo'), 'src/foo');
  assert.notEqual(atomKey('src/foo.ts'), atomKey('lib/foo.ts'));
  // Fill the first unit so only atom pairing keeps foo.ts with its tests.
  const files = [file('a/fill.ts', 200000, {patch_chars: 200000}), file('a/foo.ts', 30000), file('a/foo.stories.tsx', 30000), file('a/foo.spec.ts', 30000)];
  const plan = partition(files);
  assert.deepEqual(plan.units.map(unit => unit.owned), [['a/fill.ts'], ['a/foo.spec.ts', 'a/foo.stories.tsx', 'a/foo.ts']]);
  // A renamed file travels with the tests at its new path, with the old path recorded, and costs one entry.
  const renamed = partition([file('new/foo.ts', 1000, {previous: 'old/foo.ts', base_size: 900}), file('new/foo.spec.ts', 500)]);
  assert.deepEqual(renamed.units.map(unit => unit.owned), [['new/foo.spec.ts', 'new/foo.ts']]);
  assert.deepEqual(renamed.units[0].renamed, {'new/foo.ts': 'old/foo.ts'});
  assert.equal(renamed.units[0].costs['new/foo.ts'], Math.ceil(1.03 * 1900));
  assert.match(render(renamed), /new\/foo\.ts {2}1957 {2}\(from old\/foo\.ts\)/);
});

test('next-fit closes a unit when the next atom would overflow C, in byte order of path', () => {
  const files = ['e', 'a', 'd', 'b', 'c'].map(name => file(`${name}.ts`, 100000));
  const plan = partition(files, {unit_ceiling: 250000});
  // 103000 each: two fit under 250000, a third does not.
  assert.deepEqual(plan.units.map(unit => unit.owned), [['a.ts', 'b.ts'], ['c.ts', 'd.ts'], ['e.ts']]);
  assert.deepEqual(plan.units.map(unit => unit.id), ['u0', 'u1', 'u2']);
  // Next-fit does not go back to an earlier unit with room.
  const holes = partition([file('a.ts', 200000), file('b.ts', 200000), file('c.ts', 1000)], {unit_ceiling: 250000});
  assert.deepEqual(holes.units.map(unit => unit.owned), [['a.ts'], ['b.ts', 'c.ts']]);
  // Byte order, not UTF-16 order: U+FF5E sorts before U+10000 by UTF-8 bytes.
  const order = partition([file('\u{10000}.ts'), file('～.ts')]);
  assert.deepEqual(order.units[0].owned, ['～.ts', '\u{10000}.ts']);
});

test('an atom above C is its own unit; above the unit budget it is refused naming its paths', () => {
  const plan = partition([file('a.ts', 10000), file('big.ts', 290000, {base_size: 290000, patch_chars: 10000}), file('big.spec.ts', 100000), file('z.ts', 10000)]);
  assert.deepEqual(plan.units.map(unit => unit.owned), [['a.ts'], ['big.spec.ts', 'big.ts'], ['z.ts']]);
  assert.ok(plan.units[1].cost > DEFAULTS.unit_ceiling);
  assert.throws(() => partition([file('x.ts', 300000, {base_size: 300000, patch_chars: 250000}), file('x.spec.ts', 1000)]), error => {
    assert.equal(error.code, 'unit_exceeds_budget');
    assert.deepEqual(error.paths, ['x.spec.ts', 'x.ts']);
    return true;
  });
});

test('a changed file over the per-file bound is refused, a derived summary replaces its sources', () => {
  refusal('file_over_bound', () => partition([file('big.json', 300001)]));
  refusal('file_over_bound', () => partition([file('big.json', 1, {base_size: 300001})]));
  assert.equal(partition([file('ok.json', 300000)]).units.length, 1);
  const lock = file('pnpm-lock.yaml', 538207, {base_size: 537648, derived_size: 20000});
  assert.equal(cost(lock, DEFAULTS), 20600);
  assert.equal(partition([lock]).units[0].cost, 20600);
  assert.equal(cost(file('empty.txt', 0), DEFAULTS), 0);
});

test('more than the allowed number of units is refused', () => {
  const files = Array.from({length: 9}, (_, index) => file(`f${index}.ts`, 250000, {patch_chars: 150000}));
  assert.equal(partition(files.slice(0, 8)).units.length, 8);
  refusal('too_many_units', () => partition(files));
  assert.equal(partition(files, {max_units: 9}).units.length, 9);
});

test('unsafe paths, duplicates and binaries are refused', () => {
  for (const bad of ['', '/abs.ts', 'a/../b.ts', './a.ts', 'a//b.ts', 'a\\b.ts', 'a\0b.ts', 'a/', undefined, 7]) {
    refusal('unpartitionable_path', () => partition([file(bad)]));
  }
  refusal('unpartitionable_path', () => partition([null]));
  refusal('unpartitionable_path', () => partition([file('a.ts'), file('b.ts'), file('a.ts')]));
  refusal('unpartitionable_binary', () => partition([file('logo.png', 10, {binary: true})]));
  assert.equal(partition([file('logo.png', 10, {binary: false})]).units.length, 1);
});

test('malformed sizes and parameters are programming errors, not refusals', () => {
  for (const field of ['base_size', 'head_size', 'patch_chars']) {
    for (const value of [-1, 1.5, '3', undefined]) assert.throws(() => partition([{...file('a.ts'), [field]: value}]), TypeError);
  }
  for (const value of [-1, 0.5, 'x']) assert.throws(() => partition([file('a.ts', 1, {derived_size: value})]), /invalid derived_size/);
  assert.throws(() => partition([], {unit_ceiling: 0}), /invalid partition parameter unit_ceiling/);
  assert.throws(() => partition([], {nope: 1}), /invalid partition parameter nope/);
  assert.throws(() => partition([], {unit_ceiling: 800001}), /must fit budget/);
});

test('the ownership check rejects duplicate, missing and unknown paths', () => {
  const plan = partition([file('a.ts'), file('b.ts')], {unit_ceiling: 1});
  assert.equal(plan.units.length, 2);
  const forged = owned => ({units: owned.map((paths, index) => ({id: `u${index}`, owned: paths}))});
  assert.equal(checkOwnership(forged([['a.ts'], ['b.ts']]), ['a.ts', 'b.ts']), true);
  refusal('duplicate_ownership', () => checkOwnership(forged([['a.ts'], ['a.ts', 'b.ts']]), ['a.ts', 'b.ts']));
  refusal('unowned_path', () => checkOwnership(forged([['a.ts']]), ['a.ts', 'b.ts']));
  refusal('unknown_owned_path', () => checkOwnership(forged([['a.ts'], ['b.ts', 'c.ts']]), ['a.ts', 'b.ts']));
});

test('golden plan for the measured alcantara commit 02618a9: 5 units at C=450K', () => {
  assert.equal(table.files.length, 85);
  assert.equal(table.files.reduce((sum, entry) => sum + entry.base_size + entry.head_size, 0), 2308455);
  const plan = partition(table.files);
  assert.deepEqual(plan.units.map(unit => [unit.id, unit.owned.length, unit.cost]),
    [['u0', 29, 432125], ['u1', 12, 405463], ['u2', 15, 437478], ['u3', 9, 445610], ['u4', 20, 390158]]);
  assert.equal(plan.plan_digest, 'c418017fbfce04bcc4df90b8eab2eeefe9941a6ee8f743fd00405c180e04fa94');
  assert.equal(plan.units.reduce((sum, unit) => sum + unit.owned.length, 0), 85);
  assert.ok(plan.units.every(unit => unit.cost <= DEFAULTS.unit_ceiling));
  assert.equal(checkOwnership(plan, table.files.map(entry => entry.path)), true);
  assert.equal(partition(shuffled(table.files, random(7))).plan_digest, plan.plan_digest);
  // Without the derived summary the 538K lockfile is a file over the bound; with C=300K the plan grows.
  const raw = table.files.map(({derived_size, ...entry}) => entry);
  refusal('file_over_bound', () => partition(raw));
  assert.equal(partition(table.files, {unit_ceiling: 300000}).units.length, 8);
  refusal('too_many_units', () => partition(table.files, {unit_ceiling: 200000}));
});

test('the dry run prints the plan, the refusal, and rejects bad arguments', () => {
  const run = (argv, files) => {
    let text = '';
    const code = main(argv, {readFile: name => { assert.equal(name, 'table.json'); return JSON.stringify({files}); }, stdout: {write: chunk => { text += chunk; }}});
    return {code, text};
  };
  const ok = run(['table.json'], table.files);
  assert.equal(ok.code, 0);
  assert.ok(ok.text.startsWith(`${SCHEME} c418017f`));
  assert.match(ok.text, /^5 units, 85 files, ceiling 450000$/m);
  assert.match(ok.text, /^u4 {2}cost 390158 {2}20 files$/m);
  assert.equal(run(['table.json', '--ceiling', '300000'], table.files).text.split('\n')[1], '8 units, 85 files, ceiling 300000');
  const refused = run(['table.json', '--max-units', '2'], table.files);
  assert.equal(refused.code, 2);
  assert.match(refused.text, /^refused too_many_units: 5 units exceed the limit of 2\n$/);
  assert.throws(() => run(['table.json', '--bogus', '1'], []), /unknown option --bogus/);
  assert.throws(() => run([], []), /usage: partition-plan/);
  assert.throws(() => run(['table.json', '--ceiling', '0'], []), /invalid partition parameter/);
});

test('the dry run reads the table from disk and writes to stdout by default', () => {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => { written.push(String(chunk)); return true; };
  try {
    assert.equal(main([path.join(__dirname, '../test/fixtures/alcantara-02618a9.json')]), 0);
  } finally { process.stdout.write = original; }
  assert.match(written.join(''), /^clouseau-partition\/1 c418017f/);
});
