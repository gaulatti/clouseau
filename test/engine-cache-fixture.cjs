'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {git} = require('../src/local-git.cjs');
const {engineDigest} = require('../src/local-version.cjs');

const write = (filename, text) => { fs.mkdirSync(path.dirname(filename), {recursive: true}); fs.writeFileSync(filename, text); };

// A cache laid out as scripts/install-agent leaves it: a bare source repository and a detached worktree per revision.
function installedCache(root) {
  const origin = path.join(root, 'origin'); git(root, ['init', '-q', origin]);
  for (const name of ['action.yml', 'src/a.cjs', 'policy/p.md', 'bin/clouseau.cjs', 'skills/clouseau/SKILL.md', 'scripts/s.sh']) write(path.join(origin, name), name);
  git(origin, ['add', '.']); git(origin, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'engine']);
  const sha = git(origin, ['rev-parse', 'HEAD']).trim();
  const cache = path.join(root, 'cache'); git(root, ['clone', '-q', '--bare', origin, path.join(cache, 'source.git')]);
  const checkout = path.join(cache, 'revisions', sha);
  git(cache, ['--git-dir', path.join(cache, 'source.git'), 'worktree', 'add', '-q', '--detach', checkout, sha]);
  return {cache, checkout, pin: {reviewer_sha: sha, reviewer_digest: engineDigest(checkout)}, origin};
}

module.exports = {write, installedCache};
