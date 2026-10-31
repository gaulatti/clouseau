'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const lock = require('../test/fixtures/lockfiles.cjs');
const {summarizeLockfile, lockfileEvidence, isLockfile, compareVersions, classifyUrl, parseToml, LOCKFILES, REASONS, LockfileError,
  lockfileError, MAX_BYTES, MAX_LINES} = require('./lockfile-summary.cjs');

// Failure cases pass one text for both sides; an added or removed file has no base or head text at all.
const summarize = (path, baseText, headText, status = 'modified') => summarizeLockfile({path, status,
  baseText: status === 'added' ? null : baseText, headText: status === 'removed' ? null : headText === '' ? baseText : headText}).content;
const reason = run => { try { run(); } catch (error) { assert.ok(error instanceof LockfileError, String(error)); return error.reason; } throw new Error('expected a LockfileError'); };
const risk = (content, tag) => content.split('\n').filter(item => item.startsWith('RISK[') && item.includes(tag));

test('one table lists every known lockfile and only exact lockfile names are recognized', () => {
  assert.deepEqual(Object.keys(LOCKFILES).sort(), ['Cargo.lock', 'Gemfile.lock', 'Pipfile.lock', 'composer.lock', 'go.sum', 'npm-shrinkwrap.json',
    'package-lock.json', 'pnpm-lock.yaml', 'poetry.lock', 'uv.lock', 'yarn.lock']);
  for (const name of Object.keys(LOCKFILES)) assert.equal(isLockfile(`a/b/${name}`), true);
  for (const name of ['package.json', 'Cargo.toml', 'requirements.txt', 'constructor', 'package-lock.json.bak', 'toString']) assert.equal(isLockfile(name), false);
});

test('npm lockfile: every dependency swap stays visible in the summary', () => {
  const out = summarize('package-lock.json', lock.npmBase(), lock.npmHead());
  assert.match(out, /^## Flagged for review$/m);
  assert.match(risk(out, 'integrity-changed-same-version').join('\n'), /left-pad: version 1\.3\.0 \(unchanged\); integrity fp:[0-9a-f]{12} -> fp:[0-9a-f]{12}/);
  assert.match(risk(out, 'source-changed').join('\n'), /lodash: .*registry:registry\.npmjs\.org -> registry:registry\.example\.invalid/);
  assert.match(risk(out, 'left-registry').join('\n'), /@scope\/util: .*-> git:github\.com\/attacker\/util\.git#0123456789abcdef/);
  assert.match(risk(out, 'integrity-removed').join('\n'), /@scope\/util/);
  assert.match(risk(out, 'install-script-added').join('\n'), /esbuild: .*flags \+\[install-script\]/);
  assert.match(risk(out, 'downgrade').join('\n'), /semver: version 7\.6\.0 -> 7\.5\.0/);
  assert.match(risk(out, 'alias-added').join('\n'), /kleur: .*alias:kleur-fork/);
  assert.match(risk(out, 'non-registry-source').join('\n'), /ADDED cdn-dep@1\.0\.0 source=url:https:\/\/cdn\.example\.invalid\/cdn-dep\.tgz/);
  assert.match(risk(out, 'no-integrity').join('\n'), /ADDED bare-dep@1\.0\.0/);
  assert.match(out, /^REMOVED debug@4\.3\.4 /m);
  assert.match(out, /^ADDED nanoid@5\.0\.0 /m);
  assert.match(out, /^CHANGED tslib: .*flags \+\[\] -\[dev\]/m);
  assert.match(out, /^CHANGED chalk: version 5\.3\.0 -> 5\.4\.0/m);
  // Credentials, query strings and fragments of a URL never reach the reviewers.
  assert.doesNotMatch(out, /secret|token=abc|frag/);
  assert.match(risk(out, 'url-credentials-added').join('\n'), /cdn-dep/);
  assert.match(out, /changes: 3 added, 1 removed, 8 changed; 8 flagged RISK, 3 other added\/removed\/changed, 1 version-only updates/);
  assert.equal(summarize('package-lock.json', lock.npmBase(), lock.npmHead()), out, 'the summary is deterministic');
});

test('pnpm v9 lockfile: swaps, install scripts, git sources and downgrades are visible', () => {
  const out = summarize('pnpm-lock.yaml', lock.pnpmBase(), lock.pnpmHead());
  assert.match(risk(out, 'integrity-changed-same-version').join('\n'), /react: version 18\.3\.1 \(unchanged\)/);
  assert.match(risk(out, 'install-script-added').join('\n'), /esbuild/);
  assert.match(risk(out, 'downgrade').join('\n'), /zod: version 3\.23\.8 -> 3\.22\.0/);
  assert.match(risk(out, 'left-registry').join('\n'), /tiny-dep: .*-> git:https:\/\/github\.com\/attacker\/tiny-dep\.git#0123456789abcdef/);
  assert.match(risk(out, 'source-changed').join('\n'), /@types\/node: .*registry:default -> registry:packages\.example\.invalid/);
  assert.match(out, /^ADDED ms@2\.1\.3 /m);
  assert.match(out, /^CHANGED picocolors: version 1\.0\.1 -> 1\.1\.0/m);
  assert.doesNotMatch(out, /git-dep|local-dep/, 'unchanged git and directory packages are not listed');
  const directory = summarize('pnpm-lock.yaml', '', lock.pnpmBase(), 'added');
  assert.match(directory, /^RISK\[non-registry-source\] ADDED local-dep@file:\.\.\/local-dep source=file:\.\.\/local-dep /m);
});

test('uv.lock: artifact hosts, hashes and git sources are visible', () => {
  const out = summarize('uv.lock', lock.uvBase(), lock.uvHead());
  assert.match(risk(out, 'integrity-changed-same-version').join('\n'), /requests: version 2\.31\.0 \(unchanged\)/);
  assert.match(risk(out, 'source-changed').join('\n'), /urllib3: .*artifacts=files\.pythonhosted\.org -> registry:pypi\.org\/simple; artifacts=files\.pythonhosted\.org,mirror\.example\.invalid/);
  assert.match(risk(out, 'left-registry').join('\n'), /idna: .*-> git:https:\/\/github\.com\/attacker\/idna/);
  assert.match(risk(out, 'downgrade').join('\n'), /certifi: version 2024\.2\.2 -> 2023\.7\.22/);
  assert.match(out, /^ADDED rich@13\.7\.1 source=registry:pypi\.org\/simple; artifacts=files\.pythonhosted\.org /m);
  assert.match(out, /^CHANGED charset-normalizer: version 3\.3\.2 -> 3\.4\.0/m);
  assert.doesNotMatch(out, /fictional-app/);
});

test('a newly added or deleted lockfile is summarized completely', () => {
  const added = summarizeLockfile({path: 'package-lock.json', status: 'added', baseText: null, headText: lock.npmBase()});
  assert.match(added.content, /^base: absent$/m);
  assert.equal((added.content.match(/^ADDED /gm) || []).length, 9);
  assert.equal(added.derived.base_sha256, null); assert.equal(added.derived.base_path, null);
  const removed = summarizeLockfile({path: 'package-lock.json', status: 'removed', baseText: lock.npmBase(), headText: null});
  assert.match(removed.content, /^head: absent$/m);
  assert.equal((removed.content.match(/^REMOVED /gm) || []).length, 9);
  assert.equal(removed.derived.head_sha256, null);
});

test('a hoisting move with identical content is not a change; a rename keeps the previous format', () => {
  const a = lock.npmLock([{name: 'a', version: '1.0.0'}]).replace('"node_modules/a"', '"node_modules/x/node_modules/a"');
  const out = summarize('package-lock.json', a, lock.npmLock([{name: 'a', version: '1.0.0'}]));
  assert.match(out, /changes: 0 added, 0 removed, 0 changed/);
  assert.equal(summarizeLockfile({path: 'sub/package-lock.json', previousPath: 'package-lock.json', status: 'renamed', baseText: a, headText: a}).derived.base_path, 'package-lock.json');
  assert.equal(reason(() => summarizeLockfile({path: 'yarn.lock', previousPath: 'package-lock.json', status: 'renamed', baseText: a, headText: a})), 'format_mismatch');
  assert.equal(reason(() => summarizeLockfile({path: 'notes.txt', status: 'modified', baseText: 'a', headText: 'b'})), 'format_mismatch');
});

test('unsummarizable lockfiles fail closed with a fixed specific reason', () => {
  const npm = (text, status = 'modified') => () => summarize('package-lock.json', text, text, status);
  assert.equal(reason(npm('x'.repeat(MAX_BYTES + 1))), 'too_large');
  assert.equal(reason(npm('{"a":\0}')), 'not_text');
  assert.equal(reason(npm('{not json')), 'invalid_syntax');
  assert.equal(reason(npm('[]')), 'invalid_structure');
  assert.equal(reason(npm('{"lockfileVersion":1,"dependencies":{}}')), 'unsupported_version');
  assert.equal(reason(npm('{"lockfileVersion":3}')), 'invalid_structure');
  assert.equal(reason(npm('{"lockfileVersion":3,"packages":{"node_modules/a":1}}')), 'invalid_structure');
  assert.equal(reason(npm('{"lockfileVersion":3,"packages":{"node_modules/a":{"version":1}}}')), 'invalid_structure');
  for (const key of Object.keys(REASONS)) assert.ok(REASONS[key]);
  const error = lockfileError('a/package-lock.json', 'too_large');
  assert.deepEqual(error.lockfile, {path: 'a/package-lock.json', reason: 'too_large'});
  assert.match(error.message, /a\/package-lock\.json cannot be summarized \(its text is larger than 1000000 bytes\)/);
});

test('flagged and added or removed packages are never truncated: too many fails closed, version updates carry an explicit count', () => {
  const many = count => lock.npmLock(Array.from({length: count}, (_, i) => ({name: `p${i}`, version: '1.0.0'})));
  assert.equal(reason(() => summarize('package-lock.json', many(1), many(MAX_LINES + 10))), 'too_many_changes');
  const bump = (count, version) => lock.npmLock(Array.from({length: count}, (_, i) => ({name: `p${i}`, version})));
  const out = summarize('package-lock.json', bump(MAX_LINES + 50, '1.0.0'), bump(MAX_LINES + 50, '1.0.1'));
  const listed = (out.match(/^CHANGED /gm) || []).length;
  assert.ok(listed > 0 && listed < MAX_LINES + 50);
  assert.match(out, new RegExp(`^\\.\\.\\. ${MAX_LINES + 50 - listed} more version-only updates not listed here`, 'm'));
  assert.match(out, new RegExp(`${MAX_LINES + 50} changed; 0 flagged RISK, 0 other added/removed/changed, ${MAX_LINES + 50} version-only updates`));
  // The character bound applies too.
  const long = count => lock.npmLock(Array.from({length: count}, (_, i) => ({name: `${'n'.repeat(100)}${i}`, version: '1.0.0'})));
  assert.equal(reason(() => summarize('package-lock.json', long(1), long(1500))), 'too_many_changes');
  const wide = (count, version) => lock.npmLock(Array.from({length: count}, (_, i) => ({name: `${'n'.repeat(60)}${i}`, version})));
  const capped = summarize('package-lock.json', wide(2000, '1.0.0'), wide(2000, '1.0.1'));
  assert.match(capped, /more version-only updates not listed here/);
});

test('composer.lock and Pipfile.lock expose sources, hashes and dev scope', () => {
  const composer = (version, dist, extra = {}) => JSON.stringify({packages: [{name: 'vendor/pkg', version,
    source: {type: 'git', url: 'https://github.com/vendor/pkg.git', reference: 'a'.repeat(40)},
    dist: {type: 'zip', url: dist, reference: 'a'.repeat(40), shasum: ''}, ...extra}],
  'packages-dev': [{name: 'vendor/dev', version: '1.0.0', source: {type: 'git', url: 'https://github.com/vendor/dev.git', reference: 'b'.repeat(40)}}]});
  const out = summarize('composer.lock', composer('1.0.0', 'https://api.github.com/repos/vendor/pkg/zipball/a'), composer('1.0.0', 'https://evil.example.invalid/pkg.zip'));
  assert.match(risk(out, 'source-changed').join('\n'), /vendor\/pkg: .*dist=url:https:\/\/api\.github\.com.* -> dist=url:https:\/\/evil\.example\.invalid\/pkg\.zip/);
  assert.equal(reason(() => summarize('composer.lock', '{"packages":{}}', '{}')), 'invalid_structure');
  assert.equal(reason(() => summarize('composer.lock', '{"packages":[],"packages-dev":1}', '{}')), 'invalid_structure');
  assert.equal(reason(() => summarize('composer.lock', '{"packages":[{"name":"a","version":"1"}]}', '{}')), 'invalid_structure');
  const pipenv = (version, extra = {}) => JSON.stringify({_meta: {sources: [{name: 'pypi', url: 'https://pypi.org/simple'}, 'bad']},
    default: {requests: {version: `==${version}`, hashes: ['sha256:b', 'sha256:a'], index: 'pypi', ...extra}, tool: {git: 'https://github.com/x/tool.git', ref: 'abc', editable: true},
      local: {path: '../local'}, odd: {file: 'file:///x.whl', hashes: 'none'}}, develop: {pytest: {version: '==8.0.0', index: 'private'}, bare: {}}});
  const swapped = summarize('Pipfile.lock', pipenv('2.31.0'), pipenv('2.31.0', {hashes: ['sha256:c']}));
  assert.match(risk(swapped, 'integrity-changed-same-version').join('\n'), /requests/);
  const moved = summarize('Pipfile.lock', pipenv('2.31.0'), pipenv('2.31.0', {index: 'evil', git: 'https://github.com/x/requests.git', ref: 'abc'}));
  assert.match(risk(moved, 'left-registry').join('\n'), /requests: .*index:pypi\.org -> git:https:\/\/github\.com\/x\/requests\.git#abc/);
  assert.match(summarize('Pipfile.lock', '{"_meta":{},"default":{}}', pipenv('1.0.0'), 'modified'), /ADDED pytest@8\.0\.0 source=index:private integrity=none flags=dev/);
  assert.equal(reason(() => summarize('Pipfile.lock', '{}', '{}')), 'invalid_structure');
  assert.equal(reason(() => summarize('Pipfile.lock', '{"_meta":{},"default":{},"develop":[]}', '{}')), 'invalid_structure');
  assert.equal(reason(() => summarize('Pipfile.lock', '{"_meta":{},"default":{"a":1}}', '{}')), 'invalid_structure');
});

const YARN_V1 = (version, resolved, extra = '') => `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n"@babel/core@^7.0.0", "@babel/core@^7.1.0":\n  version "${version}"\n  resolved "${resolved}"\n  integrity sha512-abc${extra}\n  dependencies:\n    "@babel/code-frame" "^7.0.0"\n`;
const YARN_BERRY = (version, resolution, checksum) => `# This file is generated by running "yarn install"\n\n__metadata:\n  version: 6\n  cacheKey: 8\n\n"lodash@npm:^4.17.21":\n  version: ${version}\n  resolution: "${resolution}"\n  checksum: ${checksum}\n  languageName: node\n  linkType: hard\n\n"app@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "app@workspace:."\n  languageName: unknown\n  linkType: soft\n`;

test('yarn classic and berry lockfiles', () => {
  const classic = summarize('yarn.lock', YARN_V1('7.0.0', 'https://registry.yarnpkg.com/@babel/core/-/core-7.0.0.tgz#abc'),
    YARN_V1('7.0.0', 'https://registry.example.invalid/@babel/core/-/core-7.0.0.tgz#abc', 'x'));
  assert.match(risk(classic, 'source-changed').join('\n'), /@babel\/core: .*registry:registry\.yarnpkg\.com -> registry:registry\.example\.invalid/);
  assert.match(risk(classic, 'integrity-changed-same-version').join('\n'), /@babel\/core/);
  const berry = summarize('yarn.lock', YARN_BERRY('4.17.21', 'lodash@npm:4.17.21', 'aaa'), YARN_BERRY('4.17.21', 'lodash@https://evil.example.invalid/lodash.tgz', 'bbb'));
  assert.match(risk(berry, 'left-registry').join('\n'), /lodash: .*registry:npm -> other:https:\/\/evil\.example\.invalid\/lodash\.tgz/);
  const scoped = '__metadata:\n  version: 6\n\n"@scope/pkg@npm:^1.0.0, @scope/pkg@npm:^1.1.0":\n  version: 1.1.0\n  resolution: "@scope/pkg@npm:1.1.0"\n  checksum: abc\n';
  assert.match(summarize('yarn.lock', '', scoped, 'added'), /^ADDED @scope\/pkg@1\.1\.0 source=registry:npm /m);
  assert.match(summarize('yarn.lock', '', YARN_BERRY('4.17.21', 'lodash@npm:4.17.21', 'aaa'), 'added'), /ADDED app@0\.0\.0-use\.local source=workspace/);
  assert.equal(reason(() => summarize('yarn.lock', 'nothing', 'nothing')), 'unsupported_version');
  assert.equal(reason(() => summarize('yarn.lock', '# yarn lockfile v1\n\nbroken:\n  resolved "x"\n', '')), 'invalid_structure');
  assert.equal(reason(() => summarize('yarn.lock', '# yarn lockfile v1\n\nfoo@^1:\n  version "1.0.0"\n', '')), 'invalid_structure');
  assert.equal(reason(() => summarize('yarn.lock', '__metadata:\n  version: 6\n\n"x@npm:1":\n  version: 1.0.0\n', '')), 'invalid_structure');
});

const PNPM_BASE = lock.pnpmLock([{key: 'a@1.0.0', resolution: '{integrity: sha512-x}'}]);

test('pnpm parser failures are specific', () => {
  assert.equal(reason(() => summarize('pnpm-lock.yaml', 'packages:\n', '')), 'invalid_structure');
  assert.equal(reason(() => summarize('pnpm-lock.yaml', "lockfileVersion: '5.4'\n", '')), 'unsupported_version');
  assert.equal(reason(() => summarize('pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages:\n  a@1.0.0: x\n", '')), 'invalid_syntax');
  assert.equal(reason(() => summarize('pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages:\n\ta@1.0.0:\n", '')), 'invalid_syntax');
  assert.equal(reason(() => summarize('pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages:\n  a@1.0.0:\n    resolution: integrity\n", '')), 'invalid_syntax');
  assert.equal(reason(() => summarize('pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages:\n  a@1.0.0:\n    resolution: {integrity x}\n", '')), 'invalid_syntax');
  assert.equal(reason(() => summarize('pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages:\n  nover:\n    resolution: {integrity: x}\n", '')), 'invalid_structure');
  assert.equal(reason(() => summarize('pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages:\n  a@1.0.0:\n    engines: {node: 1}\n", '')), 'invalid_syntax');
  const v6 = "lockfileVersion: '6.0'\r\n\r\npackages:\r\n\r\n  /a@1.0.0(b@2.0.0):\r\n    resolution: {integrity: sha512-x, tarball: 'https://user:pw@x.example.invalid/a.tgz'}\r\n    dev: true\r\n    requiresBuild: true\r\n    optional: true\r\n    note\r\n\r\n    deeper:\r\n      x: 1\r\n";
  const out = summarize('pnpm-lock.yaml', '', v6, 'added');
  assert.match(out, /ADDED a@1\.0\.0 source=url:https:\/\/x\.example\.invalid\/a\.tgz .*flags=dev,install-script,optional,url-credentials/);
  assert.doesNotMatch(out, /pw/);
  assert.match(summarize('pnpm-lock.yaml', '', "lockfileVersion: '9.0'\nimporters: {}\n", 'added'), /0 entries/);
  assert.match(summarize('pnpm-lock.yaml', '', "lockfileVersion: '9.0'\npackages:\n  a@1.0.0:\n    resolution: {}\n    peerDependencies:\n  ,\n".replace('  ,\n', ''), 'added'), /ADDED a@1\.0\.0 source=registry:default integrity=none/);
  assert.match(summarize('pnpm-lock.yaml', '', "lockfileVersion: '9.0'\npackages:\n  a@1.0.0:\n    resolution: {integrity: x,, commit: abc}\n", 'added'), /ADDED a@1\.0\.0 source=git:#abc/);
});

const POETRY = (version, hash, source = '') => `# This file is automatically @generated by Poetry 1.8.2 and should not be changed by hand.\n\n[[package]]\nname = "requests"\nversion = "${version}"\ndescription = "HTTP library"\noptional = true\npython-versions = ">=3.7"\nfiles = [\n    {file = "requests-${version}-py3-none-any.whl", hash = "${hash}"},\n    {file = "requests-${version}.tar.gz", hash = "${hash}b"},\n]\n${source}\n[package.dependencies]\nidna = ">=2.5,<4"\n\n[package.extras]\nsocks = ["PySocks (>=1.5.6,!=1.5.7)"]\n\n[metadata]\nlock-version = "2.0"\npython-versions = "^3.11"\ncontent-hash = "abc"\n`;

test('poetry.lock: registry, git and index sources and hashes', () => {
  const git = '\n[package.source]\ntype = "git"\nurl = "https://github.com/x/requests.git"\nreference = "main"\nresolved_reference = "0123456789abcdef"\n';
  const legacy = '\n[package.source]\ntype = "legacy"\nurl = "https://private.example.invalid/simple/"\nreference = "private"\n';
  const out = summarize('poetry.lock', POETRY('2.31.0', 'sha256:aa'), POETRY('2.31.0', 'sha256:bb', git));
  assert.match(risk(out, 'left-registry').join('\n'), /requests: .*registry:pypi -> git:https:\/\/github\.com\/x\/requests\.git#0123456789abcdef/);
  assert.match(risk(out, 'integrity-changed-same-version').join('\n'), /requests/);
  assert.match(summarize('poetry.lock', '', POETRY('2.31.0', 'sha256:aa', legacy), 'added'), /ADDED requests@2\.31\.0 source=index:private\.example\.invalid\/simple .*flags=optional/);
  assert.equal(reason(() => summarize('poetry.lock', '[[package]]\nname = "a"\n', '')), 'unsupported_version');
  assert.equal(reason(() => summarize('poetry.lock', '[metadata]\nlock-version = "1.1"\n[metadata.files]\na = []\n', '')), 'unsupported_version');
  assert.equal(reason(() => summarize('poetry.lock', '[metadata]\nlock-version = 2\n', '')), 'unsupported_version');
  assert.equal(reason(() => summarize('poetry.lock', '[metadata]\nlock-version = "2.0"\n[[package]]\nname = "a"\n', '')), 'invalid_structure');
  assert.equal(reason(() => summarize('poetry.lock', '[metadata]\nlock-version = "2.0"\n[[package]]\nname = "a"\nversion = "1"\nsource = 1\n', '')), 'invalid_structure');
  assert.match(summarize('poetry.lock', '', '[metadata]\nlock-version = "2.0"\n[[package]]\nname = "a"\nversion = "1"\nfiles = "none"\n', 'added'), /ADDED a@1 source=registry:pypi integrity=none/);
});

const CARGO = (version, checksum, source = '"registry+https://github.com/rust-lang/crates.io-index"') => `# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 3\n\n[[package]]\nname = "serde"\nversion = "${version}"\nsource = ${source}\nchecksum = "${checksum}"\ndependencies = [\n "serde_derive",\n]\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "serde",\n]\n`;

test('Cargo.lock: registry, sparse, git and path packages', () => {
  const out = summarize('Cargo.lock', CARGO('1.0.197', 'aa'), CARGO('1.0.197', 'bb', '"git+https://github.com/attacker/serde?branch=main#0123456789abcdef"'));
  assert.match(risk(out, 'left-registry').join('\n'), /serde: .*registry:github\.com\/rust-lang\/crates\.io-index -> git:github\.com\/attacker\/serde#0123456789abcdef/);
  assert.match(summarize('Cargo.lock', '', CARGO('1.0.0', 'aa', '"sparse+https://index.crates.io/"'), 'added'), /ADDED serde@1\.0\.0 source=registry:index\.crates\.io /);
  assert.match(summarize('Cargo.lock', '', CARGO('1.0.0', 'aa', '"git+https://user:pw@example.invalid/x.git#abc"'), 'added'), /flags=url-credentials/);
  assert.match(summarize('Cargo.lock', '', CARGO('1.0.0', 'aa'), 'added'), /ADDED app@0\.1\.0 source=path /);
  assert.equal(reason(() => summarize('Cargo.lock', '[[package]]\nname = "a"\n', '')), 'unsupported_version');
  assert.equal(reason(() => summarize('Cargo.lock', 'version = 3\n[[package]]\nname = "a"\n', '')), 'invalid_structure');
  assert.equal(reason(() => summarize('Cargo.lock', 'version = 3\n[[package]]\nname = "a"\nversion = "1"\nsource = "registry+nope"\n', '')), 'invalid_structure');
  assert.equal(reason(() => summarize('Cargo.lock', 'version = 3\npackage = 1\n', '')), 'invalid_structure');
  assert.match(summarize('Cargo.lock', '', 'version = 4\n', 'added'), /0 entries/);
  const clash = 'version = 3\n[[package]]\nname = "a"\nversion = "1"\nchecksum = "x"\n[[package]]\nname = "a"\nversion = "1"\nchecksum = "y"\n';
  assert.equal(reason(() => summarize('Cargo.lock', clash, '')), 'invalid_structure');
  const twin = 'version = 3\n[[package]]\nname = "a"\nversion = "1"\n[[package]]\nname = "a"\nversion = "1"\n';
  assert.match(summarize('Cargo.lock', '', twin, 'added'), /1 entries/);
});

test('uv.lock parser failures are specific', () => {
  assert.equal(reason(() => summarize('uv.lock', 'requires-python = ">=3"', '')), 'unsupported_version');
  assert.equal(reason(() => summarize('uv.lock', 'version = 1\n[[package]]\nname = "a"\nversion = "1"\n', '')), 'invalid_structure');
  assert.equal(reason(() => summarize('uv.lock', 'version = 1\n[[package]]\nname = "a"\nversion = 1\nsource = {registry = "https://x.example/simple"}\n', '')), 'invalid_structure');
  assert.equal(reason(() => summarize('uv.lock', 'version = 1\n[[package]]\nname = "a"\nversion = "1"\nsource = {registry = "nope"}\n', '')), 'invalid_structure');
  assert.match(summarize('uv.lock', '', 'version = 1\n[[package]]\nname = "a"\nsource = {virtual = "."}\nwheels = [{hash = 1}]\nsdist = {url = "nohost"}\n', 'added'), /ADDED a@- source=virtual:\. ; ?artifacts=nohost|ADDED a@- source=virtual:\.; artifacts=nohost/);
});

const GEMFILE = (version, extra = '', remote = 'https://rubygems.org/') => `GIT\n  remote: https://github.com/example/rails.git\n  revision: ${'a'.repeat(40)}\n  specs:\n    railties (7.1.0)\n\nPATH\n  remote: .\n  specs:\n    app (0.1.0)\n\nGEM\n  remote: ${remote}\n  specs:\n    rack (${version})\n      nio4r (~> 2.0)\n    puma (6.4.0)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  rack\n${extra}\nBUNDLED WITH\n   2.5.6\n`;

test('Gemfile.lock: sources, git revisions and checksums', () => {
  const sums = hash => `\nCHECKSUMS\n  rack (2.2.8) sha256=${hash}\n`;
  const out = summarize('Gemfile.lock', GEMFILE('2.2.8', sums('aa')), GEMFILE('2.2.8', sums('bb'), 'https://gems.example.invalid/'));
  assert.match(risk(out, 'integrity-changed-same-version').join('\n'), /rack: version 2\.2\.8 \(unchanged\)/);
  assert.match(risk(out, 'source-changed').join('\n'), /rack: .*registry:rubygems\.org -> registry:gems\.example\.invalid/);
  assert.match(summarize('Gemfile.lock', '', GEMFILE('2.2.8'), 'added'), /ADDED railties@7\.1\.0 source=git:https:\/\/github\.com\/example\/rails\.git#a{40}/);
  assert.match(summarize('Gemfile.lock', '', GEMFILE('2.2.8'), 'added'), /ADDED app@0\.1\.0 source=file:\. /);
  assert.equal(reason(() => summarize('Gemfile.lock', 'nothing here', '')), 'invalid_structure');
  assert.equal(reason(() => summarize('Gemfile.lock', 'CHECKSUMS\n  broken\n', '')), 'invalid_syntax');
  assert.match(summarize('Gemfile.lock', '', 'DEPENDENCIES\n  rack\n', 'added'), /0 entries/);
});

test('go.sum: module hashes and go.mod hashes', () => {
  const sum = (hash, version = 'v1.2.0') => `example.com/mod ${version} h1:${hash}=\nexample.com/mod ${version}/go.mod h1:${hash}x=\n\n`;
  const out = summarize('go.sum', sum('aa'), sum('bb'));
  assert.match(risk(out, 'integrity-changed-same-version').join('\n'), /example\.com\/mod: version v1\.2\.0 \(unchanged\)/);
  assert.match(risk(out, 'integrity-changed-same-version').join('\n'), /example\.com\/mod \(go\.mod\)/);
  const bump = summarize('go.sum', sum('aa'), sum('aa', 'v1.3.0'));
  assert.match(bump, /^CHANGED example\.com\/mod: version v1\.2\.0 -> v1\.3\.0/m);
  assert.equal(reason(() => summarize('go.sum', 'broken line', '')), 'invalid_syntax');
  assert.equal(reason(() => summarize('go.sum', 'a v1 h1:x=\na v1 h1:y=\n', '')), 'invalid_structure');
});

test('version comparison orders releases and pre-releases and refuses non-versions', () => {
  const order = [['1.0.0', '1.0.1', -1], ['2.0.0', '10.0.0', -1], ['1.0.0', '1.0.0', 0], ['1.0.0-beta', '1.0.0', -1], ['1.0.0', '1.0.0-beta', 1],
    ['1.0', '1.0.1', -1], ['1.0.1', '1.0', 1], ['v1.2.0', '1.2.1', -1], ['1.0.0-alpha', '1.0.0-beta', -1], ['1.0.0-beta', '1.0.0-alpha', 1],
    ['2.32.0rc1', '2.32.0', -1], ['2.32.0', '2.32.0rc1', 1], ['1.0.post1', '1.0', 1], ['1.0', '1.0.post1', -1], ['2.32.0rc2', '2.32.0rc1', 1]];
  for (const [a, b, expected] of order) assert.equal(compareVersions(a, b), expected, `${a} ${b}`);
  assert.equal(compareVersions('abc', '1.0.0'), null);
  assert.equal(compareVersions('1.0.0', 'abc'), null);
});

test('URL classification hides credentials, queries and fragments and distinguishes registries from other hosts', () => {
  assert.deepEqual(classifyUrl('https://registry.npmjs.org/a/-/a-1.0.0.tgz', 'a', '1.0.0'), {source: 'registry:registry.npmjs.org', credentials: false});
  assert.deepEqual(classifyUrl('https://registry.npmjs.org/@s/a/-/a-1.0.0.tgz', '@s/a', '1.0.0'), {source: 'registry:registry.npmjs.org', credentials: false});
  assert.equal(classifyUrl('http://registry.example.invalid/a/-/a-1.0.0.tgz', 'a', '1.0.0').source, 'registry-http:registry.example.invalid');
  assert.equal(classifyUrl('https://registry.npmjs.org/evil/-/evil-1.0.0.tgz', 'a', '1.0.0').source, 'url:https://registry.npmjs.org/evil/-/evil-1.0.0.tgz');
  assert.deepEqual(classifyUrl('https://u:p@h.example/x.tgz?q=1#f', 'a', '1'), {source: 'url:https://h.example/x.tgz', credentials: true});
  assert.equal(classifyUrl('ssh://git@github.com/x/y.git#abc', 'y', '1').credentials, false);
  assert.equal(classifyUrl('git+https://github.com/x/y.git#abc', 'y', '1').source, 'git:github.com/x/y.git#abc');
  assert.equal(classifyUrl('git://github.com/x/y.git#abc', 'y', '1').source, 'git:github.com/x/y.git#abc');
  assert.equal(classifyUrl('file:../local', 'y', '1').source, 'file:../local');
  assert.equal(classifyUrl('link:../local', 'y', '1').source, 'file:../local');
  assert.equal(classifyUrl('ftp://h.example/x', 'y', '1').source, 'other:ftp://h.example/x');
  assert.equal(classifyUrl('not a url', 'y', '1').source, 'other:not a url');
});

test('long and non-printable values are shown bounded and fingerprinted', () => {
  const long = (suffix) => `https://${'h'.repeat(200)}.example/${suffix}`;
  const a = lock.npmLock([{name: 'a', version: '1.0.0', resolved: long('one')}]);
  const b = lock.npmLock([{name: 'a', version: '1.0.0', resolved: long('two')}]);
  const out = summarize('package-lock.json', a, b);
  const line = out.split('\n').find(item => item.startsWith('RISK[source-changed'));
  assert.match(line, /\.\.\.\[fp:[0-9a-f]{8}\]/);
  assert.ok(line.length < 500);
  const odd = lock.npmLock([{name: 'a', version: '1.0.0', resolved: '../café', extra: {link: true}}]);
  assert.match(summarize('package-lock.json', '', odd, 'added'), /source=file:\.\.\/caf\? /);
});

test('lockfileEvidence derives a bound, immutable, citable source item', () => {
  const sha = 'a'.repeat(40); const base = 'b'.repeat(40);
  const file = {filename: 'web/package-lock.json', status: 'modified'};
  const evidence = lockfileEvidence({file, baseSha: base, headSha: sha, baseText: lock.npmBase(), headText: lock.npmHead()});
  assert.match(evidence.id, /^lockfile-summary:[0-9a-f]{16}:[0-9a-f]{16}:web\/package-lock\.json$/);
  assert.equal(evidence.source.authority, 'derived'); assert.equal(evidence.source.kind, 'lockfile-summary');
  assert.equal(evidence.source.ref, sha); assert.equal(evidence.source.path, 'web/package-lock.json');
  assert.equal(evidence.source.derived.algorithm, 'lockfile-summary-v1');
  const removed = lockfileEvidence({file: {...file, status: 'removed'}, baseSha: base, headSha: sha, baseText: lock.npmBase(), headText: null});
  assert.equal(removed.source.ref, base); assert.match(removed.id, /:none:/);
  assert.match(lockfileEvidence({file: {...file, status: 'added'}, baseSha: base, headSha: sha, baseText: null, headText: lock.npmBase()}).id, /^lockfile-summary:none:/);
});

test('the TOML subset accepts lockfile syntax and refuses everything else', () => {
  const ok = parseToml('a = 1\nb = "x\\ty" # comment with "quote\nc = \'lit#eral\'\nd = [\n  "x", # one\n  { u = "y", v = [1, 2.5e1, true, false] },\n]\ne = { }\n[t]\nk = "v"\n[[t.list]]\nn = 1\n[[t.list]]\nn = 2\n[t.sub]\nq = 1_000\n"quoted key" = 3\n');
  assert.equal(ok.a, 1); assert.equal(ok.b, 'x\ty'); assert.equal(ok.c, 'lit#eral'); assert.deepEqual(ok.d[1].v, [1, 25, true, false]);
  assert.equal(ok.t.list.length, 2); assert.equal(ok.t.sub.q, 1000); assert.equal(ok.t.sub['quoted key'], 3);
  for (const text of ['a', 'a =', 'a = ', 'a = "x', 'a = \'x', 'a = """x"""', "a = '''x'''", 'a = nope', 'a = 1 2', 'a = [1 2]', 'a = [1,', 'a = {', 'a = { b }',
    'a = { b = 1 c = 2 }', 'a = { b = 1, b = 2 }', 'a = 1\na = 2', '[', '[a.b', '[[a]', '[a b]', 'a.b = 1', '"\\q" = 1', 'a = "\\q"', '[t]\n[[t]]', 'x = 1\n[x]', 'x = [1]\n[x.y]\n', '= 1']) {
    assert.equal(reason(() => parseToml(text)), 'invalid_syntax', text);
  }
});

test('workspace members, links and repeated package names are listed deterministically', () => {
  const doc = packages => `${JSON.stringify({lockfileVersion: 3, packages: {'': {}, ...packages}})}\n`;
  const workspace = doc({'packages/app': {version: '1.0.0'}, 'node_modules/app': {resolved: 'packages/app', link: true}});
  const out = summarize('package-lock.json', doc({}), workspace, 'modified');
  assert.match(out, /RISK\[non-registry-source\] ADDED app@- source=file:packages\/app /);
  assert.match(out, /RISK\[non-registry-source\] ADDED packages\/app@1\.0\.0 source=local /);
  const entry = version => ({version, resolved: `https://registry.npmjs.org/a/-/a-${version}.tgz`, integrity: `sha512-${version}`});
  const multi = summarize('package-lock.json', doc({'node_modules/a': entry('1.0.0')}),
    doc({'node_modules/a': entry('2.0.0'), 'node_modules/x/node_modules/a': entry('2.0.0'), 'node_modules/y/node_modules/a': entry('3.0.0')}));
  const names = multi.split('\n').filter(item => /^(?:RISK\[[^\]]*\] )?(?:CHANGED|ADDED) a/.test(item));
  assert.equal(names.length, 3);
  assert.match(names[0], /^ADDED a@2\.0\.0/);
  assert.match(names[1], /^ADDED a@3\.0\.0/);
  assert.match(names[2], /^CHANGED a: version 1\.0\.0 -> 2\.0\.0/);
});

test('credentials in composer, yarn and Pipfile sources are flagged and never shown', () => {
  const composer = JSON.stringify({packages: [{name: 'v/p', version: '1.0.0', dist: {url: 'https://u:p@evil.example.invalid/p.zip'}}]});
  const out = summarize('composer.lock', '', composer, 'added');
  assert.match(out, /RISK\[non-registry-source,url-credentials-added\] ADDED v\/p@1\.0\.0 source=dist=url:https:\/\/evil\.example\.invalid\/p\.zip /);
  const yarn = YARN_V1('7.0.0', 'https://u:p@evil.example.invalid/core.tgz');
  assert.match(summarize('yarn.lock', '', yarn, 'added'), /url-credentials-added\] ADDED @babel\/core@7\.0\.0 source=url:https:\/\/evil\.example\.invalid\/core\.tgz/);
  const pipenv = JSON.stringify({_meta: {}, default: {tool: {git: 'https://github.com/x/tool.git'}}});
  assert.match(summarize('Pipfile.lock', '', pipenv, 'added'), /ADDED tool@- source=git:https:\/\/github\.com\/x\/tool\.git# /);
  assert.doesNotMatch(out + summarize('yarn.lock', '', yarn, 'added') + summarize('Pipfile.lock', '', pipenv, 'added'), /u:p@/);
});

test('incomplete TOML values continue on the next line only while a collection is open', () => {
  assert.equal(reason(() => parseToml('a = { b =')), 'invalid_syntax');
  assert.equal(reason(() => parseToml('a = [1')), 'invalid_syntax');
  assert.deepEqual(parseToml('a = [\n  1,\n  2\n]\nb = { c = [\n 1 ] }\n').b.c, [1]);
});

test('several copies of one package version relocate without a reported change', () => {
  const doc = paths => `${JSON.stringify({lockfileVersion: 3, packages: Object.fromEntries(paths.map(path => [path, {version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: 'sha512-x'}]))})}\n`;
  const out = summarize('package-lock.json', doc(['node_modules/p/node_modules/a', 'node_modules/q/node_modules/a']), doc(['node_modules/r/node_modules/a', 'node_modules/s/node_modules/a']));
  assert.match(out, /changes: 0 added, 0 removed, 0 changed/);
});

test('pnpm peer-dependency variants of one version are compared separately and duplicates fail closed', () => {
  const variants = (first, second) => `lockfileVersion: '6.0'\n\npackages:\n\n  /foo@1.0.0(react@17.0.0):\n    resolution: ${first}\n\n  /foo@1.0.0(react@18.0.0):\n    resolution: ${second}\n`;
  const same = '{integrity: sha512-aaa}';
  const out = summarize('pnpm-lock.yaml', variants(same, same), variants('{tarball: https://evil.example.invalid/foo.tgz}', same));
  assert.match(out, /^RISK\[[^\]]*source-changed[^\]]*\] CHANGED foo: version 1\.0\.0 \(unchanged\); source registry:default -> url:https:\/\/evil\.example\.invalid\/foo\.tgz/m);
  assert.equal(reason(() => summarize('pnpm-lock.yaml', variants(same, '{integrity: sha512-bbb}').replace('react@18.0.0', 'react@17.0.0'), variants(same, same))), 'invalid_structure');
});

test('a downgrade to a pre-release of the same version is flagged for Python lockfiles', () => {
  const out = summarize('uv.lock', lock.uvLock([{name: 'requests', version: '2.32.0', sdist: 'https://files.pythonhosted.org/r.tar.gz'}]),
    lock.uvLock([{name: 'requests', version: '2.32.0rc1', sdist: 'https://files.pythonhosted.org/r.tar.gz'}]));
  assert.match(out, /^RISK\[downgrade\] CHANGED requests: version 2\.32\.0 -> 2\.32\.0rc1/m);
});

test('a package added from a plain-HTTP registry is flagged', () => {
  const out = summarize('package-lock.json', '', lock.npmLock([{name: 'a', version: '1.0.0', resolved: 'http://registry.example.invalid/a/-/a-1.0.0.tgz'}]), 'added');
  assert.match(out, /^RISK\[insecure-registry\] ADDED a@1\.0\.0 source=registry-http:registry\.example\.invalid /m);
});
