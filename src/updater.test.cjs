'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');

test('the installed updater rejects a fetched central revision lacking its executable synchronizer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-updater-'));
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: 'pipe'});
  try {
    git(['init', '--initial-branch=main', 'central']);
    fs.writeFileSync(path.join(root, 'central/README.md'), 'Incomplete fetched standard\n');
    git(['-C', 'central', 'add', 'README.md']);
    git(['-C', 'central', '-c', 'user.name=Updater fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    git(['clone', '--bare', 'central', 'origin.git']);
    git(['clone', 'origin.git', 'reference']);
    git(['init', '--initial-branch=main', 'target']);
    const result = spawnSync('bash', [path.join(__dirname, '../.agents/skills/ai-agentic-update/scripts/update'),
      '--repository', path.join(root, 'target'), '--reference-repository', path.join(root, 'reference')], {encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /central source does not contain an executable scripts\/sync/);
    assert.doesNotMatch(result.stdout, /agentic-bootstrap-pending|agentic-updated|agentic-current/);
    assert.equal(fs.existsSync(path.join(root, 'target/AGENTS.md')), false);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});
