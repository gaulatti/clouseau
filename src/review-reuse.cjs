'use strict';

// Evidence-keyed reuse of reviewer answers (docs/local-review.md, "Refreshing a pull request after its base moved").
//
// A local review asks a harness one question at a time: every unit investigation, every integration pass and every
// grading round is a `task` whose prompt is the complete evidence the reviewer sees. This module remembers the answer of
// every call of a review that was ACCEPTED (`auto_approve`) under a key made of that prompt, and can hand the answer back
// to a later review whose prompt is the same. It decides nothing: a reused answer goes through the very check a fresh one
// goes through, against the new snapshot, and a call whose key is not in the store is asked as before.
//
// The key is strict. It covers the policy and stage text, the schema, the role and phase, the whole evidence (every
// changed patch, every base and head source, every linked source, the seams, the requirement, the prior findings and the
// change manifest) and the review semantics of the engine. The only values left out are the ones that name the revision
// rather than describe it, and they are replaced by placeholders so that two runs compare equal exactly when everything
// else is byte-identical:
//   - the base and head commit ids, and the snapshot and unit-view digests (they hash the very values compared); the
//     commit ids of a file's recent history are not replaced and still compare byte for byte;
//   - the subject of the head commit (the merge commit that a refresh creates replaces it; the requirement stays);
//   - for a verification command that passed (exit 0, no error, no signal): its output tails and output digests. Its
//     argv, exit code, coverage counters and configuration digest stay in the key, as does every byte of a failed one.

const fs = require('node:fs');
const path = require('node:path');
const {digest} = require('./acceptance.cjs');

const VERSION = 1;
const PREFIX = '<<clouseau-reuse:';
const token = name => `${PREFIX}${name}>>`;

const isCommand = value => value !== null && typeof value === 'object' && Array.isArray(value.argv);
const passed = command => command.exit_code === 0 && !command.error && !command.signal;

// Under the opt-in outcome keying (`clouseau review --reuse outcome`, or `"review_reuse": "outcome"` in the base's
// .clouseau-local.json), exact coverage is keyed by the outcome the reviewers judge, complete or not: a base that added code
// elsewhere changes the counters but not the verdict. Coverage that is not complete keeps its counters, which are evidence.
const outcomeOf = exact => exact !== null && typeof exact === 'object' && ['lines', 'branches'].every(name => Array.isArray(exact[name]) &&
  exact[name].length === 2 && Number.isSafeInteger(exact[name][0]) && exact[name][0] === exact[name][1]) &&
  Object.keys(exact).sort().join(',') === 'branches,lines' ? {lines: 'complete', branches: 'complete'} : exact;

// The recorded verification, without the parts of a passing command that only describe how long it took to say so.
function neutralVerification(content, outcome = false) {
  const record = JSON.parse(content);
  const commands = record.commands?.map(command => {
    if (!isCommand(command) || !passed(command)) return command;
    const {stdout, stderr, stdout_bytes, stderr_bytes, stdout_digest, stderr_digest, ...rest} = command;
    return rest;
  });
  const reports = record.coverage_reports?.map(({report_digest, ...rest}) =>
    outcome && 'exact_coverage' in rest ? {...rest, exact_coverage: outcomeOf(rest.exact_coverage)} : rest);
  const {report_digest, ...rest} = record;
  if (outcome && 'exact_coverage' in rest) rest.exact_coverage = outcomeOf(rest.exact_coverage);
  return JSON.stringify({...rest, commands, ...(reports ? {coverage_reports: reports} : {})});
}

function neutral(value, outcome = false) {
  if (Array.isArray(value)) return value.map(item => neutral(item, outcome));
  if (value === null || typeof value !== 'object') return value;
  const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, neutral(item, outcome)]));
  if (copy.kind === 'verification' && typeof copy.content === 'string') copy.content = neutralVerification(copy.content, outcome);
  // Commit ids in a file's recent history are not the base or the head, even when one of them is the commit the base now
  // points at: they stay as they are, and are compared as a whole, instead of being replaced by a revision placeholder.
  if (Array.isArray(copy.history)) copy.history = copy.history.map(entry => ({...entry, commits: digest(entry.commits)}));
  if (copy.claims !== null && typeof copy.claims === 'object' && 'title' in copy.claims) copy.claims = {...copy.claims, title: null};
  return copy;
}

// `subs` is [[literal, token]]: the values of this run that name its revision.
const replace = (text, subs, from, to) => subs.reduce((out, sub) => out.split(sub[from]).join(sub[to]), text);

// The key of a task, or null when the task cannot be keyed safely (its prompt is not the documented shape, or the
// text already contains a placeholder, which would let two different prompts collide).
// Outcome keys name their mode, so an answer stored under one keying is never read under the other.
function keyOf(task, {subs, semantics, outcome = false}) {
  const cut = task.prompt.lastIndexOf('\n');
  let packet;
  try {
    packet = neutral(JSON.parse(task.prompt.slice(cut + 1)), outcome);
  } catch {
    return null;
  }
  const raw = JSON.stringify({role: task.role, phase: task.phase, schema: task.schema, text: task.prompt.slice(0, cut), packet});
  if (raw.includes(PREFIX)) return null;
  return digest({version: VERSION, semantics, ...(outcome ? {keying: 'outcome'} : {}), body: replace(raw, subs, 0, 1)});
}

// `literals()` gives the values of this run when a call is made: the digest of a snapshot changes when a source request
// adds evidence, so it is read per call. `read` turns reuse on; recording happens either way.
function createReuse({directory, read = false, semantics, literals, outcome = false}) {
  const pending = new Map();
  const stats = {reused: 0};
  const subsOf = () => {
    const {base, head, digests} = literals();
    return [[base, token('base')], [head, token('head')], ...digests.map((value, index) => [value, token(`digest-${index}`)])];
  };
  const file = key => path.join(directory, `${key}.json`);

  const load = (key, subs) => {
    try {
      const stored = JSON.parse(fs.readFileSync(file(key), 'utf8'));
      if (stored.version !== VERSION || stored.key !== key) return null;
      return JSON.parse(replace(stored.response, subs, 1, 0));
    } catch {
      return null;
    }
  };

  const wrap = ask => async task => {
    const subs = subsOf();
    const key = keyOf(task, {subs, semantics, outcome});
    if (key !== null && read) {
      const hit = load(key, subs);
      if (hit !== null) {
        try {
          task.check?.(hit.value);
          stats.reused++;
          return hit;
        } catch {
          // An answer that no longer validates against the new snapshot is not used; the reviewer is asked again.
        }
      }
    }
    const response = await ask(task);
    const text = JSON.stringify(response);
    if (key !== null && !text.includes(PREFIX)) pending.set(key, replace(text, subs, 0, 1));
    return response;
  };

  // Only an accepted review leaves answers behind.
  const commit = decision => {
    if (decision !== 'auto_approve' || !pending.size) return 0;
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    for (const [key, response] of pending) fs.writeFileSync(file(key), JSON.stringify({version: VERSION, key, response}), {mode: 0o600});
    return pending.size;
  };

  return {wrap, commit, stats};
}

module.exports = {createReuse, keyOf, neutral, PREFIX};
