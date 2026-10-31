'use strict';

// Deterministic partition of a large change into review units (scheme
// clouseau-partition/1, see the chunked review design, section 2). Pure and
// model-free: the same changed-file table and parameters give the same plan in
// any input order, so CI can recompute it. Nothing here is called by the review
// flow yet.
const crypto = require('node:crypto');
const fs = require('node:fs');

const SCHEME = 'clouseau-partition/1';
// unit_ceiling C and shared S are owned-source and shared-context characters; budget is the
// snapshot cap a unit must fit; file_ceiling is the per-file source bound of the collectors.
const DEFAULTS = Object.freeze({unit_ceiling: 450000, shared: 100000, budget: 900000, file_ceiling: 300000, max_units: 8});

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
    if (!(name in DEFAULTS) || !Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid partition parameter ${name}`);
  }
  if (params.unit_ceiling > params.budget - params.shared) throw new TypeError('unit_ceiling must fit budget minus shared');
  return params;
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
  return {path, previous: file.previous ?? null, base_size: file.base_size, head_size: file.head_size,
    patch_chars: file.patch_chars, derived_size: file.derived_size};
}

// A derived file (a lockfile replaced by a summary CI can recompute) costs its summary, not its sources.
function cost(file, params) {
  if (file.derived_size !== undefined) return inflate(file.derived_size);
  const bound = Math.max(file.base_size, file.head_size);
  if (bound > params.file_ceiling) {
    throw new PartitionRefusal('file_over_bound', `${file.path} has ${bound} bytes, over the ${params.file_ceiling} per-file bound`, [file.path]);
  }
  return inflate(file.base_size + file.head_size + file.patch_chars);
}

// Atom key: directory plus stem, with the extension and a .test/.spec/.stories marker removed, so a file
// stays with its tests. A rename is keyed by its new path, so both ends travel in one file entry.
function atomKey(path) {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1).replace(/\.[^.]*$/, '').replace(/\.(test|spec|stories)$/, '');
  return `${path.slice(0, slash + 1)}${name}`;
}

function atomsOf(files) {
  const byKey = new Map();
  for (const file of files) byKey.set(atomKey(file.path), [...(byKey.get(atomKey(file.path)) ?? []), file]);
  return [...byKey.values()].map(members => ({members, cost: members.reduce((sum, file) => sum + file.cost, 0)}));
}

const canonical = plan => JSON.stringify({scheme: plan.scheme, params: plan.params, units: plan.units.map(unit => ({
  id: unit.id, owned: unit.owned.map(path => ({path, cost: unit.costs[path]})), cost: unit.cost}))});
const digest = plan => crypto.createHash('sha256').update(canonical(plan)).digest('hex');

// I1: every changed path is owned by exactly one unit, and nothing else is owned.
function checkOwnership(plan, paths) {
  const owners = new Map();
  for (const unit of plan.units) {
    for (const path of unit.owned) {
      if (owners.has(path)) throw new PartitionRefusal('duplicate_ownership', `${path} is owned by ${owners.get(path)} and ${unit.id}`, [path]);
      owners.set(path, unit.id);
    }
  }
  const missing = paths.filter(path => !owners.has(path));
  if (missing.length) throw new PartitionRefusal('unowned_path', `unowned changed paths: ${missing.join(', ')}`, missing);
  const known = new Set(paths);
  const extra = [...owners.keys()].filter(path => !known.has(path));
  if (extra.length) throw new PartitionRefusal('unknown_owned_path', `owned paths not changed: ${extra.join(', ')}`, extra);
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
  const ceiling = params.budget - params.shared;
  const groups = [];
  let open = null;
  for (const atom of atomsOf(files)) {
    if (atom.cost > ceiling) {
      const paths = atom.members.map(file => file.path);
      throw new PartitionRefusal('unit_exceeds_budget', `${paths.join(', ')} costs ${atom.cost}, over the unit budget ${ceiling}`, paths);
    }
    // Next-fit: close the unit when the atom would overflow C. An atom above C is its own unit.
    if (open && open.cost + atom.cost <= params.unit_ceiling) {
      open.members.push(...atom.members);
      open.cost += atom.cost;
    } else {
      open = {members: [...atom.members], cost: atom.cost};
      groups.push(open);
    }
  }
  if (groups.length > params.max_units) {
    throw new PartitionRefusal('too_many_units', `${groups.length} units exceed the limit of ${params.max_units}`, []);
  }
  const units = groups.map((group, index) => {
    const members = group.members.sort((a, b) => compare(a.path, b.path));
    return {id: `u${index}`, owned: members.map(file => file.path), cost: group.cost,
      costs: Object.fromEntries(members.map(file => [file.path, file.cost])),
      renamed: Object.fromEntries(members.filter(file => file.previous).map(file => [file.path, file.previous]))};
  });
  const plan = {scheme: SCHEME, params, units};
  checkOwnership(plan, files.map(file => file.path));
  return {...plan, plan_digest: digest(plan)};
}

function render(plan) {
  const lines = [`${plan.scheme} ${plan.plan_digest}`,
    `${plan.units.length} units, ${plan.units.reduce((sum, unit) => sum + unit.owned.length, 0)} files, ceiling ${plan.params.unit_ceiling}`];
  for (const unit of plan.units) {
    lines.push(`${unit.id}  cost ${unit.cost}  ${unit.owned.length} files`);
    for (const path of unit.owned) lines.push(`  ${path}  ${unit.costs[path]}${unit.renamed[path] ? `  (from ${unit.renamed[path]})` : ''}`);
  }
  return lines.join('\n') + '\n';
}

// No-AI dry run: `main(['table.json', '--ceiling', '300000'], {stdout})` prints the plan, or the refusal.
// The table is {files: [{path, previous?, base_size, head_size, patch_chars, derived_size?, binary?}]}.
function main(argv, io = {}) {
  const read = io.readFile ?? (file => fs.readFileSync(file, 'utf8'));
  const out = io.stdout ?? process.stdout;
  const [table, ...rest] = argv;
  if (!table) throw new TypeError('usage: partition-plan TABLE.json [--ceiling N] [--max-units N]');
  const overrides = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = {'--ceiling': 'unit_ceiling', '--max-units': 'max_units'}[rest[index]];
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

module.exports = {SCHEME, DEFAULTS, PartitionRefusal, atomKey, cost, checkOwnership, partition, render, main};
