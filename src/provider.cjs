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
async function requestWiki({messages, schema, fetchImpl = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), report = () => {}}) {
  if (!schema || schema.type !== 'object') throw new Error('Wiki JSON schema is required');
  let maxTokens = 4096;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetchImpl('https://api.deepseek.com/responses', {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: {Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({model: 'deepseek-flash', reasoning: {effort: 'none'}, temperature: 0, input: messages,
        max_output_tokens: maxTokens, text: {format: {type: 'json_schema', name: 'wiki_result', schema}}}),
    });
    if (!response.ok) return {failure: `Wiki provider unavailable: HTTP ${response.status}`};
    const body = await response.json();
    const truncated = body.status === 'incomplete' && body.incomplete_details?.reason === 'max_output_tokens';
    report(`Wiki generation provider attempt ${attempt}/3: ${body.status === 'completed' ? 'complete' : truncated ? 'length' : 'failed'}, max_tokens=${maxTokens}`);
    if (body.status === 'completed') {
      const item = Array.isArray(body.output) && body.output.length === 1 && body.output[0];
      const part = item && item.type === 'message' && item.role === 'assistant' &&
        Array.isArray(item.content) && item.content.length === 1 && item.content[0];
      if (!part || part.type !== 'output_text' || typeof part.text !== 'string' || !part.text.trim()) {
        return {failure: 'Wiki provider returned an invalid structured message'};
      }
      return {content: part.text};
    }
    if (!truncated) return {failure: 'Wiki provider did not complete the structured response'};
    if (attempt < 3) {maxTokens *= 2; await wait(attempt * 1000);}
  }
  return {failure: 'Wiki provider exhausted the structured response budget'};
}

module.exports = {checkProvider, requestReview, requestWiki};
