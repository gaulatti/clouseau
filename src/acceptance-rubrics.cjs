'use strict';

// Ordered semantic anchors, not model-generated numbers. The controller owns
// their numeric positions; the provider only selects a described condition.
const RUBRICS = Object.freeze({
  defect: {
    necessity: ['No technical correction is established: the source disproves the technical failure, or the concern is solely product fit, authority or unnecessary machinery without a distinct runtime, data, security, compatibility or verification failure', 'Minor optional technical improvement', 'Real technical concern that can safely be deferred', 'Demonstrated current technical invariant requires correction before merge, such as a changed boundary, comparison, rounding or output that no supplied test would fail on or that disagrees with its stated purpose for some inputs; product fit or avoidable machinery alone is not a technical invariant', 'Explicit accepted technical contract or mandatory execution/integrity rule requires correction, including a contract or policy requirement that a changed observable behaviour be shown by a test or fixture when no supplied test fails on the prior behaviour; purpose authorization or proportionality alone belongs in the product assessment'],
    confidence: ['Decisive counterevidence disproves the allegation', 'Only an unverified hypothesis supports the causal chain', 'Some causal links are supported but a necessary link is unverified', 'Strong trace with a remaining unverified premise', 'Complete feasible source proof or focused reproduction establishes the allegation'],
    severity: ['No runtime, data, security, compatibility or verification failure; product fit, authorization or avoidable machinery alone does not establish technical harm', 'Minor functional inconvenience', 'Bounded recoverable operation failure', 'Core workflow fails or gives materially wrong output', 'Severe technical contract failure including loss, compromise or complete unavailability'],
    activation: ['Proven inactive and not enabled by the accepted release', 'Requires an unaccepted future capability', 'Requires a separate explicit enabling step', 'Conditionally executable in the accepted release', 'Executable through the demonstrated current release path'],
    irreversibility: ['Rollback completely undoes the effect', 'Simple local correction restores the state', 'Restoration requires rerun or bounded repair', 'Substantial restoration with incomplete recovery', 'Lost originals or irreversible external or persistent effects'],
    reach: ['No affected work', 'One bounded operation', 'A limited subset of users or work', 'Broad workflow or multiple tenants affected', 'Shared path can affect the full supported workload'],
    detection: ['Immediate actionable failure is reported', 'Clearly visible operation failure', 'Failure appears only in ordinary logs', 'Failure is difficult to distinguish from success', 'Failure reports success or removes the necessary detection signal'],
    propagation: ['Failure stays local to the original operation', 'Small bounded secondary effect', 'A downstream operation is affected', 'Failure amplifies through retries, queues or dependencies', 'Failure spreads or corrupts multiple downstream workflows'],
    recurrence: ['Trigger cannot recur in the accepted release', 'Exceptional but feasible trigger', 'Occasional established workload condition', 'Common established workload condition', 'Ordinary workload or automatic retries repeatedly encounter it'],
  },
});

module.exports = {RUBRICS};
