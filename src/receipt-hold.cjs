'use strict';

// The rules that hold a signed local receipt, in one place: CI applies them when it reads a receipt
// (acceptance-controller.cjs), and `clouseau review` applies them before it signs one (local-cli.cjs), so a local review
// never signs what CI would refuse. Nothing here reads a credential or the network: `github` is whatever client answers
// `supplyTests` (the GitHub API in CI, the local Git checkout in `clouseau review`, see local-git.cjs `gitContents`).

const {approvalHold, importsOf, LINKABLE_PATH} = require('./acceptance.cjs');
const {supplyTests} = require('./acceptance-sources.cjs');

// The local snapshot holds only what the local reviewer fetched. Importers are found with the same discovery the
// hosted review uses, and what it found is stored IN the record (`discovery`), so the assessment, the gate, the
// finalizer and every other path derive the decision from the same inputs: the snapshot plus its discovery. The
// signed receipt itself is not altered.
async function discoverImporters({github, repo, snapshot}) {
  const discovered = structuredClone(snapshot);
  await supplyTests({github, repo, snapshot: discovered, files: discovered.files.map(file => ({filename: file.path, status: file.status})),
    baseSha: discovered.base_sha, headSha: discovered.head_sha});
  const added = Object.entries(discovered.sources).filter(([id]) => !Object.hasOwn(snapshot.sources, id));
  // Files that are imported or import are carried as their specifiers; only a non-JS test, whose linkage reads its text, is carried whole.
  const edges = added.filter(([, source]) => LINKABLE_PATH.test(source.path)).map(([, source]) => ({path: source.path, specifiers: importsOf(source.path, source.content)}));
  return {test_imports: [...(discovered.test_imports ?? []), ...edges],
    sources: Object.fromEntries(added.filter(([, source]) => !LINKABLE_PATH.test(source.path)))};
}

function withDiscovery(snapshot, discovery) {
  return {...snapshot, test_imports: [...(snapshot.test_imports ?? []), ...discovery.test_imports], sources: {...snapshot.sources, ...discovery.sources}};
}

async function receiptHold({github, repo, snapshot, reviews}) {
  const discovery = await discoverImporters({github, repo, snapshot});
  return {discovery, hold: reviews.map(review => approvalHold(review.report, withDiscovery(snapshot, discovery))).find(Boolean)};
}

// The rule an `approvalHold` text names, and for the per-file rule the files it names (empty for the others).
const HOLD_RULES = Object.freeze({'test integrity is unresolved': 'integrity', 'review completeness is unresolved': 'completeness',
  'no supplied test imports changed production code': 'untested'});
function holdRule(hold) {
  const [rule] = hold.split(': ');
  return {rule: HOLD_RULES[rule], file: hold.slice(rule.length + 2)};
}

// The integration dispositions of one stored chunked review that are not `checked`: the seams its integration pass left
// open. A seam left open is missing evidence, so a chunked record with any holds approval.
function openSeams(review) {
  return review.integration.flatMap(entry => entry.dispositions.filter(row => row.state !== 'checked'));
}

module.exports = {discoverImporters, withDiscovery, receiptHold, HOLD_RULES, holdRule, openSeams};
