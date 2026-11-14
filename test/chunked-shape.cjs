'use strict';
// The shape of a real chunked change whose units listed each other as missing under clouseau-partition/1: src/policy.cjs,
// src/local-cli.cjs and src/acceptance-controller.cjs, each with its test, importing one another. The content is short
// fictional code; only the import and export edges matter. With C = 1 every file-and-test atom is its own unit.
const {refresh} = require('../src/acceptance-sources.cjs');

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
const PARAMS = Object.freeze({C: 1, S: 100000});
const source = (path, content, ref = HEAD) => ({path, ref, authority: 'untrusted', kind: 'source', content});
const added = content => content.split('\n').filter(Boolean).map(line => `+${line}`).join('\n');

const FILES = [
  ['src/acceptance-controller.cjs', "const control = review => holdOf(review) || run(review);\n",
    "const {holdOf} = require('./policy.cjs');\nconst run = require('./local-cli.cjs');\nmodule.exports = review => holdOf(review) || run(review);\n"],
  ['src/acceptance-controller.test.cjs', "control({});\n", "const control = require('./acceptance-controller.cjs');\ncontrol({});\n"],
  ['src/local-cli.cjs', "module.exports = () => 'clear';\n",
    "const {holdOf, reasonOf} = require('./policy.cjs');\nmodule.exports = review => reasonOf(holdOf(review));\n"],
  ['src/local-cli.test.cjs', "run({});\n", "const run = require('./local-cli.cjs');\nconst {reasonOf} = require('./policy.cjs');\nrun({});\nreasonOf(true);\n"],
  ['src/policy.cjs', "exports.holdOf = review => review.missing;\n",
    "exports.holdOf = review => review.missing && review.unresolved;\nexports.reasonOf = hold => (hold ? 'held' : 'clear');\n"],
  ['src/policy.test.cjs', "holdOf({});\n", "const {holdOf} = require('./policy.cjs');\nholdOf({});\n"],
];

function shapeSnapshot() {
  const sources = {
    contract: {path: '.github/clouseau.md', ref: BASE, authority: 'trusted', kind: 'contract', content: '# Contract\nHold approval on missing evidence.\n'},
    verification: {path: 'verification', ref: HEAD, authority: 'trusted', kind: 'verification', content: '{"ok":true}'},
    'local-request': {path: 'local-request', ref: 'r', authority: 'untrusted', kind: 'requirement', content: 'Hold only unresolved missing evidence.'},
  };
  const files = FILES.map(([path, base, head], index) => {
    sources[`f${index}.base`] = source(path, base, BASE);
    sources[`f${index}.head`] = source(path, head);
    return {path, status: 'modified', patch: `@@ -1,1 +1,${head.split('\n').length - 1} @@\n${base.split('\n').filter(Boolean).map(line => `-${line}`).join('\n')}\n${added(head)}\n`,
      base_source: `f${index}.base`, head_source: `f${index}.head`};
  });
  const snapshot = {version: 2, review_manifest_version: 1, repository: 'o/r', number: 0, base_sha: BASE, head_sha: HEAD,
    head_repository: {owner: 'o', repo: 'r'}, paths: files.map(file => file.path).sort(), config_digest: 'c', policy_digest: 'p',
    sources, files, history: [], tickets: [], intent_confirmation: null, prior_findings: [],
    claims: {title: 'change', description: 'Hold only unresolved missing evidence.'}, covering_tests: {}};
  return refresh(snapshot, 3000000);
}

// Changed paths joined by an import in either direction: what a reviewer of one end needs to read of the other.
function linksOf(snapshot) {
  const links = new Map(snapshot.paths.map(path => [path, new Set()]));
  for (const file of snapshot.files) {
    for (const [, target] of snapshot.sources[file.head_source].content.matchAll(/require\('\.\/([^']+)'\)/g)) {
      links.get(file.path).add(`src/${target}`); links.get(`src/${target}`).add(file.path);
    }
  }
  return links;
}

module.exports = {HEAD, BASE, PARAMS, shapeSnapshot, linksOf};
