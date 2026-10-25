'use strict';

const {FACTORS, GATES, STATES} = require('./acceptance.cjs');
const {proofCatalog} = require('./acceptance-sources.cjs');
const string = {type: 'string'};
const boolean = {type: 'boolean'};
const enumeration = values => ({type: 'string', enum: values});
const array = items => ({type: 'array', items});
const object = properties => ({type: 'object', properties, required: Object.keys(properties), additionalProperties: false});

function schemas(snapshot, {paged = false, inspectedSources = null, completenessReady = true, proofIds = null} = {}) {
  const catalog = proofCatalog(snapshot);
  const referenceRule = 'Select only the controller-supplied proof IDs. The controller owns the evidence register, exact source bytes and line ranges; never invent an alias.';
  const proof = paged ? proofIds === null ? {type: 'string', pattern: '^proof-(0|[1-9][0-9]*)-[1-9][0-9]*$'} :
    proofIds.length ? enumeration(proofIds) : {type: 'string', pattern: '^$',
      description: 'No citable source proof is available yet; request literal source pages before reporting facts.'} : enumeration(catalog.map(entry => entry.id));
  const citations = {...array(proof), description: referenceRule};
  const inspectedCitations = {...object({primary: proof, additional: array(proof)}), description:
    `${referenceRule} Select one primary proof and any distinct additional proofs. The controller preserves these citations without inventing evidence.`};
  const factor = object({evidence: citations, reason: string});
  const group = name => object(Object.fromEntries(FACTORS[name].map(key => [key, factor])));
  const need = group('need');
  need.properties.binding = object({evidence: {...citations, description: `${referenceRule} An established obligation requires a source marked authority=trusted and kind=contract. For an observed absence, cite the actual evidence without inventing contract authority; positive numeric grades require trusted proof after grading.`}, reason: string});
  const paths = array(enumeration(snapshot.paths));
  const available = [...new Set(Object.entries(snapshot.sources).filter(([id, source]) => source.ref === snapshot.head_sha &&
    (inspectedSources === null || inspectedSources.includes(id))).map(([, source]) => source.path))];
  const dependencies = {anyOf: [
    object({path: string, state: enumeration(['excluded']), reason: string, evidence: inspectedCitations}),
    object({path: string, state: enumeration(['missing']), reason: string}),
    ...(available.length ? [object({path: enumeration(available), state: enumeration(['inspected']), reason: string, evidence: inspectedCitations})] : []),
  ], description: 'Inspected dependencies require their own supplied current-head source and direct proof. A call site is not dependency inspection. Call source_request for absent material source before reporting inspected; otherwise explicitly exclude it or mark it missing.'};
  const source = {type: 'integer', enum: Object.keys(snapshot.sources).map((_, index) => index),
    description: 'Select the exact source_index supplied in the source catalog; the controller restores its full immutable ID.'};
  const excludable = Object.keys(snapshot.sources).map((id, index) =>
    !snapshot.files.some(file => [file.base_source, file.head_source].includes(id)) || !snapshot.sources[id].content.trim() ? index : -1)
    .filter(index => index >= 0);
  const sources = {anyOf: [
    object({source, state: enumeration(['inspected', 'excluded']), reason: string, evidence: inspectedCitations}),
    object({source, state: enumeration(['missing']), reason: string}),
  ]};
  const sourceInventory = snapshot.source_bank_version === 1 ? object(Object.fromEntries(Object.keys(snapshot.sources).map((id, index) =>
    [String(index), object({state: enumeration(['missing', ...(inspectedSources === null || inspectedSources.includes(id) ? ['inspected'] : []),
      ...(excludable.includes(index) ? ['excluded'] : [])]), reason: string, evidence: array(proof)})]))) : array(sources);
  if (snapshot.source_bank_version === 1) sourceInventory.description =
    `${referenceRule} Supply every required source_index key exactly once, including excluded and missing sources. Missing sources have an empty proof-ID array.`;
  const gateFields = {reason: string, evidence: citations};
  const gates = completenessReady ? object({name: enumeration(GATES), state: enumeration(STATES), ...gateFields}) : {anyOf: [
    object({name: enumeration(GATES.filter(name => name !== 'review_completeness')), state: enumeration(STATES), ...gateFields}),
    object({name: enumeration(['review_completeness']), state: enumeration(['unresolved', 'violated']), ...gateFields}),
  ]};
  const anchors = [...new Set(snapshot.files.flatMap(file => [file.base_source, file.head_source]).filter(Boolean))];
  const accountingFields = {units: array(string), evidence: {...citations,
    description: `${referenceRule} Include an ID citing this path's own changed base_source or head_source, not only other files or verification.`}, reason: string};
  const accounting = snapshot.source_bank_version === 1 ? object(Object.fromEntries(snapshot.paths.map(path =>
    [path, object(accountingFields)]))) : array(object({path: enumeration(snapshot.paths), ...accountingFields}));
  return {
    acceptance_report: object({version: {type: 'integer', const: 2}, snapshot: enumeration([snapshot.digest]), summary: string,
      units: {...array(object({id: string, title: string, kind: enumeration(['capability', 'mechanism']), obligation: string,
        fit: group('fit'), need, excess: group('excess'), alternative: string})),
        description: 'Identify material outcomes and engineering choices. Account for accurate companion documentation of the same behavior within its accepted outcome, not as a separate feature needing a request for prose. Independently assess new promises, unrelated documentation and material mechanisms.'},
      findings: array(object({id: string, title: string, anchor: paged ? proof : enumeration(catalog.filter(entry => anchors.includes(entry.source)).map(entry => entry.id)),
        cause: string, trigger: string, consequence: string,
        obligation: string, evidence: citations, factors: group('defect'), blast_radius: {type: 'number', minimum: 1, maximum: 10},
        opportunity: object({mechanical: boolean, beneficial: boolean, within_scope: boolean, verified: boolean}), repair_paths: paths})),
      gates: array(gates),
      accounting,
      decisions: array(object({kind: enumeration(['purpose', 'authority', 'tradeoff']), question: string, options: array(string), evidence: citations})),
      resolutions: array(object({id: string, state: enumeration(['corrected', 'dismissed']), reason: string, evidence: citations})),
      ...(snapshot.review_manifest_version ? {
        coverage: object({sources: sourceInventory,
          dependencies: array(dependencies)}),
        reopenings: array(object({id: string, reason: string, evidence: citations})),
      } : {}),
    }),
    source_request: object({request_sources: array(string)}),
  };
}

module.exports = {schemas};
