'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {digest} = require('./acceptance.cjs');

function compactSchema(schema) {
  const definitions = {};
  function visit(value) {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value.enum) && value.enum.length > 1) {
      const id = `choice_${digest([value.type, value.enum])}`;
      definitions[id] = {type: value.type, enum: value.enum};
      return {...Object.fromEntries(Object.entries(value).filter(([key]) => !['type', 'enum'].includes(key))
        .map(([key, item]) => [key, visit(item)])), $ref: `#/$defs/${id}`};
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
  }
  const result = visit(schema);
  return Object.keys(definitions).length ? {...result, $defs: definitions} : result;
}

function invoke(program, args, options) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(program, args, {...options, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs || 300000);
    child.stdout.on('data', chunk => {stdout += chunk; if (stdout.length > (options.maxBytes || 3000000)) child.kill('SIGKILL');});
    child.stderr.on('data', chunk => {stderr = (stderr + chunk).slice(-2000);});
    child.on('error', error => {clearTimeout(timer); reject(error);});
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(Object.assign(new Error(`Local harness failed (${code}); diagnostic digest ${digest(stderr)}`),
        {harnessDiagnostic: {program, exit_code: code, signal, stderr}}));
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}

async function askHarness({harness, role, phase, schema, prompt, execute = invoke}) {
  if (!['codex', 'claude'].includes(harness)) throw new Error('Supported authenticated harnesses: codex, claude');
  if (harness === 'codex' && prompt.length > 1048576) throw new Error('Local Codex input exceeds its 1048576-character transport limit; preserve and inspect the complete evidence without truncation');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-harness-'));
  try {
    const schemaPath = path.join(directory, 'schema.json');
    const resultPath = path.join(directory, 'result.json');
    const outputSchema = compactSchema(schema);
    fs.writeFileSync(schemaPath, JSON.stringify(outputSchema));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)));
    // Authentication remains in the harness's normal account store. No CI
    // provider credential or receipt signing material is passed to its process.
    const args = harness === 'codex' ? ['exec', '--sandbox', 'read-only', '--ephemeral',
      '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--json', '--output-schema', schemaPath,
      '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'plugins',
      '--disable', 'hooks', '--disable', 'code_mode_host', '--disable', 'computer_use', '--disable', 'browser_use',
      '--disable', 'in_app_browser', '--disable', 'view_image', '--enable', 'skip_host_skill_discovery',
      '-c', 'web_search="disabled"',
      '--output-last-message', resultPath, '-C', directory, '-'] :
      ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(outputSchema), '--tools', '',
        '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
    const raw = await execute(harness, args, {cwd: directory, env, input: prompt});
    let value; let session;
    if (harness === 'codex') {
      value = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      const events = raw.trim().split('\n').map(line => JSON.parse(line));
      if (events.some(event => event.item && !['reasoning', 'agent_message', 'error'].includes(event.item.type))) {
        const types = [...new Set(events.filter(event => event.item).map(event => String(event.item.type).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)))];
        throw new Error(`Local reviewer used a tool instead of the immutable evidence protocol (${types.join(', ')})`);
      }
      session = events.find(event => event.type === 'thread.started')?.thread_id;
      if (events.at(-1).type !== 'turn.completed') throw new Error('Harness returned no completed structured result or session identity');
    } else {
      const response = JSON.parse(raw);
      value = response.structured_output;
      session = response.session_id;
    }
    if (!value || typeof session !== 'string' || !session.length) throw new Error('Harness returned no structured result or session identity');
    return {value, provenance: {harness, role, phase, session, request_digest: digest({schema: outputSchema, prompt}),
      response_digest: digest(value), transport_digest: digest(raw)}};
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
}

module.exports = {compactSchema, invoke, askHarness};
