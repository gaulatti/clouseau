'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {BEGIN, END, FILE, MAX_DIGESTS, validate, parse, blockDigest, judge, exemptions} = require('./managed-agents.cjs');
const {validateConfig} = require('./config.cjs');

const LOCAL = '<!-- Repository-specific instructions below are maintained locally. -->';
const block = body => `${BEGIN}\n${body}\n${END}\n`;
const file = (managed, local = '# Local\n\nKeep tests honest.\n') => `${managed}\n${LOCAL}\n\n${local}`;
const OLD = block('# General agent instructions\n\nRule one.');
const NEW = block('# General agent instructions\n\nRule one.\n\nRule two.');
const digests = [blockDigest(NEW)];
const verdict = (baseText, headText, enrolled = digests) => judge({baseText, headText, digests: enrolled});

test('the block digest is the SHA-256 of the marker lines and everything between, with a final newline', () => {
  // `awk '$0==b{i=1} i{print} $0==e{i=0}' AGENTS.md | shasum -a 256` hashes exactly these bytes.
  assert.equal(parse(file(NEW)).block, NEW);
  assert.equal(blockDigest(NEW), require('node:crypto').createHash('sha256').update(NEW).digest('hex'));
});

test('configuration accepts only a bounded list of distinct lowercase SHA-256 digests', () => {
  assert.deepEqual(validate({digests}), {digests});
  const many = Array.from({length: MAX_DIGESTS}, (_, index) => index.toString(16).padStart(64, '0'));
  assert.equal(validate({digests: many}).digests.length, MAX_DIGESTS);
  const one = digests[0];
  for (const bad of [undefined, null, 'x', [], {}, {digests: []}, {digests: 'x'}, {digests: [one, one]}, {digests: [one.toUpperCase()]},
    {digests: ['a'.repeat(63)]}, {digests: [7]}, {digests: [one], extra: true}, {digests: [...many, one]}]) {
    assert.throws(() => validate(bad), /Invalid managed_agents configuration/, JSON.stringify(bad));
  }
  const config = {...require('../test/fixtures/config.json'), managed_agents: {digests}};
  assert.deepEqual(validateConfig(config).managed_agents, {digests});
  assert.throws(() => validateConfig({...config, managed_agents: {digests: []}}), /Invalid managed_agents/);
  assert.equal(validateConfig(require('../test/fixtures/config.json')).managed_agents, undefined);
});

test('a managed block update with every other byte unchanged is exempt, whatever the local rules say', () => {
  for (const local of ['# Local\n\nKeep tests honest.\n', '', '\n\n']) {
    const result = verdict(file(OLD, local), file(NEW, local));
    assert.equal(result.exempt, true, local);
    assert.equal(result.digest, digests[0]);
  }
  assert.equal(verdict(`Preface\n${file(OLD)}`, `Preface\n${file(NEW)}`).exempt, true, 'unchanged text before the block is outside it');
  assert.equal(verdict(file(OLD).replace(/\n$/, ''), file(NEW).replace(/\n$/, '')).exempt, true, 'no final newline');
});

test('any other change keeps the protected-control hold', () => {
  const base = file(OLD);
  const held = (head, reason, enrolled) => {
    const result = verdict(base, head, enrolled);
    assert.equal(result.exempt, false, head);
    assert.match(result.reason, reason, head);
  };
  // Local rules edited, with or without the real block.
  held(file(NEW, '# Local\n\nSkip the tests.\n'), /outside the managed block changed/);
  held(`${file(NEW)}\nExtra rule appended.\n`, /outside the managed block changed/);
  held(`Injected instruction.\n${file(NEW)}`, /outside the managed block changed/);
  held(file(NEW).replace(LOCAL, `${LOCAL} `), /outside the managed block changed/);
  held(file(NEW).replace('\n\n', '\n'), /not an enrolled|outside the managed block changed/);
  // Block bytes not an enrolled snapshot: partial edit, whitespace, line endings.
  held(file(block('# General agent instructions\n\nRule one.\n\nRule two. ')), /not an enrolled/);
  held(file(block('# General agent instructions\n\nRule one.\n\nRule two.\n')), /not an enrolled/);
  held(file(NEW).replace(/\n/g, '\r\n'), /exactly one well-formed managed block/);
  held(file(NEW).replace('Rule two.', 'Rule 2.'), /not an enrolled/);
  held(file(OLD), /not an enrolled/);
  held(file(NEW), /not an enrolled/, [blockDigest(OLD)]);
  // Markers wrapped around edited rules, duplicated, reordered, padded or nested.
  held(`${BEGIN}\nInjected.\n${file(NEW)}`, /exactly one well-formed/);
  held(`${file(NEW)}\n${BEGIN}\nInjected.\n${END}\n`, /exactly one well-formed/);
  held(`${file(NEW)}\n${END}\n`, /exactly one well-formed/);
  held(file(NEW).replace(END, `${END}\n${END}`), /exactly one well-formed/);
  held(`${END}\n${NEW.split('\n').slice(1, -2).join('\n')}\n${BEGIN}\n\n${LOCAL}\n`, /exactly one well-formed/);
  held(file(NEW).replace(BEGIN, ` ${BEGIN}`), /exactly one well-formed/);
  held(file(NEW).replace(END, `${END} `), /exactly one well-formed/);
  held(file(NEW).replace(BEGIN, BEGIN.toLowerCase()), /exactly one well-formed/);
  held(file(NEW).replace(BEGIN, `${BEGIN} ${BEGIN}`), /exactly one well-formed/);
  held('', /exactly one well-formed/);
  // Wrapping the local rules into a larger enrolled-looking block changes the digest.
  const wrapped = `${BEGIN}\n# General agent instructions\n\nRule one.\n\nRule two.\n# Local\n\nSkip the tests.\n${END}\n\n${LOCAL}\n`;
  held(wrapped, /not an enrolled/);
  // A base without one well-formed block never defines "outside the block".
  assert.match(verdict('# Local only\n', file(NEW)).reason, /base file does not contain exactly one/);
  assert.match(verdict(`${file(OLD)}${BEGIN}\n`, file(NEW)).reason, /base file does not contain exactly one/);
});

function fakeGithub(texts, calls = []) {
  return {rest: {repos: {getContent: async args => {
    calls.push(args);
    const value = texts[args.ref];
    if (value instanceof Error) throw value;
    return {data: value};
  }}}};
}
const content = text => ({encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text)});
const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const repo = {owner: 'gaulatti', repo: 'target'};
const pr = {base: {sha: BASE}, head: {sha: HEAD, repo: {owner: {login: 'forker'}, name: 'target-fork'}}};
const config = {managed_agents: {digests}};
const modified = {filename: FILE, status: 'modified', patch: '@@'};

test('without managed_agents nothing is read and nothing is exempt', async () => {
  const calls = [];
  const result = await exemptions({github: fakeGithub({}, calls), repo, pr, files: [modified], config: {}});
  assert.deepEqual(result, {exempt: new Set(), notices: []});
  assert.equal(calls.length, 0);
});

test('files other than AGENTS.md read nothing and produce no notice', async () => {
  const calls = [];
  const result = await exemptions({github: fakeGithub({}, calls), repo, pr, files: [{...modified, filename: 'src/a.js'}], config});
  assert.deepEqual(result, {exempt: new Set(), notices: []});
  assert.equal(calls.length, 0);
});

test('the verified update is exempt; base is read from the base repository and head from the head repository', async () => {
  const calls = [];
  const github = fakeGithub({[BASE]: content(file(OLD)), [HEAD]: content(file(NEW))}, calls);
  const result = await exemptions({github, repo, pr, files: [modified, {filename: 'README.md', status: 'modified'}], config});
  assert.deepEqual([...result.exempt], [FILE]);
  assert.match(result.notices[0], new RegExp(`^AGENTS.md is not a protected-control hold: .* \\(sha256 ${digests[0]}\\)\\.$`));
  assert.deepEqual(calls.map(call => [call.owner, call.repo, call.path, call.ref]),
    [['gaulatti', 'target', FILE, BASE], ['forker', 'target-fork', FILE, HEAD]]);
});

test('an unverified update is named and stays held', async () => {
  const run = async (files, texts, pull = pr) => exemptions({github: fakeGithub(texts), repo, pr: pull, files, config});
  const texts = {[BASE]: content(file(OLD)), [HEAD]: content(file(NEW, 'Skip the tests.\n'))};
  let result = await run([modified], texts);
  assert.equal(result.exempt.size, 0);
  assert.deepEqual(result.notices, ['AGENTS.md stays a protected-control hold: content outside the managed block changed.']);
  for (const changed of [{...modified, status: 'added'}, {...modified, status: 'removed'}, {...modified, status: 'renamed', previous_filename: 'OLD.md'},
    {...modified, filename: 'docs/AGENTS.md', previous_filename: FILE, status: 'renamed'}, {...modified, previous_filename: FILE}]) {
    result = await run([changed], {});
    assert.equal(result.exempt.size, 0);
    assert.match(result.notices[0], /only a modification of the existing file qualifies/);
  }
  for (const head of [{sha: HEAD}, {sha: HEAD, repo: null}, {sha: HEAD, repo: {owner: {}, name: 'x'}}, {sha: HEAD, repo: {owner: {login: 'x'}}}]) {
    result = await run([modified], {}, {...pr, head});
    assert.match(result.notices[0], /head repository is unavailable/);
  }
  const unavailable = [{encoding: 'none', content: '', size: 2000000}, {encoding: 'base64', content: 5, size: 1},
    {...content('x'), size: 400000}, {...content(file(OLD)), content: Buffer.from([0xff, 0xfe]).toString('base64')},
    content('has a \0 byte')];
  for (const bad of unavailable) {
    result = await run([modified], {[BASE]: bad, [HEAD]: content(file(NEW))});
    assert.match(result.notices[0], /unavailable as complete text/);
    result = await run([modified], {[BASE]: content(file(OLD)), [HEAD]: bad});
    assert.match(result.notices[0], /unavailable as complete text/);
  }
});

test('transport failures are not mistaken for a verdict', async () => {
  await assert.rejects(exemptions({github: fakeGithub({[BASE]: new Error('rate limited')}), repo, pr, files: [modified], config}), /rate limited/);
});
