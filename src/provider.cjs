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

module.exports = {checkProvider};
