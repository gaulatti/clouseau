'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {PRICING, estimate} = require('./review-cost.cjs');

test('comparison estimates include input, output, cache and both tariffs for the complete workflow', () => {
  const common = {provider: 'deepseek', requested_model: 'deepseek-flash', tokens: {
    prompt_tokens: 1000000, prompt_cache_hit_tokens: 400000, completion_tokens: 100000,
  }};
  const baseline = estimate([common, common]);
  const hybrid = estimate([common, {provider: 'typesafe', model: 'jev-1.13.0', tokens: {input_tokens: 1000000}}]);
  assert.equal(baseline.complete, true); assert.equal(baseline.requests, 2);
  assert.equal(baseline.known_cost_min, 0.3024); assert.equal(baseline.known_cost_max, 0.6048);
  assert.equal(hybrid.known_cost_min, 0.1932);
  const pro = estimate([{...common, requested_model: 'deepseek-v4-pro'}]);
  assert.equal(pro.known_cost_min, 0.6028); assert.equal(pro.known_cost_max, 1.2056);
  assert.equal(hybrid.pricing_as_of, PRICING.as_of); assert.equal(PRICING.sources.length, 2);
});

test('missing, inconsistent or unknown usage is explicitly unpriced rather than silently free', () => {
  const invalid = [
    {provider: 'other'}, {provider: 'typesafe', model: 'unqualified', tokens: {input_tokens: 10}},
    {provider: 'typesafe', model: 'jev-1.13.0', tokens: null},
    {provider: 'typesafe', model: 'jev-1.13.0', tokens: {input_tokens: -1}},
    {provider: 'deepseek', requested_model: 'unknown'},
    {provider: 'deepseek', requested_model: 'deepseek-flash', tokens: null},
    ...[{prompt_tokens: 1}, {prompt_tokens: 1, completion_tokens: -1},
      {prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 2},
    ].map(tokens => ({provider: 'deepseek', requested_model: 'deepseek-flash', tokens})),
  ];
  const result = estimate(invalid);
  assert.equal(result.complete, false); assert.equal(result.unknown_requests, invalid.length);
  assert.equal(estimate([]).complete, true);
});
