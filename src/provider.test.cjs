'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {checkProvider} = require('./provider.cjs');

test('provider probe requires credentials and validates complete structured output', async () => {
  const original = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    await assert.rejects(checkProvider(), /not configured/);
    process.env.DEEPSEEK_API_KEY = 'fictional-test-key';
    await checkProvider({fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer fictional-test-key');
      const body = JSON.parse(options.body);
      assert.equal(body.tools, undefined);
      assert.equal(body.response_format.type, 'json_object');
      return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: '{"ok":true}'}}]})};
    }});
    for (const response of [
      {ok: false, status: 429},
      ...[{}, {choices: []}, {choices: [{finish_reason: 'length'}]},
        {choices: [{finish_reason: 'stop', message: {content: '{"ok":false}'}}]},
        {choices: [{finish_reason: 'stop', message: {content: 'invalid JSON'}}]},
      ].map(body => ({ok: true, json: async () => body})),
    ]) {
      await assert.rejects(checkProvider({fetchImpl: async () => response}));
    }
    await assert.rejects(checkProvider({fetchImpl: async () => {throw new Error('fixture network failure');}}), /network failure/);
  } finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
  }
});

const {requestReview} = require('./provider.cjs');
const messages = [{role: 'system', content: 'trusted policy'}, {role: 'user', content: 'untrusted patch'}];
const completion = (finish_reason, content = '{"decision":"second_opinion"}') =>
  ({choices: [{finish_reason, message: {content}}]});
const response = body => ({ok: true, json: async () => body});

test('truncation retries have a fixed attempt, token and backoff budget with safe diagnostics', async () => {
  const requests = [], delays = [], reports = [];
  const result = await requestReview({messages,
    wait: async ms => delays.push(ms), report: line => reports.push(line),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(options.method, 'POST');
      assert.ok(options.signal instanceof AbortSignal);
      const request = JSON.parse(options.body); requests.push(request);
      assert.equal(request.model, 'deepseek-flash');
      assert.deepEqual(request.thinking, {type: 'enabled'});
      assert.equal(request.reasoning_effort, 'low');
      assert.deepEqual(request.response_format, {type: 'json_object'});
      assert.deepEqual(request.messages, messages);
      assert.equal(request.tools, undefined);
      return response(completion('length', 'private response and reasoning must stay out of logs'));
    }});
  assert.deepEqual(requests.map(request => request.max_tokens), [4096, 8192, 16384]);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(reports.length, 3);
  assert.match(result.failure, /incomplete after 3 attempt\(s\).*length/);
  assert.equal(result.content, undefined);
  assert.ok(reports.every(line => /^AI assessment provider attempt [123]\/3: length, max_tokens=\d+$/.test(line)));
});

test('missing completions retry with the same evidence and token budget', async () => {
  for (const missing of [{}, {choices: []}, {choices: [{}]}]) {
    const requests = [], delays = [];
    const result = await requestReview({messages, wait: async ms => delays.push(ms),
      fetchImpl: async (_, options) => {
        requests.push(JSON.parse(options.body));
        return response(requests.length === 1 ? missing : completion('stop', '{"complete":true}'));
      }});
    assert.deepEqual(result, {content: '{"complete":true}'});
    assert.deepEqual(requests.map(request => request.max_tokens), [4096, 4096]);
    assert.deepEqual(delays, [1000]);
    assert.deepEqual(requests[0].messages, requests[1].messages);
  }
});

test('repeated missing output exhausts retries and never yields partial review content', async () => {
  let calls = 0;
  const result = await requestReview({messages, wait: async () => {},
    fetchImpl: async () => {calls++; return response({});}});
  assert.equal(calls, 3);
  assert.match(result.failure, /after 3 attempt\(s\).*missing/);
  assert.equal(result.content, undefined);
});

test('unsupported finish reasons fail closed without retrying or logging provider text', async () => {
  for (const finish of ['content_filter', 'tool_calls', null, 'untrusted response text']) {
    let calls = 0;
    const reports = [];
    const result = await requestReview({messages, report: line => reports.push(line),
      wait: async () => assert.fail('must not retry a terminal response'),
      fetchImpl: async () => {calls++; return response(completion(finish));}});
    assert.equal(calls, 1);
    assert.match(result.failure, /after 1 attempt\(s\).*other/);
    assert.deepEqual(reports, ['AI assessment provider attempt 1/3: other, max_tokens=4096']);
  }
});

test('HTTP, network and response decoding failures are not retried as truncation', async () => {
  for (const status of [401, 429, 500]) {
    let calls = 0;
    const result = await requestReview({messages, fetchImpl: async () => {calls++; return {ok: false, status};}});
    assert.equal(calls, 1);
    assert.equal(result.failure, `AI assessment unavailable: provider HTTP ${status}`);
  }
  for (const fetchImpl of [async () => {throw new Error('network');},
    async () => ({ok: true, json: async () => {throw new Error('decoding');}})]) {
    await assert.rejects(requestReview({messages, fetchImpl}), /network|decoding/);
  }
  assert.deepEqual(await requestReview({messages, fetchImpl: async () => response({choices: [{finish_reason: 'stop'}]})}), {content: undefined});
});

test('default backoff executes a delayed retry without requiring caller orchestration', async () => {
  let calls = 0;
  const result = await requestReview({messages, fetchImpl: async () => {
    calls++; return response(completion(calls === 1 ? 'length' : 'stop'));
  }});
  assert.equal(calls, 2);
  assert.equal(result.content, '{"decision":"second_opinion"}');
});

test('default provider transport returns the complete response without exposing its content', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.deepEqual(JSON.parse(options.body).messages, messages);
    return response(completion('stop', '{"complete":true}'));
  };
  try {
    assert.deepEqual(await requestReview({messages}), {content: '{"complete":true}'});
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

const {requestWiki} = require('./provider.cjs');
const wikiSchema = {type: 'object', additionalProperties: false, required: ['pages'], properties: {pages: {type: 'array', items: {type: 'string'}}}};
const wikiResponse = text => ({choices: [{finish_reason: 'tool_calls', message: {tool_calls: [{type: 'function', function: {name: 'wiki_result', arguments: text}}]}}]});

test('wiki requests force one strict structured return without executing any model-selected tool', async () => {
  const result = await requestWiki({messages, schema: wikiSchema, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(url, 'https://api.deepseek.com/beta/chat/completions');
    assert.equal(options.method, 'POST');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.thinking, {type: 'disabled'});
    assert.equal(body.temperature, 0);
    assert.deepEqual(body.messages, messages);
    assert.deepEqual(body.tool_choice, {type: 'function', function: {name: 'wiki_result'}});
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].function.strict, true);
    assert.deepEqual(body.tools[0].function.parameters, wikiSchema);
    return response(wikiResponse('{"pages":[]}'));
  }});
  assert.deepEqual(result, {content: '{"pages":[]}'});
  await assert.rejects(requestWiki({messages}), /JSON schema is required/);
  await assert.rejects(requestWiki({messages, schema: {type: 'array'}}), /JSON schema is required/);
});

test('wiki truncation retries keep a fixed budget and identical schema/evidence', async () => {
  const requests = [], waits = [], reports = [];
  const result = await requestWiki({messages, schema: wikiSchema, wait: async ms => waits.push(ms), report: line => reports.push(line),
    fetchImpl: async (_, options) => {requests.push(JSON.parse(options.body)); return response({choices: [{finish_reason: 'length'}]});}});
  assert.deepEqual(requests.map(body => body.max_tokens), [4096, 8192, 16384]);
  assert.deepEqual(waits, [1000, 2000]);
  assert.ok(requests.every(body => JSON.stringify(body.tools[0].function.parameters) === JSON.stringify(wikiSchema) && JSON.stringify(body.messages) === JSON.stringify(messages)));
  assert.match(result.failure, /exhausted/);
  assert.equal(reports.length, 3);
  let calls = 0;
  const recovered = await requestWiki({messages, schema: wikiSchema, fetchImpl: async () => response(++calls === 1 ?
    {choices: [{finish_reason: 'length'}]} : wikiResponse('{"pages":[]}'))});
  assert.deepEqual(recovered, {content: '{"pages":[]}'});
  assert.equal(calls, 2);
});

test('wiki rejects plain text, wrong return names, multiple returns and missing structured results', async () => {
  for (const body of [{}, {choices: []}, {choices: [{}]}, {choices: [{finish_reason: 'stop'}]}, {choices: [{finish_reason: 'content_filter'}]}]) {
    const reports = [];
    const result = await requestWiki({messages, schema: wikiSchema, report: line => reports.push(line), fetchImpl: async () => response(body)});
    assert.match(result.failure, /did not complete/);
    assert.ok(reports[0].includes('failed'));
  }
  for (const calls of [undefined, [], [null], [{type: 'custom'}], [{type: 'function'}],
    [{type: 'function', function: {name: 'other', arguments: '{}'}}],
    [{type: 'function', function: {name: 'wiki_result', arguments: 1}}],
    [{type: 'function', function: {name: 'wiki_result', arguments: ' '}}],
    [...wikiResponse('{}').choices[0].message.tool_calls, ...wikiResponse('{}').choices[0].message.tool_calls]]) {
    const result = await requestWiki({messages, schema: wikiSchema, fetchImpl: async () => response({choices: [{finish_reason: 'tool_calls', message: {tool_calls: calls}}]})});
    assert.match(result.failure, /invalid structured result/);
  }
  assert.match((await requestWiki({messages, schema: wikiSchema, fetchImpl: async () => response({choices: [{finish_reason: 'tool_calls'}]})})).failure, /invalid structured result/);
  assert.match((await requestWiki({messages, schema: wikiSchema, fetchImpl: async () => ({ok: false, status: 400})})).failure, /HTTP 400/);
});

test('default wiki transport uses the bounded strict return protocol without exposing response bodies', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response(wikiResponse('{"pages":[]}'));
  try {assert.deepEqual(await requestWiki({messages, schema: wikiSchema}), {content: '{"pages":[]}'});}
  finally {globalThis.fetch = original;}
});
