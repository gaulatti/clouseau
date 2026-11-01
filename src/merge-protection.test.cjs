'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {assertMergeProtection, postProtectionNotice} = require('./merge-protection.cjs');

const unsupported = () => Object.assign(new Error('Upgrade to GitHub Pro or make this repository public to enable this feature.'), {status: 403});
function fixture() {
  const state = {settings: {private: true, allow_auto_merge: false}, branch: {protected: false}, checks: 0, error: unsupported()};
  const github = {rest: {repos: {
    get: async () => ({data: state.settings}),
    getBranch: async args => {assert.equal(args.branch, 'main'); return {data: state.branch};},
  }}};
  const check = manual => assertMergeProtection({github, repo: {owner: 'example', repo: 'app'}, baseBranch: 'main', manual,
    assertProtection: async () => {state.checks++; if (state.error) throw state.error;}});
  return {state, check};
}

test('explicit manual mode permits only the documented unavailable-private-plan protection error', async () => {
  const f = fixture();
  assert.equal((await f.check(true)).enforced, false);
  assert.equal(f.state.checks, 1);
  for (const change of [
    s => {s.settings.private = false;}, s => {delete s.settings.private;},
    s => {s.branch.protected = true;}, s => {delete s.branch.protected;},
    s => {s.error = Object.assign(new Error('Resource not accessible by integration'), {status: 403});},
    s => {s.error = Object.assign(new Error('Not found'), {status: 404});},
    s => {s.error = new Error('Upgrade to GitHub Pro or make this repository public');},
    s => {s.error = new Error('Missing required verification and approval checks');},
  ]) {
    const negative = fixture(); change(negative.state);
    await assert.rejects(negative.check(true));
  }
});

test('manual mode requires auto-merge disabled and continues to enforce all available protection', async () => {
  for (const enabled of [true, undefined]) {
    const f = fixture(); f.state.settings.allow_auto_merge = enabled;
    await assert.rejects(f.check(true), /auto-merge to be disabled/);
    assert.equal(f.state.checks, 0);
  }
  const f = fixture(); f.state.branch.protected = true; f.state.error = null;
  assert.deepEqual(await f.check(true), {enforced: true});
  assert.equal(f.state.checks, 1);
  f.state.error = new Error('Missing fresh approval');
  await assert.rejects(f.check(true), /fresh approval/);
  f.state.error = null; f.state.branch.protected = false;
  await assert.rejects(f.check(true), /Available branch protection/);
});

test('automatic mode reports bounded gaps instead of failing and never claims enforcement', async () => {
  const f = fixture();
  assert.deepEqual(await f.check(false), {enforced: false, insufficient: true, gaps: ['auto-merge disabled', 'main not protected']});
  assert.equal(f.state.checks, 0);
  f.state.settings.allow_auto_merge = true;
  assert.deepEqual((await f.check(false)).gaps, ['main not protected']);
  f.state.branch.protected = true;
  await assert.rejects(f.check(false), /Upgrade to GitHub Pro/);
  f.state.error = Object.assign(new Error('x'), {gaps: ['up-to-date missing']});
  assert.deepEqual((await f.check(false)).gaps, ['up-to-date missing']);
  f.state.error = null;
  assert.deepEqual(await f.check(false), {enforced: true});
});

test('the protection notice is one fixed-text comment updated in place', async () => {
  const comments = [{id: 1, user: {type: 'User'}, body: '<!-- clouseau-protection-notice -->\nspoof'}];
  const writes = [];
  const github = {paginate: async () => comments, rest: {issues: {
    createComment: async a => {writes.push(['create', a]); comments.push({id: 2, user: {type: 'Bot'}, body: a.body});},
    updateComment: async a => writes.push(['update', a])}}};
  const post = gaps => postProtectionNotice({github, repo: {owner: 'o', repo: 'r'}, pull_number: 3, gaps});
  const body = await post(['main not protected']);
  assert.match(body, /insufficient: main not protected\./);
  assert.equal(writes[0][0], 'create');
  await post(['main not protected']);
  assert.equal(writes.length, 1);
  await post(['auto-merge disabled']);
  assert.deepEqual(writes[1][1].comment_id, 2);
  assert.equal(writes[1][0], 'update');
});

test('explicit owner automatic mode admits only the unavailable private-plan path with native auto-merge disabled', async () => {
  const f = fixture();
  const run = () => assertMergeProtection({github: {rest: {repos: {
    get: async () => ({data: f.state.settings}), getBranch: async () => ({data: f.state.branch}),
  }}}, repo: {}, baseBranch: 'main', manual: false, privateOwnerAutomatic: true,
  assertProtection: async () => {if (f.state.error) throw f.state.error;}});
  assert.equal((await run()).controllerManaged, true);
  f.state.error = Object.assign(new Error('Resource not accessible by integration'), {status: 403});
  await assert.rejects(run(), /accessible/);
  f.state.error = null;
  await assert.rejects(run(), /Available branch protection/);
  f.state.error = unsupported(); f.state.settings.allow_auto_merge = true;
  assert.equal((await run()).insufficient, true);
});
