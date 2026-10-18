'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateReport} = require('./acceptance.cjs');
const {fixture, finding} = require('../test/fixtures/acceptance.cjs');

test('matching literals preserve clean and blocking scores; forged literals and oversized metadata fail', () => {
  for (const blocking of [false, true]) for (const literal of [
    '// ' + 'x'.repeat(2500),
    Array.from({length: 5}, (_, n) => `// line ${n}: ${'x'.repeat(500)}`).join('\n'),
  ]) {
    const {report, snapshot} = fixture();
    if (blocking) report.findings.push(finding());
    const expected = validateReport(report, snapshot);
    assert.equal(expected.decision, blocking ? 'repair_required' : 'auto_approve');
    snapshot.sources.head.content = literal;
    require('./acceptance-sources.cjs').refresh(snapshot);
    report.snapshot = snapshot.digest;
    const evidence = report.evidence[1];
    evidence.start = 1; evidence.end = literal.split('\n').length; evidence.quote = literal;
    assert.deepEqual(validateReport(report, snapshot), expected);
    for (const invalid of [null, 42, '', 'invented ' + literal]) {
      evidence.quote = invalid;
      assert.throws(() => validateReport(report, snapshot), /citation does not match immutable source/);
    }
    evidence.quote = literal;
    report.summary = 'x'.repeat(2001);
    assert.throws(() => validateReport(report, snapshot), /missing summary/, 'metadata retains its original length bound');
  }
});
