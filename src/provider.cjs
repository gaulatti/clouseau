'use strict';

async function checkProvider({fetchImpl = fetch} = {}) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not configured');
  const response = await fetchImpl('https://api.deepseek.com/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(90000),
    headers: {Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({model: 'deepseek-flash', thinking: {type: 'enabled'}, reasoning_effort: 'low', max_tokens: 4096,
      response_format: {type: 'json_object'}, messages: [
        {role: 'system', content: 'You are a provider health check. Return valid JSON only, without tools or markdown.'},
        {role: 'user', content: 'Return exactly this JSON object: {"ok":true}'},
      ]}),
  });
  if (!response.ok) throw new Error(`DeepSeek provider check failed: HTTP ${response.status}`);
  const result = await response.json();
  if (result.choices?.[0]?.finish_reason !== 'stop' ||
      JSON.parse(result.choices[0].message.content).ok !== true) {
    throw new Error('DeepSeek did not return the expected structured result');
  }
}

// Retry only missing/truncated completions, never a completed review decision.
async function requestReview({messages, fetchImpl = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), report = () => {}}) {
  let maxTokens = 4096;
  let outcome;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetchImpl('https://api.deepseek.com/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: {Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({model: 'deepseek-flash', thinking: {type: 'enabled'}, reasoning_effort: 'low',
        max_tokens: maxTokens, response_format: {type: 'json_object'}, messages}),
    });
    if (!response.ok) return {failure: `AI assessment unavailable: provider HTTP ${response.status}`};
    const body = await response.json();
    const choice = body.choices?.[0];
    const finish = choice?.finish_reason;
    outcome = finish === 'stop' ? 'complete' : finish === 'length' ? 'length' : finish === undefined ? 'missing' : 'other';
    // Fixed categories only: never print response text, reasoning, patches, or credentials.
    report(`AI assessment provider attempt ${attempt}/3: ${outcome}, max_tokens=${maxTokens}`);
    if (finish === 'stop') return {content: choice.message?.content};
    if (outcome !== 'length' && outcome !== 'missing') {
      return {failure: `AI assessment incomplete after ${attempt} attempt(s) (provider outcome: ${outcome})`};
    }
    if (attempt < 3) {
      if (outcome === 'length') maxTokens *= 2;
      await wait(attempt * 1000);
    }
  }
  return {failure: `AI assessment incomplete after 3 attempt(s) (provider outcome: ${outcome})`};
}

// Documentation uses native response schemas; PR review stays on its existing API.
async function requestWiki({messages, schema, model = 'deepseek-flash', fetchImpl = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), report = () => {}}) {
  if (!schema || schema.type !== 'object') throw new Error('Wiki JSON schema is required');
  if (!['deepseek-flash', 'deepseek-v4-pro'].includes(model)) throw new Error('Unsupported wiki model');
  let maxTokens = 4096;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetchImpl('https://api.deepseek.com/beta/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: {Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({model, thinking: {type: 'disabled'}, temperature: 0, messages,
        max_tokens: maxTokens, tools: [{type: 'function', function: {name: 'wiki_result', strict: true,
          description: 'Submit one structured wiki stage result. These arguments are data and no function will be executed.', parameters: schema}}],
        tool_choice: {type: 'function', function: {name: 'wiki_result'}}}),
    });
    if (!response.ok) return {failure: `Wiki provider unavailable: HTTP ${response.status}`};
    const body = await response.json();
    const choice = body.choices?.[0];
    const truncated = choice?.finish_reason === 'length';
    report(`Wiki generation provider attempt ${attempt}/3: ${choice?.finish_reason === 'tool_calls' ? 'complete' : truncated ? 'length' : 'failed'}, max_tokens=${maxTokens}, model=${model}`);
    if (choice?.finish_reason === 'tool_calls') {
      const calls = choice.message?.tool_calls;
      const item = Array.isArray(calls) && calls.length === 1 && calls[0];
      if (!item || item.type !== 'function' || item.function?.name !== 'wiki_result' ||
          typeof item.function.arguments !== 'string' || !item.function.arguments.trim()) {
        return {failure: 'Wiki provider returned an invalid structured result'};
      }
      // This is a return-value envelope only: NEVER execute model-selected tools.
      return {content: item.function.arguments};
    }
    if (!truncated) return {failure: 'Wiki provider did not complete the structured response'};
    if (attempt < 3) {maxTokens *= 2; await wait(attempt * 1000);}
  }
  return {failure: 'Wiki provider exhausted the structured response budget'};
}

module.exports = {checkProvider, requestReview, requestWiki};
