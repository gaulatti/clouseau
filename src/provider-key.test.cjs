'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {keyProblem, assertProviderKey, MAX_LENGTH} = require('./provider-key.cjs');

test('only a bare printable ASCII credential passes and no message ever contains the value', () => {
  assert.equal(keyProblem('fictional-test-key_123'), null);
  const cases = [
    [undefined, 'is not configured'], ['', 'is not configured'], [42, 'is not configured'],
    ['fictional\n', 'contains whitespace or a line break'], [' fictional', 'contains whitespace or a line break'],
    ['fiction al', 'contains whitespace or a line break'], ['fictional\u0000', 'contains a non-printable or non-ASCII character'],
    ['fictionalé', 'contains a non-printable or non-ASCII character'], ['"fictional"', 'is wrapped in quotation marks'],
    ["'fictional", 'is wrapped in quotation marks'], ['x'.repeat(MAX_LENGTH + 1), `is longer than ${MAX_LENGTH} characters`],
  ];
  for (const [value, problem] of cases) {
    assert.equal(keyProblem(value), problem);
    let error;
    try {assertProviderKey('FICTIONAL_KEY', {FICTIONAL_KEY: value});} catch (caught) {error = caught;}
    assert.equal(error.message, `FICTIONAL_KEY ${problem}`);
    assert.equal(error.code, 'PROVIDER_KEY');
    assert.equal(error.cause_code, problem === 'is not configured' ? 'provider_key_missing' : 'provider_key_invalid');
    if (typeof value === 'string' && value.length > 3) assert.ok(!error.message.includes(value.trim()));
  }
  assert.doesNotThrow(() => assertProviderKey('FICTIONAL_KEY', {FICTIONAL_KEY: 'fictional'}));
});

test('the default environment is inspected without being changed', () => {
  const original = process.env.FICTIONAL_PROVIDER_KEY;
  process.env.FICTIONAL_PROVIDER_KEY = 'bad key';
  try {assert.throws(() => assertProviderKey('FICTIONAL_PROVIDER_KEY'), /FICTIONAL_PROVIDER_KEY contains whitespace/);} finally {
    if (original === undefined) delete process.env.FICTIONAL_PROVIDER_KEY; else process.env.FICTIONAL_PROVIDER_KEY = original;
  }
});
