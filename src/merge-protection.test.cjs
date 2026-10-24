'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {assertMergeProtection} = require('./merge-protection.cjs');

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

test('automatic mode never falls back when protection, settings or inspection is unavailable', async () => {
  const f = fixture();
  await assert.rejects(f.check(false), /auto-merge and main protection/);
  f.state.settings.allow_auto_merge = true;
  await assert.rejects(f.check(false), /auto-merge and main protection/);
  f.state.branch.protected = true;
  await assert.rejects(f.check(false), /Upgrade to GitHub Pro/);
  f.state.error = null;
  assert.deepEqual(await f.check(false), {enforced: true});
});
