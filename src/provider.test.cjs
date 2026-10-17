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
