'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {digest} = require('./acceptance.cjs');
const {fixture} = require('../test/fixtures/acceptance.cjs');
const {MARKER, history, envelope, validateProposal, propose, apply} = require('./acceptance-repair.cjs');

function setup() {
  const {snapshot, report} = fixture(); snapshot.base_sha = 'b'.repeat(40);
  const record = {snapshot, controls: false, result: {decision: 'repair_required', reviews: [{report}]}};
  const permitted = envelope(record, []);
  const proposal = {envelope_digest: digest(permitted), summary: 'Preserve validation before durable acceptance.',
    edits: [{path: 'src/upload.rs', before: permitted.paths[0].before, action: 'replace', content: 'validate(input)?;\npersist_then_ack(input)\n'}]};
  const context = {repo: {owner: 'example', repo: 'upload-gateway'}};
  const writes = [];
  const pr = {state: 'open', draft: false, head: {sha: snapshot.head_sha, ref: 'fix/upload', repo: {full_name: snapshot.repository}},
    base: {sha: snapshot.base_sha, ref: 'main'}};
  const tree = {truncated: false, tree: [{path: 'src/upload.rs', mode: '100755', type: 'blob'}]};
  const author = {type: 'User', login: 'repair-author'};
  const write = (kind, result) => async args => {writes.push({kind, args}); return {data: result};};
  const github = {rest: {pulls: {get: async () => ({data: pr})}, issues: {createComment: write('reserve', {})}}};
  const authorGithub = {rest: {users: {getAuthenticated: async () => ({data: author})}, git: {
    getCommit: async () => ({data: {tree: {sha: 'base-tree'}}}), getTree: async () => ({data: tree}),
    createBlob: write('blob', {sha: 'blob'}), createTree: write('tree', {sha: 'new-tree'}),
    createCommit: write('commit', {sha: 'c'.repeat(40)}), updateRef: write('push', {}),
  }}};
  return {record, permitted, proposal, context, writes, pr, tree, author, github, authorGithub, reservations: []};
}

test('repair history accepts only bot-reserved attempts for this PR and never resets the two-attempt budget', () => {
  const f = setup();
  const first = {repository: f.record.snapshot.repository, number: 3, attempt: 1, head_sha: f.record.snapshot.head_sha, envelope_digest: digest(f.permitted)};
  const comment = value => ({user: {login: 'github-actions[bot]'}, body: `${MARKER}${Buffer.from(JSON.stringify(value)).toString('base64')} -->`});
  assert.deepEqual(history([{user: {login: 'contributor'}, body: MARKER}], first.repository, 3), []);
  assert.equal(history([comment(first)], first.repository, 3).length, 1);
  assert.throws(() => history([{user: {login: 'github-actions[bot]'}, body: MARKER}], first.repository, 3), /incomplete/);
  assert.throws(() => history([{user: {login: 'github-actions[bot]'}, body: `${MARKER}${'A'.repeat(3004)} -->`}], first.repository, 3), /incomplete/);
  for (const mutate of [v => {v.repository = 'wrong/repo';}, v => {v.number = 99;}, v => {v.attempt = 0;},
    v => {v.head_sha = 'bad';}, v => {v.envelope_digest = 'bad';}]) {
    const changed = {...first}; mutate(changed); assert.throws(() => history([comment(changed)], first.repository, 3), /identity/);
  }
  assert.throws(() => history([comment(first), comment(first)], first.repository, 3), /inconsistent/);
  const two = history([comment({...first, attempt: 2}), comment(first)], first.repository, 3);
  assert.throws(() => envelope(f.record, two), /exhausted/);
  assert.equal(envelope(f.record, [first]).attempt, 2);
  for (const change of [{controls: true}, {result: {decision: 'auto_approve'}}, {result: {decision: 'review_incomplete'}}]) {
    assert.throws(() => envelope({...f.record, ...change}, []), /does not authorize/);
  }
  assert.throws(() => envelope({...f.record, snapshot: {...f.record.snapshot, files: [{path: 'removed', base_source: 'base'}]}}, []), /No existing/);
  assert.ok(envelope({...f.record, result: {decision: 'blocked_integrity'}}, []));
});

test('repair edits cannot expand paths, erase existing files, replace identical bytes or manufacture new authority', () => {
  const f = setup(); assert.equal(validateProposal(f.proposal, f.permitted), f.proposal);
  for (const mutate of [
    p => {p.envelope_digest = 'bad';}, p => {p.extra = true;}, p => {p.summary = '';}, p => {p.summary = 'x'.repeat(1001);},
    p => {p.edits = null;}, p => {p.edits = [];}, p => {p.edits = Array(9).fill(p.edits[0]);}, p => {p.edits.push({...p.edits[0]});},
    p => {p.edits[0].path = 'src/new-feature.rs';}, p => {p.edits[0].before = 'stale';}, p => {p.edits[0].extra = true;},
    p => {p.edits[0].action = 'execute';}, p => {p.edits[0].content = null;}, p => {p.edits[0].content = 'x'.repeat(300001);},
    p => {p.edits[0].content = 'x\0y';}, p => {p.edits[0].content = '';},
    p => {p.edits[0].content = f.record.snapshot.sources.head.content;}, p => {p.edits[0].action = 'delete'; p.edits[0].content = '';},
  ]) {const changed = structuredClone(f.proposal); mutate(changed); assert.throws(() => validateProposal(changed, f.permitted));}
  assert.throws(() => validateProposal(null, f.permitted));
  const unsafe = {...f.permitted, paths: [{...f.permitted.paths[0], path: '../outside'}]};
  assert.throws(() => validateProposal({...f.proposal, envelope_digest: digest(unsafe), edits: [{...f.proposal.edits[0], path: '../outside'}]}, unsafe), /exceeds/);
  const added = structuredClone(f.permitted); added.paths[0].deletion_allowed = true;
  const deleted = {...f.proposal, envelope_digest: digest(added), edits: [{...f.proposal.edits[0], action: 'delete', content: ''}]};
  assert.equal(validateProposal(deleted, added), deleted);
  assert.throws(() => validateProposal({...deleted, edits: [{...deleted.edits[0], content: 'unexpected'}]}, added), /exceeds/);
});

test('the repair model proposes bounded source data and receives neither the author credential nor an execution tool', async () => {
  const f = setup(); const old = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fictional';
  try {
    const result = await propose({...f, fetchImpl: async (_, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.tools.length, 1); assert.equal(request.tools[0].function.name, 'repair_proposal');
      assert.ok(!options.headers['X-Author-Token']);
      const state = JSON.parse(request.messages[1].content); assert.equal(state.envelope.head_sha, f.record.snapshot.head_sha);
      assert.match(request.messages[0].content, /never shell commands/);
      return {ok: true, json: async () => ({choices: [{finish_reason: 'tool_calls', message: {tool_calls:
        [{function: {name: 'repair_proposal', arguments: JSON.stringify(f.proposal)}}]}}]})};
    }});
    assert.equal(result.proposal.summary, f.proposal.summary); assert.equal(result.envelope.attempt, 1);
  } finally {if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;}
});

test('the separate author preserves executable modes, reserves budget before a non-force push and causes a new protected review', async () => {
  const f = setup(); const result = await apply(f);
  assert.equal(result.head_sha, 'c'.repeat(40));
  assert.deepEqual(f.writes.map(item => item.kind), ['blob', 'tree', 'commit', 'reserve', 'push']);
  assert.equal(f.writes[1].args.tree[0].mode, '100755');
  assert.deepEqual(f.writes[2].args.parents, [f.record.snapshot.head_sha]);
  assert.equal(f.writes.at(-1).args.force, false); assert.equal(f.writes.at(-1).args.ref, 'heads/fix/upload');
  const reserved = history([{user: {login: 'github-actions[bot]'}, body: f.writes[3].args.body}], f.record.snapshot.repository, 3);
  assert.equal(reserved.length, 1);
  await assert.rejects(apply({...f, reservations: reserved}), /Invalid bounded/);
  const remove = setup(); remove.record.snapshot.files[0].status = 'added';
  remove.permitted = envelope(remove.record, []); remove.proposal.envelope_digest = digest(remove.permitted);
  remove.proposal.edits[0].action = 'delete'; remove.proposal.edits[0].content = '';
  await apply(remove);
  assert.equal(remove.writes.find(item => item.kind === 'tree').args.tree[0].sha, null);
  assert.equal(remove.writes.some(item => item.kind === 'blob'), false);
});

test('forks, changed revisions, shared bot identity, partial trees and special files cannot cross the repair write boundary', async () => {
  for (const mutate of [
    f => {f.context.repo.repo = 'other';}, f => {f.author.type = 'Bot';}, f => {f.author.login = 'github-actions[bot]';},
    f => {f.pr.state = 'closed';}, f => {f.pr.draft = true;}, f => {f.pr.head.sha = 'd'.repeat(40);},
    f => {f.pr.base.sha = 'e'.repeat(40);}, f => {f.pr.head.repo.full_name = 'external/fork';}, f => {f.pr.head.ref = 'main';},
    f => {f.tree.truncated = true;}, f => {f.tree.tree = [];}, f => {f.tree.tree[0].type = 'commit';}, f => {f.tree.tree[0].mode = '120000';},
  ]) {const f = setup(); mutate(f); await assert.rejects(apply(f)); assert.equal(f.writes.length, 0);}
});
