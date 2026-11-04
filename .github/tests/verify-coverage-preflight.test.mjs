import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '../../scripts/verify-coverage');

test('a missing Python coverage module stops verification early with an actionable error', () => {
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-no-coverage-'));
  try {
    fs.writeFileSync(path.join(stub, 'python3'), '#!/bin/sh\necho "No module named coverage" >&2\nexit 1\n', {mode: 0o755});
    const result = spawnSync('/bin/bash', [script], {encoding: 'utf8', env: {PATH: `${stub}:/usr/bin:/bin`}});
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Python coverage\.py is required/);
    assert.match(result.stderr, /pip install -r requirements-test\.txt/);
    assert.equal(result.stdout, '');
  } finally {fs.rmSync(stub, {recursive: true, force: true});}
});
