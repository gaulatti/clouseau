'use strict';
// One valid sample per documented optional `.clouseau-local.json` field (src/coverage-plan.cjs OPTIONAL_LOCAL_KEYS). Every
// reader-of-the-file guard builds its recipe from `everyOptional()`, so a field added to the list without a sample here fails
// every guard, and a field with a sample is exercised by every reader at once.
const {OPTIONAL_LOCAL_KEYS} = require('../src/coverage-plan.cjs');

const SAMPLES = Object.freeze({review_reuse: 'outcome'});

function everyOptional() {
  const missing = OPTIONAL_LOCAL_KEYS.filter(key => !Object.hasOwn(SAMPLES, key));
  if (missing.length) throw new Error(`No sample for optional .clouseau-local.json field(s): ${missing.join(', ')}`);
  return Object.fromEntries(OPTIONAL_LOCAL_KEYS.map(key => [key, SAMPLES[key]]));
}

module.exports = {SAMPLES, everyOptional};
