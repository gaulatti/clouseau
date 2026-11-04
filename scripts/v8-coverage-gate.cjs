#!/usr/bin/env node
'use strict';

// Usage: v8-coverage-gate.cjs RAW_V8_DIRECTORY LCOV_FILE [ROOT]
// Writes LCOV for the production sources under ROOT/src and exits 1 unless every
// line and branch is covered. See src/v8-coverage.cjs for why Node's merge is not used.
const path = require('node:path');
const {gate} = require('../src/v8-coverage.cjs');

const [coverage, lcov, root = path.resolve(__dirname, '..')] = process.argv.slice(2);
process.exitCode = gate({root: path.resolve(root), source: 'src', coverage: path.resolve(coverage), lcov: path.resolve(lcov), stdout: process.stdout});
