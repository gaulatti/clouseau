'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateConfig} = require('./config.cjs');
const valid = require('../examples/colombo.json');

test('configuration is explicit and cannot omit technical or owner requirements', () => {
  assert.deepEqual(validateConfig(valid), valid);
  for (const field of Object.keys(valid)) {
    const config = structuredClone(valid); delete config[field];
    assert.throws(() => validateConfig(config), /Invalid Clouseau/, field);
  }
  for (const mutate of [
    config => {config.version = 2;},
    config => {config.repository_policy = '../untrusted.md';},
    config => {config.readme = '/tmp/untrusted.md';},
    config => {config.manual_reviewer = '';},
    config => {config.workflow = '../other.yml';},
    config => {config.verification.steps = ['Only lint'];},
    config => {config.deployment.paths = [];},
  ]) {
    const config = structuredClone(valid); mutate(config);
    assert.throws(() => validateConfig(config), /Invalid Clouseau/);
  }
  assert.equal(validateConfig({...valid, deployment: null}).deployment, null);
});
