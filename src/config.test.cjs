'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateConfig, loadConfig} = require('./config.cjs');
const valid = require('../examples/colombo.json');

test('configuration is explicit and cannot omit technical or owner requirements', () => {
  assert.deepEqual(validateConfig(valid), valid);
  for (const field of Object.keys(valid)) {
    const config = structuredClone(valid); delete config[field];
    assert.throws(() => validateConfig(config), /Invalid Clouseau/, field);
  }
  for (const mutate of [
    config => {config.version = 3;},
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

test('trusted configuration loading validates files and rejects missing or malformed input', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-config-'));
  try {
    const filename = path.join(directory, 'config.json');
    fs.writeFileSync(filename, JSON.stringify(valid));
    assert.deepEqual(loadConfig(filename), valid);
    assert.throws(() => loadConfig(), /trusted repository configuration/);
    assert.throws(() => loadConfig(path.join(directory, 'missing.json')), /ENOENT/);
    fs.writeFileSync(filename, 'invalid');
    assert.throws(() => loadConfig(filename), SyntaxError);
    fs.writeFileSync(filename, '{}');
    assert.throws(() => loadConfig(filename), /Invalid Clouseau/);
  } finally { fs.rmSync(directory, {recursive: true}); }
});

test('version two explicitly selects bounded qualified model roles and cannot alter policy thresholds', () => {
  const config = {...valid, version: 2, acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro',
    grader: 'deepseek', grading_model: 'deepseek-flash', repair_attempts: 2}};
  assert.deepEqual(validateConfig(config), config);
  assert.equal(validateConfig({...config, acceptance: {...config.acceptance, grader: 'typesafe'}}).acceptance.grader, 'typesafe');
  assert.equal(validateConfig({...config, acceptance: {...config.acceptance, grader: 'routed'}}).acceptance.grader, 'routed');
  for (const mutate of [
    c => {delete c.acceptance;}, c => {c.acceptance.examiner = 'unknown';}, c => {c.acceptance.challenger = 'unknown';},
    c => {c.acceptance.grader = 'unknown';}, c => {c.acceptance.grading_model = 'unqualified';},
    c => {c.acceptance.repair_attempts = 100;}, c => {c.acceptance.product_threshold = 0;},
  ]) {const changed = structuredClone(config); mutate(changed); assert.throws(() => validateConfig(changed), /acceptance configuration/);}
});
