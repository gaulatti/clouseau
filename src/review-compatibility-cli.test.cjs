'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const semantics = require('./review-semantics.cjs');
const cli = require('./review-compatibility-cli.cjs');

const H = char => char.repeat(64);
const PROTECTED = Object.freeze({GITHUB_REPOSITORY: 'gaulatti/clouseau', GITHUB_REF: 'refs/heads/main'});
const write = (root, file, text) => {fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true}); fs.writeFileSync(path.join(root, file), text);};
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
const cleanup = root => fs.rmSync(root, {recursive: true, force: true});
const run = (root, args, env = {}) => {
  const lines = [];
  const code = cli.main(args, {root, out: text => lines.push(text), env});
  return {code, text: lines.join('')};
};
const statementOf = root => semantics.readStatement(root);
const declarations = root => fs.existsSync(path.join(root, cli.DECLARATIONS)) ? fs.readdirSync(path.join(root, cli.DECLARATIONS)).sort() : [];

// A minimal engine tree whose statement and manifest were folded for exactly its present semantic files, with one
// earlier compatible semantics (H('1')).
function folded(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-declarations-'));
  for (const directory of ['src', 'policy', 'bin', 'skills', 'scripts']) fs.mkdirSync(path.join(root, directory));
  write(root, 'action.yml', 'name: Fictional fixture\n');
  write(root, 'src/review-cost.cjs', 'module.exports = 0;\n');
  for (const [file, text] of Object.entries({'src/a.cjs': 'module.exports = "a";\n', 'src/b.cjs': 'module.exports = "b";\n', ...files})) write(root, file, text);
  const list = semantics.entries(root);
  write(root, cli.MANIFEST, cli.renderManifest(list));
  write(root, semantics.STATEMENT, semantics.render({version: 1, current: semantics.digestOf(list), compatible: [H('1')]}));
  return root;
}

test('a manifest must be exactly the documented shape and renders one entry per line', () => {
  const good = {version: 1, entries: [['a.cjs', 0, H('a')], ['b.cjs', 0o111, H('b')]]};
  assert.deepEqual(cli.parseManifest(JSON.stringify(good)), good);
  assert.deepEqual(cli.parseManifest(cli.renderManifest(good.entries)), good);
  assert.equal(cli.renderManifest(good.entries).split('\n').length, 8);
  assert.deepEqual(cli.parseManifest(cli.renderManifest([])), {version: 1, entries: []});
  // The order is the digest's traversal order, not alphabetical, and must be preserved.
  const unsorted = [['src/x.cjs', 0, H('a')], ['policy/y.md', 0, H('b')]];
  assert.deepEqual(cli.parseManifest(cli.renderManifest(unsorted)).entries, unsorted);
  assert.throws(() => cli.parseManifest('{'), /not JSON/);
  for (const bad of [null, [], {...good, extra: 1}, {...good, version: 2}, {...good, entries: 'x'},
    {...good, entries: [['a.cjs', 0]]}, {...good, entries: [[1, 0, H('a')]]}, {...good, entries: [['a.cjs', 0o200, H('a')]]},
    {...good, entries: [['a.cjs', 1.5, H('a')]]}, {...good, entries: [['a.cjs', 0, 'abc']]},
    {...good, entries: [['a.cjs', 0, H('a')], ['a.cjs', 0, H('a')]]}]) {
    assert.throws(() => cli.parseManifest(JSON.stringify(bad)), /malformed/);
  }
});

test('a declaration must be exactly the documented shape and named by the digest of its content', () => {
  const changes = [{path: 'src/a.cjs', mode: 0, sha256: H('a')}, {path: 'src/gone.cjs', mode: 0, sha256: null}];
  const name = decision => `${cli.declarationId(decision, changes)}.json`;
  const text = JSON.parse(cli.renderDeclaration('compatible', changes));
  assert.deepEqual(cli.parseDeclaration(name('compatible'), cli.renderDeclaration('compatible', changes)),
    {name: name('compatible'), decision: 'compatible', changes});
  assert.notEqual(name('compatible'), name('incompatible'));
  assert.throws(() => cli.parseDeclaration(name('compatible'), '{'), /not JSON/);
  assert.throws(() => cli.parseDeclaration(name('incompatible'), cli.renderDeclaration('compatible', changes)), /named by the digest/);
  for (const bad of [null, [], {...text, extra: 1}, {...text, version: 2}, {...text, decision: 'maybe'}, {...text, changes: 'x'},
    {...text, changes: []}, {...text, changes: [{...changes[0], extra: 1}]}, {...text, changes: [{...changes[0], path: 1}]},
    {...text, changes: [{...changes[0], mode: 0o200}]}, {...text, changes: [{...changes[0], sha256: 'abc'}]},
    {...text, changes: [{...changes[0], mode: 0o111, sha256: null}]}, {...text, changes: [changes[1], changes[0]]},
    {...text, changes: [changes[0], changes[0]]}]) {
    assert.throws(() => cli.parseDeclaration(name('compatible'), JSON.stringify(bad)), /malformed/);
  }
});

test('a change without a declaration fails verify, a declared one passes, and only the protected fold records it', () => {
  const root = folded();
  try {
    let result = run(root, ['verify']);
    assert.equal(result.code, 0); assert.match(result.text, /current/);
    assert.equal(run(root, ['check']).code, 0);
    assert.equal(run(root, ['fold'], PROTECTED).text, 'Nothing to fold: the statement is current\n');
    const before = statementOf(root);

    // An undeclared semantic change fails both verify and check, and names the file and the repair.
    write(root, 'src/a.cjs', 'module.exports = "changed";\n');
    for (const command of ['verify', 'check']) {
      result = run(root, [command]);
      assert.equal(result.code, 1); assert.match(result.text, /Undeclared review-semantics change: src\/a\.cjs.*declare --compatible/);
    }
    assert.equal(run(root, ['fold'], PROTECTED).code, 1);
    assert.deepEqual(statementOf(root), before);
    // A neutral file and a test are not semantic changes.
    write(root, 'src/review-cost.cjs', 'module.exports = 9;\n');
    write(root, 'src/a.test.cjs', 'test');

    // Declaring writes one file named by its own content; declaring again has nothing to add.
    result = run(root, ['declare', '--compatible']);
    assert.equal(result.code, 0); assert.match(result.text, /Declared 1 file\(s\) compatible in compat\/declarations\/[a-f0-9]{64}\.json/);
    assert.equal(declarations(root).length, 1);
    assert.match(run(root, ['declare', '--incompatible']).text, /Nothing to declare/);
    assert.equal(declarations(root).length, 1);
    result = run(root, ['verify']);
    assert.equal(result.code, 0); assert.match(result.text, /1 semantic file\(s\) changed and declared/);
    assert.equal(run(root, ['check']).code, 1);

    // Until the fold, the statement describes another tree, so the engine refuses every claim, including the old ones.
    // (The acceptor caches per directory, so the window is checked on a copy.)
    const copy = `${root}-copy`; fs.cpSync(root, copy, {recursive: true});
    const pending = semantics.acceptor(copy);
    for (const claim of [before.current, H('1'), semantics.semanticsDigest(root)]) assert.equal(pending(claim), false);
    cleanup(copy);

    // The fold refuses anything but protected main and writes nothing then.
    const snapshot = [read(root, semantics.STATEMENT), read(root, cli.MANIFEST), declarations(root).join()];
    for (const env of [{}, {GITHUB_REPOSITORY: 'gaulatti/clouseau', GITHUB_REF: 'refs/heads/feature'},
      {GITHUB_REPOSITORY: 'someone/clouseau', GITHUB_REF: 'refs/heads/main'}, {GITHUB_REPOSITORY: 'gaulatti/clouseau', GITHUB_REF: 'refs/pull/1/merge'}]) {
      result = run(root, ['fold'], env);
      assert.equal(result.code, 1); assert.match(result.text, /only on protected gaulatti\/clouseau refs\/heads\/main/);
    }
    assert.deepEqual([read(root, semantics.STATEMENT), read(root, cli.MANIFEST), declarations(root).join()], snapshot);

    result = run(root, ['fold'], PROTECTED);
    assert.equal(result.code, 0); assert.match(result.text, /Folded 1 semantic file\(s\) compatible; review semantics [a-f0-9]{64}, 2 earlier/);
    const after = statementOf(root);
    assert.deepEqual(after, {version: 1, current: semantics.semanticsDigest(root), compatible: [before.current, H('1')]});
    assert.deepEqual(declarations(root), []);
    assert.equal(run(root, ['check']).code, 0);
    const accepted = semantics.acceptor(root);
    assert.equal(accepted(before.current), true); assert.equal(accepted(H('1')), true); assert.equal(accepted(after.current), true);
    assert.equal(accepted(H('2')), false);

    // Idempotent: a second fold changes nothing, byte for byte.
    const files = [read(root, semantics.STATEMENT), read(root, cli.MANIFEST)];
    assert.equal(run(root, ['fold'], PROTECTED).code, 0);
    assert.deepEqual([read(root, semantics.STATEMENT), read(root, cli.MANIFEST)], files);
  } finally {cleanup(root);}
});

test('an incompatible declaration retires every earlier semantics, alone or mixed with compatible ones', () => {
  for (const second of [null, '--compatible']) {
    const root = folded();
    try {
      const before = statementOf(root);
      write(root, 'src/a.cjs', 'module.exports = "changed";\n');
      assert.equal(run(root, ['declare', '--incompatible']).code, 0);
      if (second) {
        write(root, 'src/b.cjs', 'module.exports = "changed";\n');
        assert.equal(run(root, ['declare', second]).code, 0);
        assert.equal(declarations(root).length, 2);
      }
      assert.equal(run(root, ['verify']).code, 0);
      assert.match(run(root, ['fold'], PROTECTED).text, /incompatible; review semantics [a-f0-9]{64}, 0 earlier/);
      assert.deepEqual(statementOf(root).compatible, []);
      const accept = semantics.acceptor(root);
      assert.equal(accept(before.current), false); assert.equal(accept(H('1')), false);
      assert.equal(accept(semantics.semanticsDigest(root)), true);
    } finally {cleanup(root);}
  }
});

test('added, deleted and re-moded semantic files are declared by content and folded', () => {
  const root = folded();
  try {
    write(root, 'src/new.cjs', 'module.exports = "new";\n');
    fs.rmSync(path.join(root, 'src/b.cjs'));
    fs.chmodSync(path.join(root, 'src/a.cjs'), 0o755);
    assert.equal(run(root, ['declare', '--compatible']).code, 0);
    const [name] = declarations(root);
    const declared = JSON.parse(read(root, `${cli.DECLARATIONS}/${name}`));
    assert.deepEqual(declared.changes.map(change => change.path), ['src/a.cjs', 'src/b.cjs', 'src/new.cjs']);
    assert.deepEqual(declared.changes[1], {path: 'src/b.cjs', mode: 0, sha256: null});
    assert.equal(declared.changes[0].mode, 0o111);
    assert.equal(run(root, ['verify']).code, 0);
    assert.equal(run(root, ['fold'], PROTECTED).code, 0);
    assert.deepEqual(cli.parseManifest(read(root, cli.MANIFEST)).entries.map(entry => entry[0]), ['action.yml', 'src/a.cjs', 'src/new.cjs']);
    assert.equal(run(root, ['check']).code, 0);
  } finally {cleanup(root);}
});

test('every inconsistent declaration or statement fails verify, blocks the fold and is never repaired silently', () => {
  const root = folded();
  try {
    write(root, 'src/a.cjs', 'module.exports = "changed";\n');
    run(root, ['declare', '--compatible']);
    const [name] = declarations(root);
    const original = read(root, `${cli.DECLARATIONS}/${name}`);
    const text = file => fs.existsSync(path.join(root, file)) ? read(root, file) : null;
    const snapshot = () => [text(semantics.STATEMENT), text(cli.MANIFEST), declarations(root).join()];
    const refuse = (pattern, commands = [['verify'], ['check'], ['declare', '--compatible'], ['bump', '--compatible']]) => {
      const before = snapshot();
      for (const args of commands) {
        const result = run(root, args, PROTECTED);
        assert.equal(result.code, 1, args.join(' ')); assert.match(result.text, pattern, args.join(' '));
      }
      assert.equal(run(root, ['fold'], PROTECTED).code, 1);
      assert.match(run(root, ['fold'], PROTECTED).text, /Nothing was folded/);
      assert.deepEqual(snapshot(), before);
    };

    // The file changed again after it was declared (content differs; the mode alone differing is covered below).
    write(root, 'src/a.cjs', 'module.exports = "changed again";\n');
    refuse(/different content than this tree has; delete it and declare again/);
    fs.chmodSync(path.join(root, 'src/a.cjs'), 0o755);
    write(root, 'src/a.cjs', 'module.exports = "changed";\n');
    refuse(/different content than this tree has/);
    fs.chmodSync(path.join(root, 'src/a.cjs'), 0o644);
    assert.equal(run(root, ['verify']).code, 0);

    // The declared file went back to its folded content: the declaration claims a change that is not there.
    write(root, 'src/a.cjs', 'module.exports = "a";\n');
    refuse(/declares src\/a\.cjs, which has not changed since the last fold/);
    write(root, 'src/a.cjs', 'module.exports = "changed";\n');

    // Two declarations for one file, even with identical content and decision under different names.
    const twin = JSON.parse(original); twin.decision = 'incompatible';
    write(root, `${cli.DECLARATIONS}/${cli.declarationId('incompatible', twin.changes)}.json`, `${JSON.stringify(twin, null, 2)}\n`);
    refuse(/src\/a\.cjs is declared by both/);
    fs.rmSync(path.join(root, cli.DECLARATIONS, `${cli.declarationId('incompatible', twin.changes)}.json`));

    // Unknown files, renamed or edited declarations and symbolic links.
    write(root, `${cli.DECLARATIONS}/notes.txt`, 'x');
    refuse(/notes\.txt is not a declaration/);
    fs.rmSync(path.join(root, cli.DECLARATIONS, 'notes.txt'));
    write(root, `${cli.DECLARATIONS}/${name}`, original.replace('compatible', 'incompatible'));
    refuse(/is not named by the digest of its own content/);
    write(root, `${cli.DECLARATIONS}/${name}`, '{');
    refuse(/is not JSON/);
    write(root, `${cli.DECLARATIONS}/${name}`, original);
    fs.symlinkSync(name, path.join(root, cli.DECLARATIONS, 'a'.repeat(64) + '.json'));
    refuse(/is not a declaration/);
    fs.rmSync(path.join(root, cli.DECLARATIONS, 'a'.repeat(64) + '.json'));
    assert.equal(run(root, ['verify']).code, 0);

    // A manifest that does not describe the statement, or an unreadable statement, manifest or tree.
    const manifest = read(root, cli.MANIFEST);
    write(root, cli.MANIFEST, cli.renderManifest(cli.parseManifest(manifest).entries.slice(1)));
    refuse(/does not describe the semantics/);
    write(root, cli.MANIFEST, '{');
    refuse(/not JSON/);
    fs.rmSync(path.join(root, cli.MANIFEST));
    refuse(/ENOENT/);
    write(root, cli.MANIFEST, manifest);
    const statement = read(root, semantics.STATEMENT);
    write(root, semantics.STATEMENT, '{');
    refuse(/not JSON/);
    write(root, semantics.STATEMENT, statement);
    fs.symlinkSync('a.cjs', path.join(root, 'src/link.cjs'));
    refuse(/symbolic links/);
    fs.rmSync(path.join(root, 'src/link.cjs'));
    assert.equal(run(root, ['verify']).code, 0);
    assert.equal(run(root, ['fold'], PROTECTED).code, 0);
  } finally {cleanup(root);}
});

test('the usage is printed for anything that is not a documented command', () => {
  const root = folded();
  try {
    for (const args of [[], ['check', 'x'], ['verify', 'x'], ['declare'], ['declare', '--maybe'], ['declare', '--compatible', 'x'], ['fold', 'x'],
      ['bump'], ['bump', '--maybe'], ['bump', '--compatible', 'x'], ['other']]) {
      const result = run(root, args, PROTECTED);
      assert.equal(result.code, 2, args.join(' ')); assert.match(result.text, /^usage: review-compatibility check/);
    }
  } finally {cleanup(root);}
});

test('bump records a decision by hand: it consumes declarations and keeps statement and manifest together', () => {
  const root = folded();
  try {
    let result = run(root, ['bump', '--incompatible']);
    assert.equal(result.code, 0); assert.match(result.text, /unchanged/);
    write(root, 'src/a.cjs', 'module.exports = "changed";\n');
    run(root, ['declare', '--compatible']);
    result = run(root, ['bump', '--incompatible']);
    assert.equal(result.code, 0); assert.match(result.text, /0 earlier/);
    assert.deepEqual(declarations(root), []);
    assert.deepEqual(statementOf(root).compatible, []);
    assert.equal(run(root, ['check']).code, 0);
    write(root, 'src/b.cjs', 'module.exports = "changed";\n');
    assert.match(run(root, ['bump', '--compatible']).text, /1 earlier/);
    assert.equal(run(root, ['check']).code, 0);
  } finally {cleanup(root);}
});

// ACCEPTANCE. Two pull requests from one base, each changing a different semantic file and declaring it, merge in either
// order with real Git and no conflict, pass verify before the fold and fold to a current statement afterwards.
const git = (root, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
  '-c', 'init.defaultBranch=main', ...args], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

function pullRequests(files) {
  const root = folded(files);
  git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  const pull = (branch, edits, decision) => {
    git(root, 'checkout', '-q', '-b', branch, 'main');
    for (const [file, text] of Object.entries(edits)) write(root, file, text);
    assert.equal(run(root, ['declare', decision]).code, 0);
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', branch); git(root, 'checkout', '-q', 'main');
  };
  return {root, pull};
}

test('two pull requests that change different semantic files merge in either order and both fold cleanly', () => {
  for (const order of [['one', 'two'], ['two', 'one']]) {
    const {root, pull} = pullRequests();
    try {
      const base = statementOf(root);
      pull('one', {'src/a.cjs': 'module.exports = "one";\n'}, '--compatible');
      pull('two', {'src/b.cjs': 'module.exports = "two";\n'}, '--compatible');
      for (const branch of order) {
        git(root, 'merge', '-q', '--no-edit', branch);
        // The merge result of every step passes verify without anyone touching the statement or the manifest.
        assert.equal(run(root, ['verify']).code, 0);
        assert.deepEqual(statementOf(root), base);
      }
      assert.equal(declarations(root).length, 2);
      assert.match(run(root, ['fold'], PROTECTED).text, /Folded 2 semantic file\(s\) compatible/);
      assert.equal(run(root, ['check']).code, 0);
      assert.deepEqual(statementOf(root).compatible, [base.current, H('1')]);
      assert.equal(JSON.parse(read(root, semantics.STATEMENT)).current, semantics.semanticsDigest(root));
      assert.equal(semantics.acceptor(root)(base.current), true);
      // A pull request opened before the fold still merges, because the declaration is the only thing it adds.
      git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'fold');
      pull('three', {'src/c.cjs': 'module.exports = "three";\n'}, '--incompatible');
      git(root, 'merge', '-q', '--no-edit', 'three');
      assert.equal(run(root, ['verify']).code, 0);
      assert.equal(run(root, ['fold'], PROTECTED).code, 0);
      assert.deepEqual(statementOf(root).compatible, []);
    } finally {cleanup(root);}
  }
});

test('the folded result does not depend on the merge order', () => {
  const results = [];
  for (const order of [['one', 'two'], ['two', 'one']]) {
    const {root, pull} = pullRequests();
    try {
      pull('one', {'src/a.cjs': 'module.exports = "one";\n'}, '--compatible');
      pull('two', {'src/b.cjs': 'module.exports = "two";\n'}, '--incompatible');
      for (const branch of order) git(root, 'merge', '-q', '--no-edit', branch);
      assert.equal(run(root, ['fold'], PROTECTED).code, 0);
      results.push([read(root, semantics.STATEMENT).replace(/"current": "[a-f0-9]{64}"/, ''), read(root, cli.MANIFEST)]);
      assert.deepEqual(statementOf(root).compatible, []);
    } finally {cleanup(root);}
  }
  assert.deepEqual(results[0], results[1]);
});

test('two pull requests that edit the same semantic file merge as text but fail closed: neither declaration matches the result', () => {
  const lines = Array.from({length: 12}, (_, index) => `module.exports.v${index} = ${index};\n`).join('');
  const {root, pull} = pullRequests({'src/a.cjs': lines});
  try {
    pull('one', {'src/a.cjs': lines.replace('v0 = 0', 'v0 = 100')}, '--compatible');
    pull('two', {'src/a.cjs': lines.replace('v11 = 11', 'v11 = 111')}, '--incompatible');
    git(root, 'merge', '-q', '--no-edit', 'one');
    assert.equal(run(root, ['verify']).code, 0);
    git(root, 'merge', '-q', '--no-edit', 'two');
    const result = run(root, ['verify']);
    assert.equal(result.code, 1); assert.match(result.text, /src\/a\.cjs is declared by both/);
    assert.match(result.text, /different content than this tree has/);
    const before = read(root, semantics.STATEMENT);
    assert.equal(run(root, ['fold'], PROTECTED).code, 1);
    assert.equal(read(root, semantics.STATEMENT), before);
  } finally {cleanup(root);}
});
