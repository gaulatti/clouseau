'use strict';

// A re-run of failed jobs (`gh run rerun --failed`) starts a new attempt of the same run but does not repeat the
// assessment job that succeeded, so its acceptance artifact keeps the attempt number of the attempt that made it.
// The consuming jobs therefore resolve the artifact by run id and take the newest attempt that is not in the
// future, instead of assuming the current attempt. Artifacts of any other run or revision are never accepted.
const PREFIX = 'clouseau-acceptance-';

async function resolveArtifactName({github, context, attempt}) {
  const runId = Number(context.runId);
  const current = Number(attempt);
  if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(current) || current < 1) {
    throw new Error('Acceptance artifact lookup requires a positive run id and run attempt');
  }
  const pattern = new RegExp(`^${PREFIX}${runId}-([1-9][0-9]*)$`);
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {...context.repo, run_id: runId, per_page: 100});
  let best = null;
  for (const artifact of artifacts) {
    const match = pattern.exec(artifact.name);
    // The producer must be this run at this revision, and the artifact must still be downloadable.
    if (!match || artifact.expired || artifact.workflow_run?.id !== runId || artifact.workflow_run.head_sha !== context.sha) continue;
    const produced = Number(match[1]);
    if (produced <= current && (best === null || produced > best)) best = produced;
  }
  if (best === null) throw new Error(`No acceptance artifact of run ${runId} (attempts up to ${current}) is available; re-run the assessment job.`);
  return `${PREFIX}${runId}-${best}`;
}

module.exports = {PREFIX, resolveArtifactName};
