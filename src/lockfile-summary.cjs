'use strict';

// Deterministic, pure dependency-change summaries for lockfiles.
//
// A changed lockfile can be megabytes of generated text that says little more than "these packages moved".
// Reviewers get a parsed set difference between the exact base and head bytes instead of the raw text and
// patch, and every way a dependency can be swapped stays visible in it. Nothing here executes, fetches or
// reads anything: the functions take text and return text, so the hosted review, the local review and the
// verification of a signed local receipt all compute the identical summary from identical bytes.

const crypto = require('node:crypto');
const path = require('node:path');

const ALGORITHM = 'lockfile-summary-v1';
const MAX_BYTES = 1000000;
const MAX_LINES = 3000;
const MAX_CHARS = 250000;
const LOCKFILE_PATCH = '# The raw lockfile patch is replaced by the derived dependency summary source.\n';

const REASONS = Object.freeze({
  too_large: `its text is larger than ${MAX_BYTES} bytes`,
  not_text: 'it is not valid UTF-8 text',
  invalid_syntax: 'it is not valid in the expected lockfile syntax',
  unsupported_version: 'its lockfile format version is not supported',
  invalid_structure: 'it does not have the expected lockfile structure',
  too_many_changes: 'it has more flagged, added or removed packages than can be listed completely',
  format_mismatch: 'it was renamed between lockfile formats',
});

class LockfileError extends Error {
  constructor(reason) {
    super(`Lockfile cannot be summarized: ${REASONS[reason]}`);
    this.reason = reason;
  }
}
const fail = reason => { throw new LockfileError(reason); };

function lockfileError(file, reason) {
  return Object.assign(new Error(`Lockfile ${file} cannot be summarized (${REASONS[reason]}) and its raw text is not reviewable within the limits`),
    {lockfile: {path: file, reason}});
}

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.length > 0;
const NEWLINES = /\r\n/g;

// Text shown to reviewers: no control characters, no credentials embedded in a URL, bounded, and
// fingerprinted when shortened so that two long values that differ late never look identical.
function show(value) {
  const clean = String(value).replace(/\/\/[^/@\s]+@/g, '//').replace(/[^\x20-\x7e]/g, '?');
  return clean.length > 160 ? `${clean.slice(0, 160)}...[fp:${sha256(clean).slice(0, 8)}]` : clean;
}

// A URL is described by what decides where the code comes from, never by its credentials or query.
function classifyUrl(raw, name, version) {
  const git = raw.startsWith('git+');
  let url;
  try { url = new URL(git ? raw.slice(4) : raw); } catch { return {source: `other:${raw}`, credentials: false}; }
  const credentials = Boolean(url.password) || (Boolean(url.username) && /^https?:$/.test(url.protocol));
  if (git || ['git:', 'ssh:'].includes(url.protocol)) return {source: `git:${url.host}${url.pathname}${url.hash}`, credentials};
  if (['file:', 'link:'].includes(url.protocol)) return {source: `file:${raw.replace(/^(?:file|link):/, '')}`, credentials};
  if (!['https:', 'http:'].includes(url.protocol)) return {source: `other:${raw}`, credentials};
  const http = url.protocol === 'http:';
  const scoped = name.split('/').pop();
  if (url.pathname === `/${name}/-/${scoped}-${version}.tgz`) return {source: `${http ? 'registry-http' : 'registry'}:${url.host}`, credentials};
  return {source: `url:${url.protocol}//${url.host}${url.pathname}`, credentials};
}

function hostOf(raw) {
  try { return new URL(raw).host; } catch { return raw; }
}

function registryName(raw) {
  try { const url = new URL(raw); return `${url.host}${url.pathname.replace(/\/$/, '')}`; } catch { return fail('invalid_structure'); }
}

function entry(id, name, version, source, integrity, flags = []) {
  return {id, name, version, source, integrity: integrity || null, flags: [...new Set(flags)].sort()};
}

function uniqueEntries(entries) {
  const seen = new Map();
  for (const item of entries) {
    const old = seen.get(item.id);
    if (old && JSON.stringify(old) !== JSON.stringify(item)) fail('invalid_structure');
    seen.set(item.id, item);
  }
  return [...seen.values()];
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return fail('invalid_syntax'); }
}

// ---------------------------------------------------------------- JSON formats

function parseNpm(text) {
  const lock = parseJson(text);
  if (!isObject(lock)) fail('invalid_structure');
  if (![2, 3].includes(lock.lockfileVersion)) fail('unsupported_version');
  if (!isObject(lock.packages)) fail('invalid_structure');
  const entries = [];
  for (const [key, value] of Object.entries(lock.packages)) {
    if (key === '') continue;
    if (!isObject(value) || (value.version !== undefined && !isText(value.version))) fail('invalid_structure');
    const marker = key.lastIndexOf('node_modules/');
    const name = marker < 0 ? key : key.slice(marker + 13);
    const version = value.version ?? '-';
    const flags = [];
    for (const [field, flag] of [['hasInstallScript', 'install-script'], ['dev', 'dev'], ['optional', 'optional'], ['peer', 'peer'], ['inBundle', 'bundled']]) {
      if (value[field] === true) flags.push(flag);
    }
    if (value.name !== undefined && value.name !== name) flags.push(`alias:${show(value.name)}`);
    let source = 'local';
    if (typeof value.resolved === 'string' && value.link === true) source = `file:${value.resolved}`;
    else if (typeof value.resolved === 'string') {
      const found = classifyUrl(value.resolved, name, version);
      source = found.source; if (found.credentials) flags.push('url-credentials');
    }
    entries.push(entry(key, name, version, source, typeof value.integrity === 'string' ? value.integrity : null, flags));
  }
  return entries;
}

function parseComposer(text) {
  const lock = parseJson(text);
  if (!isObject(lock) || !Array.isArray(lock.packages) || (lock['packages-dev'] !== undefined && !Array.isArray(lock['packages-dev']))) fail('invalid_structure');
  const entries = [];
  for (const [section, list] of [['packages', lock.packages], ['packages-dev', lock['packages-dev'] || []]]) {
    for (const item of list) {
      if (!isObject(item) || !isText(item.name) || !isText(item.version) || !(isObject(item.dist) || isObject(item.source))) fail('invalid_structure');
      const parts = []; const flags = section === 'packages-dev' ? ['dev'] : [];
      if (isObject(item.dist)) {
        const found = classifyUrl(String(item.dist.url), item.name, item.version);
        parts.push(`dist=${found.source}`); if (found.credentials) flags.push('url-credentials');
      }
      if (isObject(item.source)) parts.push(`src=${show(item.source.type)}:${show(item.source.url)}`);
      const raw = [item.dist?.shasum, item.dist?.reference, item.source?.reference].filter(Boolean).join('|');
      entries.push(entry(`${section}:${item.name}`, item.name, item.version, parts.join('; '), raw, flags));
    }
  }
  return entries;
}

function parsePipfile(text) {
  const lock = parseJson(text);
  if (!isObject(lock) || !isObject(lock._meta) || !isObject(lock.default) || (lock.develop !== undefined && !isObject(lock.develop))) fail('invalid_structure');
  const indexes = new Map((Array.isArray(lock._meta.sources) ? lock._meta.sources : []).filter(isObject).map(item => [item.name, item.url]));
  const entries = [];
  for (const [section, table] of [['default', lock.default], ['develop', lock.develop || {}]]) {
    for (const [name, value] of Object.entries(table)) {
      if (!isObject(value)) fail('invalid_structure');
      const flags = section === 'develop' ? ['dev'] : [];
      if (value.editable === true) flags.push('editable');
      let source;
      if (typeof value.git === 'string') source = `git:${show(value.git)}#${show(value.ref ?? '')}`;
      else if (typeof value.file === 'string' || typeof value.path === 'string') source = `file:${show(value.file ?? value.path)}`;
      else source = `index:${show(indexes.has(value.index) ? hostOf(indexes.get(value.index)) : value.index ?? 'pypi')}`;
      const hashes = Array.isArray(value.hashes) ? [...value.hashes].map(String).sort().join(',') : '';
      entries.push(entry(`${section}:${name}`, name, String(value.version ?? value.ref ?? '-').replace(/^==/, ''), source, hashes, flags));
    }
  }
  return entries;
}

// ---------------------------------------------------------------- pnpm (YAML subset)

const unquote = value => {
  const text = value.trim();
  return /^(['"]).*\1$/.test(text) && text.length > 1 ? text.slice(1, -1) : text;
};

function flowMap(text) {
  const value = (text || '').trim();
  if (!value.startsWith('{') || !value.endsWith('}')) fail('invalid_syntax');
  const map = Object.create(null);
  for (const part of value.slice(1, -1).split(',')) {
    if (!part.trim()) continue;
    const pair = /^\s*([A-Za-z]+):\s*(.*?)\s*$/.exec(part);
    if (!pair) fail('invalid_syntax');
    map[pair[1]] = unquote(pair[2]);
  }
  return map;
}

function parsePnpm(text) {
  const lines = text.replace(NEWLINES, '\n').split('\n');
  const declared = lines.map(line => /^lockfileVersion:\s*['"]?(\d+)/.exec(line)).find(Boolean);
  if (!declared) fail('invalid_structure');
  if (![6, 9].includes(Number(declared[1]))) fail('unsupported_version');
  const sections = {packages: [], snapshots: []};
  let target = null; let current = null;
  for (const line of lines) {
    if (/^\S/.test(line)) { target = sections[line.replace(/:\s*$/, '')] ?? null; current = null; continue; }
    if (!target || !line.trim()) continue;
    if (line.includes('\t')) fail('invalid_syntax');
    if (/^ {2}\S/.test(line)) {
      const header = /^ {2}(\S.*?):(?: \{\})?$/.exec(line);
      if (!header) fail('invalid_syntax');
      current = {key: unquote(header[1]).replace(/^\//, ''), props: Object.create(null)}; target.push(current);
    } else {
      const prop = /^ {4}([A-Za-z]+):\s*(.*)$/.exec(line);
      if (prop && current) current.props[prop[1]] = prop[2];
    }
  }
  const built = new Map();
  for (const item of sections.snapshots) {
    const key = item.key.replace(/\(.*$/, '');
    built.set(key, [...(built.get(key) || []), ...['requiresBuild', 'optional'].filter(name => item.props[name] === 'true')]);
  }
  return sections.packages.map(item => {
    const key = item.key.replace(/\(.*$/, '');
    const at = key.indexOf('@', 1);
    if (at < 1) fail('invalid_structure');
    const name = key.slice(0, at); const version = key.slice(at + 1);
    const resolution = flowMap(item.props.resolution);
    const flags = [...(built.get(key) || []).map(flag => flag === 'requiresBuild' ? 'install-script' : flag)];
    for (const [field, flag] of [['requiresBuild', 'install-script'], ['optional', 'optional'], ['dev', 'dev']]) {
      if (item.props[field] === 'true') flags.push(flag);
    }
    let source = 'registry:default';
    if (resolution.tarball) {
      const found = classifyUrl(resolution.tarball, name, version);
      source = found.source; if (found.credentials) flags.push('url-credentials');
    } else if (resolution.commit) source = `git:${show(resolution.repo ?? '')}#${show(resolution.commit)}`;
    else if (resolution.directory) source = `file:${show(resolution.directory)}`;
    return entry(key, name, version, source, resolution.integrity, flags);
  });
}

// ---------------------------------------------------------------- yarn (classic and berry)

function parseYarn(text) {
  const lines = text.replace(NEWLINES, '\n').split('\n');
  const berry = lines.includes('__metadata:');
  if (!berry && !lines.includes('# yarn lockfile v1')) fail('unsupported_version');
  const blocks = []; let block = null;
  for (const line of lines) {
    const header = /^([^\s#].*):$/.exec(line);
    if (header) { block = {header: header[1], fields: Object.create(null)}; blocks.push(block); continue; }
    const field = /^ {2}([A-Za-z]+):? (.*)$/.exec(line);
    if (field && block) block.fields[field[1]] = unquote(field[2]);
  }
  const entries = [];
  for (const item of blocks.filter(candidate => candidate.header !== '__metadata')) {
    // Classic lockfiles quote each descriptor, berry quotes the whole comma-joined header once.
    const first = item.header.split(', ')[0].replaceAll('"', '');
    const at = first.indexOf('@', 1);
    const version = item.fields.version;
    if (at < 1 || !isText(version)) fail('invalid_structure');
    const name = first.slice(0, at);
    const flags = []; let source; let key;
    if (berry) {
      const resolution = item.fields.resolution;
      if (!isText(resolution)) fail('invalid_structure');
      const protocol = resolution.slice(resolution.indexOf('@', 1) + 1);
      source = protocol.startsWith('npm:') ? 'registry:npm' : protocol.startsWith('workspace:') ? 'workspace' : `other:${show(protocol)}`;
      key = resolution;
    } else {
      if (!isText(item.fields.resolved)) fail('invalid_structure');
      const found = classifyUrl(item.fields.resolved, name, version);
      source = found.source; key = item.fields.resolved; if (found.credentials) flags.push('url-credentials');
    }
    entries.push(entry(key, name, version, source, item.fields.checksum || item.fields.integrity, flags));
  }
  return entries;
}

// ---------------------------------------------------------------- TOML subset (uv, poetry, Cargo)

const INCOMPLETE = Symbol('incomplete');

function tomlValue(state) {
  const {text} = state;
  const skip = () => { while (state.at < text.length && /\s/.test(text[state.at])) state.at++; };
  skip();
  if (state.at >= text.length) throw INCOMPLETE;
  const char = text[state.at];
  if (char === '"') {
    const match = /^"((?:[^"\\\n]|\\.)*)"/.exec(text.slice(state.at));
    if (!match || match[0].startsWith('"""')) fail('invalid_syntax');
    state.at += match[0].length;
    try { return JSON.parse(`"${match[1]}"`); } catch { return fail('invalid_syntax'); }
  }
  if (char === "'") {
    const end = text.indexOf("'", state.at + 1);
    if (end < 0 || text.slice(state.at, state.at + 3) === "'''") fail('invalid_syntax');
    const value = text.slice(state.at + 1, end); state.at = end + 1; return value;
  }
  if (char === '[' || char === '{') {
    const close = char === '[' ? ']' : '}'; const list = []; const table = Object.create(null);
    state.at++;
    for (;;) {
      skip();
      if (state.at >= text.length) throw INCOMPLETE;
      if (text[state.at] === close) { state.at++; return char === '[' ? list : table; }
      if (char === '[') list.push(tomlValue(state));
      else {
        const key = tomlKey(state);
        skip();
        if (text[state.at] !== '=') fail('invalid_syntax');
        state.at++;
        if (Object.hasOwn(table, key)) fail('invalid_syntax');
        table[key] = tomlValue(state);
      }
      skip();
      if (state.at >= text.length) throw INCOMPLETE;
      if (text[state.at] === ',') state.at++;
      else if (text[state.at] !== close) fail('invalid_syntax');
    }
  }
  const literal = /^(?:true|false|[+-]?\d[\d_.eE+-]*)(?![\w.])/.exec(text.slice(state.at));
  if (!literal) fail('invalid_syntax');
  state.at += literal[0].length;
  return literal[0] === 'true' ? true : literal[0] === 'false' ? false : Number(literal[0].replaceAll('_', ''));
}

function tomlKey(state) {
  const rest = state.text.slice(state.at);
  const quoted = /^"(?:[^"\\\n]|\\.)*"/.exec(rest);
  if (quoted) { state.at += quoted[0].length; try { return JSON.parse(quoted[0]); } catch { return fail('invalid_syntax'); } }
  const bare = /^[A-Za-z0-9_-]+/.exec(rest);
  if (!bare) fail('invalid_syntax');
  state.at += bare[0].length; return bare[0];
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === '"' && char === '\\') i++;
    else if (quote) { if (char === quote) quote = null; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === '#') return line.slice(0, i);
  }
  return line;
}

const TOML_NAME = '[A-Za-z0-9_-]+(?:\\s*\\.\\s*[A-Za-z0-9_-]+)*';

function parseToml(text) {
  const root = Object.create(null); let table = root;
  const lines = text.replace(NEWLINES, '\n').split('\n');
  const walk = parts => {
    let node = root;
    for (const part of parts) {
      if (!Object.hasOwn(node, part)) node[part] = Object.create(null);
      node = node[part];
      if (Array.isArray(node)) node = node[node.length - 1];
      if (!isObject(node)) fail('invalid_syntax');
    }
    return node;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = stripComment(lines[index]).trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      const array = new RegExp(`^\\[\\[\\s*(${TOML_NAME})\\s*\\]\\]$`).exec(line);
      const plain = new RegExp(`^\\[\\s*(${TOML_NAME})\\s*\\]$`).exec(line);
      if (!array && !plain) fail('invalid_syntax');
      const parts = (array || plain)[1].split('.').map(part => part.trim());
      if (array) {
        const parent = walk(parts.slice(0, -1)); const last = parts[parts.length - 1];
        if (!Object.hasOwn(parent, last)) parent[last] = [];
        if (!Array.isArray(parent[last])) fail('invalid_syntax');
        table = Object.create(null); parent[last].push(table);
      } else table = walk(parts);
      continue;
    }
    const head = {text: line, at: 0};
    const key = tomlKey(head);
    const after = /^\s*=\s*(.*)$/.exec(line.slice(head.at));
    if (!after || !after[1]) fail('invalid_syntax');
    if (Object.hasOwn(table, key)) fail('invalid_syntax');
    let valueText = after[1]; let rest;
    for (;;) {
      const state = {text: valueText, at: 0};
      try { table[key] = tomlValue(state); rest = valueText.slice(state.at); break; } catch (error) {
        if (error !== INCOMPLETE) throw error;
        if (++index >= lines.length) fail('invalid_syntax');
        valueText += `\n${stripComment(lines[index]).trim()}`;
      }
    }
    if (rest.trim()) fail('invalid_syntax');
  }
  return root;
}

function packages(root) {
  if (root.package === undefined) return [];
  if (!Array.isArray(root.package) || root.package.some(item => !isObject(item) || !isText(item.name))) fail('invalid_structure');
  return root.package;
}

function parseUv(text) {
  const root = parseToml(text);
  if (!Number.isInteger(root.version)) fail('unsupported_version');
  return uniqueEntries(packages(root).map(item => {
    const kind = isObject(item.source) ? Object.keys(item.source)[0] : null;
    if (!kind || !isText(item.source[kind]) || (item.version !== undefined && !isText(item.version))) fail('invalid_structure');
    const location = kind === 'registry' ? registryName(item.source[kind]) : item.source[kind];
    const artifacts = [item.sdist, ...(Array.isArray(item.wheels) ? item.wheels : [])].filter(isObject);
    const hosts = [...new Set(artifacts.filter(artifact => isText(artifact.url)).map(artifact => hostOf(artifact.url)))].sort();
    const hashes = [...new Set(artifacts.filter(artifact => isText(artifact.hash)).map(artifact => artifact.hash))].sort();
    const base = `${kind}:${show(location)}`;
    return entry(`${item.name}@${item.version ?? '-'}|${base}`, item.name, item.version ?? '-', hosts.length ? `${base}; artifacts=${hosts.map(show).join(',')}` : base, hashes.join(','));
  }));
}

function parsePoetry(text) {
  const root = parseToml(text);
  // Before lock-version 2 the hashes live in [metadata.files], which a package-level summary would silently ignore.
  if (!isObject(root.metadata) || !/^2\./.test(root.metadata['lock-version'])) fail('unsupported_version');
  return uniqueEntries(packages(root).map(item => {
    if (!isText(item.version) || (item.source !== undefined && !(isObject(item.source) && isText(item.source.type) && isText(item.source.url)))) fail('invalid_structure');
    let source = 'registry:pypi';
    if (item.source) {
      const type = item.source.type === 'legacy' ? 'index' : item.source.type;
      source = `${type}:${show(type === 'index' ? registryName(item.source.url) : item.source.url)}${isText(item.source.resolved_reference) ? `#${show(item.source.resolved_reference)}` : ''}`;
    }
    const hashes = (Array.isArray(item.files) ? item.files : []).filter(file => isObject(file) && isText(file.hash)).map(file => file.hash);
    return entry(`${item.name}@${item.version}|${source}`, item.name, item.version, source, [...new Set(hashes)].sort().join(','), item.optional === true ? ['optional'] : []);
  }));
}

function parseCargo(text) {
  const root = parseToml(text);
  if (![3, 4].includes(root.version)) fail('unsupported_version');
  return uniqueEntries(packages(root).map(item => {
    if (!isText(item.version) || (item.source !== undefined && !isText(item.source))) fail('invalid_structure');
    let source = 'path';
    const flags = [];
    if (item.source) {
      const registry = /^(?:registry|sparse)\+(.*)$/.exec(item.source);
      if (registry) source = `registry:${registryName(registry[1])}`;
      else { const found = classifyUrl(item.source, item.name, item.version); source = found.source; if (found.credentials) flags.push('url-credentials'); }
    }
    return entry(`${item.name}@${item.version}|${source}`, item.name, item.version, source, item.checksum, flags);
  }));
}

// ---------------------------------------------------------------- Gemfile.lock and go.sum

function parseGemfile(text) {
  const sections = []; let section = null;
  for (const line of text.replace(NEWLINES, '\n').split('\n')) {
    if (/^[A-Z]/.test(line)) { section = {name: line.trim(), lines: []}; sections.push(section); }
    else if (section && line.trim()) section.lines.push(line);
  }
  const checksums = new Map();
  for (const line of sections.filter(item => item.name === 'CHECKSUMS').flatMap(item => item.lines)) {
    const found = /^ {2}(\S+) \(([^)]+)\) (\S+)$/.exec(line);
    if (!found) fail('invalid_syntax');
    checksums.set(`${found[1]}@${found[2]}`, found[3]);
  }
  const specs = sections.filter(item => ['GEM', 'GIT', 'PATH', 'PLUGIN SOURCE'].includes(item.name));
  if (!specs.length && !sections.some(item => item.name === 'DEPENDENCIES')) fail('invalid_structure');
  const entries = [];
  for (const item of specs) {
    const remotes = item.lines.filter(line => /^ {2}remote: /.test(line)).map(line => line.slice(10).trim()).sort();
    const revision = item.lines.find(line => /^ {2}revision: /.test(line))?.slice(12).trim() ?? '';
    const source = item.name === 'GIT' ? `git:${show(remotes.join(','))}#${show(revision)}` : item.name === 'PATH' ? `file:${show(remotes.join(','))}` :
      `registry:${remotes.map(remote => show(registryName(remote))).join(',')}`;
    for (const line of item.lines) {
      const spec = /^ {4}([^\s(]+) \(([^)]+)\)$/.exec(line);
      if (spec) entries.push(entry(`${spec[1]}@${spec[2]}|${source}`, spec[1], spec[2], source, checksums.get(`${spec[1]}@${spec[2]}`)));
    }
  }
  return uniqueEntries(entries);
}

function parseGoSum(text) {
  return uniqueEntries(text.replace(NEWLINES, '\n').split('\n').filter(line => line.trim()).map(line => {
    const found = /^(\S+) (\S+?)(\/go\.mod)? (h1:\S+)$/.exec(line);
    if (!found) fail('invalid_syntax');
    return entry(`${found[1]}@${found[2]}${found[3] ?? ''}`, `${found[1]}${found[3] ? ' (go.mod)' : ''}`, found[2], 'module', found[4]);
  }));
}

// One table: every lockfile name Clouseau summarizes, its format and whether the format records integrity.
const LOCKFILES = Object.freeze({
  'package-lock.json': {format: 'npm', parse: parseNpm, integrity: true},
  'npm-shrinkwrap.json': {format: 'npm', parse: parseNpm, integrity: true},
  'pnpm-lock.yaml': {format: 'pnpm', parse: parsePnpm, integrity: true},
  'yarn.lock': {format: 'yarn', parse: parseYarn, integrity: false},
  'uv.lock': {format: 'uv', parse: parseUv, integrity: true},
  'poetry.lock': {format: 'poetry', parse: parsePoetry, integrity: true},
  'Cargo.lock': {format: 'cargo', parse: parseCargo, integrity: false},
  'Gemfile.lock': {format: 'gemfile', parse: parseGemfile, integrity: false},
  'go.sum': {format: 'go', parse: parseGoSum, integrity: true},
  'composer.lock': {format: 'composer', parse: parseComposer, integrity: false},
  'Pipfile.lock': {format: 'pipfile', parse: parsePipfile, integrity: true},
});

const specFor = file => Object.hasOwn(LOCKFILES, path.posix.basename(file)) ? LOCKFILES[path.posix.basename(file)] : null;
const isLockfile = file => specFor(file) !== null;

// ---------------------------------------------------------------- difference

// Returns -1, 0 or 1, or null when the two values are not comparable release versions.
function compareVersions(a, b) {
  if (!/^v?\d/.test(a) || !/^v?\d/.test(b)) return null;
  const left = a.replace(/^v/, '').split(/[.\-+_]/); const right = b.replace(/^v/, '').split(/[.\-+_]/);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    if (/^\d+$/.test(left[i]) && /^\d+$/.test(right[i])) return Number(left[i]) < Number(right[i]) ? -1 : 1;
    return left[i] < right[i] ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  const longer = left.length > right.length ? left : right;
  const higher = /^\d/.test(longer[Math.min(left.length, right.length)]) ? 1 : -1;
  return (left.length > right.length ? 1 : -1) * higher;
}

const isRegistry = source => /^(?:registry|index)/.test(source);
const fingerprint = value => value === null ? 'none' : `fp:${sha256(value).slice(0, 12)}`;
const RISKY_FLAGS = ['install-script', 'url-credentials', 'alias'];
const byText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function addedTags(item, integrity) {
  const tags = [];
  if (!isRegistry(item.source)) tags.push('non-registry-source');
  if (integrity && isRegistry(item.source) && !item.integrity) tags.push('no-integrity');
  for (const flag of item.flags) if (RISKY_FLAGS.includes(flag.split(':')[0])) tags.push(`${flag.split(':')[0]}-added`);
  return tags;
}

function describe(before, after, integrity) {
  const tags = []; const parts = [];
  const versionChanged = before.version !== after.version;
  parts.push(versionChanged ? `version ${show(before.version)} -> ${show(after.version)}` : `version ${show(after.version)} (unchanged)`);
  if (before.source !== after.source) {
    tags.push('source-changed'); if (isRegistry(before.source) && !isRegistry(after.source)) tags.push('left-registry');
    parts.push(`source ${show(before.source)} -> ${show(after.source)}`);
  }
  if (before.integrity !== after.integrity) {
    if (before.integrity && !after.integrity) tags.push('integrity-removed');
    else if (!versionChanged) tags.push('integrity-changed-same-version');
    parts.push(`integrity ${fingerprint(before.integrity)} -> ${fingerprint(after.integrity)}`);
  }
  const added = after.flags.filter(flag => !before.flags.includes(flag));
  const removed = before.flags.filter(flag => !after.flags.includes(flag));
  if (added.length || removed.length) parts.push(`flags +[${added.join(',')}] -[${removed.join(',')}]`);
  for (const flag of added) if (RISKY_FLAGS.includes(flag.split(':')[0])) tags.push(`${flag.split(':')[0]}-added`);
  if (compareVersions(after.version, before.version) === -1) tags.push('downgrade');
  const quiet = !tags.length && before.source === after.source && !added.length && !removed.length;
  return {tags: [...new Set(tags)], parts, tier: tags.length ? 0 : quiet ? 2 : 1};
}

function difference(base, head, integrity) {
  const groups = new Map();
  for (const [side, list] of [['base', base], ['head', head]]) {
    for (const item of list) {
      if (!groups.has(item.name)) groups.set(item.name, {base: new Map(), head: new Map()});
      groups.get(item.name)[side].set(item.id, item);
    }
  }
  const records = [];
  for (const [name, group] of groups) {
    const left = []; const right = [];
    for (const [id, item] of group.base) {
      if (group.head.has(id)) {
        const other = group.head.get(id);
        if (JSON.stringify(item) !== JSON.stringify(other)) records.push({name, kind: 'changed', ...describe(item, other, integrity), version: other.version});
      } else left.push(item);
    }
    for (const [id, item] of group.head) if (!group.base.has(id)) right.push(item);
    left.sort((a, b) => byText(a.version, b.version) || byText(a.id, b.id)); right.sort((a, b) => byText(a.version, b.version) || byText(a.id, b.id));
    const paired = Math.min(left.length, right.length);
    for (let i = 0; i < paired; i++) {
      // The same package content at another location (a hoisting move) changes nothing a reviewer can act on.
      if (JSON.stringify({...left[i], id: ''}) !== JSON.stringify({...right[i], id: ''})) records.push({name, kind: 'changed', ...describe(left[i], right[i], integrity), version: right[i].version});
    }
    for (const item of left.slice(paired)) records.push({name, kind: 'removed', version: item.version, tags: [], tier: 1,
      parts: [`${show(item.name)}@${show(item.version)} source=${show(item.source)} integrity=${fingerprint(item.integrity)}${item.flags.length ? ` flags=${item.flags.join(',')}` : ''}`]});
    for (const item of right.slice(paired)) {
      const tags = addedTags(item, integrity);
      records.push({name, kind: 'added', version: item.version, tags, tier: tags.length ? 0 : 1,
        parts: [`${show(item.name)}@${show(item.version)} source=${show(item.source)} integrity=${fingerprint(item.integrity)}${item.flags.length ? ` flags=${item.flags.map(show).join(',')}` : ''}`]});
    }
  }
  return records.sort((a, b) => byText(a.name, b.name) || byText(a.version, b.version) || byText(a.kind, b.kind));
}

function line(record) {
  const prefix = record.tags.length ? `RISK[${record.tags.join(',')}] ` : '';
  return record.kind === 'changed' ? `${prefix}CHANGED ${show(record.name)}: ${record.parts.join('; ')}` : `${prefix}${record.kind.toUpperCase()} ${record.parts[0]}`;
}

function parseSide(spec, text) {
  if (text === null) return [];
  if (Buffer.byteLength(text) > MAX_BYTES) fail('too_large');
  if (text.includes('\0')) fail('not_text');
  return spec.parse(text);
}

// Summarizes the dependency difference between the exact base and head text of one lockfile. `baseText` is null
// when the file was added and `headText` is null when it was removed. Anything that cannot be summarized
// completely throws a LockfileError with a fixed reason; nothing is ever truncated silently.
function summarizeLockfile({path: file, previousPath = file, status, baseText, headText}) {
  const spec = specFor(file);
  if (!spec) fail('format_mismatch');
  if (status !== 'added' && specFor(previousPath) !== spec) fail('format_mismatch');
  const base = parseSide(spec, baseText); const head = parseSide(spec, headText);
  const records = difference(base, head, spec.integrity);
  const tiers = [0, 1, 2].map(tier => records.filter(record => record.tier === tier));
  const counts = kind => records.filter(record => record.kind === kind).length;
  const head_lines = [
    `Dependency lockfile summary (${ALGORITHM}, derived from the exact base and head bytes; it replaces the lockfile raw text and patch)`,
    `file: ${show(file)} (${spec.format}, ${status})`,
    `base: ${baseText === null ? 'absent' : `${base.length} entries, sha256 ${sha256(baseText)}`}`,
    `head: ${headText === null ? 'absent' : `${head.length} entries, sha256 ${sha256(headText)}`}`,
    `changes: ${counts('added')} added, ${counts('removed')} removed, ${counts('changed')} changed; ${tiers[0].length} flagged RISK, ${tiers[1].length} other added/removed/changed, ${tiers[2].length} version-only updates`,
    'RISK tags: source-changed, left-registry, integrity-changed-same-version, integrity-removed, no-integrity, non-registry-source, install-script-added, url-credentials-added, alias-added, downgrade',
  ];
  const body = [];
  for (const [title, list] of [['## Flagged for review', tiers[0]], ['## Other added, removed and changed packages', tiers[1]]]) {
    if (list.length) body.push(title, ...list.map(line));
  }
  let used = head_lines.length + body.length + (tiers[2].length ? 2 : 0);
  let chars = [...head_lines, ...body].join('\n').length;
  if (used + 1 > MAX_LINES || chars > MAX_CHARS) fail('too_many_changes');
  const updates = [];
  for (const record of tiers[2]) {
    const text = line(record);
    if (used + 2 > MAX_LINES || chars + text.length + 1 > MAX_CHARS) break;
    updates.push(text); used++; chars += text.length + 1;
  }
  if (tiers[2].length) body.push('## Version-only updates (source, integrity presence and flags unchanged, no downgrade)', ...updates);
  if (updates.length < tiers[2].length) body.push(`... ${tiers[2].length - updates.length} more version-only updates not listed here (counted in the changes line above)`);
  return {format: spec.format, content: `${[...head_lines, ...body].join('\n')}\n`, derived: {algorithm: ALGORITHM, format: spec.format, status,
    base_path: baseText === null ? null : previousPath, base_sha256: baseText === null ? null : sha256(baseText),
    head_sha256: headText === null ? null : sha256(headText)}};
}

// The derived evidence item for a changed file. `file` is {filename, previous_filename, status}.
function lockfileEvidence({file, baseSha, headSha, baseText, headText}) {
  const out = summarizeLockfile({path: file.filename, previousPath: file.previous_filename || file.filename, status: file.status, baseText, headText});
  const id = `lockfile-summary:${(out.derived.base_sha256 || 'none').slice(0, 16)}:${(out.derived.head_sha256 || 'none').slice(0, 16)}:${file.filename}`;
  return {id, source: {path: file.filename, ref: file.status === 'removed' ? baseSha : headSha, authority: 'derived',
    kind: 'lockfile-summary', content: out.content, derived: out.derived}};
}

module.exports = {ALGORITHM, MAX_BYTES, MAX_LINES, MAX_CHARS, LOCKFILE_PATCH, REASONS, LOCKFILES, LockfileError, lockfileError,
  isLockfile, summarizeLockfile, lockfileEvidence, compareVersions, classifyUrl, parseToml};
