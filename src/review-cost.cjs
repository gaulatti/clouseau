'use strict';

// Published USD per million tokens, checked 2026-10-18. Estimates expose both
// DeepSeek tariffs; billing, holiday schedules and future prices remain with
// the provider. A missing usage field is unknown cost, never zero usage.
const PRICING = Object.freeze({as_of: '2026-10-18', sources: [
  'https://api-docs.deepseek.com/quick_start/pricing/', 'https://docs.typesafe.ai/models',
], deepseek: {'deepseek-flash': {hit: 0.003, miss: 0.15, output: 0.6},
  'deepseek-v4-pro': {hit: 0.022, miss: 0.66, output: 1.98}}, typesafe: {'jev-1.13.0': 0.042}});

function estimate(usage) {
  let min = 0, max = 0, unknown = 0;
  for (const entry of usage) {
    const tokens = entry.tokens;
    const valid = value => Number.isSafeInteger(value) && value >= 0;
    if (entry.provider === 'typesafe' && PRICING.typesafe[entry.model] && valid(tokens?.input_tokens)) {
      const cost = tokens.input_tokens * PRICING.typesafe[entry.model] / 1000000;
      min += cost; max += cost;
    } else if (entry.provider === 'deepseek' && PRICING.deepseek[entry.requested_model] &&
        valid(tokens?.prompt_tokens) && valid(tokens?.completion_tokens) && valid(tokens?.prompt_cache_hit_tokens) &&
        tokens.prompt_cache_hit_tokens <= tokens.prompt_tokens) {
      const prices = PRICING.deepseek[entry.requested_model];
      const cost = (tokens.prompt_cache_hit_tokens * prices.hit + (tokens.prompt_tokens - tokens.prompt_cache_hit_tokens) * prices.miss +
        tokens.completion_tokens * prices.output) / 1000000;
      min += cost; max += cost * 2;
    } else unknown++;
  }
  return {currency: 'USD', pricing_as_of: PRICING.as_of, complete: unknown === 0, unknown_requests: unknown,
    known_cost_min: min, known_cost_max: max, requests: usage.length};
}

module.exports = {PRICING, estimate};
