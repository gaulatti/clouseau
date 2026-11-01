'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {SCHEME, DEFAULTS, PartitionRefusal, atomKey, parameters, cost, threshold, inflate, checkOwnership, partition, render, main} = require('./review-partition.cjs');

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
    const reference = partition(files, {unit_ceiling: 150000});
    for (let round = 0; round < 3; round++) {
      const again = partition(shuffled(files, next), {unit_ceiling: 150000});
      assert.equal(again.plan_digest, reference.plan_digest);
      assert.deepEqual(again.units, reference.units);
    }
  }
});

test('I1 holds on random trees: every changed path is owned by exactly one unit, units respect the ceiling', () => {
  for (let seed = 1000; seed < 1150; seed++) {
    const next = random(seed);
    const files = randomTree(next);
    const plan = partition(files, {unit_ceiling: 120000});
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
  assert.equal(renamed.units[0].costs['new/foo.ts'], Math.ceil(1.03 * 1900) + DEFAULTS.file_overhead);
  assert.match(render(renamed), /new\/foo\.ts {2}2469 {2}\(from old\/foo\.ts\)/);
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

test('an atom above C is its own unit; one above the unit threshold falls apart into its files, never a refusal', () => {
  const plan = partition([file('a.ts', 10000), file('big.ts', 250000, {base_size: 250000, patch_chars: 10000}), file('big.spec.ts', 20000), file('z.ts', 10000)]);
  assert.deepEqual(plan.units.map(unit => unit.owned), [['a.ts'], ['big.spec.ts', 'big.ts'], ['z.ts']]);
  assert.ok(plan.units[1].cost > DEFAULTS.unit_ceiling && plan.units[1].cost <= threshold(DEFAULTS));
  // Together the stem group costs more than one unit can hold: its files are packed separately.
  const apart = partition([file('x.ts', 300000, {base_size: 100000, patch_chars: 50000}), file('x.spec.ts', 100000)]);
  assert.deepEqual(apart.units.map(unit => unit.owned), [['x.spec.ts'], ['x.ts']]);
  assert.equal(threshold(DEFAULTS), 560000);
});

test('a file too large for one unit is split into segments, each owned by a different unit', () => {
  const big = file('big.json', 1000000, {base_size: 1000000, patch_chars: 20000});
  const plan = partition([file('a.ts', 1000), big, file('z.ts', 1000)]);
  const holders = plan.units.filter(unit => unit.owned.includes('big.json'));
  assert.ok(holders.length >= 5);
  assert.deepEqual(holders.map(unit => unit.parts['big.json']), holders.map((_, index) => ({index, count: holders.length})));
  assert.ok(holders.every(unit => unit.cost <= DEFAULTS.unit_ceiling));
  assert.equal(checkOwnership(plan, ['a.ts', 'big.json', 'z.ts']), true);
  // Whole files keep no parts at all, so their plans are as they were.
  assert.ok(plan.units.filter(unit => !unit.owned.includes('big.json')).every(unit => unit.parts === undefined));
  // Segments of one file never share a unit, even when each is small enough to.
  const small = partition([{...big, segments: [1000, 1000, 1000]}]);
  assert.equal(small.units.length, 3);
  assert.deepEqual(small.units.map(unit => unit.parts['big.json'].index), [0, 1, 2]);
  // The costs a caller supplies are used as given (plus the overhead of the entry); without them the cost is split evenly.
  assert.deepEqual(small.units.map(unit => unit.cost), [inflate(1000) + 512, inflate(1000) + 512, inflate(1000) + 512]);
  const even = partition([big]);
  assert.ok(even.units.every(unit => Math.abs(unit.cost - even.units[0].cost) <= 1));
  // A file under the threshold ignores the segments it carries; a derived summary is never split.
  assert.equal(partition([{...file('ok.ts', 1000), segments: [5, 5]}]).units[0].parts, undefined);
  assert.equal(partition([file('lock.yaml', 5000000, {derived_size: 300000})]).units[0].parts, undefined);
  // Another file may share a unit with a segment while room remains.
  const room = partition([file('a.ts', 1000), {...big, segments: [200000, 200000]}]);
  assert.deepEqual(room.units.map(unit => unit.owned), [['a.ts', 'big.json'], ['big.json']]);
  assert.match(render(plan), /big\.json {2}\d+ {2}\(segment 1 of \d+\)/);
});

test('a file of any size, and any number of units, is planned; nothing is refused for size', () => {
  assert.equal(partition([file('big.json', 300001)]).units.length, 1);
  assert.ok(partition([file('huge.json', 900000000, {base_size: 100000000, patch_chars: 90000000})]).units.length > 400);
  const lock = file('pnpm-lock.yaml', 538207, {base_size: 537648, derived_size: 20000});
  assert.equal(cost(lock, DEFAULTS), inflate(20000) + DEFAULTS.file_overhead);
  assert.equal(partition([lock]).units[0].cost, 20600 + 512);
  assert.equal(cost(file('empty.txt', 0), DEFAULTS), DEFAULTS.file_overhead);
  const many = Array.from({length: 300}, (_, index) => file(`f${index}.ts`, 250000, {patch_chars: 150000}));
  assert.equal(partition(many).units.length, 300);
  // Many tiny files still end in separate units once their accounting entries add up.
  const tiny = Array.from({length: 2000}, (_, index) => file(`dir/t${index}.ts`, 10));
  assert.ok(partition(tiny).units.length >= 2 && partition(tiny).units.every(unit => unit.cost <= DEFAULTS.unit_ceiling));
});

test('random trees with huge files keep I1: every changed line is owned once, segments are complete', () => {
  for (let seed = 5000; seed < 5060; seed++) {
    const next = random(seed);
    const files = randomTree(next).map(entry => (next() < 0.2 ? {...entry, head_size: 200000 + Math.floor(next() * 3000000), patch_chars: Math.floor(next() * 400000)} : entry));
    const plan = partition(files, {unit_ceiling: 150000});
    assert.equal(checkOwnership(plan, files.map(entry => entry.path)), true);
    assert.equal(partition(shuffled(files, next), {unit_ceiling: 150000}).plan_digest, plan.plan_digest);
    for (const unit of plan.units) assert.ok(unit.cost <= 150000 || unit.owned.length === 1 || new Set(unit.owned.map(atomKey)).size === 1);
  }
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
  assert.throws(() => partition([], {file_overhead: -1}), /invalid partition parameter file_overhead/);
  assert.equal(parameters({file_overhead: 0}).file_overhead, 0);
  assert.throws(() => partition([], {unit_ceiling: 560001}), /must fit budget minus shared and reserve/);
  assert.equal(parameters({unit_ceiling: 560000}).unit_ceiling, 560000);
  for (const value of [[], [], 'x', [1.5], [-1], [], null]) {
    if (value === null || value.length === 0) continue;
    assert.throws(() => partition([{...file('a.ts'), segments: value}]), /invalid segments/);
  }
  for (const value of [[], 'x']) assert.throws(() => partition([{...file('a.ts'), segments: value}]), /invalid segments/);
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

test('the ownership check of a split file wants every one of its segments, once', () => {
  const part = (index, count = 3) => ({'big.ts': {index, count}});
  const forged = (...units) => ({units: units.map(([parts, paths], index) => ({id: `u${index}`, owned: paths, ...(parts ? {parts} : {})}))});
  const whole = (...rest) => forged(...rest.map(([parts, paths]) => [parts, paths]));
  assert.equal(checkOwnership(whole([part(0), ['big.ts']], [part(1), ['big.ts']], [part(2), ['big.ts']]), ['big.ts']), true);
  refusal('incomplete_segments', () => checkOwnership(whole([part(0), ['big.ts']], [part(1), ['big.ts']]), ['big.ts']));
  refusal('incomplete_segments', () => checkOwnership(whole([part(0), ['big.ts']], [part(0), ['big.ts']], [part(2), ['big.ts']]), ['big.ts']));
  refusal('incomplete_segments', () => checkOwnership(whole([part(0, 2), ['big.ts']], [part(1, 3), ['big.ts']], [part(2), ['big.ts']]), ['big.ts']));
  // A segment of a path another unit owns whole, or a whole claim on a split path, is a duplicate.
  refusal('duplicate_ownership', () => checkOwnership(whole([part(0), ['big.ts']], [null, ['big.ts']]), ['big.ts']));
  refusal('duplicate_ownership', () => checkOwnership(whole([null, ['big.ts']], [part(0), ['big.ts']]), ['big.ts']));
});

test('golden plans for the measured alcantara commit 02618a9: stored (compact) sizes give 4 units, full patches 5, at C=450K', () => {
  assert.equal(table.files.length, 85);
  assert.equal(table.files.reduce((sum, entry) => sum + entry.base_size + entry.head_size, 0), 2308455);
  // Stored size: a file added whole keeps only its patch header, the body lives once in head_source.
  const plan = partition(table.files);
  assert.deepEqual(plan.units.map(unit => [unit.id, unit.owned.length, unit.cost]),
    [['u0', 36, 444565], ['u1', 22, 437671], ['u2', 12, 449538], ['u3', 15, 201175]]);
  assert.equal(plan.plan_digest, 'e246174b65d762f16130be60b2607582724eb81279d922087db986f3090047d6');
  assert.equal(plan.units.reduce((sum, unit) => sum + unit.owned.length, 0), 85);
  assert.ok(plan.units.every(unit => unit.cost <= DEFAULTS.unit_ceiling));
  assert.equal(checkOwnership(plan, table.files.map(entry => entry.path)), true);
  assert.equal(partition(shuffled(table.files, random(7))).plan_digest, plan.plan_digest);
  // Before compact storage every added file counted its full patch as well: the design's 5 units.
  const full = table.files.map(entry => ({...entry, patch_chars: entry.full_patch_chars ?? entry.patch_chars}));
  const old = partition(full);
  assert.deepEqual(old.units.map(unit => [unit.id, unit.owned.length, unit.cost]),
    [['u0', 29, 446973], ['u1', 12, 411607], ['u2', 15, 445158], ['u3', 8, 436455], ['u4', 21, 414161]]);
  assert.equal(old.plan_digest, '720841d824b85e455cdd56f7c89ff5a47988785aeb90ec6beaf2ebaff5e25a7a');
  // Without the derived summary the 538K lockfile is a file over the bound; with C=300K the plan grows.
  const raw = table.files.map(({derived_size, ...entry}) => entry);
  const rawPlan = partition(raw);
  assert.ok(rawPlan.units.filter(unit => unit.parts?.['pnpm-lock.yaml']).length >= 2);
  assert.equal(checkOwnership(rawPlan, raw.map(entry => entry.path)), true);
  assert.equal(partition(table.files, {unit_ceiling: 300000}).units.length, 7);
  assert.ok(partition(table.files, {unit_ceiling: 150000}).units.length > 6);
});

test('the dry run prints the plan, the refusal, and rejects bad arguments', () => {
  const run = (argv, files) => {
    let text = '';
    const code = main(argv, {readFile: name => { assert.equal(name, 'table.json'); return JSON.stringify({files}); }, stdout: {write: chunk => { text += chunk; }}});
    return {code, text};
  };
  const ok = run(['table.json'], table.files);
  assert.equal(ok.code, 0);
  assert.ok(ok.text.startsWith(`${SCHEME} e246174b`));
  assert.match(ok.text, /^4 units, 85 files, ceiling 450000$/m);
  assert.match(ok.text, /^u3 {2}cost 201175 {2}15 files$/m);
  assert.equal(run(['table.json', '--ceiling', '300000'], table.files).text.split('\n')[1], '7 units, 85 files, ceiling 300000');
  const refused = run(['table.json'], [{path: 'logo.png', base_size: 0, head_size: 10, patch_chars: 0, binary: true}]);
  assert.equal(refused.code, 2);
  assert.match(refused.text, /^refused unpartitionable_binary: binary change logo.png\n$/);
  assert.match(run(['table.json'], [{path: 'big.json', base_size: 0, head_size: 5000000, patch_chars: 100}]).text, /\(segment 1 of 12\)/);
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
  assert.match(written.join(''), /^clouseau-partition\/1 e246174b/);
});
