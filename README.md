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
| `plan-wiki` | `provider-key`, `wiki-config`, wiki/source checkouts | Generate and validate a coordinated multi-page draft after deployment; `wiki-draft: true` permits read-only validation |
| `publish-wiki` | `wiki-config`, validated `wiki-plan-path`, wiki/source checkouts | Revalidate deployment and publish every page in one non-force wiki commit; no provider key |
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
actions write permissions and must receive no provider key. Pass the
assessment output between jobs. The action cannot elevate the caller's token.
The shared model is `deepseek-flash`; changes are sent to it only after
technical verification succeeds. It assesses repository fit and supported intent,
including large test improvements. There is no file-count or line-count approval
cutoff. New product decisions and unclear scope require the owner’s judgment.
A missing or token-truncated provider completion is retried within the same
read-only assessment, using the identical evidence, at most three attempts total.
Retries wait one then two seconds. The output budget starts at 4,096 tokens and
doubles only after a token-limit truncation, capped at 16,384 tokens per request.
Every request retains its 90-second timeout. Fixed attempt/outcome/token-budget
categories are logged without model text, reasoning, patches, or credentials.
A complete verdict stops retries immediately, including second opinions,
integrity rejections, and invalid or wrong-revision evidence. HTTP failures,
network/decoding errors, unknown terminal finish reasons, and exhausted retries
fail closed and require a second opinion. The provider health probe is unchanged. AI must also support test integrity with evidence about assertions
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

The native job summary preserves detailed reasons; no additional API check is
created in native mode. A `GITHUB_TOKEN` API check can attach to another run's
suite and is insufficient as the required approval result for this flow. Comment/manual handlers call
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
not actual test execution or an end-to-end PR merge. The maintenance case injects
one synthetic truncated completion before calling the real provider to verify
automatic recovery within the same assessment. Logs identify that injection
explicitly; it is not evidence of a naturally occurring provider outage. Controller regression tests
use simulated provider decisions separately. Run live evaluations only in a
read-only diagnostic job with the provider key and no repository write token.

## Wiki maintenance after deployment

The [shared wiki policy](policy/wiki-maintenance.md) grounds documentation in the
exact deployment source revision and the existing wiki. A read-only job plans all
needed pages, then renders each against that common plan. Home/navigation updates
are included when needed. The full bundle is validated before it becomes an artifact;
no partial page set is publishable. The source context is complete or the job fails:
there is no silent truncation. Generation uses the same bounded incomplete-response
recovery as PR assessment, with at most three completions per manifest or page.

A separate publishing job receives no model key. It downloads only the artifact
from its own deployment run and checks the repository, source SHA, wiki base SHA,
and run ID. Both normal planning and publication verify that the expected main
workflow's configured deployment job actually completed successfully. A draft can
skip deployment verification, but publication never can. Scope `actions: read` and
`contents: read` to generation; grant `contents: write` only to publication. The
wiki checkout's credential must be available to Git only in the publishing job.
No deployment credential belongs in either documentation job.

Consumer `.github/clouseau-wiki.json` must specify all fields explicitly:

```json
{
  "version": 1,
  "source_paths": ["README.md", "src/", "migrations/", "Dockerfile", "compose.yaml", "Makefile", "scripts/", ".env.example", ".github/workflows/"],
  "deployment_workflow": "backend-deploy.yml",
  "deployment_job": "deploy",
  "wiki_branch": "master"
}
```

Only committed text in those paths is provided; real `.env` files and agent-rule
paths are refused. The current wiki must be a clean, initialized Git checkout.
Agent instructions are excluded from its model context. Supported pages are flat
Markdown filenames, including Home, `_Sidebar`, and `_Footer`. The model cannot
change configuration or delete pages. At most 20 pages, 128,000 bytes per page,
512,000 bytes per published bundle, 300 source files, and 1,000,000 bytes of base
source/wiki context are accepted. Exceeding a limit fails clearly without publishing.
Generated pages use ordinary inline Markdown links; broken links, orphaned new
pages, ambiguous names, unsafe paths, unsupported link syntax, and unclosed code
fences fail validation. External URLs are not fetched by the validator.

Use `plan-wiki` with `wiki-directory: wiki` and the source checkout at `.`. The
validated bundle is written to `work/wiki-plan.json` by default. Transfer it with
same-run Actions upload/download artifacts to `publish-wiki`; its `wiki-plan-path`
can point to the downloaded file. Pin both operations to a reviewed full commit.
Serialize the entire deployment-and-documentation workflow, with cancellation
disabled, so a later deployment cannot overtake documentation for an earlier one.

Publication fetches the wiki again and refuses an advanced base instead of rebasing
full generated pages over a person's edits. It builds a private Git index, keeping
working files and symlink targets untouched, and publishes a single non-force
commit. A push rejection publishes nothing. The controller-owned
`.clouseau-deployment.json` records the source SHA and deployment run. Repeated source
revisions spend no model credits and create no duplicate commit. When no Markdown
needs changing, only the documentation-check receipt is recorded; the summary
reports zero changed pages. Documentation failures are separate from deployment
success, and a wiki commit never asserts live application health.
