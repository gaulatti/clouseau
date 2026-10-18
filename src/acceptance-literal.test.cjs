'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateReport} = require('./acceptance.cjs');
const {fixture} = require('../test/fixtures/acceptance.cjs');

test('literal source evidence is bounded by its immutable source rather than the metadata length limit', () => {
  for (const literal of ['// ' + 'x'.repeat(2500), Array.from({length: 5}, (_, n) => `// line ${n}: ${'x'.repeat(500)}`).join('\n')]) {
    const {report, snapshot} = fixture();
    snapshot.sources.head.content = literal;
    require('./acceptance-sources.cjs').refresh(snapshot);
    report.snapshot = snapshot.digest;
    const evidence = report.evidence[1];
    evidence.start = 1; evidence.end = literal.split('\n').length; evidence.quote = literal;
    assert.equal(validateReport(report, snapshot).decision, 'auto_approve');
    for (const invalid of [null, 42, '', 'invented ' + literal]) {
      evidence.quote = invalid;
      assert.throws(() => validateReport(report, snapshot), /citation does not match immutable source/);
    }
    evidence.quote = literal;
    report.summary = 'x'.repeat(2001);
    assert.throws(() => validateReport(report, snapshot), /missing summary/, 'metadata retains its original length bound');
  }
});
