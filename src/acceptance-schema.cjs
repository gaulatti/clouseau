'use strict';

const {FACTORS, GATES, STATES} = require('./acceptance.cjs');
const {proofCatalog} = require('./acceptance-sources.cjs');
const string = {type: 'string'};
const boolean = {type: 'boolean'};
const enumeration = values => ({type: 'string', enum: values});
const array = items => ({type: 'array', items});
const object = properties => ({type: 'object', properties, required: Object.keys(properties), additionalProperties: false});

function schemas(snapshot) {
  const catalog = proofCatalog(snapshot);
  const referenceRule = 'Select only the controller-supplied proof IDs. The controller owns the evidence register, exact source bytes and line ranges; never invent an alias.';
  const proof = enumeration(catalog.map(entry => entry.id));
  const citations = {...array(proof), description: referenceRule};
  const inspectedCitations = {...object({primary: proof, additional: array(proof)}), description:
    `${referenceRule} Select one primary proof and any distinct additional proofs. The controller preserves these citations without inventing evidence.`};
  const factor = object({evidence: citations, reason: string});
  const group = name => object(Object.fromEntries(FACTORS[name].map(key => [key, factor])));
  const paths = array(enumeration(snapshot.paths));
  const available = [...new Set(Object.values(snapshot.sources).filter(source => source.ref === snapshot.head_sha).map(source => source.path))];
  const dependencies = {anyOf: [
    object({path: string, state: enumeration(['excluded']), reason: string, evidence: inspectedCitations}),
    object({path: string, state: enumeration(['missing']), reason: string}),
    ...(available.length ? [object({path: enumeration(available), state: enumeration(['inspected']), reason: string, evidence: inspectedCitations})] : []),
  ], description: 'Inspected dependencies require their own supplied current-head source and direct proof. A call site is not dependency inspection. Call source_request for absent material source before reporting inspected; otherwise explicitly exclude it or mark it missing.'};
  const source = {type: 'integer', enum: Object.keys(snapshot.sources).map((_, index) => index),
    description: 'Select the exact source_index supplied in the source catalog; the controller restores its full immutable ID.'};
  const sources = {anyOf: [
    object({source, state: enumeration(['inspected', 'excluded']), reason: string, evidence: inspectedCitations}),
    object({source, state: enumeration(['missing']), reason: string}),
  ]};
  const anchors = [...new Set(snapshot.files.flatMap(file => [file.base_source, file.head_source]).filter(Boolean))];
  return {
    acceptance_report: object({version: {type: 'integer', const: 4}, snapshot: enumeration([snapshot.digest]), summary: string,
      units: {...array(object({id: string, title: string, kind: enumeration(['capability', 'mechanism']), obligation: string})),
        description: 'Group the change into material outcomes and engineering choices so every changed file is accounted for. Account for accurate companion documentation of the same behavior within its accepted outcome.'},
      findings: array(object({id: string, title: string, anchor: enumeration(catalog.filter(entry => anchors.includes(entry.source)).map(entry => entry.id)),
        cause: string, trigger: string, consequence: string,
        obligation: string, evidence: citations, factors: group('defect'), blast_radius: {type: 'number', minimum: 1, maximum: 10},
        opportunity: object({mechanical: boolean, beneficial: boolean, within_scope: boolean, verified: boolean}), repair_paths: paths})),
      gates: array(object({name: enumeration(GATES), state: enumeration(STATES), reason: string, evidence: citations})),
      accounting: array(object({path: enumeration(snapshot.paths), units: array(string), evidence: {...citations,
        description: `${referenceRule} Include an ID citing this path's own changed base_source or head_source, not only other files or verification.`}, reason: string})),
      resolutions: array(object({id: string, state: enumeration(['corrected', 'dismissed']), reason: string, evidence: citations})),
      ...(snapshot.review_manifest_version ? {
        coverage: object({sources: array(sources),
          dependencies: array(dependencies)}),
        reopenings: array(object({id: string, reason: string, evidence: citations})),
      } : {}),
    }),
    source_request: object({request_sources: array(string)}),
  };
}

module.exports = {schemas};
