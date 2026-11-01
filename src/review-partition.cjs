'use strict';

// Deterministic partition of a large change into review units (scheme
// clouseau-partition/1, see the chunked review design, section 2). Pure and
// model-free: the same changed-file table and parameters give the same plan in
// any input order, so CI can recompute it. Nothing here is called by the review
// flow yet.
//
// A change is never refused for its size. A file whose evidence is too large for one unit is split into bounded
// segments (see file-segments.cjs), each owned by a different unit, and the number of units is unbounded: running
// them in waves is the runner's concern. Every changed line is owned by exactly one unit.
const crypto = require('node:crypto');
const fs = require('node:fs');

const SCHEME = 'clouseau-partition/1';
// unit_ceiling C and shared S are owned-source and shared-context characters; budget is the snapshot cap a unit
// view must fit and reserve what a view adds besides owned and shared sources (change manifest and foreign hunks).
// A file or atom costing more than budget - shared - reserve cannot be one unit and is split into segments of at
// most C; file_overhead is the per-file cost of its accounting entry and manifest row.
const DEFAULTS = Object.freeze({unit_ceiling: 450000, shared: 100000, budget: 900000, reserve: 240000, file_overhead: 512});

class PartitionRefusal extends Error {
  constructor(code, message, paths) {
    super(`${code}: ${message}`);
    this.name = 'PartitionRefusal';
    this.code = code;
    this.paths = paths;
  }
}

const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
// ceil(1.03 * n) in integer arithmetic.
const inflate = characters => Math.floor((103 * characters + 99) / 100);

function parameters(overrides) {
  const params = {...DEFAULTS, ...overrides};
  for (const [name, value] of Object.entries(params)) {
    if (!(name in DEFAULTS) || !Number.isSafeInteger(value) || value < (name === 'file_overhead' ? 0 : 1)) throw new TypeError(`invalid partition parameter ${name}`);
  }
  if (params.unit_ceiling > threshold(params)) throw new TypeError('unit_ceiling must fit budget minus shared and reserve');
  return params;
}

// The largest cost of one unit: above it a file or atom is split.
function threshold(params) {
  return params.budget - params.shared - params.reserve;
}

function normalize(file) {
  const path = file?.path;
  const unsafe = typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\0') ||
    path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..');
  if (unsafe) throw new PartitionRefusal('unpartitionable_path', `unsafe changed path ${JSON.stringify(path)}`, [String(path)]);
  if (file.binary === true) throw new PartitionRefusal('unpartitionable_binary', `binary change ${path}`, [path]);
  for (const field of ['base_size', 'head_size', 'patch_chars']) {
    if (!Number.isSafeInteger(file[field]) || file[field] < 0) throw new TypeError(`${path}: invalid ${field}`);
  }
  if (file.derived_size !== undefined && (!Number.isSafeInteger(file.derived_size) || file.derived_size < 0)) {
    throw new TypeError(`${path}: invalid derived_size`);
  }
  if (file.segments !== undefined && (!Array.isArray(file.segments) || !file.segments.length ||
      file.segments.some(size => !Number.isSafeInteger(size) || size < 0))) {
    throw new TypeError(`${path}: invalid segments`);
  }
  return {path, previous: file.previous ?? null, base_size: file.base_size, head_size: file.head_size,
    patch_chars: file.patch_chars, derived_size: file.derived_size, segments: file.segments};
}

// A derived file (a lockfile replaced by a summary CI can recompute) costs its summary, not its sources.
function cost(file, params) {
  const size = file.derived_size ?? (file.base_size + file.head_size + file.patch_chars);
  return inflate(size) + params.file_overhead;
}

// The sizes a file is split into when it is too large for one unit: the segments of its own patch rows when the
// row carries them (see file-segments.cjs), otherwise equal parts of its cost. A derived summary is never split.
function segmentSizes(file, params) {
  if (file.derived_size !== undefined || file.cost <= threshold(params)) return null;
  if (file.segments) return file.segments.map(size => inflate(size) + params.file_overhead);
  const count = Math.ceil(file.cost / params.unit_ceiling);
  return Array.from({length: count}, (_, index) => Math.floor(file.cost / count) + (index < file.cost % count ? 1 : 0));
}

// Atom key: directory plus stem, with the extension and a .test/.spec/.stories marker removed, so a file
// stays with its tests. A rename is keyed by its new path, so both ends travel in one file entry.
function atomKey(path) {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1).replace(/\.[^.]*$/, '').replace(/\.(test|spec|stories)$/, '');
  return `${path.slice(0, slash + 1)}${name}`;
}

// One member per whole file and one per segment of a split file. A split file's segments are atoms of their own
// (a segment is already as large as a unit can hold and never shares a stem group).
function membersOf(files, params) {
  return files.flatMap(file => {
    const sizes = segmentSizes(file, params);
    return sizes ? sizes.map((size, index) => ({...file, cost: size, part: {index, count: sizes.length}})) : [file];
  });
}

function atomsOf(members, params) {
  const byKey = new Map();
  for (const member of members) {
    const key = member.part ? `${member.path}\0${member.part.index}` : atomKey(member.path);
    byKey.set(key, [...(byKey.get(key) ?? []), member]);
  }
  // A stem group too large for one unit falls apart into its files.
  return [...byKey.values()].flatMap(group => {
    const total = group.reduce((sum, member) => sum + member.cost, 0);
    return total > threshold(params) ? group.map(member => ({members: [member], cost: member.cost})) : [{members: group, cost: total}];
  });
}

const canonical = plan => JSON.stringify({scheme: plan.scheme, params: plan.params, units: plan.units.map(unit => ({
  id: unit.id, owned: unit.owned.map(path => ({path, cost: unit.costs[path], ...(unit.parts?.[path] ? {part: unit.parts[path]} : {})})),
  cost: unit.cost}))});
const digest = plan => crypto.createHash('sha256').update(canonical(plan)).digest('hex');

// I1: every changed path is owned by exactly one unit, and nothing else is owned. A split file is owned by one unit per
// segment: its segments are numbered 0..count-1, each owned once, and the count is the same everywhere.
function checkOwnership(plan, paths) {
  const owners = new Map();
  for (const unit of plan.units) {
    for (const path of unit.owned) {
      const part = unit.parts?.[path];
      const seen = owners.get(path) ?? [];
      if (seen.length && (!part || !seen[0].part)) {
        throw new PartitionRefusal('duplicate_ownership', `${path} is owned by ${seen[0].unit} and ${unit.id}`, [path]);
      }
      owners.set(path, [...seen, {unit: unit.id, part}]);
    }
  }
  const missing = paths.filter(path => !owners.has(path));
  if (missing.length) throw new PartitionRefusal('unowned_path', `unowned changed paths: ${missing.join(', ')}`, missing);
  const known = new Set(paths);
  const extra = [...owners.keys()].filter(path => !known.has(path));
  if (extra.length) throw new PartitionRefusal('unknown_owned_path', `owned paths not changed: ${extra.join(', ')}`, extra);
  for (const [path, list] of owners) {
    if (!list[0].part) continue;
    const count = list[0].part.count;
    const indexes = list.map(item => item.part.index).sort((a, b) => a - b);
    if (list.some(item => item.part.count !== count) || indexes.length !== count || indexes.some((index, at) => index !== at)) {
      throw new PartitionRefusal('incomplete_segments', `${path} is not covered by each of its ${count} segments exactly once`, [path]);
    }
  }
  return true;
}

function partition(input, overrides = {}) {
  const params = parameters(overrides);
  const files = input.map(normalize).sort((a, b) => compare(a.path, b.path));
  for (let index = 1; index < files.length; index++) {
    if (files[index].path === files[index - 1].path) {
      throw new PartitionRefusal('unpartitionable_path', `duplicate changed path ${files[index].path}`, [files[index].path]);
    }
  }
  for (const file of files) file.cost = cost(file, params);
  const groups = [];
  let open = null;
  for (const atom of atomsOf(membersOf(files, params), params)) {
    // Next-fit: close the unit when the atom would overflow C, or when it would hold a second segment of one file.
    // An atom above C (but within the unit threshold) is its own unit.
    const repeated = open && atom.members.some(member => member.part && open.members.some(held => held.path === member.path));
    if (open && !repeated && open.cost + atom.cost <= params.unit_ceiling) {
      open.members.push(...atom.members);
      open.cost += atom.cost;
    } else {
      open = {members: [...atom.members], cost: atom.cost};
      groups.push(open);
    }
  }
  const units = groups.map((group, index) => {
    const members = group.members.sort((a, b) => compare(a.path, b.path));
    const parts = Object.fromEntries(members.filter(member => member.part).map(member => [member.path, member.part]));
    return {id: `u${index}`, owned: members.map(file => file.path), cost: group.cost,
      costs: Object.fromEntries(members.map(file => [file.path, file.cost])),
      renamed: Object.fromEntries(members.filter(file => file.previous).map(file => [file.path, file.previous])),
      ...(Object.keys(parts).length ? {parts} : {})};
  });
  const plan = {scheme: SCHEME, params, units};
  checkOwnership(plan, files.map(file => file.path));
  return {...plan, plan_digest: digest(plan)};
}

function render(plan) {
  const lines = [`${plan.scheme} ${plan.plan_digest}`,
    `${plan.units.length} units, ${new Set(plan.units.flatMap(unit => unit.owned)).size} files, ceiling ${plan.params.unit_ceiling}`];
  for (const unit of plan.units) {
    lines.push(`${unit.id}  cost ${unit.cost}  ${unit.owned.length} files`);
    for (const path of unit.owned) {
      const part = unit.parts?.[path];
      lines.push(`  ${path}  ${unit.costs[path]}${unit.renamed[path] ? `  (from ${unit.renamed[path]})` : ''}${part ? `  (segment ${part.index + 1} of ${part.count})` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}

// No-AI dry run: `main(['table.json', '--ceiling', '300000'], {stdout})` prints the plan, or the refusal.
// The table is {files: [{path, previous?, base_size, head_size, patch_chars, derived_size?, binary?}]}.
function main(argv, io = {}) {
  const read = io.readFile ?? (file => fs.readFileSync(file, 'utf8'));
  const out = io.stdout ?? process.stdout;
  const [table, ...rest] = argv;
  if (!table) throw new TypeError('usage: partition-plan TABLE.json [--ceiling N]');
  const overrides = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = {'--ceiling': 'unit_ceiling'}[rest[index]];
    if (!flag) throw new TypeError(`unknown option ${rest[index]}`);
    overrides[flag] = Number(rest[index + 1]);
  }
  try {
    out.write(render(partition(JSON.parse(read(table)).files, overrides)));
    return 0;
  } catch (error) {
    if (!(error instanceof PartitionRefusal)) throw error;
    out.write(`refused ${error.message}\n`);
    return 2;
  }
}

module.exports = {SCHEME, DEFAULTS, PartitionRefusal, atomKey, parameters, cost, threshold, inflate, checkOwnership, partition, render, main};
