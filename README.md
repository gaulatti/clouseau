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
| `assess` | `config`, optional `pull-request`, `provider-key` | Read-only intent assessment; emits `assessment` JSON |
| `gate` | `config`, `assessment`, optional `pull-request` | Validate protection, arm auto-merge, request owner review, or approve a verified revision |
| `check-provider` | `provider-key` | Verify DeepSeek authentication and JSON output without touching a PR |

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
The shared model is `deepseek-flash`; small fixes are sent to it only after
technical verification succeeds. Provider errors and incomplete evidence require
a second opinion. No numerical confidence score grants approval.

The controller requires active effective base-branch rules: strict required
checks for the configured verification job and `approval-policy` from GitHub
Actions, a fresh approving review, no deletion, and no force pushes. The installing
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
If it waits for technical verification, it dispatches the consumer's configured
workflow again to perform assessment with a separate read-only credential context.

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

CI also exercises the packaged composite action and verifies both passing and
failing coverage reports. No provider credential is needed for regression tests.
The new repository's wiki is not initialized; operational documentation lives
here until a wiki is available.
