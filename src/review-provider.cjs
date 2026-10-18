'use strict';

const MODELS = Object.freeze(['deepseek-flash', 'deepseek-v4-pro']);
const JEV_MODEL = 'jev-1.13.0';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// A completed answer, including a negative or malformed one, is never resampled.
async function requestJSON({messages, model, thinking = true, schemas, fetchImpl = fetch, wait = delay, report = () => {}}) {
  if (!MODELS.includes(model)) throw new Error('Unsupported acceptance model');
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not configured');
  const usage = [];
  let completed;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    const response = await fetchImpl(schemas ? 'https://api.deepseek.com/beta/chat/completions' : 'https://api.deepseek.com/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: {Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({model, ...(thinking ? {thinking: {type: 'enabled'}, reasoning_effort: 'low'} : {thinking: {type: 'disabled'}, temperature: 0}),
        max_tokens: 8192 * 2 ** attempt, messages, ...(schemas ? {
          tools: Object.entries(schemas).map(([name, parameters]) => ({type: 'function', function: {name, parameters, strict: true,
            description: 'Submit structured evidence or request repository source. Arguments are parsed data; no generated function or source is executed.'}})),
          tool_choice: thinking ? 'auto' : 'required', parallel_tool_calls: false,
        } : {response_format: {type: 'json_object'}})}),
    });
    if (!response.ok) throw new Error(`Acceptance provider unavailable: HTTP ${response.status}`);
    const body = await response.json();
    usage.push({provider: 'deepseek', requested_model: model, model: body.model || model,
      milliseconds: Date.now() - started, tokens: body.usage || null});
    const choice = body.choices?.[0];
    const complete = choice?.finish_reason === (schemas ? 'tool_calls' : 'stop');
    report(`Acceptance provider: model=${model}, attempt=${attempt + 1}/3, outcome=${complete ? 'complete' : choice?.finish_reason === 'length' ? 'length' : 'incomplete'}`);
    if (complete) {
      if (schemas) {
        const calls = choice.message.tool_calls;
        if (calls?.length !== 1 || !Object.hasOwn(schemas, calls[0].function.name)) throw new Error('Acceptance provider returned an invalid structured result');
        completed = calls[0].function.arguments;
      } else completed = choice.message.content;
      break;
    }
    if (choice?.finish_reason !== 'length' || attempt === 2) throw new Error('Acceptance provider did not complete the bounded review');
    await wait((attempt + 1) * 1000);
  }
  return {value: JSON.parse(completed), usage};
}

async function requestJev({state, questions, fetchImpl = fetch, wait = delay, report = () => {}}) {
  if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not configured');
  const ids = Object.keys(questions);
  if (!ids.length || JSON.stringify({state, questions}).length > 100000) throw new Error('Jev requires a bounded atomic-question packet');
  const usage = [];
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: {Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({model: JEV_MODEL, state, questions}),
    });
    if ([429, 529].includes(response.status) && attempt < 2) {
      report(`Jev provider: attempt=${attempt + 1}/3, outcome=backoff`);
      await wait((attempt + 1) * 1000); continue;
    }
    if (!response.ok) throw new Error(`Jev provider unavailable: HTTP ${response.status}`);
    const body = await response.json();
    if (body.model !== JEV_MODEL || !body.answers || Object.keys(body.answers).sort().join('\0') !== ids.sort().join('\0')) {
      throw new Error('Jev returned a different model or incomplete question set');
    }
    for (const id of ids) {
      const answer = body.answers[id];
      const options = Object.keys(questions[id].criteria);
      if (answer.type !== 'choice' || !options.includes(answer.choice) ||
          !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 ||
          !answer.probabilities || Object.keys(answer.probabilities).sort().join('\0') !== options.sort().join('\0') ||
          Object.values(answer.probabilities).some(value => !Number.isFinite(value) || value < 0 || value > 1) ||
          Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.000001) {
        throw new Error('Jev returned an invalid typed probability distribution');
      }
    }
    usage.push({provider: 'typesafe', requested_model: JEV_MODEL, model: body.model,
      milliseconds: Date.now() - started, tokens: body.usage || null});
    report(`Jev provider: model=${JEV_MODEL}, questions=${ids.length}, outcome=complete`);
    return {value: body.answers, usage};
  }
}

module.exports = {MODELS, JEV_MODEL, requestJSON, requestJev};
