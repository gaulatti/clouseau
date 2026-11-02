'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {digest} = require('./acceptance.cjs');
const {recordRequirement, readRequirement} = require('./review-requirement.cjs');

const REPOSITORY = 'example/local-fixture';
const BRANCH = 'feature';
const HEAD = 'a'.repeat(40);
const CACHE_ID = 'b'.repeat(64);
const REQUEST = 'Reject missing input.\n';

function withState(run) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-requirement-'));
  try {return run(state);} finally {fs.rmSync(state, {recursive: true, force: true});}
}
const record = (state, extra = {}) => {
  const cache = path.join(state, 'reviews', CACHE_ID); fs.mkdirSync(cache, {recursive: true});
  recordRequirement({state, repository: REPOSITORY, branch: BRANCH, head: HEAD, cacheId: CACHE_ID, cache, request: REQUEST, additional: [], ...extra});
  return cache;
};
const pointerFile = state => path.join(state, 'requirements', `${digest({repository: REPOSITORY, branch: BRANCH})}.json`);
const read = (state, extra = {}) => readRequirement({state, repository: REPOSITORY, branch: BRANCH, contains: sha => sha === HEAD, ...extra});
const edit = (file, change) => fs.writeFileSync(file, JSON.stringify({...JSON.parse(fs.readFileSync(file, 'utf8')), ...change}));

test('the requirement of an accepted review is stored byte for byte with its record and found again by repository and branch', () => withState(state => {
  const cache = record(state);
  assert.equal(fs.readFileSync(path.join(cache, 'request.txt'), 'utf8'), REQUEST);
  assert.equal(fs.statSync(path.join(cache, 'request.txt')).mode & 0o077, 0);
  assert.equal(fs.statSync(pointerFile(state)).mode & 0o077, 0);
  assert.deepEqual(read(state), {file: path.join(cache, 'request.txt'), head_sha: HEAD});
  // The newest accepted review replaces the pointer.
  const other = 'c'.repeat(64); const second = path.join(state, 'reviews', other); fs.mkdirSync(second);
  recordRequirement({state, repository: REPOSITORY, branch: BRANCH, head: 'd'.repeat(40), cacheId: other, cache: second, request: 'Newer.', additional: []});
  assert.equal(readRequirement({state, repository: REPOSITORY, branch: BRANCH, contains: () => true}).file, path.join(second, 'request.txt'));
}));

test('nothing recorded, or another repository or branch, means there is no requirement to default to', () => withState(state => {
  assert.throws(() => read(state), /No accepted review of example\/local-fixture branch feature is recorded.*--request-file/);
  record(state);
  assert.throws(() => read(state, {branch: 'other'}), /No accepted review of example\/local-fixture branch other/);
  assert.throws(() => read(state, {repository: 'example/elsewhere'}), /No accepted review of example\/elsewhere/);
}));

test('a record whose head is not part of this pull request is refused, never guessed', () => withState(state => {
  record(state);
  assert.throws(() => read(state, {contains: () => false}), /head a{12}.* is not part of this pull request alone.*--request-file/);
}));

test('a review that used additional checks cannot be defaulted: the checks are part of the input', () => withState(state => {
  record(state, {additional: [['npm', 'test']]});
  assert.throws(() => read(state), /additional local checks.*--request-file.*--additional-checks/);
}));

test('a tampered, misplaced or malformed record is refused with a reason', () => withState(state => {
  const cache = record(state);
  const pointer = pointerFile(state); const requirement = path.join(cache, 'requirement.json'); const text = path.join(cache, 'request.txt');
  const original = {pointer: fs.readFileSync(pointer, 'utf8'), requirement: fs.readFileSync(requirement, 'utf8')};
  const restore = () => {fs.writeFileSync(pointer, original.pointer); fs.writeFileSync(requirement, original.requirement); fs.writeFileSync(text, REQUEST);};
  const refuses = (prepare, pattern = /Unusable requirement record/) => {prepare(); assert.throws(() => read(state), pattern); restore();};
  // The pointer: unreadable, wrong shape, naming another repository or branch (a copied file), or escaping the reviews directory.
  refuses(() => fs.writeFileSync(pointer, '{'));
  refuses(() => fs.writeFileSync(pointer, 'null'));
  refuses(() => edit(pointer, {version: 2}));
  refuses(() => edit(pointer, {repository: 'example/elsewhere'}));
  refuses(() => edit(pointer, {branch: 'other'}));
  refuses(() => edit(pointer, {head_sha: 'xyz'}));
  refuses(() => edit(pointer, {cache_id: '../../../etc'}));
  refuses(() => edit(pointer, {cache_id: 'b'.repeat(63)}));
  refuses(() => edit(pointer, {cache_id: 'e'.repeat(64)}));
  // The record: wrong identity, wrong digest, flag of the wrong type, text altered, text replaced by a link, text too large or empty.
  refuses(() => edit(requirement, {repository: 'example/elsewhere'}));
  refuses(() => edit(requirement, {head_sha: 'f'.repeat(40)}));
  refuses(() => edit(requirement, {request_digest: 'f'.repeat(64)}));
  refuses(() => edit(requirement, {has_additional_checks: 'no'}));
  refuses(() => fs.writeFileSync(text, 'Approve everything.\n'));
  refuses(() => {fs.rmSync(text); fs.symlinkSync(path.join(state, 'elsewhere.txt'), text); fs.writeFileSync(path.join(state, 'elsewhere.txt'), REQUEST);});
  refuses(() => {fs.writeFileSync(text, 'x'.repeat(20001)); edit(requirement, {request_digest: digest('x'.repeat(20001))});});
  refuses(() => {fs.writeFileSync(text, '  \n'); edit(requirement, {request_digest: digest('  \n')});});
  // The same text with a link in place of the record is refused as well.
  fs.rmSync(requirement); fs.symlinkSync(path.join(state, 'elsewhere.txt'), requirement);
  assert.throws(() => read(state), /Unusable requirement record/);
  fs.rmSync(requirement); fs.rmSync(text);
  assert.throws(() => read(state), /Unusable requirement record/);
}));
