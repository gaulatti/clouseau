# Clouseau

Shared coverage gates and evidence-led AI pull request approval for GitHub Actions.
Clouseau owns the PR intent review process: check whether a change is needed,
compare it with repository contracts and precedent, request the owner's second
opinion when necessary, and approve and arm auto-merge only after every technical
requirement passes. The initial implementation was extracted from Colombo.

## Ownership

Clouseau contains the coverage checker, regression tests, PR intent review rules,
DeepSeek integration, approval controller, and reusable composite action.
Each consuming repository keeps its build/test commands, a configuration file,
and its own purpose, contracts, acceptance criteria, and manual-review owner.
There is no application-specific deployment infrastructure in Clouseau.

## Operations

Use `gaulatti/clouseau@FULL_REVIEWED_COMMIT_SHA`. Pin the full commit, and update
that reference through a reviewed PR. Do not track `main` or a movable tag in a
consumer's privileged approval job. See `examples/colombo.json` for configuration.

| Operation | Inputs | Result |
| --- | --- | --- |
| `test` | none | Run Clouseau's Python and Node regression suites |
| `coverage` | `coverage-report`, `source-directory` | Require exact, nonempty 100% application line and branch coverage in LLVM JSON |
| `assess` | `config`, optional `pull-request`, `provider-key` | Wait for verification, then emit a read-only intent assessment |
| `gate` | `config`, `assessment`, optional `pull-request` | Validate protection, arm auto-merge, request owner review, or approve a verified revision |
| `evaluate-review` | `provider-key` | Evaluate the real model on fixed maintenance, product-drift, and test-fakery cases; no GitHub writes |
| `check-provider` | `provider-key` | Verify DeepSeek authentication and JSON output without touching a PR |
| `request-reassessment` | `config`, optional `pull-request` | Validate the maintainer trigger and rerun the exact trusted PR metadata workflow; never rebuild contributor code |
| `finalize` | `config`, `assessment` | Wait for GitHub auto-merge after the required native gate finishes, then preserve the existing CD handoff |

For example, a caller's coverage step supplies:

```yaml
with:
  operation: coverage
  coverage-report: coverage.json
  source-directory: src
```

The report must contain every compiled application path, including uncovered
code. Vendor/dependency coverage cannot mask application gaps. Counts must match
exactly; rounded percentages, missing data, or a zero branch total fail. The
caller owns instrumentation and test execution. Colombo uses Rust nightly branch
instrumentation with normal application cfgs, followed by docs and Docker tests.

## Trust and permissions

Keep test execution and privileged review in separate jobs. Contributor code runs
on disposable read-only PR runners with no secrets. Assessment and gating must
check out only the protected base branch; configuration, README, and repository
contract files are read from that trusted checkout. PR patches, source, commit
messages, and tickets are untrusted evidence and never executed by the reviewer.

The `assess` job needs actions/contents/pull-requests/issues read permissions and
the repository's `DEEPSEEK_API_KEY`. `gate` needs contents/pull-requests/issues/
checks/actions write permissions and must receive no provider key. Pass the
assessment output between jobs. The action cannot elevate the caller's token.
The shared model is `deepseek-flash`; changes are sent to it only after
technical verification succeeds. It assesses repository fit and supported intent,
including large test improvements. There is no file-count or line-count approval
cutoff. New product decisions and unclear scope require the owner’s judgment. Provider errors and incomplete evidence require
a second opinion. AI must also support test integrity with evidence about assertions
and failure cases. Detected test fakery blocks approval, including after an intent
confirmation. Coverage percentages alone cannot satisfy that assessment. No numerical confidence score grants approval.

`sensitive_paths` lists additional paths the consumer explicitly protects with
owner confirmation. The example leaves it empty; ordinary test, dependency,
and infrastructure paths are assessed by AI rather than rejected by filename.
The configured verification workflow, review controls, and repository-purpose
contract remain protected. Their changes still receive an AI integrity assessment
and require explicit owner confirmation.

The controller requires active effective base-branch rules: strict required
checks for the configured verification job and native `approve-and-merge` job
from GitHub Actions, a fresh approving review, no deletion, and no force pushes. The installing
administrator must also verify no bypass actors. Repository auto-merge and Actions
approving reviews must be enabled. Runtime tokens do not get administration access.

Manual decisions assign the PR to `manual_reviewer` and request that person's
review. Owner-authored PRs use assignment without an invalid self-review request.
The owner can comment `/approve-intent FULL_HEAD_SHA`; this confirms intent only.
All tests and exact coverage remain mandatory. Changes invalidate the decision.
The Actions bot cannot approve its own PR; it needs an independent human review.
First-time fork workflow authorization remains GitHub's responsibility.

The consumer must retain PR, metadata-only target, comment, and manual workflow
entry points and PR-level concurrency. The controller validates the exact latest
PR-event run, revision, verification job, and named steps from configuration.
The read-only `assess` job waits for the PR verification run to finish before
calling AI. Allow 70 minutes for this job when verification can take 60 minutes.
The separate native job named `approve-and-merge` calls `gate`; it must run on
`pull_request_target` and fail if assessment fails, intent is missing, integrity
is rejected, or technical evidence is incomplete. Use `always()` with `needs`
so a failed assessment cannot silently skip the required gate. In other event
contexts, use a different job name to avoid a skipped duplicate required check.
The `native-gate` and `wait-for-verification` action inputs default to `true`.

The informational `clouseau-review` API check preserves detailed reasons, but
GitHub's required result is the actual native job. A custom API check created by
`GITHUB_TOKEN` is insufficient for this flow. Comment/manual handlers call
`request-reassessment` with actions write and contents/pull-requests read access;
they rerun the current revision's existing `pull_request_target` run. Its test job
is skipped, so confirming intent does not rebuild the container. The handler
validates maintainer permission and exact comment SHA before requesting a rerun.

Run `finalize` in a separate job after the native gate succeeds, with actions
write and contents/pull-requests read access and no provider key. Auto-merge must
wait for the required gate job to finish, so deployment handoff cannot run inside
that gate. A provider diagnostic remains read-only and never approves a PR.

`deployment` is either `null` or an explicit workflow and path list. For a bot
merge touching those paths, Clouseau dispatches that existing workflow because
`GITHUB_TOKEN` merges suppress push-triggered workflows. It verifies main still
points at the merged revision. Deployment health, staged rollout, smoke tests,
bake windows, and ticket closure remain separate delivery work.

## Development

```sh
python3 -m unittest discover -s src -p 'test_*.py'
node --test src/*.test.cjs
```

Clouseau's own CI also requires exactly 100% line and branch coverage across
all production Python and JavaScript modules. New source files are included
even when no test imports them. Test code is outside the production scope;
there are no exclusions for production failure paths or rounded thresholds.

To run the same gate locally with Node 22:

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements-test.txt
./scripts/verify-coverage
```

CI also exercises the packaged composite action and verifies both passing and
failing coverage reports. No provider credential is needed for regression tests.
The new repository's wiki is not initialized; operational documentation lives
here until a wiki is available.

## Live model evaluations

The `evaluate-review` operation calls the real provider with three committed
synthetic review contexts. Maintenance must qualify, unrelated product scope
must request an owner decision, and test-specific validation bypasses must block
approval. A wrong or unavailable decision fails the evaluation. The GitHub and
technical-readiness inputs are fixtures; these evaluations validate model judgment,
not actual test execution or an end-to-end PR merge. Controller regression tests
use simulated provider decisions separately. Run live evaluations only in a
read-only diagnostic job with the provider key and no repository write token.
