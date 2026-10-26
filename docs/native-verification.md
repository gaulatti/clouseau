# Native verification traces

Run the existing verification commands from the repository root:

```sh
bash scripts/verify-coverage
bash scripts/verify-archive
```

Both commands run their selected Node tests once. The native `spec` reporter writes
every case, diagnostic, test stdout/stderr message and coverage summary to a
separate file from that same execution. The wrapper prints its actual native
outcome and retained artifact identities on completion, forwarding raw child
stdout/stderr unchanged. Node 22 supports paired
[reporters and destinations](https://nodejs.org/download/release/v22.22.0/docs/api/test.html#multiple-reporters).
The reporter format is native Node output; the reporting helper does not parse
it, invent test counts or rerun tests to obtain another report.

Each run creates a new private directory beneath the already ignored
`.clouseau-work/verification-runs/`:

```text
coverage-UNIQUE/                 # or archive-UNIQUE/
  started.json                  # run identity, exact native argv and start time
  native.spec.log               # complete native per-case report
  native.stdout                 # exact child command stdout bytes
  native.stderr                 # exact child command stderr bytes
  manifest.json                 # outcome, paths, byte counts and SHA-256 hashes
```

Per-test stdout/stderr messages are in the complete spec trace; `native.stdout`
and `native.stderr` are the raw streams of the Node command running the
reporters. They are retained without truncation. The console names the full
trace and its actual SHA-256, plus the manifest and its SHA-256. The manifest
records Node version, executable, argv, working directory, native PID, timing,
exit code or signal, forwarded interrupts, and any native spawn error. It also
records the actual helper-module path and digest, including its archived copy. A failed spawn records no
invented native exit status. Missing required trace output fails reporting.

New runs use different directories and never replace the artifact referenced by
an earlier run. Keep the referenced directory with the associated review or CI
evidence. The files remain ordinary operator-owned artifacts; verify their
recorded hashes when copying or inspecting them. They are not a signing or
attestation mechanism.

On a nonzero native exit or interruption, the helper streams the complete
available spec trace to the console as well as retaining it. Native stderr is
also forwarded unchanged. SIGINT, SIGTERM, SIGHUP and SIGQUIT are forwarded to the native
process; its actual exit code or terminating signal remains the command outcome.
A process killed before it can finish may have only its started record and
available trace bytes. No test timeout or process-output limit is raised.

The archive command creates its trace destination in the original checkout
before entering the temporary Git-free archive. Traces therefore survive both
successful and failed archive teardown. The temporary archive is still removed.

Coverage keeps its original test selection, source include/exclude flags,
100% line/branch thresholds, and `.clouseau-work/node.lcov` destination. Python
commands, workflow tests, local recipe, CI policies and providers are unchanged.
The coverage invocation uses only native spec and the existing LCOV reporter.
Adding a third dot reporter produces a real Node22 listener warning, so live
dots are deliberately avoided without suppressing warnings or changing limits.
Compact successful reporting does not change the tests executed or any gate.
