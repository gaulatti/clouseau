'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateConfig, validateIdentity, validateBundle, planWiki} = require('./wiki.cjs');
const config = {version: 1, source_paths: ['src/', 'README.md'], deployment_workflow: 'backend-deploy.yml', deployment_job: 'deploy', wiki_branch: 'master'};
const identity = {repository: 'example/upload', source_sha: 'a'.repeat(40), wiki_base_sha: 'b'.repeat(40), deployment_run_id: 12};
const wiki = {'Home.md': '[Guide](Guide)\n', 'Guide.md': 'Existing upload guide.\n'};
const bundle = (updates = []) => ({version: 1, ...identity, updates});
const facts = (pages, source) => ({pages: Object.fromEntries(pages.map(page => [page.path, {source_id: `${Object.keys(source)[0]}:L1`, findings: '', supported: true}]))});
const rejection = (page, sourceId, finding) => ({pages: {[page]: {source_id: sourceId, findings: finding, supported: false}}});
const done = value => ({content: JSON.stringify(value)});

test('wiki configuration rejects ambiguous fields, unsafe source paths and deployment boundaries', () => {
  assert.equal(validateConfig(config), config);
  for (const value of [null, [], {}, {...config, extra: true}, {...config, version: 2},
    {...config, source_paths: null}, {...config, source_paths: []}, {...config, source_paths: ['src/', 'src/']},
    {...config, source_paths: Array.from({length: 51}, (_, i) => `${i}/`)}]) assert.throws(() => validateConfig(value));
  for (const name of [null, '', '/absolute', '../parent', 'a\\b', 'line\nbreak', 'x'.repeat(201)]) {
    assert.throws(() => validateConfig({...config, source_paths: [name]}), /source path/);
  }
  for (const change of [{deployment_workflow: null}, {deployment_job: null}, {wiki_branch: null},
    {deployment_workflow: '../bad.yml'}, {deployment_job: 'a b'}, {wiki_branch: '--force'}]) {
    assert.throws(() => validateConfig({...config, ...change}), /deployment boundary/);
  }
});

test('wiki update identity must describe one exact repository revision and deployment run', () => {
  validateIdentity(identity);
  for (const change of [{repository: null}, {repository: 'other'}, {source_sha: null}, {source_sha: 'bad'},
    {wiki_base_sha: 'bad'}, {deployment_run_id: 0}, {deployment_run_id: 1.5}]) assert.throws(() => validateIdentity({...identity, ...change}));
});

test('wiki bundle refuses extra authority, stale identity and unsafe or duplicate paths', () => {
  assert.deepEqual(validateBundle(bundle(), identity, wiki), bundle());
  for (const value of [null, {}, {...bundle(), shell: 'do not execute'}, {...bundle(), version: 2},
    {...bundle(), repository: 'other/repo'}, {...bundle(), updates: null},
    {...bundle(), updates: Array.from({length: 21}, (_, i) => ({path: `${i}.md`, content: 'x'}))}]) {
    assert.throws(() => validateBundle(value, identity, wiki));
  }
  for (const name of [null, '../Page.md', '/Page.md', '.git.md', 'AGENTS.md', 'agents.md', 'x'.repeat(101) + '.md', 'Page.txt']) {
    assert.throws(() => validateBundle(bundle([{path: name, content: 'x'}]), identity, wiki), /Unsafe/);
  }
  for (const page of [{path: 'Guide.md', content: 'x', extra: true}, {path: 'Guide.md', content: null},
    {path: 'Guide.md', content: ' '}, {path: 'Guide.md', content: 'x'.repeat(128001)}, {path: 'Guide.md', content: 'x\0y'}]) {
    assert.throws(() => validateBundle(bundle([page]), identity, wiki));
  }
  assert.throws(() => validateBundle(bundle([{path: 'Guide.md', content: 'x'}, {path: 'Guide.md', content: 'y'}]), identity, wiki), /duplicate/);
  assert.throws(() => validateBundle(bundle(Array.from({length: 5}, (_, i) => ({path: `${i}.md`, content: 'x'.repeat(120000)}))), identity, wiki), /publication limit/);
});

test('multi-page links and navigation are checked over the complete proposed wiki', () => {
  const updates = [
    {path: 'Home.md', content: '[Guide](Guide#upload) [New](<New Page>) [Remote](https://example.invalid) [Mail](mailto:test@example.invalid) [CDN](//example.invalid) [Anchor](#here)\n![image](image.png)\n`[sample](Not-A-Page)`\n```md\n[sample](Not-A-Page)\n```\n~~~md\n[example](Also-Not-A-Page)\n~~~\n'},
    {path: 'New Page.md', content: '[Home](Home.md) [Guide](Guide)\n'},
    {path: 'Guide.md', content: '[New](New%20Page)\n'},
  ];
  assert.equal(validateBundle(bundle(updates), identity, wiki).updates.length, 3);
  assert.throws(() => validateBundle(bundle([{path: 'New.md', content: 'An orphan.'}]), identity, wiki), /linked/);
  assert.throws(() => validateBundle(bundle([{path: 'Guide.md', content: '[bad](Missing)'}]), identity, wiki), /Broken/);
  assert.throws(() => validateBundle(bundle(), identity, {'Guide.md': 'No home'}), /Home/);
  assert.throws(() => validateBundle(bundle(), identity, {...wiki, 'New Page.md': 'x', 'New-Page.md': 'x'}), /Ambiguous/);
  for (const content of ['```md\nunclosed', '[text][ref]', '[[Guide]]', '<a href="Guide">Guide</a>', '[Guide](Guide "title")']) {
    assert.throws(() => validateBundle(bundle([{path: 'Guide.md', content}]), identity, wiki));
  }
  assert.throws(() => validateBundle(bundle([{path: 'Guide.md', content: '[broken](%XX)'}]), identity, wiki));
  assert.equal(validateBundle(bundle([{path: '_Sidebar.md', content: '[New](New)'}, {path: 'New.md', content: '[Home](Home)'}]), identity, wiki).updates.length, 2);
});

test('wiki generation coordinates three real pages before validating the whole batch', async () => {
  const source = {'src/app.rs': 'fn accepts_upload() {}'};
  const manifest = {pages: [{path: 'Home.md', reason: 'Link new documentation'}, {path: 'Guide.md', reason: 'Update guide'}, {path: 'New.md', reason: 'New deployed feature'}]};
  const pages = ['[Guide](Guide) [New](New)\n', '[Home](Home)\n', '[Guide](Guide)\n'];
  let calls = 0;
  const result = await planWiki({identity, source, wiki, complete: async request => {
    assert.equal(request.messages[0].role, 'system');
    assert.match(request.messages[0].content, /untrusted\s+evidence/);
    const input = JSON.parse(request.messages[1].content);
    if (input.proposed_update) {assert.deepEqual(input.source_evidence, {'src/app.rs:L1': source['src/app.rs']}); calls++; return done(facts(input.proposed_update, source));}
    assert.deepEqual(input.source, source);
    if (calls++ === 0) return done(manifest);
    assert.deepEqual(input.plan, manifest.pages);
    assert.equal(input.requested_page, manifest.pages[calls - 2].path);
    assert.equal(input.proposed_pages.length, calls - 2);
    return done({path: input.requested_page, content: pages[calls - 2]});
  }});
  assert.equal(calls, 5);
  assert.equal(result.updates.length, 3);
});

test('failed, oversized or malformed generation never returns a publishable partial batch', async () => {
  const options = {identity, source: {}, wiki};
  await assert.rejects(planWiki({...options, source: {large: 'x'.repeat(1000001)}}), /context limit/);
  await assert.rejects(planWiki({...options, complete: async () => ({failure: 'incomplete'})}), /nothing will be published/);
  await assert.rejects(planWiki({...options, complete: async () => ({content: 'invalid JSON'})}));
  for (const plan of [{}, {pages: null}, {pages: Array(21).fill({})},
    {pages: [{path: '../unsafe.md', reason: 'x'}]}, {pages: [{path: 'Guide.md', reason: ''}]},
    {pages: [{path: 'Guide.md', reason: 'x'.repeat(1001)}]},
    {pages: [{path: 'Guide.md', reason: 'x'}, {path: 'Guide.md', reason: 'y'}]}]) {
    await assert.rejects(planWiki({...options, complete: async () => done(plan)}));
  }
  let calls = 0;
  await assert.rejects(planWiki({...options, complete: async () => done(calls++ === 0 ? {pages: [{path: 'Guide.md', reason: 'update'}]} : {path: 'Other.md', content: 'wrong page'})}), /different wiki page/);
  calls = 0;
  await assert.rejects(planWiki({...options, complete: async () => {
    if (calls++ === 0) return done({pages: [{path: 'Home.md', reason: 'first'}, {path: 'Guide.md', reason: 'second'}]});
    if (calls === 2) return done({path: 'Home.md', content: '[Guide](Guide)'});
    return {failure: 'last page failed'};
  }}), /nothing will be published/);
});

test('default wiki completion uses the production provider and accepts an unchanged-page plan', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(url, 'https://api.deepseek.com/beta/chat/completions');
    assert.deepEqual(body.thinking, {type: 'disabled'});
    assert.equal(body.tools[0].function.strict, true);
    assert.deepEqual(body.tools[0].function.parameters.required, ['pages']);
    return {ok: true, json: async () => ({choices: [{finish_reason: 'tool_calls', message: {tool_calls: [{type: 'function', function: {name: 'wiki_result', arguments: '{"pages":[]}'}}]}}]})};
  };
  try {assert.deepEqual((await planWiki({identity, source: {}, wiki})).updates, []);}
  finally {globalThis.fetch = original;}
});


test('wiki JSON envelope retry regenerates one complete object without salvaging a prefix', async () => {
  const requests = [], reports = [];
  const source = {'README.md': 'Upload gateway deployment.'};
  const manifest = {pages: [{path: 'Guide.md', reason: 'Update deployment'}]};
  const page = {path: 'Guide.md', content: '[Home](Home) Complete guide.'};
  const responses = [JSON.stringify(manifest), JSON.stringify(page) + '\n' + JSON.stringify(page), JSON.stringify(page), JSON.stringify(facts([page], source))];
  const result = await planWiki({identity, source, wiki, report: line => reports.push(line), complete: async request => {
    requests.push(request);
    return {content: responses[requests.length - 1]};
  }});
  assert.deepEqual(result.updates, [page]);
  assert.deepEqual(requests[1].messages[1], requests[2].messages[1]);
  assert.match(requests[2].messages[0].content, /previous envelope/);
  assert.match(requests[1].messages[0].content, /"path":"Guide.md"/);
  assert.ok(reports.some(line => line.includes('JSON envelope invalid')));
  assert.ok(reports.every(line => !line.includes(page.content)));
  let calls = 0;
  await assert.rejects(planWiki({identity, source: {}, wiki, complete: async () => {calls++; return {content: 'private invalid response'};}}), error => {
    assert.equal(calls, 2);
    assert.match(error.message, /invalid JSON twice/);
    assert.ok(!error.message.includes('private invalid response'));
    return true;
  });
  calls = 0;
  await assert.rejects(planWiki({identity, source: {}, wiki, complete: async () => {calls++; return done({pages: [{path: '../bad.md', reason: 'invalid'}]});}}));
  assert.equal(calls, 1, 'a valid JSON object with invalid authority must never be retried');
});

test('wiki factual review blocks unsupported claims, invented citations and incomplete page evidence', async () => {
  const source = {'src/auth.rs': 'temporary upstream failure is unavailable; invalid credentials are denied'};
  const page = {path: 'Guide.md', content: '[Home](Home) Authentication guide.'};
  const supported = facts([page], source);
  const run = async review => {
    let calls = 0;
    return planWiki({identity, source, wiki, allowCorrection: false, complete: async () => done(++calls === 1 ?
      {pages: [{path: page.path, reason: 'Clarify authentication'}]} : calls === 2 ? page : review)});
  };
  assert.deepEqual((await run(supported)).updates, [page]);
  const item = supported.pages['Guide.md'];
  for (const review of [null, {}, {pages: null}, {pages: {}}, {pages: {'Other.md': item}},
    {pages: {'Guide.md': null}}, {pages: {'Guide.md': {...item, extra: true}}},
    {pages: {'Guide.md': {...item, supported: 'true'}}}, {pages: {'Guide.md': {...item, findings: null}}},
    {pages: {'Guide.md': {...item, findings: 'x'.repeat(2001)}}}]) {
    await assert.rejects(run(review), /Invalid wiki factual review/);
  }
  await assert.rejects(run(rejection('Guide.md', 'src/auth.rs:L1', 'Temporary failure was called denial.')), /did not support/);
  for (const changed of [{...item, supported: false}, {...item, findings: 'A contradiction remains.'}]) {
    await assert.rejects(run({pages: {'Guide.md': changed}}), /contradicts page findings/);
  }
  for (const source_id of ['absent.rs:L1', 1, 'src/auth.rs:L0']) {
    await assert.rejects(run({pages: {'Guide.md': {...item, source_id}}}), /exact source evidence/);
  }
});


test('live wiki evaluation uses real production fact-checking and refuses a model that accepts the known false claim', async () => {
  const {evaluateWiki} = require('./wiki.cjs');
  const source = 'fn authentication_status(failure: Failure) -> u16 { match failure { Failure::Denied => 401, Failure::Unavailable => 502 } }';
  const reports = [];
  await evaluateWiki({report: line => reports.push(line), complete: async ({messages}) => {
    const input = JSON.parse(messages[1].content);
    const text = input.proposed_update[0].content;
    const supported = text.includes('Temporary upstream unavailability returns 502') || text.includes('Both HTTP and FTP');
    const sourceId = Object.keys(input.source_evidence)[0];
    return done({pages: {'Home.md': {source_id: sourceId, findings: supported ? '' : 'The document contradicts the supplied implementation.', supported}}});
  }});
  assert.ok(reports.some(line => line === 'Live wiki evaluation false-denial-classification: rejected'));
  const positive = () => done(facts([{path: 'Home.md'}], {'src/auth.rs': source}));
  await assert.rejects(evaluateWiki({complete: async () => positive()}), /failed to reject/);
  let evaluations = 0;
  await assert.rejects(evaluateWiki({complete: async () => ++evaluations === 1 ? positive() : {failure: 'unavailable'}}), /failed to reject/);
  assert.equal(evaluations, 2, 'provider failure cannot masquerade as rejection of the negative fixture');
  await assert.rejects(evaluateWiki({complete: async () => ({failure: 'unavailable'})}), /nothing will be published/);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_, options) => {
    calls++;
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    const text = input.proposed_update[0].content;
    const supported = text.includes('Temporary upstream unavailability returns 502') || text.includes('Both HTTP and FTP');
    return {ok: true, json: async () => ({choices: [{finish_reason: 'tool_calls', message: {tool_calls: [{type: 'function', function: {name: 'wiki_result', arguments: JSON.stringify({pages: {'Home.md': {source_id: Object.keys(input.source_evidence)[0], findings: supported ? '' : 'The source contradicts this claim.', supported}}})}}]}}]})};
  };
  try {await evaluateWiki(); assert.equal(calls, 4);}
  finally {globalThis.fetch = original;}
});

test('one corrected batch uses actionable findings and receives a new factual review on changed text', async () => {
  const source = {'src/auth.rs': 'Temporary upstream unavailability returns 502.'};
  for (const firstSupported of [false]) {
    const requests = [], diagnostics = [];
    const result = await planWiki({identity, source, wiki, diagnostic: result => diagnostics.push(result), complete: async ({messages}) => {
      const input = JSON.parse(messages[1].content); requests.push(input);
      if (input.proposed_update) {
        const corrected = input.proposed_update[0].content.includes('returns 502');
        return done(corrected ? facts(input.proposed_update, source) : rejection('Guide.md', 'src/auth.rs:L1', 'Temporary unavailability returns 502, not 401.'));
      }
      if (input.requested_page) return done({path: 'Guide.md', content: input.review_findings.length ? '[Home](Home) Temporary upstream unavailability returns 502.' : '[Home](Home) Temporary upstream unavailability returns 401.'});
      return done({pages: [{path: 'Guide.md', reason: 'Authentication status'}]});
    }});
    assert.equal(requests.length, 5);
    assert.deepEqual(requests[3].review_findings, ['Guide.md: Temporary unavailability returns 502, not 401.']);
    assert.deepEqual(requests[3].previous_update, requests[2].proposed_update);
    assert.notDeepEqual(requests[2].proposed_update, requests[4].proposed_update);
    assert.deepEqual(requests[2].source_evidence, requests[4].source_evidence);
    assert.match(result.updates[0].content, /returns 502/);
    assert.deepEqual(diagnostics.map(result => result.revision), [0, 1]);
    assert.equal(diagnostics[1].review.pages['Guide.md'].supported, true);
  }
});

test('correction refuses missing findings, repeated text and an exhausted substantive correction budget', async () => {
  for (const scenario of ['no-findings', 'unchanged', 'still-wrong']) {
    const source = {'README.md': 'Temporary upstream unavailability returns 502.'};
    let calls = 0, renders = 0, reviews = 0;
    const promise = planWiki({identity, source, wiki, complete: async ({messages}) => {
      calls++;
      const input = JSON.parse(messages[1].content);
      if (input.proposed_update) {reviews++; return done(rejection('Guide.md', 'README.md:L1', scenario === 'no-findings' ? '' : 'The status is wrong.'));}
      if (input.requested_page) {renders++; return done({path: 'Guide.md', content: '[Home](Home) Wrong status.' + (scenario === 'still-wrong' ? ` Still wrong ${renders}.` : '')});}
      return done({pages: [{path: 'Guide.md', reason: 'Authentication'}]});
    }});
    await assert.rejects(promise, scenario === 'no-findings' ? /contradicts page findings/ : scenario === 'unchanged' ? /did not change/ : /did not support/);
    assert.equal(reviews, scenario === 'still-wrong' ? 4 : 1);
    assert.equal(calls, scenario === 'no-findings' ? 3 : scenario === 'unchanged' ? 4 : 9);
  }
});

test('source references preserve exact indexed lines and never accept blank or invented evidence', async () => {
  const source = {'README.md': '\n# Gateway\n'};
  for (const id of ['README.md:L1', 'README.md:L2', 'README.md:L3', 'README.md:L999']) {
    const diagnostics = [];
    const promise = planWiki({identity, source, wiki, diagnostic: result => diagnostics.push(result), complete: async ({messages}) => {
      const input = JSON.parse(messages[1].content);
      if (input.proposed_update) return done({pages: {'Guide.md': {source_id: id, findings: '', supported: true}}});
      if (input.requested_page) return done({path: 'Guide.md', content: '[Home](Home) Gateway guide.'});
      return done({pages: [{path: 'Guide.md', reason: 'Gateway documentation'}]});
    }});
    if (id === 'README.md:L2') assert.equal((await promise).updates.length, 1);
    else await assert.rejects(promise, /exact source evidence/);
    assert.deepEqual(diagnostics[0].source_evidence, {'README.md:L1': '', 'README.md:L2': '# Gateway', 'README.md:L3': ''});
  }
});

test('every generation and factual request has a complete-context budget with no silent evidence truncation', async () => {
  let calls = 0;
  await assert.rejects(planWiki({identity, source: {'README.md': 's'.repeat(900000)}, wiki, complete: async () => {
    calls++;
    return done(calls === 1 ? {pages: [{path: 'Home.md', reason: 'Large document'}]} : {path: 'Home.md', content: 'x'.repeat(128000)});
  }}), /complete-context limit/);
  assert.equal(calls, 2, 'oversized review evidence must fail before a provider call');
});

test('native response schemas bind planning, the requested page and factual citations to distinct shapes', async () => {
  const source = {'README.md': '# Upload gateway'};
  const requests = [];
  await planWiki({identity, source, wiki, complete: async request => {
    requests.push(request);
    const input = JSON.parse(request.messages[1].content);
    return done(input.proposed_update ? facts(input.proposed_update, source) : input.requested_page ?
      {path: 'Guide.md', content: '[Home](Home) Upload gateway guide.'} : {pages: [{path: 'Guide.md', reason: 'Gateway contract'}]});
  }});
  assert.deepEqual(requests.map(request => request.model), ['deepseek-flash', 'deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual(requests.map(request => request.schema.required), [['pages'], ['path', 'content'], ['pages']]);
  assert.ok(requests.every(request => request.schema.additionalProperties === false));
  assert.deepEqual(requests[1].schema.properties.path.enum, ['Guide.md']);
  assert.deepEqual(requests[2].schema.properties.pages.required, ['Guide.md']);
  assert.deepEqual(requests[2].schema.properties.pages.properties['Guide.md'].required, ['source_id', 'findings', 'supported']);
  assert.equal(requests[2].schema.properties.pages.properties['Guide.md'].properties.supported.type, 'boolean');
});

test('an invalid planning decision leaves inspectable diagnostics and never reaches page generation', async () => {
  const plan = {pages: [{path: 'AGENTS.md', reason: 'Forbidden authority change'}]};
  const diagnostics = [];
  let calls = 0;
  await assert.rejects(planWiki({identity, source: {}, wiki, diagnostic: value => diagnostics.push(value), complete: async () => {calls++; return done(plan);}}), /Invalid wiki planned page/);
  assert.equal(calls, 1);
  assert.equal(diagnostics[0].stage, 'planning');
  assert.deepEqual(diagnostics[0].plan, plan);
  assert.equal(diagnostics[0].identity.source_sha, identity.source_sha);
});


test('correction refuses cycling back to any previously rejected draft, not only the immediately prior text', async () => {
  let renders = 0, reviews = 0;
  await assert.rejects(planWiki({identity, source: {'README.md': 'Correct fact.'}, wiki, complete: async ({messages}) => {
    const input = JSON.parse(messages[1].content);
    if (input.proposed_update) {reviews++; return done(rejection('Guide.md', 'README.md:L1', 'The fact is wrong.'));}
    if (input.requested_page) {renders++; return done({path: 'Guide.md', content: '[Home](Home) Wrong draft ' + (renders % 2)});}
    return done({pages: [{path: 'Guide.md', reason: 'Fact correction'}]});
  }}), /revisited rejected text/);
  assert.equal(renders, 3);
  assert.equal(reviews, 2, 'a repeated rejected draft is refused before another model verdict');
});


test('invalid factual response values remain inspectable before schema rejection', async () => {
  const diagnostics = [];
  const invalid = {pages: {'Guide.md': {source_id: 'README.md:L1', findings: null, supported: true}}};
  await assert.rejects(planWiki({identity, source: {'README.md': 'Gateway.'}, wiki, diagnostic: value => diagnostics.push(value), complete: async ({messages}) => {
    const input = JSON.parse(messages[1].content);
    return done(input.proposed_update ? invalid : input.requested_page ? {path: 'Guide.md', content: '[Home](Home) Guide.'} : {pages: [{path: 'Guide.md', reason: 'Documentation'}]});
  }}), /Invalid wiki factual review/);
  assert.equal(diagnostics[0].stage, 'factual-review');
  assert.deepEqual(diagnostics[0].review, invalid);
  assert.equal(diagnostics[0].source_evidence['README.md:L1'], 'Gateway.');
});

test('per-page findings regenerate only rejected pages and preserve the other page bytes exactly', async () => {
  const source = {'README.md': 'Temporary unavailability returns 502.'};
  const originalHome = '# Home\nHand-written introduction.\n[Guide](Guide)';
  const rendered = [], diagnostics = [];
  const result = await planWiki({identity, source, wiki, diagnostic: value => diagnostics.push(value), complete: async ({messages}) => {
    const input = JSON.parse(messages[1].content);
    if (input.proposed_update) {
      const report = facts(input.proposed_update, source);
      if (input.proposed_update[0].content.includes('401')) report.pages['Guide.md'] = {source_id: 'README.md:L1', findings: 'Unavailability returns 502, not 401.', supported: false};
      return done(report);
    }
    if (input.requested_page) {
      rendered.push(input.requested_page);
      return done({path: input.requested_page, content: input.requested_page === 'Home.md' ? originalHome : '[Home](Home) Unavailability returns ' + (input.review_findings.length ? '502.' : '401.')});
    }
    return done({pages: [{path: 'Guide.md', reason: 'Authentication'}, {path: 'Home.md', reason: 'Navigation'}]});
  }});
  assert.deepEqual(rendered, ['Guide.md', 'Home.md', 'Guide.md']);
  assert.equal(result.updates[1].content, originalHome);
  assert.match(result.updates[0].content, /502/);
  assert.equal(diagnostics[0].review.pages['Home.md'].supported, true);
  assert.equal(diagnostics[1].review.pages['Guide.md'].supported, true);
});
