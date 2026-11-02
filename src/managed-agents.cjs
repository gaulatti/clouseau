'use strict';

// Opt-in exemption of the managed-standard AGENTS.md update from the protected-control hold.
//
// AGENTS.md is a protected control, so every managed-standard sync commit (the central block between the markers below)
// is held for the owner's exact-head confirmation. A repository that enrolls `managed_agents.digests` in its protected
// configuration accepts such a change WITHOUT that hold only when all of these are verified from the base and head file
// bytes themselves, never from the PR description, commit message or any metadata:
//   1. the head file has exactly one well-formed managed block (marker lines, in order), and
//   2. the SHA-256 of that block is one of the enrolled digests, and
//   3. the base file also has exactly one well-formed block, and every byte outside the block is identical in both.
// Anything else (an unenrolled block, a partial edit of the block, a stray or repeated marker, changed whitespace, a changed
// line outside the block, an added, removed or renamed file) keeps the ordinary protected-control hold.
// The engine has no verifiable access to the central standard repository, so the enrolled digests are the only
// verified input. Unset, nothing here is called and behaviour is unchanged.

const crypto = require('node:crypto');
const BEGIN = '<!-- BEGIN BASTILLE MANAGED RULES -->';
const END = '<!-- END BASTILLE MANAGED RULES -->';
const FILE = 'AGENTS.md';
const MAX_DIGESTS = 64;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'digests' ||
      !Array.isArray(value.digests) || value.digests.length === 0 || value.digests.length > MAX_DIGESTS ||
      !value.digests.every(hash) || new Set(value.digests).size !== value.digests.length) {
    throw new Error(`Invalid managed_agents configuration; use {"digests": [1 to ${MAX_DIGESTS} distinct lowercase SHA-256 hex digests]}`);
  }
  return value;
}

// Split on LF only. A marker must be a whole line, byte for byte: CRLF text, indented or padded markers never match.
function parse(text) {
  const lines = text.split('\n');
  const begins = lines.flatMap((line, index) => line === BEGIN ? [index] : []);
  const ends = lines.flatMap((line, index) => line === END ? [index] : []);
  if (begins.length !== 1 || ends.length !== 1 || begins[0] > ends[0]) return null;
  return {before: lines.slice(0, begins[0]).join('\n'), after: lines.slice(ends[0] + 1).join('\n'),
    block: lines.slice(begins[0], ends[0] + 1).join('\n') + '\n'};
}

const blockDigest = block => crypto.createHash('sha256').update(block).digest('hex');

// Decide one base/head pair. The reason is a stable sentence for the visible notice; it never quotes file content.
function judge({baseText, headText, digests}) {
  const head = parse(headText);
  if (!head) return {exempt: false, reason: 'the head file does not contain exactly one well-formed managed block'};
  const base = parse(baseText);
  if (!base) return {exempt: false, reason: 'the base file does not contain exactly one well-formed managed block'};
  const found = blockDigest(head.block);
  if (!digests.includes(found)) return {exempt: false, reason: 'the managed block is not an enrolled central snapshot', digest: found};
  if (head.before !== base.before || head.after !== base.after) {
    return {exempt: false, reason: 'content outside the managed block changed', digest: found};
  }
  return {exempt: true, reason: 'only the managed block changed and it matches an enrolled central snapshot', digest: found};
}

// The AGENTS.md changes of one PR that are exempt from the hold, with a notice per decided change.
async function exemptions({github, repo, pr, files, config}) {
  const exempt = new Set();
  const notices = [];
  if (!config.managed_agents) return {exempt, notices};
  const file = files.find(item => item.filename === FILE || item.previous_filename === FILE);
  if (!file) return {exempt, notices};
  const hold = reason => {notices.push(`${FILE} stays a protected-control hold: ${reason}.`); return {exempt, notices};};
  if (file.filename !== FILE || file.previous_filename || file.status !== 'modified') return hold('only a modification of the existing file qualifies');
  const headRepo = pr.head.repo;
  if (!headRepo?.owner?.login || !headRepo.name) return hold('the head repository is unavailable');
  const {fetchText} = require('./acceptance-sources.cjs');
  const snapshot = {head_sha: pr.head.sha, head_repository: {owner: headRepo.owner.login, repo: headRepo.name}};
  let baseText;
  let headText;
  try {
    baseText = await fetchText({github, repo, snapshot, filename: FILE, ref: pr.base.sha});
    headText = await fetchText({github, repo, snapshot, filename: FILE, ref: pr.head.sha});
  } catch (error) {
    if (!error.unavailable) throw error;
    return hold('the base or head file is unavailable as complete text');
  }
  const verdict = judge({baseText, headText, digests: config.managed_agents.digests});
  if (!verdict.exempt) return hold(verdict.reason);
  exempt.add(FILE);
  notices.push(`${FILE} is not a protected-control hold: ${verdict.reason} (sha256 ${verdict.digest}).`);
  return {exempt, notices};
}

module.exports = {BEGIN, END, FILE, MAX_DIGESTS, validate, parse, blockDigest, judge, exemptions};
