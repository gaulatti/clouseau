# Freezing protected central main

Review source inventories use controller-assigned numeric indices over the model
transport. The controller restores each full immutable source ID before the
existing completeness validation. Unknown, duplicated or substituted sources
remain errors; malformed evidence cannot authorize approval.
The report schema permits an inspected dependency only when its current-head
source is supplied. Call-site evidence cannot establish dependency inspection;
missing material source must be requested or explicitly reported missing.

The stable `scripts/resolve` composite bootstrap defines “latest” as the commit
on `gaulatti/clouseau` protected `main` when its isolated resolution job executes.
Its repository and branch are fixed in reviewed source. It takes no source
inputs from the caller, PR text, model output or uploaded evidence.

The bootstrap validates the protected branch response and full immutable SHA,
checks out that exact commit, and invokes the digest implementation from the
frozen source. This allows later digest implementation releases without changing
the stable bootstrap pin. Missing, malformed, unprotected or unavailable source
fails; there is no old-version fallback.

The `sha` and `digest` outputs are the run selection. Integrated workflows must
resolve only once, make every engine job directly depend on that job, check out
its SHA and supply those values to the shared action. A central advance cannot
change those existing outputs; a later run can select the newer revision.

The workflow summary and `clouseau-engine-RUN_ID-RUN_ATTEMPT` artifact record the
source, exact SHA and computed digest. Separate workflows make separate
selections. This bootstrap adds no consumer workflow, provider credential,
branch rule, private bastille dependency or production deployment.

The next protocol change will bind review/receipt/approval to these outputs;
consumer installations enable that wiring through separately reviewed PRs.
