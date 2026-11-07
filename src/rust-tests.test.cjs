'use strict';

// Rust keeps unit tests inside the production file. These tests follow a changed `.rs` file through the
// approval hold: in-file test modules, Rust integration tests under `tests/`, and the cases that must
// still be held because the engine cannot show any test reaches the change.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {approvalHold} = require('./acceptance.cjs');
const {fixture} = require('../test/fixtures/acceptance.cjs');

const MODULE = [
  'pub fn parse(x: &str) -> usize {',       // 1
  '    x.len()',                             // 2
  '}',                                       // 3
  '',                                        // 4
  '#[cfg(test)]',                            // 5
  'mod tests {',                             // 6
  '    use super::*;',                       // 7
  '',                                        // 8
  '    #[test]',                             // 9
  '    fn parses() {',                       // 10
  '        assert_eq!(parse("ab"), 2);',     // 11
  '    }',                                   // 12
  '}',                                       // 13
  ''].join('\n');

function rust(content, patch, extra = [], path = 'backend/src/grpc.rs') {
  const f = fixture();
  const source = (id, where, text) => ({authority: 'untrusted', kind: 'source', ref: f.snapshot.head_sha, path: where, content: text});
  f.snapshot.sources = {head: source('head', path, content)};
  extra.forEach(([where, text], index) => {f.snapshot.sources[`extra${index}`] = source(`extra${index}`, where, text);});
  f.snapshot.files = [{path, status: 'modified', head_source: 'head', patch}];
  return f;
}
const held = f => approvalHold(f.report, f.snapshot);
const HOLD = /^no supplied test imports changed production code: backend\/src\/grpc\.rs$/;

test('a change inside an in-file test module counts as a supplied test of that file', () => {
  assert.equal(held(rust(MODULE, '@@ -10,3 +10,3 @@\n     fn parses() {\n-        assert_eq!(parse("ab"), 1);\n+        assert_eq!(parse("ab"), 2);\n     }\n')), null);
  assert.equal(held(rust(MODULE, '--- a/x\n+++ b/x\n@@ -11,2 +11,1 @@\n-        let a = 1;\n \n-        let b = 2;\n\\ No newline at end of file\n')), null, 'a removal inside the module');
  assert.equal(held(rust(MODULE, '@@ -0,0 +1,13 @@\n' + MODULE.split('\n').slice(0, 13).map(line => `+${line}`).join('\n') + '\n')), null, 'a new file that brings its own tests');
});

test('production code changed beside an untouched test module is still held', () => {
  assert.match(held(rust(MODULE, '@@ -1,3 +1,3 @@\n pub fn parse(x: &str) -> usize {\n-    x.len() + 1\n+    x.len()\n }\n')), HOLD);
  assert.match(held(rust(MODULE, '@@ -1,2 +1,2 @@\n+pub fn first() {}\n')), HOLD, 'a change ending before the module');
  assert.match(held(rust(MODULE, '@@ -14,0 +14,2 @@\n+fn after() {}\n+fn later() {}\n')), HOLD, 'a change after the module');
  assert.match(held(rust(MODULE, '--- a/x\n+++ b/x\n+not in a hunk\n')), HOLD, 'lines outside a hunk have no position');
});

test('a Rust file without a counting test module is held', () => {
  const change = '@@ -1,1 +1,1 @@\n+pub fn parse() {}\n';
  assert.match(held(rust('pub fn parse() {}\n', change)), HOLD, 'no tests at all');
  const helpers = '#[cfg(test)]\nmod support {\n    pub fn helper() {}\n}\n';
  assert.match(held(rust(helpers, '@@ -3,0 +3,1 @@\n+    pub fn helper() {}\n')), HOLD, 'a test module without a test function');
  assert.match(held(rust('#[cfg(test)]\nmod tests;\n', '@@ -2,0 +2,1 @@\n+mod tests;\n')), HOLD, 'a test module in another file');
  assert.match(held(rust('#[cfg(test)]\nmod tests {\n    #[test]\n    fn a() {\n', '@@ -3,0 +3,2 @@\n+    #[test]\n+    fn a() {\n')), HOLD, 'unbalanced braces');
  assert.match(held(rust('pub fn a() {}\n// #[cfg(test)] mod tests { #[test] fn a() {} }\nconst S: &str = "#[cfg(test)] mod t { #[test] }";\n', '@@ -2,0 +2,2 @@\n+// x\n+const S: &str = "y";\n')), HOLD, 'test-looking text in comments and strings');
  assert.match(held({...rust(MODULE, change), snapshot: {...rust(MODULE, change).snapshot, sources: {}}}), HOLD, 'a head source that was not supplied');
});

test('braces in comments, strings and character literals do not end a test module early', () => {
  const tricky = [
    '#[cfg(test)]',                                      // 1
    '#[allow(dead_code)]',                               // 2
    'pub(crate) mod tests {',                            // 3
    '    /* } */',                                       // 4
    '    const A: &str = "}\\"}";',                      // 5
    '    const B: &str = r#"}"#;',                       // 6
    "    const C: char = '}'; const D: char = '\\''; const E: &'static str = \"x\";",   // 7
    '    #[tokio::test(flavor = "multi_thread")]',       // 8
    '    async fn runs() {}',                            // 9
    '}',                                                 // 10
    'pub fn tail() {}',                                  // 11
    ''].join('\n');
  assert.equal(held(rust(tricky, '@@ -9,1 +9,1 @@\n+    async fn runs() {}\n')), null);
  assert.match(held(rust(tricky, '@@ -11,1 +11,1 @@\n+pub fn tail() {}\n')), HOLD, 'code after the module is production code');
});

test('every Rust test attribute spelling counts, and a similar attribute does not', () => {
  const module = attribute => `#[cfg(test)]\nmod tests {\n    ${attribute}\n    fn a() {}\n}\n`;
  for (const attribute of ['#[test]', '#[tokio::test]', '#[sqlx::test(migrations = "x")]', '#[rstest]', '#[test_case(1)]']) {
    assert.equal(held(rust(module(attribute), '@@ -3,1 +3,1 @@\n+    fn a() {}\n')), null, attribute);
  }
  for (const attribute of ['#[testing]', '#[derive(Debug)]', '#[cfg(testing)]']) {
    assert.match(held(rust(module(attribute), '@@ -3,1 +3,1 @@\n+    fn a() {}\n')), HOLD, attribute);
  }
});

test('an integration test that uses the module by its path under the same package counts', () => {
  const change = '@@ -1,1 +1,1 @@\n+pub fn parse() {}\n';
  const code = 'pub fn parse() {}\n';
  const accepted = text => assert.equal(held(rust(code, change, [['backend/tests/api.rs', text]])), null, text);
  for (const text of ['use monitor::grpc::parse;\n', 'use crate::grpc::{parse, other};\n', 'pub use monitor::grpc;\n', 'pub(crate) use my_crate::grpc::parse;\n', 'fn t() {}\n    use monitor::grpc::parse;\n']) accepted(text);
  const rejected = (text, extra) => assert.match(held(rust(code, change, [[extra || 'backend/tests/api.rs', text]])), HOLD, text);
  rejected('// use monitor::grpc::parse;\n');
  rejected('const S: &str = "use monitor::grpc::parse;";\n');
  rejected('use monitor::grpc_other::parse;\n');
  rejected('use monitor::grpcs;\n');
  rejected('use std::grpc::parse;\n');
  rejected('use core::grpc::parse;\n');
  rejected('use monitor::grpc::parse;\n', 'backend/src/helper.rs');
  rejected('use monitor::grpc::parse;\n', 'other/tests/api.rs');
  rejected('use monitor::grpc::parse;\n', 'backend/tests/api.py');
  const wrongRef = rust(code, change, [['backend/tests/api.rs', 'use monitor::grpc::parse;\n']]);
  wrongRef.snapshot.sources.extra0.ref = 'b'.repeat(40);
  assert.match(held(wrongRef), HOLD, 'a test from another revision');
  const notSource = rust(code, change, [['backend/tests/api.rs', 'use monitor::grpc::parse;\n']]);
  notSource.snapshot.sources.extra0.kind = 'diff';
  assert.match(held(notSource), HOLD, 'only source files are tests');
});

test('integration linkage follows Rust module paths', () => {
  const change = '@@ -1,1 +1,1 @@\n+pub fn x() {}\n';
  const linked = (path, text, tests) => held(rust('pub fn x() {}\n', change, [[tests, text]], path));
  assert.equal(linked('src/a/b.rs', 'use k::a::b::x;\n', 'tests/t.rs'), null, 'a nested module at the package root');
  assert.equal(linked('crates/k/src/a/mod.rs', 'use k::a::x;\n', 'crates/k/tests/t.rs'), null, 'mod.rs is named by its directory');
  assert.equal(linked('crates/k/src/a/b.rs', 'use k::a::b;\n', 'crates/k/tests/sub/t.rs'), null, 'a nested integration test file');
  assert.match(linked('src/a/b.rs', 'use k::a::x;\n', 'tests/t.rs'), /src\/a\/b\.rs$/, 'the whole path must match');
  for (const path of ['src/lib.rs', 'src/main.rs', 'src/mod.rs', 'build.rs']) assert.match(linked(path, 'use k::lib::x;\nuse k::main::x;\nuse k::build::x;\nuse k::mod::x;\n', 'tests/t.rs'), new RegExp(path.replace('.', '\\.') + '$'), `${path} is not reachable by a module path`);
});

test('other languages keep the import rule', () => {
  const body = 'export const x = 1;\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn a() {}\n}\n';
  const change = '@@ -1,6 +1,6 @@\n-export const y = 1;\n+export const x = 1;\n #[cfg(test)]\n mod tests {\n     #[test]\n';
  for (const path of ['src/app.ts', 'src/app.py', 'src/app.go.rs.ts']) {
    const f = rust(body, change, [['tests/app.rs', 'use k::app::x;\n']], path);
    assert.match(held(f), new RegExp(path.replace(/\./g, '\\.') + '$'), path);
  }
});
