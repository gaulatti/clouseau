'use strict';

const {digest} = require('./acceptance.cjs');

function compactSchema(schema, {definitionKey = '$defs', inlineEnums = false} = {}) {
  if (!['$defs', '$def'].includes(definitionKey)) throw new Error('Unsupported schema definition keyword');
  if (schema?.[definitionKey]) return structuredClone(schema);
  const definitions = {};
  const counts = new Map();
  const shape = value => value?.type === 'object' && value.properties ? `object_${digest(value)}` : null;
  function count(value) {
    if (!value || typeof value !== 'object') return;
    const id = shape(value);
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
    Object.values(value).forEach(count);
  }
  count(schema);
  function visit(value) {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    if (!inlineEnums && Array.isArray(value.enum) && value.enum.length > 1) {
      const id = `choice_${digest([value.type, value.enum])}`;
      definitions[id] = {type: value.type, enum: value.enum};
      return {...Object.fromEntries(Object.entries(value).filter(([key]) => !['type', 'enum'].includes(key))
        .map(([key, item]) => [key, visit(item)])), $ref: `#/${definitionKey}/${id}`};
    }
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    const id = shape(value);
    if (id && counts.get(id) > 1) {
      definitions[id] = result;
      return {$ref: `#/${definitionKey}/${id}`};
    }
    return result;
  }
  const result = visit(schema);
  return Object.keys(definitions).length ? {...result, [definitionKey]: definitions} : result;
}

module.exports = {compactSchema};
