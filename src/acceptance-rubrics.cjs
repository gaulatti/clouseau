'use strict';

// Ordered semantic anchors, not model-generated numbers. The controller owns
// their numeric positions; the provider only selects a described condition.
const RUBRICS = Object.freeze({
  completeness: {
    material_sources: ['The claimed completeness contradicts an explicit trusted inspection requirement or excludes required context without establishing it',
      'Material behavior depends on unavailable or uninspected source',
      'The source and dependency inventory leaves a material uncertainty',
      'Most context is established but a necessary dependency remains unverified',
      'All explicitly required and materially necessary sources are supplied and inspected, or a source-backed exclusion proves they do not apply; an unchanged path or test-only change cannot waive an explicit inspection requirement'],
  },
  fit: {
    outcome: ['Unrelated outcome', 'Weak indirect connection to the accepted purpose', 'Adjacent outcome needing an unaccepted product choice', 'Supports part of an accepted outcome', 'Directly delivers or repairs an accepted outcome'],
    workflow: ['Unrelated workflow', 'Hypothetical future workflow', 'Adjacent workflow not established by requirements', 'Supports an established workflow indirectly', 'Directly supports an established or explicitly accepted workflow'],
    domain: ['Different business or data domain', 'Mostly outside the accepted domain', 'Mixed accepted and unaccepted domain', 'Existing domain with a bounded documented extension', 'Entirely within the accepted domain'],
    boundary: ['Takes another component responsibility without authority', 'Substantially exceeds component responsibilities', 'Unresolved overlap in component responsibilities', 'Bounded justified extension of existing responsibility', 'Preserves the component responsibility boundary'],
    operating_model: ['Incompatible operating model', 'Adds an unsupported operating model', 'Requires unresolved operational commitments', 'Documented modest change within accepted operations', 'Preserves or directly improves the accepted operating model'],
  },
  need: {
    binding: ['No established obligation for this outcome', 'Only a contributor assertion of obligation', 'Inferred obligation not established by trusted requirements', 'Trusted requirement establishes part of the outcome', 'Trusted accepted requirement, demonstrated existing contract violation, or mandatory policy requires this outcome, including routine tests or accurate companion documentation directly supporting that same mandated outcome; unrelated prose or new promises do not inherit the obligation'],
    evidence: ['No evidence of need', 'Speculative future need', 'Concrete but incomplete evidence of need', 'Strong observed need with a bounded unresolved detail', 'Explicit accepted request, directly demonstrated defect, or measured requirement establishes need'],
    value: ['No useful improvement to the outcome', 'Minor convenience', 'Useful bounded improvement', 'Substantial improvement to a real workflow', 'Restores or enables a required user outcome'],
    unmetness: ['Existing capability already fully solves the need', 'Almost entirely duplicated capability', 'Need is partly unsolved', 'Most of the need remains unsolved', 'The existing behavior fails or lacks the required capability'],
    timeliness: ['No reason to address now', 'Only hypothetical later use', 'Useful now but safely deferrable', 'Present requirement or observed limitation', 'Current accepted work or active defect requires this now'],
  },
  excess: {
    abstraction: ['No demonstrated unnecessary abstraction', 'Small proven avoidable indirection', 'Material abstraction without demonstrated variations', 'A large speculative extension mechanism', 'Framework machinery serves no accepted requirement'],
    surface: ['Every added interface or option has an accepted role', 'A small unused optional surface', 'Material public or configuration surface lacks an accepted consumer', 'Most added surface has no accepted consumer', 'Added surface is wholly unrelated to accepted work'],
    authority: ['No demonstrated duplicated decision or state authority', 'Small avoidable duplicate representation', 'Material independent copies unnecessarily govern one fact', 'Competing sources of truth dominate the implementation', 'The mechanism is entirely redundant authority'],
    dependencies: ['Dependencies have necessary demonstrated capabilities', 'Small avoidable dependency burden with a feasible alternative', 'Material lifecycle burden without necessary capability', 'Most new operational dependencies are unnecessary', 'No new dependency serves an accepted requirement'],
    collateral: ['Changes are necessary to the accepted outcome', 'Small proven unrelated change', 'Material unrelated behavior or ownership changes', 'Most implementation expands beyond the accepted work', 'Implementation primarily performs unrelated work'],
    generalization: ['Design matches the demonstrated requirement', 'Small unnecessary generalization', 'Material broader problem solved without a requirement', 'Broad platform introduced for a narrow accepted need', 'The proposed platform has no demonstrated accepted use'],
  },
  defect: {
    necessity: ['No technical correction is established: the source disproves the technical failure, or the concern is solely product fit, authority or unnecessary machinery without a distinct runtime, data, security, compatibility or verification failure', 'Minor optional technical improvement', 'Real technical concern that can safely be deferred', 'Demonstrated current technical invariant requires correction before merge; product fit or avoidable machinery alone is not a technical invariant', 'Explicit accepted technical contract or mandatory execution/integrity rule requires correction; purpose authorization or proportionality alone belongs in the product assessment'],
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
