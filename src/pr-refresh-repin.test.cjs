'use strict';
// Refresh's `updated` push (protected local_review.binding: "diff") in a repository that carries compatibility declarations
// (docs/receipt-compatibility.md): a declaration made stale by the merge is re-pinned in the same push when that is the whole
// repair, every other finding refuses before the push, and a repository without the tooling behaves as before.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {git} = require('./local-git.cjs');
const semantics = require('./review-semantics.cjs');
const compat = require('./compat-declarations.cjs');
const cli = require('./review-compatibility-cli.cjs');
const {refreshPull} = require('./pr-refresh.cjs');

const GITHUB = 'git@github.com:example/local-fixture.git';
const FOLD_ENV = {GITHUB_REPOSITORY: 'gaulatti/clouseau', GITHUB_REF: 'refs/heads/main'};
const LONG = Array.from({length: 20}, (_, index) => `const line${index} = ${index};`).join('\n') + '\n';
const edit = (line, value, text = LONG) => text.replace(`line${line} = ${line};`, `line${line} = ${value};`);
const quiet = () => {};
const declare = (root, decision) => assert.equal(cli.main(['declare', `--${decision}`], {root, out: quiet}), 0);
const fold = root => assert.equal(cli.main(['fold'], {root, out: quiet, env: FOLD_ENV}), 0);
const declarations = (directory, revision) => {
  const listed = git(directory, ['ls-tree', '--name-only', `${revision}:compat/declarations`]);
  return listed.trim().split('\n').filter(Boolean);
};

// A pull request fixture as in pr-refresh-binding.test.cjs (a bare "GitHub" origin, a working clone on the feature branch and
// a second clone that moves main), shaped like Clouseau's own repository when `engine` is set: the semantic roots, a folded
// statement and manifest, and no declarations on main. `feature` makes the pull request's commits in the working clone.
async function pullRepository(run, {engine = true, files = {}, feature = () => {}} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-repin-'));
  try {
    const bare = path.join(root, 'origin.git'); git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
    const work = path.join(root, 'work'); fs.mkdirSync(work);
    const commit = (directory, message) => {git(directory, ['add', '--all', '.']); git(directory, ['commit', '-qm', message]);};
    const identify = directory => {git(directory, ['config', 'user.name', 'Fixture']); git(directory, ['config', 'user.email', 'fixture@example.invalid']);};
    git(work, ['init', '-q', '-b', 'main']); identify(work);
    git(work, ['remote', 'add', 'origin', GITHUB]);
    const ssh = path.join(root, 'ssh'); fs.writeFileSync(ssh, `#!/bin/sh\nfor last; do :; done\ncommand=$(printf '%s' "$last" | sed -e 's#^git-#git #' -e "s#example/local-fixture.git#${bare}#")\nexec sh -c "$command"\n`, {mode: 0o755});
    process.env.GIT_SSH_COMMAND = ssh;
    const write = (directory, name, text) => {fs.mkdirSync(path.dirname(path.join(directory, name)), {recursive: true}); fs.writeFileSync(path.join(directory, name), text);};
    write(work, 'README.md', 'Handle an accepted request and reject missing input.\n');
    write(work, 'AGENTS.md', 'Preserve purpose and meaningful tests.\n');
    write(work, '.clouseau-local.json', JSON.stringify({version: 1, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md',
      verification: [['node', '--version']], coverage: {format: 'istanbul', report: 'coverage.json', source_directory: 'src'}}));
    write(work, '.github/clouseau.json', JSON.stringify({local_review: {binding: 'diff'}}));
    write(work, 'src/long.js', LONG);
    write(work, 'src/other.js', LONG);
    if (engine) {
      for (const name of ['action.yml', 'bin/tool', 'skills/skill.md', 'scripts/task', 'policy/rules.md']) write(work, name, `${name}\n`);
      const entries = semantics.entries(work);
      write(work, semantics.STATEMENT, semantics.render({version: 1, current: semantics.digestOf(entries), compatible: []}));
      write(work, compat.MANIFEST, compat.renderManifest(entries));
    }
    for (const [name, text] of Object.entries(files)) write(work, name, text);
    commit(work, 'feat: start'); git(work, ['push', '-q', 'origin', 'main']);
    git(work, ['checkout', '-q', '-b', 'feature']);
    const other = path.join(root, 'other'); git(root, ['clone', '-q', bare, other]); identify(other);
    const f = {root, bare, work, other, commit, write};
    feature(f);
    git(work, ['push', '-q', 'origin', 'feature']);
    f.head = () => git(work, ['rev-parse', 'HEAD']).trim();
    f.remoteHead = () => git(bare, ['rev-parse', 'refs/heads/feature']).trim();
    // An earlier pull request merged into main: `change` edits the clone of main, then it is pushed.
    f.advance = (change, message = 'feat: an earlier pull request') => {
      change(other); commit(other, message); git(other, ['push', '-q', 'origin', 'main']);
      return git(other, ['rev-parse', 'HEAD']).trim();
    };
    f.pull = {number: 7, author: 'fixture-author', state: 'open', base: 'main', head: f.head(), ref: 'feature', repository: 'example/local-fixture', title: 'fix: a change', body: 'Body.\n'};
    f.execute = (program, args) => {
      assert.equal(program, 'gh');
      assert.doesNotMatch(args.join(' '), /PATCH/, 'an `updated` refresh never edits the pull request');
      return JSON.stringify({...f.pull, base_sha: git(bare, ['rev-parse', 'refs/heads/main']).trim(), changed_files: 1});
    };
    return await run(f);
  } finally {delete process.env.GIT_SSH_COMMAND; fs.rmSync(root, {recursive: true, force: true});}
}

// The receipt stands under the diff binding; a review or publication would mean the `updated` path was left.
function runtime(f) {
  const seen = [];
  const never = name => async () => {seen.push(name); throw new Error(`${name} must not run on the updated path`);};
  return {seen, options: {standing: async () => ({applicable: true, usable: true, binding: 'diff'}), installed: () => ({}),
    review: never('review'), publish: never('publish'), execute: f.execute, available: () => true}};
}
const args = f => {
  const filename = path.join(f.root, 'requirement.txt'); fs.writeFileSync(filename, 'Change the early lines.');
  return {pr: '7', directory: f.work, 'request-file': filename, harness: 'claude'};
};

// The pull request changes line 1 of src/long.js and declares it.
const declaredLong = decision => f => {
  f.write(f.work, 'src/long.js', edit(1, 101)); declare(f.work, decision); f.commit(f.work, 'fix: change an early line');
};
// The earlier pull request changes a distant line of the same file, so the normalized diff of the pull request is unchanged.
const earlierLong = (folded = true) => directory => {
  fs.writeFileSync(path.join(directory, 'src/long.js'), edit(18, 118));
  declare(directory, 'compatible');
  if (folded) fold(directory);
};

// A refusal pushes nothing and leaves the merge commit (the pull request head and the base) in the local branch.
async function refused(f, pattern) {
  const before = f.head();
  const remote = f.remoteHead();
  const moved = git(f.bare, ['rev-parse', 'refs/heads/main']).trim();
  const {seen, options} = runtime(f);
  await assert.rejects(refreshPull(args(f), options), error => {
    assert.match(error.message, pattern);
    assert.match(error.message, /Nothing was pushed; the merge commit remains in the local branch/);
    assert.match(error.message, new RegExp(`git reset --hard ${before}`));
    return true;
  });
  assert.equal(f.remoteHead(), remote, 'the pull request branch on GitHub is unchanged');
  assert.deepEqual(git(f.work, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').slice(1), [before, moved], 'the local merge is kept');
  assert.equal(git(f.work, ['status', '--porcelain']), '');
  assert.deepEqual(seen, []);
}

for (const decision of ['compatible', 'incompatible']) {
  test(`a stale ${decision} declaration left by the merge is re-pinned with the same decision in the same push`, async () => {
    await pullRepository(async f => {
      const before = f.head();
      const [stale] = declarations(f.work, 'HEAD');
      const moved = f.advance(earlierLong());
      const {seen, options} = runtime(f);
      const result = await refreshPull(args(f), options);
      assert.equal(result.status, 'updated', JSON.stringify(result));
      assert.equal(result.declaration, 're-pinned');
      assert.equal(result.pushed, true); assert.equal(result.previous_head_sha, before); assert.equal(result.base_sha, moved);
      assert.deepEqual(seen, []);
      assert.equal(f.remoteHead(), f.head()); assert.equal(result.head_sha, f.head());
      assert.equal(git(f.work, ['log', '-1', '--format=%s']).trim(), 'chore(compat): re-pin the compatibility declaration after merging origin/main');
      const [merge] = git(f.work, ['rev-list', '--parents', '-n', '1', 'HEAD~1']).trim().split(' ').slice(1, 2);
      assert.equal(merge, before, 'the re-pin commit follows the merge commit');
      // The pushed head: the stale declaration is gone, one new declaration keeps its decision over the same file, and the
      // repository's own check passes on a fresh clone of it.
      const pinned = declarations(f.bare, 'refs/heads/feature');
      assert.equal(pinned.length, 1); assert.notEqual(pinned[0], stale);
      assert.match(result.note, new RegExp(`the ${decision} compatibility declaration was re-pinned .*${stale} replaced by ${pinned[0]}`));
      const pushed = path.join(f.root, 'pushed'); git(f.root, ['clone', '-q', '-b', 'feature', f.bare, pushed]);
      const parsed = compat.parseDeclaration(pinned[0], fs.readFileSync(path.join(pushed, compat.DECLARATIONS, pinned[0]), 'utf8'));
      assert.equal(parsed.decision, decision);
      assert.deepEqual(parsed.changes.map(change => change.path), ['src/long.js']);
      const state = compat.inspect(pushed);
      assert.deepEqual([state.problems, state.undeclared], [[], []]);
    }, {feature: declaredLong(decision)});
  });
}

test('the base\'s change to a declared file that is not folded yet refuses: nothing is pushed', async () => {
  await pullRepository(async f => {
    f.advance(earlierLong(false));
    await refused(f, /the base's change to a declared file is not folded yet .*src\/long\.js is declared by both/);
  }, {feature: declaredLong('compatible')});
});

test('a stale declaration whose path set differs from the pull request\'s changed semantic paths refuses: nothing is pushed', async () => {
  await pullRepository(async f => {
    f.advance(earlierLong());
    await refused(f, /the declared path set \(src\/long\.js\) differs from the pull request's changed semantic paths \(src\/long\.js, src\/other\.js\)/);
  }, {feature: g => {
    declaredLong('compatible')(g);
    // A second declaration, for another file the merge does not touch: it still verifies, so it is not among the stale ones.
    g.write(g.work, 'src/other.js', edit(1, 201)); declare(g.work, 'compatible'); g.commit(g.work, 'fix: change another file');
  }});
});

test('an undeclared semantic change beside a stale declaration refuses: nothing is pushed', async () => {
  await pullRepository(async f => {
    f.advance(earlierLong());
    await refused(f, /an undeclared semantic change \(src\/other\.js\)/);
  }, {feature: g => {
    declaredLong('compatible')(g);
    g.write(g.work, 'src/other.js', edit(1, 201)); g.commit(g.work, 'fix: change another file without declaring it');
  }});
});

test('stale declarations with mixed decisions refuse: nothing is pushed', async () => {
  await pullRepository(async f => {
    f.advance(directory => {
      fs.writeFileSync(path.join(directory, 'src/long.js'), edit(18, 118));
      fs.writeFileSync(path.join(directory, 'src/other.js'), edit(18, 218));
      declare(directory, 'compatible'); fold(directory);
    });
    await refused(f, /the stale declarations carry mixed decisions \(compatible, incompatible\)/);
  }, {feature: g => {
    declaredLong('compatible')(g);
    g.write(g.work, 'src/other.js', edit(1, 201)); declare(g.work, 'incompatible'); g.commit(g.work, 'fix: change another file');
  }});
});

test('a re-pin that still leaves the check failing pushes nothing and keeps both commits', async () => {
  await pullRepository(async f => {
    const before = f.head();
    const remote = f.remoteHead();
    f.advance(earlierLong());
    const original = compat.declare;
    compat.declare = () => ({problems: [], changes: []});
    try {
      await assert.rejects(refreshPull(args(f), runtime(f).options),
        new RegExp(`left the tree failing its check \\(src/long\\.js\\)\\. Nothing was pushed; the merge and re-pin commits remain .*git reset --hard ${before}`));
    } finally {compat.declare = original;}
    assert.equal(f.remoteHead(), remote);
    assert.equal(git(f.work, ['log', '-1', '--format=%s']).trim(), 'chore(compat): re-pin the compatibility declaration after merging origin/main');
  }, {feature: declaredLong('compatible')});
});

// Today's result for an `updated` push: the merge commit alone, and exactly these fields.
function today(f, result, before, moved) {
  assert.deepEqual(result, {status: 'updated', pull_request: 7, previous_head_sha: before, head_sha: f.head(), base_sha: moved, pushed: true,
    note: 'Merged origin/main into pull request 7 and pushed it. Its local review receipt still covers the unchanged diff (protected binding: diff); nothing was reviewed or published'});
  assert.deepEqual(Object.keys(result), ['status', 'pull_request', 'previous_head_sha', 'head_sha', 'base_sha', 'pushed', 'note']);
  assert.equal(f.remoteHead(), f.head());
  assert.deepEqual(git(f.work, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').slice(1), [before, moved], 'the pushed head is the merge commit');
}

test('a repository without the compatibility tooling is refreshed exactly as before, and its tree is never inspected', async () => {
  // No compat/ at all (a consumer), a manifest without a declarations directory, and a declarations directory without a manifest.
  const shapes = [{}, {'compat/manifest.json': '{}\n'}, {'compat/declarations/notes.txt': 'not a declaration\n'}];
  for (const files of shapes) {
    await pullRepository(async f => {
      const before = f.head();
      const moved = f.advance(directory => fs.writeFileSync(path.join(directory, 'src/long.js'), edit(18, 118)), 'chore: move main');
      const original = compat.inspect;
      compat.inspect = () => {throw new Error('inspected a repository without the tooling');};
      try {today(f, await refreshPull(args(f), runtime(f).options), before, moved);}
      finally {compat.inspect = original;}
    }, {engine: false, files, feature: g => {g.write(g.work, 'src/long.js', edit(1, 101)); g.commit(g.work, 'fix: change an early line');}});
  }
});

test('a merge that leaves every declaration verifying pushes as before, with no re-pin', async () => {
  // A declaration over a file the base did not change, and a pull request with no semantic change (no declarations directory).
  const features = [declaredLong('compatible'), g => {g.write(g.work, 'README.md', 'Changed.\n'); g.commit(g.work, 'docs: change the readme');}];
  for (const feature of features) {
    await pullRepository(async f => {
      const before = f.head();
      const moved = f.advance(directory => {fs.writeFileSync(path.join(directory, 'src/other.js'), edit(18, 218)); declare(directory, 'compatible'); fold(directory);});
      const result = await refreshPull(args(f), runtime(f).options);
      today(f, result, before, moved);
      assert.equal('declaration' in result, false);
    }, {feature});
  }
});
