'use strict';

const {FACTORS, GATES, STATES, MAX_CITATION_LINES} = require('./acceptance.cjs');
const string = {type: 'string'};
const boolean = {type: 'boolean'};
const enumeration = values => ({type: 'string', enum: values});
const array = items => ({type: 'array', items});
const object = properties => ({type: 'object', properties, required: Object.keys(properties), additionalProperties: false});

function schemas(snapshot) {
  const referenceRule = 'Use evidence IDs declared verbatim in this report\'s evidence register. Every referenced ID must exist; source names and undeclared aliases are invalid.';
  const citations = {...array(string), description: referenceRule};
  const factor = object({evidence: citations, reason: string});
  const group = name => object(Object.fromEntries(FACTORS[name].map(key => [key, factor])));
  const need = group('need');
  need.properties.binding = object({evidence: {...citations, description: `${referenceRule} An established obligation requires a source marked authority=trusted and kind=contract. For an observed absence, cite the actual evidence without inventing contract authority; positive numeric grades require trusted proof after grading.`}, reason: string});
  const paths = array(enumeration(snapshot.paths));
  const anchors = [...new Set(snapshot.files.flatMap(file => [file.base_source, file.head_source]).filter(Boolean))];
  const end = {type: 'integer', minimum: 1, description: `Inclusive last line: start <= end < start + ${MAX_CITATION_LINES}. Select the narrow relevant lines, never a whole receipt or file.`};
  return {
    acceptance_report: object({version: {type: 'integer', const: 2}, snapshot: enumeration([snapshot.digest]), summary: string,
      evidence: array(object({id: string, source: enumeration(Object.keys(snapshot.sources)), start: {type: 'integer', minimum: 1}, end})),
      units: {...array(object({id: string, title: string, kind: enumeration(['capability', 'mechanism']), obligation: string,
        fit: group('fit'), need, excess: group('excess'), alternative: string})),
        description: 'Identify material outcomes and engineering choices. Account for accurate companion documentation of the same behavior within its accepted outcome, not as a separate feature needing a request for prose. Independently assess new promises, unrelated documentation and material mechanisms.'},
      findings: array(object({id: string, title: string, anchor: object({source: enumeration(anchors),
        start: {type: 'integer', minimum: 1}, end}), cause: string, trigger: string, consequence: string,
        obligation: string, evidence: citations, factors: group('defect'), blast_radius: {type: 'number', minimum: 1, maximum: 10},
        opportunity: object({mechanical: boolean, beneficial: boolean, within_scope: boolean, verified: boolean}), repair_paths: paths})),
      gates: array(object({name: enumeration(GATES), state: enumeration(STATES), reason: string, evidence: citations})),
      accounting: array(object({path: enumeration(snapshot.paths), units: array(string), evidence: {...citations,
        description: `${referenceRule} Include an ID citing this path's own changed base_source or head_source, not only other files or verification.`}, reason: string})),
      decisions: array(object({kind: enumeration(['purpose', 'authority', 'tradeoff']), question: string, options: array(string), evidence: citations})),
      resolutions: array(object({id: string, state: enumeration(['corrected', 'dismissed']), reason: string, evidence: citations})),
    }),
    source_request: object({request_sources: array(string)}),
  };
}

module.exports = {schemas};
