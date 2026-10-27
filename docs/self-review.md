# Clouseau self-review

The repository's local recipe runs the existing exact native Node
coverage gate, a Git-free archive test, and the workflow security/contract
suite. Use Node 22 and `requirements-test.txt` (coverage.py, used only by one real-report integration test), matching CI. Run the
global `clouseau review` command from a clean committed candidate. The accepted
base supplies the recipe and public signer enrollment; neither is trusted merely
because it appears on a proposed branch.

`scripts/verify-coverage` retains Node's native LCOV report at
`.clouseau-work/node.lcov`. The existing 100% line and branch thresholds and
complete source loader remain in force. No textual percentage is converted into
Istanbul or LLVM counters. Node's LCOV report is not a supported shared local
coverage adapter, so the local recipe deliberately records diagnostic
`coverage.status: unavailable` with no claimed aggregate counters. That is
separate from the real verification command results and never authorizes a
technical approval or merge. Independent CI continues to enforce the existing
native exact-coverage command and all other named checks.

The existing CI policy predates the local recipe. Generic first-install mode
must not treat that policy as absent. Enroll the proposed recipe and public key
through the existing owner-authorized controller installation procedure in
[change acceptance](change-acceptance.md), with a frozen owner-authored PR,
exact-head intent confirmation, independent verification and scored Clouseau
assessment. Preserve all existing rules and manual initial owner acceptance.
After that revision reaches protected main, a useful ordinary follow-up must
run the local examiner/challenger and demonstrate signed reuse in hosted CI
without model calls. Initial bootstrap alone does not complete that proof.

The registered public key identifies the native GitHub actor `gaulatti`. Private
signing material remains in the existing trusted local runner outside Git and
all review evidence. Normal bootstrap refresh and one frozen protected engine
revision remain mandatory.
