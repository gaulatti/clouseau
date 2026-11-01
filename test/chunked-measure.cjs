'use strict';

// Alcantara-shaped fixture and measurement for chunked local review (design section 7, PR 6). No AI and no network.
//
// `combinedSnapshot` turns a changed-file table ({files: [{path, status, previous, base_size, head_size, patch_chars,
// derived_size?}]}, for example test/fixtures/alcantara-02618a9.json) into a combined snapshot with the shape the local
// collector produces: the same source ids, compact storage for files added whole, and a lockfile replaced by the real
// derived summary. File CONTENT is deterministic fictional filler of exactly the measured size, never alcantara text;
// only sizes and paths (public metadata) come from the table. `measure` partitions it with the real planner, builds every
// unit view with the real `unitView`, merges fake unit reports with the real `mergeUnitReports`, builds the chunked record
// with thin (quote-elided) reports, signs and verifies it, and reports the sizes the owner needs to see.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {digest} = require('../src/acceptance.cjs');
const {refresh, UNBOUNDED} = require('../src/acceptance-sources.cjs');
const {modelTemplate, materialize} = require('../src/acceptance-review.cjs');
const {localEvidence} = require('../src/local-review.cjs');
const {lockfileEvidence, LOCKFILE_PATCH} = require('../src/lockfile-summary.cjs');
const {PartitionRefusal, partition} = require('../src/review-partition.cjs');
const {changeTable, segmentLimit} = require('../src/change-table.cjs');
const {unitView, mergeUnitReports} = require('../src/review-units.cjs');
const {SCHEME, RECORD_LIMIT, ChunkedRecordError, elideQuotes} = require('../src/chunked-record.cjs');
const {issueReceipt, verifyReceipt} = require('../src/local-receipt.cjs');
const {engineDigest} = require('../src/local-version.cjs');
const lock = require('./fixtures/lockfiles.cjs');

const PARAMS = Object.freeze({C: 450000, S: 100000});
const CODEX_LIMIT = 1048576;
const RECEIPT_LIMIT = 3000000;
// The stage text and instructions around the evidence in a unit prompt; PR 4 owns the exact prompt, this is an upper bound.
const PROMPT_FRAME = 9000;
const ROLES = ['examiner', 'challenger'];
const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const TABLE = path.join(__dirname, 'fixtures/alcantara-02618a9.json');

// Deterministic code-shaped filler of exactly `size` characters ending in a newline, about 34 characters per line like source.
function filler(seed, size, mark = '') {
  if (size === 0) return '';
  let out = '';
  for (let line = 0; out.length < size; line++) {
    out += `${mark}const v${line} = '${crypto.createHash('sha256').update(`${seed}:${line}`).digest('hex').slice(0, 16)}';\n`;
  }
  return `${out.slice(0, size - 1)}\n`;
}

const hunk = (name, status, base, head) => `diff --git a/${name} b/${name}\n${status === 'added' ? 'new file mode 100644\n' : ''}` +
  `index ${status === 'added' ? '0000000' : '1111111'}..2222222${status === 'added' ? '' : ' 100644'}\n--- ${status === 'added' ? '/dev/null' : `a/${name}`}\n+++ b/${name}\n` +
  `@@ -${status === 'added' ? '0,0' : `1,${base}`} +1,${head} @@\n`;

const lineCount = text => text.split('\n').length - 1;
const CODE = /\.(?:ts|tsx|cjs|mjs|js)$/;

// A relative import of `target` from `from`, so the unit views exercise foreign hunks across units.
function importLine(from, target) {
  const relative = path.posix.relative(path.posix.dirname(from), target).replace(/\.[^.]+$/, '');
  return `import {v0} from '${relative.startsWith('.') ? relative : `./${relative}`}';\n`;
}

// The measured table repeated under `copies` fictional top-level directories (85 files each), for changes far beyond 02618a9.
// Only the first copy keeps the lockfile derived; the others are plain files of the same sizes.
function scaledTable(table, copies) {
  return {files: Array.from({length: copies}, (_, copy) => table.files.filter(file => copy === 0 || file.derived_size === undefined)
    .map(file => ({...file, path: `copy-${copy}/${file.path}`}))).flat()};
}

// The measured table plus one added file of `size` characters (and its patch header), for the single-file ceilings.
function withLargeFile(table, size, name = 'generated/large-module.ts') {
  return {files: [...table.files, {path: name, status: 'added', previous: null, base_size: 0, head_size: size, patch_chars: 160}]};
}

// Large generated pnpm lockfile of about `size` characters; the head bumps some versions so the summary lists changes.
function pnpmLockfiles(baseSize, headSize) {
  const entry = lock.largePnpm(100).length / 100;
  const base = lock.largePnpm(Math.round(baseSize / entry));
  return {base, head: lock.largePnpm(Math.round(headSize / entry), 150)};
}

function combinedSnapshot(table, {imports = true} = {}) {
  const entries = [...table.files].sort((a, b) => (a.path < b.path ? -1 : 1));
  const code = entries.filter(file => file.derived_size === undefined && CODE.test(file.path) && file.head_size >= 1000).map(file => file.path);
  const snapshot = {version: 2, review_manifest_version: 1, repository: 'example/alcantara-shaped', number: 0, base_sha: BASE, head_sha: HEAD,
    head_repository: {owner: 'example', repo: 'alcantara-shaped'}, paths: entries.map(file => file.path),
    config_digest: digest('fictional configuration'), policy_digest: digest(fs.readFileSync(path.join(__dirname, '../policy/change-acceptance.md'), 'utf8')),
    sources: {}, files: [], history: [], tickets: [], intent_confirmation: null, prior_findings: [],
    local_config_digest: digest('fictional local configuration'),
    claims: {title: 'test(coverage): add a fictional alcantara-shaped change', description: 'A synthetic change shaped like a large coverage commit.'}};
  const request = 'Assess the fictional change against the accepted contract.';
  snapshot.sources['local-request'] = {authority: 'untrusted', kind: 'requirement', path: 'local-request', ref: digest(request), content: request};
  snapshot.sources[`${BASE}:README.md`] = {path: 'README.md', ref: BASE, authority: 'trusted', kind: 'contract', content: filler('README.md', 2000)};
  snapshot.sources[`${BASE}:.github/clouseau.md`] = {path: '.github/clouseau.md', ref: BASE, authority: 'trusted', kind: 'contract',
    content: filler('.github/clouseau.md', 3000)};
  snapshot.sources.verification = {authority: 'trusted', kind: 'verification', path: 'verification', ref: HEAD,
    content: JSON.stringify({synthetic: true, commands: [{command: ['npm', 'test'], status: 0}]})};
  for (const file of entries) {
    const previous = file.previous ?? file.path;
    const status = file.derived_size === undefined ? (file.previous ? 'renamed' : file.base_size === 0 ? 'added' : 'modified') : 'modified';
    const item = {path: file.path, status, patch: ''};
    const source = (name, ref, content) => {
      snapshot.sources[`${ref}:${name}`] = {path: name, ref, authority: 'untrusted', kind: 'source', content};
      return `${ref}:${name}`;
    };
    if (file.derived_size !== undefined) {
      const {base, head} = pnpmLockfiles(file.base_size, file.head_size);
      const evidence = lockfileEvidence({file: {filename: file.path, previous_filename: previous, status}, baseSha: BASE, headSha: HEAD, baseText: base, headText: head});
      snapshot.sources[evidence.id] = evidence.source;
      Object.assign(item, {patch: LOCKFILE_PATCH, lockfile: true, base_source: evidence.id, head_source: evidence.id});
    } else {
      const index = code.indexOf(file.path);
      const target = code[(index * 7 + 3) % code.length] === file.path ? code[(index + 1) % code.length] : code[(index * 7 + 3) % code.length];
      const prefix = imports && index >= 0 && code.length > 1 ? importLine(file.path, target) : '';
      const head = prefix + filler(`${file.path}@head`, file.head_size - prefix.length);
      const base = filler(`${previous}@base`, file.base_size);
      if (status !== 'added') item.base_source = source(previous, BASE, base);
      item.head_source = source(file.path, HEAD, head);
      const header = hunk(file.path, status, lineCount(base), lineCount(head));
      if (status === 'added') {
        // A whole added file is its patch body: keep the header and let the head source carry the text once.
        Object.assign(item, {patch: header, patch_body: 'head_source'});
      } else {
        item.patch = header + filler(`${file.path}@patch`, Math.max(0, file.patch_chars - header.length), '+');
      }
      snapshot.history.push(...(status === 'added' ? [] : [{path: file.path, commits: 'aaaaaaa fictional earlier change'}]));
    }
    snapshot.files.push(item);
  }
  return refresh(snapshot, UNBOUNDED);
}

// Recompute hooks for the chunked verifier, built from the real planner, `unitView` and `mergeUnitReports`. Seams belong to
// another change and are empty here.
function hooksFor(params) {
  const options = {unit_ceiling: params.C, shared: params.S};
  const planOf = snapshot => partition(changeTable(snapshot, options), options);
  const specsOf = snapshot => planOf(snapshot).units.map(({id, owned, parts}) => ({id, owned, context_ids: [], ...(parts ? {parts} : {})}));
  const viewOf = (snapshot, unit) => unitView(snapshot, {id: unit.id, owned: unit.owned, context_ids: unit.context_ids, ...(unit.parts ? {parts: unit.parts} : {})},
    {units: specsOf(snapshot), segmentLimit: segmentLimit(options)});
  return {
    partition: ({snapshot}) => {
      const plan = planOf(snapshot);
      const specs = specsOf(snapshot);
      return {scheme: plan.scheme, params: {C: params.C, S: params.S},
        units: plan.units.map((unit, index) => ({...specs[index], view_digest: viewOf(snapshot, specs[index]).digest, cost: unit.cost})),
        plan_digest: plan.plan_digest};
    },
    unitView: viewOf,
    seams: () => [],
    merge: ({unitReports, snapshot}) => {
      const specs = specsOf(snapshot);
      return mergeUnitReports(unitReports.map(({unit, report}) => ({view: viewOf(snapshot, specs.find(spec => spec.id === unit)), report})), snapshot).report;
    },
  };
}

// What an honest, finding-free reviewer returns for one unit view.
function fakeReport(view) {
  const report = modelTemplate(view);
  report.gates.forEach(gate => {gate.state = 'satisfied';});
  return materialize(report, view);
}

function buildRecord(snapshot, params = PARAMS) {
  const hooks = hooksFor(params);
  const plan = hooks.partition({snapshot, params});
  const views = plan.units.map(unit => hooks.unitView(snapshot, unit));
  const reports = views.map(view => fakeReport(view));
  const usage = [];
  const call = (role, phase, unit) => {
    const n = usage.length + 1;
    usage.push({harness: 'codex', role, phase, session: `fictional-session-${n}`, ...(unit ? {unit} : {}),
      request_digest: digest(['request', n]), response_digest: digest(['response', n]), transport_digest: digest(['transport', n])});
  };
  const reviews = ROLES.map(role => {
    for (const unit of plan.units) call(role, 'investigation', unit.id);
    call(role, 'integration');
    return {role, unit_reports: reports.map((report, index) => ({unit: plan.units[index].id, report: elideQuotes(report, views[index])})),
      integration: [], drafts: [], grading: {provider: 'local-harness', decisions: []}};
  });
  const result = {version: 2, snapshot: snapshot.digest, policy_digest: snapshot.policy_digest, config_digest: snapshot.config_digest,
    decision: 'auto_approve', reviews, usage, execution_digest: digest(usage)};
  const record = {version: 3, snapshot, partition: plan, seams: [], result, previous: {comment: null, findings: []},
    controls: false, technical: JSON.parse(snapshot.sources.verification.content)};
  return {record, plan, views, reports, hooks};
}

// Sign the record with an ephemeral key and verify the bundle through the one derivation, as CI does.
function signAndVerify(record, snapshot, chunked) {
  const keys = crypto.generateKeyPairSync('ed25519');
  const trust = {mode: 'required', reviewer_digest: engineDigest(), max_age_seconds: 172800,
    keys: [{id: 'test-runner', issuer: 'fictional-runner', github_actor: 'fixture-author', revoked: false,
      public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}]};
  const bundle = issueReceipt({record, privateKey: keys.privateKey.export({type: 'pkcs8', format: 'pem'}), keyId: 'test-runner',
    issuer: 'fictional-runner', reviewerSha: 'e'.repeat(40), now: 10000000, nonce: 'f'.repeat(64), chunked});
  const verified = verifyReceipt(bundle, {trust, repository: snapshot.repository, author: 'fixture-author', headSha: snapshot.head_sha,
    baseSha: snapshot.base_sha, reviewerSha: 'e'.repeat(40), configDigest: snapshot.config_digest, policyDigest: snapshot.policy_digest,
    now: 10000000, chunked});
  return {bundle, verified};
}

const sum = (items, measure) => items.reduce((total, item) => total + measure(item), 0);

// Sizes of one unit view: the evidence JSON (what the unit budget bounds), the shared context, the manifest, the foreign
// hunks and the estimated prompt (policy, frame, evidence, template).
function unitSizes(view, unit, policy) {
  const mine = new Set(view.files.flatMap(file => [file.base_source, file.head_source]));
  const value = {...view}; delete value.digest;
  return {id: unit.id, files: unit.owned.length, cost: unit.cost, view_chars: JSON.stringify(value).length,
    owned_chars: sum([...mine].filter(Boolean), id => view.sources[id].content.length),
    shared_chars: sum(Object.entries(view.sources).filter(([id]) => !mine.has(id)), ([, source]) => source.content.length),
    manifest_chars: JSON.stringify(view.change_manifest).length, foreign_chars: sum(view.foreign_hunks, hunk => hunk.patch.length),
    foreign_hunks: view.foreign_hunks.length,
    prompt_chars: policy.length + PROMPT_FRAME + JSON.stringify({evidence: localEvidence(view), template: modelTemplate(view), drafts: []}).length};
}

function measure(table, overrides = {}) {
  const params = {...PARAMS, ...overrides};
  const snapshot = combinedSnapshot(table);
  const {record, plan, views, hooks} = buildRecord(snapshot, params);
  const policy = fs.readFileSync(path.join(__dirname, '../policy/change-acceptance.md'), 'utf8');
  const {bundle} = signAndVerify(record, snapshot, {params, hooks});
  const value = {...snapshot}; delete value.digest;
  return {params, plan_digest: plan.plan_digest, files: snapshot.files.length, combined_chars: JSON.stringify(value).length,
    units: plan.units.map((unit, index) => unitSizes(views[index], unit, policy)), calls: record.result.usage.length,
    record_bytes: Buffer.byteLength(JSON.stringify(record)), record_limit: RECORD_LIMIT, receipt_files: 1 + (bundle.parts?.length ?? 0),
    receipt_bytes: Buffer.byteLength(JSON.stringify({payload: bundle.payload, signature: bundle.signature})) +
      (bundle.parts ?? []).reduce((total, part) => total + Buffer.from(part, 'base64').length, 0),
    receipt_limit: RECEIPT_LIMIT, prompt_limit: CODEX_LIMIT, verified: true};
}

const pad = (value, width) => String(value).padStart(width);

function render(report) {
  const {params} = report;
  const lines = [`${SCHEME} ${report.plan_digest}`,
    `${report.units.length} units, ${report.files} files, C ${params.C}, S ${params.S}`,
    `combined snapshot ${report.combined_chars} chars (no cap; units are bounded)`,
    `${'unit'.padEnd(5)}${pad('files', 6)}${pad('cost', 9)}${pad('view', 9)}${pad('owned', 9)}${pad('shared', 9)}${pad('manifest', 10)}${pad('foreign', 9)}${pad('prompt', 9)}`];
  for (const unit of report.units) {
    lines.push(`${unit.id.padEnd(5)}${pad(unit.files, 6)}${pad(unit.cost, 9)}${pad(unit.view_chars, 9)}${pad(unit.owned_chars, 9)}` +
      `${pad(unit.shared_chars, 9)}${pad(unit.manifest_chars, 10)}${pad(unit.foreign_chars, 9)}${pad(unit.prompt_chars, 9)}`);
  }
  const worst = Math.max(...report.units.map(unit => unit.prompt_chars));
  lines.push(`largest unit prompt ${worst} of ${report.prompt_limit} chars (estimate)`,
    `harness calls ${report.calls} (${report.units.length} units x 2 roles + 2 integration, no grading)`,
    `record ${report.record_bytes} bytes (${(100 * report.record_bytes / report.record_limit).toFixed(1)}% of the ${report.record_limit} single-receipt limit)`,
    `signed receipt ${report.receipt_bytes} bytes in ${report.receipt_files} file${report.receipt_files === 1 ? '' : 's'}, verified through the one derivation`);
  return `${lines.join('\n')}\n`;
}

function refusalCode(error) {
  if (error instanceof PartitionRefusal) return error.message;
  return error instanceof ChunkedRecordError ? `${error.cause_code}: ${error.message}` : null;
}

// `main(['table.json', '--ceiling', '300000'], {stdout})` prints the measurements of the plan, or the refusal (exit 2).
function main(argv, io = {}) {
  const read = io.readFile ?? (file => fs.readFileSync(file, 'utf8'));
  const out = io.stdout ?? process.stdout;
  const flags = {'--ceiling': 'C', '--shared': 'S'};
  const overrides = {};
  let table = TABLE;
  for (let index = 0; index < argv.length; index++) {
    if (!argv[index].startsWith('--')) table = argv[index];
    else if (flags[argv[index]]) overrides[flags[argv[index]]] = Number(argv[++index]);
    else throw new TypeError(`unknown option ${argv[index]}; usage: measure-chunked [TABLE.json] [--ceiling N] [--shared N]`);
  }
  try {
    out.write(render(measure(JSON.parse(read(table)), overrides)));
    return 0;
  } catch (error) {
    const reason = refusalCode(error);
    if (reason === null) throw error;
    out.write(`refused ${reason}\n`);
    return 2;
  }
}

module.exports = {PARAMS, CODEX_LIMIT, RECEIPT_LIMIT, scaledTable, withLargeFile, filler, combinedSnapshot, changeTable, hooksFor, fakeReport, buildRecord,
  signAndVerify, measure, render, main};
