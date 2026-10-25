'use strict';

const assert = require('node:assert/strict');
const {pagedFixture} = require('./paged-review-fixture.cjs');
const {refresh} = require('../src/acceptance-sources.cjs');

// Synthetic controller-capacity data, not consumer source or AI qualification.
// Counts and contract lengths exercise the independently measured large case.
async function capacityFixture() {
  const f = await pagedFixture();
  const contracts = Object.values(f.snapshot.sources).filter(source => source.authority === 'trusted' && source.kind === 'contract');
  for (const [index, source] of contracts.entries()) {
    const bytes = [23786, 21762][index];
    source.content += '\nController-only contract capacity fixture.\n'.repeat(Math.ceil(bytes / 40));
    source.content = source.content.slice(0, bytes);
  }
  const added = [];
  for (let index = 0; index < 84; index++) {
    const filename = `backend/src/qualification/subject-${index}.service.spec.ts`;
    const head = `${f.snapshot.head_sha}:${filename}`;
    f.snapshot.sources[head] = {path: filename, ref: f.snapshot.head_sha, authority: 'untrusted', kind: 'source', content: ''};
    added.push(head);
    const file = {path: filename, status: index < 21 ? 'modified' : 'added', head_source: head, patch: '@@ controller-only fixture @@\n'};
    if (index < 21) {
      file.base_source = `${f.snapshot.base_sha}:${filename}`;
      f.snapshot.sources[file.base_source] = {...f.snapshot.sources[head], ref: f.snapshot.base_sha};
      added.push(file.base_source);
    }
    f.snapshot.files.push(file);
  }
  const changed = [...new Set(f.snapshot.files.flatMap(file => [file.base_source, file.head_source]).filter(Boolean))];
  let remaining = 2308455 - changed.reduce((sum, id) => sum + Buffer.byteLength(f.snapshot.sources[id].content), 0);
  for (const [index, id] of added.entries()) {
    const bytes = Math.floor(remaining / (added.length - index));
    f.snapshot.sources[id].content = '// Controller-only complete textual capacity fixture.\n'.repeat(Math.ceil(bytes / 50)).slice(0, bytes);
    remaining -= bytes;
  }
  f.snapshot.paths = f.snapshot.files.map(file => file.path).sort(); refresh(f.snapshot);
  assert.equal(f.snapshot.files.length, 85); assert.equal(changed.length, 107);
  // Keep the original fixture's additional production dependency as well.
  assert.equal(Object.keys(f.snapshot.sources).length, 111);
  assert.equal(changed.reduce((sum, id) => sum + Buffer.byteLength(f.snapshot.sources[id].content), 0), 2308455);
  return f;
}

module.exports = {capacityFixture};
