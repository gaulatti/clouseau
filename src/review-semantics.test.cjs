'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const crypto = require('node:crypto');
const semantics = require('./review-semantics.cjs');
const cli = require('./review-compatibility-cli.cjs');

const H = char => char.repeat(64);

// A minimal engine tree: one semantic source, one neutral tool, and a statement for it.
function engine(statement) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-semantics-'));
  for (const directory of ['src', 'policy', 'bin', 'skills', 'scripts']) fs.mkdirSync(path.join(root, directory));
  fs.writeFileSync(path.join(root, 'action.yml'), 'name: Fictional fixture\n');
  fs.writeFileSync(path.join(root, 'src/rules.cjs'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'src/review-cost.cjs'), 'module.exports = 2;\n');
  if (statement) fs.writeFileSync(path.join(root, semantics.STATEMENT), typeof statement === 'string' ? statement : JSON.stringify(statement));
  return root;
}
const cleanup = root => fs.rmSync(root, {recursive: true, force: true});
const quiet = () => {const lines = []; return {lines, out: text => lines.push(text)};};

// ENFORCEMENT. This is what keeps the compatibility statement honest: any change to a file that determines what a review
// attests makes this tree differ from the manifest the statement was last folded for, and this test then fails until the
// change carries a declaration (`scripts/review-compatibility declare --compatible|--incompatible`). Once the change is on
// protected main, the fold records it in the statement; until then `acceptor()` refuses every claim.
test('every review-semantics change of this tree is either folded into the statement or declared', () => {
  const state = cli.inspect(path.join(__dirname, '..'));
  assert.deepEqual(state.problems, []);
  assert.deepEqual(state.undeclared, [], 'Review semantics changed without a declaration. Run scripts/review-compatibility declare ' +
    '--compatible (the change cannot alter what a review attests) or declare --incompatible (receipts issued earlier must be reviewed again).');
  assert.equal(cli.main(['verify'], {out: () => {}}), 0);
  const live = semantics.semanticsDigest();
  assert.equal(semantics.acceptor()(live), state.changed.size === 0);
  assert.equal(semantics.acceptor()(live), semantics.readStatement().current === live);
});

test('the semantic entries are exactly what the digest covers', () => {
  const root = engine();
  try {
    const list = semantics.entries(root);
    assert.deepEqual(list.map(entry => entry[0]), ['action.yml', 'src/rules.cjs']);
    assert.equal(semantics.digestOf(list), semantics.semanticsDigest(root));
    assert.equal(semantics.digestOf(list), crypto.createHash('sha256').update(JSON.stringify([semantics.DOMAIN, list])).digest('hex'));
  } finally {cleanup(root);}
});

test('every receipt-neutral file is explained, exists, and is not loaded by semantic code', () => {
  const root = path.join(__dirname, '..');
  const classes = new Map(semantics.classify().map(file => [file.path, file.semantic]));
  const semanticText = [...classes].filter(([name, semantic]) => semantic && name !== 'src/review-semantics.cjs')
    .map(([name]) => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
  for (const entry of semantics.NEUTRAL) {
    assert.match(entry.reason, /^[a-z].{10,}/, `${entry.path} needs a real reason`);
    assert.equal(classes.get(entry.path), false, `${entry.path} must exist in the engine and be classified neutral`);
    if (!entry.presentation) assert.ok(!semanticText.includes(path.basename(entry.path)), `${entry.path} is referenced by semantic code, so it is not receipt-neutral`);
  }
  assert.equal(new Set(semantics.NEUTRAL.map(entry => entry.path)).size, semantics.NEUTRAL.length);
  assert.equal(classes.get('src/review-semantics.cjs'), true);
  assert.equal(classes.get('src/local-receipt.cjs'), true);
  assert.equal(classes.get('action.yml'), true);
  assert.equal(classes.get('policy/change-acceptance.md'), true);
});

test('the digest covers every engine file except tests and listed neutral files', () => {
  const root = engine();
  try {
    const first = semantics.semanticsDigest(root);
    assert.match(first, /^[a-f0-9]{64}$/);
    // Neutral files, tests and caches never move it.
    fs.writeFileSync(path.join(root, 'src/review-cost.cjs'), 'module.exports = 3;\n');
    fs.writeFileSync(path.join(root, 'src/rules.test.cjs'), 'test');
    fs.writeFileSync(path.join(root, 'src/test_fixture.py'), 'test');
    fs.mkdirSync(path.join(root, 'src/__pycache__')); fs.writeFileSync(path.join(root, 'src/__pycache__/x.pyc'), 'cache');
    fs.writeFileSync(path.join(root, semantics.STATEMENT), '{}');
    assert.equal(semantics.semanticsDigest(root), first);
    assert.deepEqual(semantics.classify(root).filter(file => !file.semantic).map(file => file.path).sort(), [semantics.STATEMENT, 'src/review-cost.cjs'].sort());
    // Everything else does, including a brand new, unlisted file, a mode change and a policy edit.
    for (const change of [
      () => fs.writeFileSync(path.join(root, 'src/rules.cjs'), 'module.exports = 9;\n'),
      () => fs.writeFileSync(path.join(root, 'src/new-module.cjs'), 'module.exports = 1;\n'),
      () => fs.chmodSync(path.join(root, 'src/rules.cjs'), 0o755),
      () => fs.writeFileSync(path.join(root, 'policy/rules.md'), 'Accepted policy.\n'),
      () => fs.writeFileSync(path.join(root, 'action.yml'), 'name: Changed\n'),
    ]) {
      const before = semantics.semanticsDigest(root);
      change();
      assert.notEqual(semantics.semanticsDigest(root), before);
    }
    fs.symlinkSync('rules.cjs', path.join(root, 'src/link.cjs'));
    assert.throws(() => semantics.semanticsDigest(root), /symbolic links/);
  } finally {cleanup(root);}
});

test('a statement must be exactly the documented shape', () => {
  const good = {version: 1, current: H('a'), compatible: [H('b'), H('c')]};
  assert.deepEqual(semantics.parseStatement(JSON.stringify(good)), good);
  assert.equal(semantics.render(good), `${JSON.stringify(good, null, 2)}\n`);
  assert.throws(() => semantics.parseStatement('{'), /not JSON/);
  for (const bad of [null, [], 'text', {...good, extra: 1}, {...good, version: 2}, {...good, current: 'abc'},
    {...good, compatible: 'x'}, {...good, compatible: [H('b'), 'abc']}, {...good, compatible: [H('b'), H('b')]},
    {...good, compatible: [H('a')]}, {...good, compatible: Array.from({length: 65}, (_, index) => index.toString(16).padStart(64, '0'))}]) {
    assert.throws(() => semantics.parseStatement(JSON.stringify(bad)), /malformed/);
  }
  const full = Array.from({length: 64}, (_, index) => (index + 1).toString(16).padStart(64, '0'));
  assert.equal(semantics.parseStatement(JSON.stringify({...good, compatible: full})).compatible.length, 64);
});

test('a bump keeps or retires the previous semantics and never lists the current ones', () => {
  const previous = {version: 1, current: H('a'), compatible: [H('b')]};
  assert.equal(semantics.next(previous, H('a'), true), previous);
  assert.deepEqual(semantics.next(previous, H('c'), true), {version: 1, current: H('c'), compatible: [H('a'), H('b')]});
  assert.deepEqual(semantics.next(previous, H('c'), false), {version: 1, current: H('c'), compatible: []});
  // Returning to older semantics removes them from the list instead of listing the current digest.
  assert.deepEqual(semantics.next(previous, H('b'), true), {version: 1, current: H('b'), compatible: [H('a')]});
  const full = Array.from({length: 64}, (_, index) => (index + 1).toString(16).padStart(64, '0'));
  const grown = semantics.next({version: 1, current: H('a'), compatible: full}, H('c'), true);
  assert.equal(grown.compatible.length, 64); assert.equal(grown.compatible[0], H('a')); assert.ok(!grown.compatible.includes(full[63]));
});

test('only a listed digest of the very checkout that was read is accepted, and any doubt refuses', () => {
  const root = engine();
  try {
    const live = semantics.semanticsDigest(root);
    const old = H('1');
    fs.writeFileSync(path.join(root, semantics.STATEMENT), JSON.stringify({version: 1, current: live, compatible: [old]}));
    const accept = semantics.acceptor(root);
    assert.equal(semantics.acceptor(root), accept);
    assert.equal(accept(live), true); assert.equal(accept(old), true);
    assert.equal(accept(H('2')), false); assert.equal(accept('abc'), false); assert.equal(accept(undefined), false);
    assert.equal(accept('A'.repeat(64)), false);
  } finally {cleanup(root);}
  // A statement that describes another tree vouches for nothing, not even its own current digest.
  const stale = engine({version: 1, current: H('9'), compatible: [H('1')]});
  const missing = engine();
  const broken = engine('{');
  try {
    for (const root of [stale, missing, broken]) {
      const accept = semantics.acceptor(root);
      assert.equal(accept(H('1')), false); assert.equal(accept(H('9')), false); assert.equal(accept(semantics.semanticsDigest(root)), false);
    }
  } finally {[stale, missing, broken].forEach(cleanup);}
});

