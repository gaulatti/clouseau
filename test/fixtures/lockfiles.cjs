'use strict';

// Real-shaped, fictional lockfile excerpts. Package names, versions and hashes are invented; the layout is what
// npm (lockfileVersion 3), pnpm (lockfileVersion 9.0) and uv write, so the parsers see production structure.

const crypto = require('node:crypto');

const sri = label => `sha512-${crypto.createHash('sha512').update(label).digest('base64')}`;
const hex = label => crypto.createHash('sha256').update(label).digest('hex');
const NPM = 'https://registry.npmjs.org';
const tarball = (name, version, host = NPM) => `${host}/${name}/-/${name.split('/').pop()}-${version}.tgz`;

function npmLock(packages) {
  const entries = {'': {name: 'fictional-app', version: '1.0.0', dependencies: {'left-pad': '^1.3.0'}}};
  for (const item of packages) {
    entries[`node_modules/${item.name}`] = {version: item.version, resolved: item.resolved ?? tarball(item.name, item.version),
      ...(item.integrity === null ? {} : {integrity: item.integrity ?? sri(`${item.name}@${item.version}`)}),
      ...(item.extra || {})};
  }
  return `${JSON.stringify({name: 'fictional-app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: entries}, null, 2)}\n`;
}

const npmBase = () => npmLock([
  {name: 'left-pad', version: '1.3.0'}, {name: 'chalk', version: '5.3.0'}, {name: 'lodash', version: '4.17.21'},
  {name: '@scope/util', version: '2.0.0'}, {name: 'esbuild', version: '0.19.0'}, {name: 'semver', version: '7.6.0'},
  {name: 'debug', version: '4.3.4'}, {name: 'tslib', version: '2.6.2', extra: {dev: true}}, {name: 'kleur', version: '4.1.5'},
]);

const npmHead = () => npmLock([
  {name: 'left-pad', version: '1.3.0', integrity: sri('left-pad@1.3.0 swapped')},
  {name: 'chalk', version: '5.4.0'},
  {name: 'lodash', version: '4.17.21', resolved: tarball('lodash', '4.17.21', 'https://registry.example.invalid')},
  {name: '@scope/util', version: '2.0.0', resolved: 'git+ssh://git@github.com/attacker/util.git#0123456789abcdef0123456789abcdef01234567', integrity: null},
  {name: 'esbuild', version: '0.19.0', extra: {hasInstallScript: true}},
  {name: 'semver', version: '7.5.0'},
  {name: 'nanoid', version: '5.0.0'},
  {name: 'tslib', version: '2.6.2'},
  {name: 'kleur', version: '4.1.5', extra: {name: 'kleur-fork'}},
  {name: 'cdn-dep', version: '1.0.0', resolved: 'https://user:secret@cdn.example.invalid/cdn-dep.tgz?token=abc#frag'},
  {name: 'bare-dep', version: '1.0.0', integrity: null},
]);

function pnpmLock(packages, snapshots = '') {
  const body = packages.map(item => `  ${item.key}:\n    resolution: ${item.resolution}\n${item.extra || ''}`).join('\n');
  return `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      react:\n        specifier: ^18.3.1\n        version: 18.3.1\n\npackages:\n\n${body}\n\nsnapshots:\n\n${snapshots}`;
}
const resolutionOf = label => `{integrity: ${sri(label)}}`;

const pnpmBase = () => pnpmLock([
  {key: 'react@18.3.1', resolution: resolutionOf('react@18.3.1'), extra: '    engines: {node: ">=0.10.0"}\n'},
  {key: "'@types/node@20.11.0'", resolution: resolutionOf('@types/node@20.11.0')},
  {key: 'esbuild@0.21.5', resolution: resolutionOf('esbuild@0.21.5'), extra: '    engines: {node: ">=12"}\n    hasBin: true\n'},
  {key: 'zod@3.23.8', resolution: resolutionOf('zod@3.23.8')},
  {key: 'picocolors@1.0.1', resolution: resolutionOf('picocolors@1.0.1')},
  {key: 'tiny-dep@1.0.0', resolution: resolutionOf('tiny-dep@1.0.0')},
  {key: 'git-dep@https://codeload.github.com/example/git-dep/tar.gz/aaaa', resolution: "{tarball: 'https://codeload.github.com/example/git-dep/tar.gz/aaaa'}"},
  {key: 'local-dep@file:../local-dep', resolution: '{directory: ../local-dep, type: directory}'},
], "  react@18.3.1:\n    dependencies:\n      loose-envify: 1.4.0\n\n  esbuild@0.21.5:\n    optionalDependencies:\n      '@esbuild/darwin-arm64': 0.21.5\n\n  ms@2.1.3: {}\n\n  '@types/node@20.11.0': {}\n");

const pnpmHead = () => pnpmLock([
  {key: 'react@18.3.1', resolution: `{integrity: ${sri('react@18.3.1 swapped')}}`, extra: '    engines: {node: ">=0.10.0"}\n'},
  {key: "'@types/node@20.11.0'", resolution: "{tarball: https://packages.example.invalid/@types/node/-/node-20.11.0.tgz}"},
  {key: 'esbuild@0.21.5', resolution: resolutionOf('esbuild@0.21.5'), extra: '    engines: {node: ">=12"}\n    hasBin: true\n    requiresBuild: true\n'},
  {key: 'zod@3.22.0', resolution: resolutionOf('zod@3.22.0')},
  {key: 'picocolors@1.1.0', resolution: resolutionOf('picocolors@1.1.0')},
  {key: 'tiny-dep@1.0.0', resolution: "{commit: 0123456789abcdef0123456789abcdef01234567, repo: 'https://github.com/attacker/tiny-dep.git', type: git}"},
  {key: 'git-dep@https://codeload.github.com/example/git-dep/tar.gz/aaaa', resolution: "{tarball: 'https://codeload.github.com/example/git-dep/tar.gz/aaaa'}"},
  {key: 'local-dep@file:../local-dep', resolution: '{directory: ../local-dep, type: directory}'},
  {key: 'ms@2.1.3', resolution: resolutionOf('ms@2.1.3')},
], "  react@18.3.1:\n    dependencies:\n      loose-envify: 1.4.0\n\n  esbuild@0.21.5:\n    optionalDependencies:\n      '@esbuild/darwin-arm64': 0.21.5\n\n  ms@2.1.3: {}\n\n  '@types/node@20.11.0': {}\n");

function uvLock(packages) {
  const blocks = packages.map(item => {
    const wheels = (item.wheels || []).map(wheel => `    { url = "${wheel.url}", hash = "sha256:${hex(wheel.url)}", size = 1024 },`).join('\n');
    return `[[package]]\nname = "${item.name}"\nversion = "${item.version}"\nsource = ${item.source || '{ registry = "https://pypi.org/simple" }'}\n` +
      `${item.sdist ? `sdist = { url = "${item.sdist}", hash = "sha256:${hex(item.sdist + (item.salt || ''))}", size = 2048 }\n` : ''}` +
      `${wheels ? `wheels = [\n${wheels}\n]\n` : ''}${item.dependencies ? `dependencies = [\n    { name = "${item.dependencies}" },\n]\n` : ''}`;
  });
  return `version = 1\nrequires-python = ">=3.11"\n\n${blocks.join('\n')}`;
}
const PYPI = 'https://files.pythonhosted.org/packages';

const uvBase = () => uvLock([
  {name: 'requests', version: '2.31.0', sdist: `${PYPI}/aa/requests-2.31.0.tar.gz`, wheels: [{url: `${PYPI}/bb/requests-2.31.0-py3-none-any.whl`}], dependencies: 'urllib3'},
  {name: 'urllib3', version: '2.2.1', sdist: `${PYPI}/cc/urllib3-2.2.1.tar.gz`, wheels: [{url: `${PYPI}/dd/urllib3-2.2.1-py3-none-any.whl`}]},
  {name: 'idna', version: '3.6', sdist: `${PYPI}/ee/idna-3.6.tar.gz`},
  {name: 'certifi', version: '2024.2.2', sdist: `${PYPI}/ff/certifi-2024.2.2.tar.gz`},
  {name: 'charset-normalizer', version: '3.3.2', sdist: `${PYPI}/gg/charset-normalizer-3.3.2.tar.gz`},
  {name: 'fictional-app', version: '0.1.0', source: '{ editable = "." }', dependencies: 'requests'},
]);

const uvHead = () => uvLock([
  {name: 'requests', version: '2.31.0', sdist: `${PYPI}/aa/requests-2.31.0.tar.gz`, salt: 'swapped', wheels: [{url: `${PYPI}/bb/requests-2.31.0-py3-none-any.whl`}], dependencies: 'urllib3'},
  {name: 'urllib3', version: '2.2.1', sdist: 'https://mirror.example.invalid/packages/urllib3-2.2.1.tar.gz', wheels: [{url: `${PYPI}/dd/urllib3-2.2.1-py3-none-any.whl`}]},
  {name: 'idna', version: '3.6', source: '{ git = "https://github.com/attacker/idna?rev=0123456789abcdef0123456789abcdef01234567#0123456789abcdef0123456789abcdef01234567" }'},
  {name: 'certifi', version: '2023.7.22', sdist: `${PYPI}/ff/certifi-2023.7.22.tar.gz`},
  {name: 'charset-normalizer', version: '3.4.0', sdist: `${PYPI}/gg/charset-normalizer-3.4.0.tar.gz`},
  {name: 'fictional-app', version: '0.1.0', source: '{ editable = "." }', dependencies: 'requests'},
  {name: 'rich', version: '13.7.1', sdist: `${PYPI}/hh/rich-13.7.1.tar.gz`},
]);

// Large generated lockfile of `count` registry packages, roughly the shape and size of a monorepo pnpm lockfile.
function largePnpm(count, bump = 0) {
  return pnpmLock(Array.from({length: count}, (_, i) => {
    const version = `1.${i % 50}.${i < bump ? 1 : 0}`;
    return {key: `package-${i}@${version}`, resolution: resolutionOf(`package-${i}@${version}`),
      extra: `    engines: {node: '>=18'}\n    peerDependencies:\n      react: ^18.0.0\n      typescript: '>=5.0.0'\n    peerDependenciesMeta:\n      typescript:\n        optional: true\n`};
  }));
}

module.exports = {sri, hex, tarball, npmLock, npmBase, npmHead, pnpmLock, pnpmBase, pnpmHead, uvLock, uvBase, uvHead, largePnpm};
