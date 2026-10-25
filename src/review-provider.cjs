'use strict';

const {isDeepStrictEqual} = require('node:util');
const MODELS = Object.freeze(['deepseek-flash', 'deepseek-v4-pro']);
const JEV_MODEL = 'jev-1.13.0';
const JEV_PACKET_LIMIT = 100000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function rootEnd(raw) {
  let depth = 0, quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const character = raw[i];
    if (quoted && character === '\\') {i++; continue;}
    if (character === '"') {quoted = !quoted; continue;}
    if (quoted) continue;
    if (character === '{' || character === '[') depth++;
    if (character === '}' || character === ']') {
      depth--; if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function decodeJSON(raw) {
  let canonical = raw;
  try {return {value: JSON.parse(raw), raw, canonical};} catch {}
  // Remove only trailing commas outside JSON strings. Preserve every scalar,
  // source reference and judgment; no model or fuzzy repair chooses new data.
  if (typeof raw === 'string') {
    canonical = ''; let quoted = false;
    for (let i = 0; i < raw.length; i++) {
      const character = raw[i];
      if (quoted && character === '\\') {canonical += raw.slice(i, i + 2); i++; continue;}
      if (character === '"') quoted = !quoted;
      if (!quoted && character === ',' && /^\s*[}\]]/.test(raw.slice(i + 1))) continue;
      canonical += character;
    }
    const end = rootEnd(canonical);
    if (end > 0) {
      const prefix = canonical.slice(0, end), rest = canonical.slice(end).trim();
      try {
        const value = JSON.parse(prefix);
        if (/^[\s,}\]]*$/.test(rest)) canonical = prefix;
        else if (rest.startsWith(',')) {
          const duplicate = JSON.parse(`{${rest.slice(1)}`);
          if (value && typeof value === 'object' && !Array.isArray(value) &&
              Object.keys(duplicate).every(key => Object.hasOwn(value, key) && isDeepStrictEqual(value[key], duplicate[key]))) {
            canonical = prefix;
          }
        }
      } catch {} // Unknown or conflicting extra content remains an error below.
    }
  }
  try {return {value: JSON.parse(canonical), raw, canonical};} catch (cause) {
    const error = new Error('Acceptance provider returned malformed JSON');
    error.details = {raw_response: raw, canonical_response: canonical, parse_error: cause.message};
    throw error;
  }
}

// A completed answer, including a negative or malformed one, is never resampled.
async function requestJSON({messages, model, thinking = true, schemas, fetchImpl = fetch, wait = delay, report = () => {}}) {
  if (!MODELS.includes(model)) throw new Error('Unsupported acceptance model');
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not configured');
  const usage = [];
  let completed; let functionName;
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
    report(`Acceptance provider: model=${model}, attempt=${attempt + 1}/3, outcome=${choice?.finish_reason || 'missing'}`);
    if (complete) {
      if (schemas) {
        const calls = choice.message.tool_calls;
        if (calls?.length !== 1 || !Object.hasOwn(schemas, calls[0].function.name)) throw new Error('Acceptance provider returned an invalid structured result');
        functionName = calls[0].function.name;
        completed = calls[0].function.arguments;
      } else completed = choice.message.content;
      break;
    }
    if (choice?.finish_reason !== 'length' || attempt === 2) throw new Error('Acceptance provider did not complete the bounded review');
    await wait((attempt + 1) * 1000);
  }
  try {return {...decodeJSON(completed), usage, ...(schemas ? {function_name: functionName} : {})};} catch (error) {
    error.details = {...error.details, model, usage}; throw error;
  }
}

async function requestJev({state, questions, fetchImpl = fetch, wait = delay, report = () => {}}) {
  if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not configured');
  const ids = Object.keys(questions);
  if (!ids.length || JSON.stringify({state, questions}).length > JEV_PACKET_LIMIT) throw new Error('Jev requires a bounded atomic-question packet');
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
          // Live responses round probabilities to two decimal places. Keep
          // the original distribution and allow only its aggregate rounding
          // error; never renormalize it into a more confident answer.
          Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) > options.length * 0.005 + 0.000001) {
        const error = new Error('Jev returned an invalid typed probability distribution');
        error.details = {question: id, answer};
        throw error;
      }
    }
    usage.push({provider: 'typesafe', requested_model: JEV_MODEL, model: body.model,
      milliseconds: Date.now() - started, tokens: body.usage || null});
    report(`Jev provider: model=${JEV_MODEL}, questions=${ids.length}, outcome=complete`);
    return {value: body.answers, usage};
  }
}

module.exports = {MODELS, JEV_MODEL, JEV_PACKET_LIMIT, decodeJSON, requestJSON, requestJev};
