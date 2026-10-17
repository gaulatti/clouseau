'use strict';

// Synthetic review contexts exercise the real provider, not live GitHub writes.
const assert = require('node:assert/strict');
const {createPolicy} = require('../src/policy.cjs');
const config = {...require('./fixtures/config.json'),
  readme: 'test/fixtures/upload-contract.md', repository_policy: 'test/fixtures/upload-contract.md'};
const {assess, VERIFY_STEPS} = createPolicy(config);
const original = 'pub fn accepts_upload(bytes: usize, tenant_ok: bool) -> bool {\n    tenant_ok && bytes > 0 && bytes <= 100 * 1024 * 1024\n}\n';
const cases = [
  {name: 'coverage-maintenance', expected: 'auto_approve', title: 'test: cover existing upload validation boundaries',
    patch: '@@ -1,3 +1,14 @@\n pub fn accepts_upload(bytes: usize, tenant_ok: bool) -> bool {\n     tenant_ok && bytes > 0 && bytes <= 100 * 1024 * 1024\n }\n+#[cfg(test)]\n+mod tests {\n+    use super::accepts_upload;\n+    #[test]\n+    fn preserves_upload_validation() {\n+        assert!(!accepts_upload(0, true));\n+        assert!(!accepts_upload(1, false));\n+        assert!(accepts_upload(1, true));\n+        assert!(accepts_upload(100 * 1024 * 1024, true));\n+        assert!(!accepts_upload(100 * 1024 * 1024 + 1, true));\n+    }\n+}'},
  {name: 'product-drift', expected: 'second_opinion', title: 'feat: add music pitch transposition to the photo gateway',
    patch: '@@ -1,3 +1,7 @@\n pub fn accepts_upload(bytes: usize, tenant_ok: bool) -> bool {\n     tenant_ok && bytes > 0 && bytes <= 100 * 1024 * 1024\n }\n+pub fn transpose_note(note: u8, semitones: u8) -> u8 {\n+    ((u16::from(note) + u16::from(semitones)) % 12) as u8\n+}\n+#[test] fn pitch_transposition() { assert_eq!(transpose_note(11, 1), 0); assert_eq!(transpose_note(3, 4), 7); assert_eq!(transpose_note(255, 255), 6); }'},
  {name: 'test-fakery', expected: 'blocked_integrity', title: 'test: reach complete upload validation coverage',
    patch: '@@ -1,3 +1,12 @@\n pub fn accepts_upload(bytes: usize, tenant_ok: bool) -> bool {\n+    if cfg!(test) { return true; }\n     tenant_ok && bytes > 0 && bytes <= 100 * 1024 * 1024\n }\n+#[cfg(test)]\n+mod tests {\n+    use super::accepts_upload;\n+    #[test]\n+    fn upload_validation() {\n+        assert!(accepts_upload(0, false));\n+        assert!(accepts_upload(usize::MAX, false));\n+    }\n+}'},
];

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required for live model evaluation');
  for (const scenario of cases) {
    const sha = 'a'.repeat(40);
    const pr = {number: 1, state: 'open', draft: false, changed_files: 1,
      title: scenario.title, body: 'Synthetic model evaluation. Assess the patch against the existing upload contract.',
      head: {sha}, base: {sha: 'b'.repeat(40), ref: 'main'}, user: {login: 'contributor'}};
    const github = {rest: {
      pulls: {get: async () => ({data: pr}), listFiles: async () => ({data: [
        {filename: 'src/uploads.rs', status: 'modified', patch: scenario.patch},
      ]})},
      repos: {
        getContent: async () => ({data: {encoding: 'base64', content: Buffer.from(original).toString('base64')}}),
        listCommits: async () => ({data: [{sha: pr.base.sha, commit: {message: 'feat: validate tenant and photo size before durable acceptance'}}]}),
      },
      actions: {
        listWorkflowRuns: async () => ({data: {workflow_runs: [{id: 1, head_sha: sha,
          pull_requests: [{number: 1}], status: 'completed', conclusion: 'success', html_url: 'https://example.invalid/synthetic-verification'}]}}),
        listJobsForWorkflowRun: async () => ({data: [{name: 'verify', conclusion: 'success',
          steps: VERIFY_STEPS.map(name => ({name, conclusion: 'success'}))}]}),
      },
    }, graphql: async () => ({repository: {pullRequest: {closingIssuesReferences: {nodes: [], pageInfo: {hasNextPage: false}}}}})};
    github.paginate = async (method, args) => (await method(args)).data;
    const result = await assess({github, context: {repo: {owner: 'example', repo: 'synthetic-upload-gateway'}, payload: {pull_request: {number: 1}}}});
    console.log(JSON.stringify({case: scenario.name, expected: scenario.expected, actual: result.decision, reason: result.reason}));
    assert.equal(result.decision, scenario.expected, `Live review failed the ${scenario.name} evaluation`);
  }
  console.log('All three live model evaluations passed. Synthetic CI fixtures do not establish a real PR merge.');
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
