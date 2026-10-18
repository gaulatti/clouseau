'use strict';

const {FACTORS, GATES, STATES} = require('./acceptance.cjs');
const string = {type: 'string'};
const boolean = {type: 'boolean'};
const enumeration = values => ({type: 'string', enum: values});
const array = items => ({type: 'array', items});
const object = properties => ({type: 'object', properties, required: Object.keys(properties), additionalProperties: false});

function schemas(snapshot) {
  const citations = array(string);
  const factor = object({evidence: citations, reason: string});
  const group = name => object(Object.fromEntries(FACTORS[name].map(key => [key, factor])));
  const paths = array(enumeration(snapshot.paths));
  return {
    acceptance_report: object({version: {type: 'integer', const: 2}, snapshot: enumeration([snapshot.digest]), summary: string,
      evidence: array(object({id: string, source: enumeration(Object.keys(snapshot.sources)), start: {type: 'integer', minimum: 1}, end: {type: 'integer', minimum: 1}})),
      units: array(object({id: string, title: string, kind: enumeration(['capability', 'mechanism']), paths, obligation: string,
        fit: group('fit'), need: group('need'), excess: group('excess'), alternative: string})),
      findings: array(object({id: string, title: string, path: enumeration(snapshot.paths), cause: string, trigger: string, consequence: string,
        obligation: string, evidence: citations, factors: group('defect'), blast_radius: {type: 'number', minimum: 1, maximum: 10},
        opportunity: object({mechanical: boolean, beneficial: boolean, within_scope: boolean, verified: boolean}), repair_paths: paths})),
      gates: array(object({name: enumeration(GATES), state: enumeration(STATES), reason: string, evidence: citations})),
      accounting: array(object({path: enumeration(snapshot.paths), units: array(string), evidence: citations, reason: string})),
      decisions: array(object({kind: enumeration(['purpose', 'authority', 'tradeoff']), question: string, options: array(string), evidence: citations})),
      resolutions: array(object({id: string, state: enumeration(['corrected', 'dismissed']), reason: string, evidence: citations})),
    }),
    source_request: object({request_sources: array(string)}),
  };
}

module.exports = {schemas};
