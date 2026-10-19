'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {git} = require('../src/local-git.cjs');

async function repository(run, setup = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-local-git-'));
  try {
    git(directory, ['init', '-q', '-b', 'main']);
    git(directory, ['config', 'user.name', 'Fixture']); git(directory, ['config', 'user.email', 'fixture@example.invalid']);
    git(directory, ['remote', 'add', 'origin', 'https://github.com/example/local-fixture.git']);
    fs.mkdirSync(path.join(directory, 'src'));
    fs.writeFileSync(path.join(directory, 'README.md'), 'Handle an accepted request and reject missing input.\n');
    fs.writeFileSync(path.join(directory, 'AGENTS.md'), 'Preserve purpose and meaningful tests.\n');
    fs.writeFileSync(path.join(directory, '.gitignore'), 'coverage.json\n');
    fs.writeFileSync(path.join(directory, '.clouseau-local.json'), JSON.stringify({version: 1, base_branch: 'main',
      readme: 'README.md', repository_policy: 'AGENTS.md', verification: [['node', '--version']],
      coverage: {format: 'istanbul', report: 'coverage.json', source_directory: 'src'}}));
    fs.writeFileSync(path.join(directory, 'src/handler.js'), 'module.exports = input => Boolean(input);\n');
    setup(directory);
    git(directory, ['add', '.']); git(directory, ['commit', '-qm', 'feat: accept input']);
    const base = git(directory, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(directory, 'src/handler.js'), 'module.exports = input => { if (!input) throw Error("Missing input"); return true; };\n');
    fs.writeFileSync(path.join(directory, 'src/new.js'), 'module.exports = 1;\n');
    git(directory, ['add', '.']); git(directory, ['commit', '-qm', 'fix: reject missing input']);
    return await run({directory, base});
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
}
module.exports = {repository};
