'use strict';
// The source inventory rules shared by the adapters that scan a source directory for application files.
//
// The default scope is the JS/TS inventory and is byte-for-byte what the adapters always applied. An lcov part may
// declare other source suffixes (`source_suffixes`); that custom scope keeps every default exclusion and adds only the
// explicit, documented language-neutral rules below. Nothing else is ever skipped.
const fs = require('node:fs');
const path = require('node:path');
const {validateSourceSuffixes} = require('./coverage-util.cjs');

const JS_SUFFIXES = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs'];
// Directories that never hold application source, at any depth.
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'vendor', 'test', 'tests', '__tests__']);
// Added for a custom suffix list only.
//  * `Tests` at any depth: the SwiftPM and Xcode spelling of `tests`; directory names are otherwise matched exactly.
//  * `target` directly under a source directory that holds a `Cargo.toml`, and `.build` directly under one that holds a
//    `Package.swift`: the Cargo and SwiftPM build outputs sit beside their manifest. A module that is merely named `target`
//    elsewhere (for example `src/target/`) is still application source.
const CUSTOM_EXCLUDED_ANYWHERE = new Set(['Tests']);
const BUILD_OUTPUTS = new Map([['target', 'Cargo.toml'], ['.build', 'Package.swift']]);

const IGNORE_DIRECTIVE = /\b(?:c8|istanbul|v8)\s+ignore\b/;
// Added for a custom suffix list only: the exclusion markers of lcov producers (LCOV_EXCL_*, GRCOV_EXCL_*), Rust's
// `#[coverage(off)]` and tarpaulin's skip attributes. Any mention fails the gate, as the JS/TS directives do.
const CUSTOM_IGNORE_DIRECTIVE = /\b(?:c8|istanbul|v8)\s+ignore\b|\b(?:LCOV|GRCOV)_EXCL|coverage\s*\(\s*off\s*\)|\btarpaulin(?:::skip|_include)\b/;

// `root` is the resolved source directory, consulted only for the manifest that makes a build-output directory.
function scopeFor(suffixes, root) {
  const custom = suffixes !== undefined;
  const list = custom ? validateSourceSuffixes(suffixes) : JS_SUFFIXES;
  const buildOutput = part => root !== undefined && BUILD_OUTPUTS.has(part) && fs.existsSync(path.join(root, BUILD_OUTPUTS.get(part)));
  return {
    custom,
    suffixes: new Set(list),
    label: custom ? list.join(' ') : 'JS/TS',
    ignorePattern: custom ? CUSTOM_IGNORE_DIRECTIVE : IGNORE_DIRECTIVE,
    // Whether the directory chain (names from the source directory down, ending at a directory) is excluded.
    excludesDirectories: parts => parts.some((part, index) => EXCLUDED_DIRECTORIES.has(part) ||
      custom && (CUSTOM_EXCLUDED_ANYWHERE.has(part) || index === 0 && buildOutput(part))),
  };
}

module.exports = {JS_SUFFIXES, EXCLUDED_DIRECTORIES, scopeFor, DEFAULT_SCOPE: scopeFor(undefined)};
