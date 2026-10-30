'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {finalizePrivateOwner} = require('./private-owner-merge.cjs');

function fixture() {
  const repo = {owner: 'example', repo: 'private-product'};
  const base = 'b'.repeat(40); const head = 'a'.repeat(40);
  const repository = {node_id: 'R_PRIVATE_FIXTURE', full_name: 'example/private-product', private: true};
  const pr = {number: 7, state: 'open', draft: false, merged: false, changed_files: 1,
    user: {login: 'alice', type: 'User'},
    base: {ref: 'main', sha: base, repo: {...repository}}, head: {ref: 'fix/input-validation', sha: head, repo: {...repository}}};
  const assessment = {number: 7, head_sha: head, base_sha: base, decision: 'auto_approve'};
  const state = {pr: structuredClone(pr), repository, base, head, text: '* @alice\n/private/ @bob\n', permission: 'write',
    files: [{filename: 'src/handler.js', status: 'modified'}], reviews: [
      {id: 21, user: {login: 'github-actions[bot]', type: 'Bot'}, state: 'APPROVED', commit_id: head}],
    comparison: {status: 'ahead', merge_base_commit: {sha: base}}, protected: false, calls: [], comments: [], mutations: [], atomicCalls: 0, verifyCalls: 0};
  const read = (name, fn) => async args => {state.calls.push({name, args}); return {data: await fn(args)};};
  const github = {rest: {repos: {
    get: read('repository', () => structuredClone(state.repository)),
    getBranch: read('branch', args => ({name: args.branch, protected: state.protected, commit: {sha: args.branch === 'main' ? state.base : state.head}})),
    getContent: read('ownership', args => {
      if (state.missingOwnership || args.path !== '.github/CODEOWNERS') throw Object.assign(new Error('404 ownership missing'), {status: 404});
      if (state.ownershipError) throw new Error('ownership unavailable');
      return {encoding: 'base64', content: Buffer.from(state.text).toString('base64'), size: Buffer.byteLength(state.text)};
    }),
    getCollaboratorPermissionLevel: read('permission', () => ({permission: state.permission})),
    compareCommits: read('comparison', () => {if (state.compareError) throw new Error('comparison unavailable'); return structuredClone(state.comparison);}),
  }, pulls: {
    get: read('pull', () => structuredClone(state.pr)),
    listFiles: read('files', () => structuredClone(state.files)),
    listReviews: read('reviews', () => structuredClone(state.reviews)),
  }, issues: {
    listComments: read('comments', () => structuredClone(state.comments)),
    createComment: read('notice', args => {state.comments.push({user: {login: 'github-actions[bot]'}, body: args.body}); return {id: 1};}),
  }}};
  github.paginate = async (method, args) => (await method(args)).data;
  github.graphql = async (query, variables) => {
    state.calls.push({name: 'atomic', query, variables}); state.atomicCalls++;
    if (state.atomicError) throw new Error('atomic update rejected');
    const updates = variables.input.refUpdates;
    assert.equal(variables.input.repositoryId, repository.node_id);
    assert.equal(updates.length, 2);
    assert.ok(updates.every(update => update.force === false));
    const target = updates.find(update => update.name === 'refs/heads/main');
    const source = updates.find(update => update.name === `refs/heads/${pr.head.ref}`);
    assert.deepEqual(target, {name: 'refs/heads/main', beforeOid: base, afterOid: head, force: false});
    assert.deepEqual(source, {name: `refs/heads/${pr.head.ref}`, beforeOid: head, afterOid: head, force: false});
    if (target.beforeOid !== state.base || source.beforeOid !== state.head) throw new Error('atomic compare-and-swap conflict');
    state.mutations.push(structuredClone(updates)); state.base = head;
    if (!state.noMergeObservation) {state.pr.merged = true; state.pr.state = 'closed'; state.pr.merge_commit_sha = head;}
    if (state.postMutation) state.postMutation();
    return {updateRefs: {clientMutationId: null}};
  };
  const verify = async () => {state.calls.push({name: 'verify'}); state.verifyCalls++; if (state.verifyError) throw new Error('exact verification failed'); if (state.duringVerify) state.duringVerify();};
  const check = extra => finalizePrivateOwner({github, repo, pr: structuredClone(state.pr), assessment, baseBranch: 'main', verify, ...extra});
  return {repo, pr, assessment, state, github, base, head, verify, check};
}

async function denied(f, extra) {
  await assert.rejects(f.check(extra));
  assert.equal(f.state.mutations.length, 0, 'a denied merge cannot change either branch');
}

test('owner-qualified private work merges once through a paired non-forced atomic update after full verification', async () => {
  const f = fixture(); const merged = await f.check();
  assert.equal(merged.merged, true); assert.equal(merged.head.sha, f.head);
  assert.equal(f.state.base, f.head); assert.equal(f.state.head, f.head);
  assert.equal(f.state.mutations.length, 1); assert.equal(f.state.verifyCalls, 1);
  const mutation = f.state.calls.findIndex(call => call.name === 'atomic');
  const verification = f.state.calls.findIndex(call => call.name === 'verify');
  assert.deepEqual(f.state.calls.slice(verification + 1, mutation).map(call => call.name), ['pull', 'branch'],
    'only final native PR and branch freshness reads separate full verification from the atomic write');
  assert.match(f.state.calls[mutation].query, /updateRefs/);
  assert.ok(f.state.calls.filter(call => call.name === 'ownership').every(call => call.args.ref === f.base));
  const comparison = f.state.calls.find(call => call.name === 'comparison');
  assert.deepEqual(comparison.args, {...f.repo, base: f.base, head: f.head});
});

test('missing, unknown or incomplete ownership, outsiders and rename old-path ownership prevent mutation', async () => {
  for (const change of [f => {f.state.missingOwnership = true;}, f => {f.state.ownershipError = true;},
    f => {f.state.text = '';}, f => {f.state.text = '/docs/ @alice';}, f => {f.state.text = '* person@example.invalid';},
    f => {f.state.pr.user.login = 'outsider';}, f => {f.state.pr.user.type = 'Bot';}, f => {f.state.permission = 'read';},
    f => {f.state.files = [];}, f => {f.state.pr.changed_files = 2;},
    f => {f.state.files[0] = {filename: 'src/handler.js', previous_filename: 'private/old-handler.js', status: 'renamed'};},
  ]) {const f = fixture(); change(f); await denied(f); assert.equal(f.state.atomicCalls, 0);}
});

test('forks, missing native repository identities, invalid refs and changed candidate revisions fail before mutation', async () => {
  for (const change of [f => {f.state.pr.state = 'closed';}, f => {f.state.pr.draft = true;},
    f => {f.state.pr.head.sha = 'c'.repeat(40);}, f => {f.state.pr.base.sha = 'c'.repeat(40);},
    f => {f.state.pr.head.repo.node_id = 'R_FORK';}, f => {delete f.state.pr.head.repo;},
    f => {delete f.state.pr.head.repo.node_id;}, f => {delete f.state.pr.base.repo.node_id;},
    f => {delete f.state.repository.node_id;}, f => {f.state.pr.head.ref = 'main';},
    f => {f.state.pr.head.ref = '../unsafe';}, f => {f.state.base = 'c'.repeat(40);}, f => {f.state.protected = true;},
    f => {delete f.state.protected;}, f => {f.state.pr.auto_merge = {};},
  ]) {const f = fixture(); change(f); await denied(f); assert.equal(f.state.atomicCalls, 0);}
  for (const extra of [{baseBranch: '../unsafe'}, {assessment: {decision: 'review_incomplete'}},
    {assessment: {number: 7, head_sha: 'mutable-head', base_sha: 'b'.repeat(40), decision: 'auto_approve'}}]) await denied(fixture(), extra);
});

test('only a fresh current bot approval and no unresolved latest human change request permit mutation', async () => {
  for (const reviews of [[], [{user: {login: 'bob', type: 'User'}, state: 'APPROVED', commit_id: 'a'.repeat(40)}],
    [{user: {login: 'github-actions[bot]', type: 'User'}, state: 'APPROVED', commit_id: 'a'.repeat(40)}],
    [{user: {login: 'github-actions[bot]', type: 'Bot'}, state: 'APPROVED', commit_id: 'b'.repeat(40)}],
    [{user: {login: 'github-actions[bot]', type: 'Bot'}, state: 'DISMISSED', commit_id: 'a'.repeat(40)}],
  ]) {const f = fixture(); f.state.reviews = reviews; await denied(f); assert.equal(f.state.atomicCalls, 0);}
  for (const latest of ['DISMISSED', 'CHANGES_REQUESTED']) {
    const f = fixture(); f.state.reviews.push({...f.state.reviews[0], id: 22, state: latest}); await denied(f);
  }
  const blocked = fixture(); blocked.state.reviews.push({id: 22, user: {login: 'bob', type: 'User'}, state: 'CHANGES_REQUESTED', commit_id: blocked.head});
  await denied(blocked);
  const cleared = fixture(); cleared.state.reviews.push({...cleared.state.reviews[0], state: 'COMMENTED'});
  cleared.state.reviews.push({id: 23, user: {login: 'bob', type: 'User'}, state: 'CHANGES_REQUESTED', commit_id: cleared.head},
    {id: 24, user: {login: 'bob', type: 'User'}, state: 'APPROVED', commit_id: cleared.head});
  assert.equal((await cleared.check()).merged, true);
});

test('an unavailable, diverged, identical or unrelated comparison never mutates either ref', async () => {
  for (const comparison of [{status: 'behind', merge_base_commit: {sha: 'b'.repeat(40)}},
    {status: 'diverged', merge_base_commit: {sha: 'b'.repeat(40)}}, {status: 'identical', merge_base_commit: {sha: 'b'.repeat(40)}},
    {status: 'ahead', merge_base_commit: {sha: 'c'.repeat(40)}}, {status: 'ahead'}]) {
    const f = fixture(); f.state.comparison = comparison; await denied(f); assert.equal(f.state.atomicCalls, 0);
  }
  const failed = fixture(); failed.state.compareError = true; await denied(failed); assert.equal(failed.state.atomicCalls, 0);
});

test('verification failure and either source or target racing the last checks cannot mutate either ref', async () => {
  const failed = fixture(); failed.state.verifyError = true; await denied(failed); assert.equal(failed.state.atomicCalls, 0);
  for (const field of ['base', 'head']) {
    const f = fixture(); f.state.duringVerify = () => {f.state[field] = 'c'.repeat(40);};
    await denied(f); assert.equal(f.state.verifyCalls, 1); assert.equal(f.state.atomicCalls, field === 'base' ? 0 : 1);
  }
  for (const change of [f => {f.state.pr.head.sha = 'c'.repeat(40);}, f => {f.state.pr.base.sha = 'c'.repeat(40);},
    f => {f.state.pr.auto_merge = {};}, f => {f.state.protected = true;}]) {
    const f = fixture(); f.state.duringVerify = () => change(f); await denied(f); assert.equal(f.state.atomicCalls, 0);
  }
  const rejected = fixture(); rejected.state.atomicError = true; await denied(rejected); assert.equal(rejected.state.atomicCalls, 1);
});

test('an atomic result without the exact merged PR and target observation is never reported as success', async () => {
  const unobserved = fixture(); unobserved.state.noMergeObservation = true;
  await assert.rejects(unobserved.check()); assert.equal(unobserved.state.mutations.length, 1);
  for (const change of [f => {f.state.base = 'c'.repeat(40);}, f => {f.state.pr.head.sha = 'c'.repeat(40);},
    f => {f.state.pr.merge_commit_sha = 'c'.repeat(40);}]) {
    const f = fixture(); f.state.postMutation = () => change(f); await assert.rejects(f.check());
    assert.equal(f.state.mutations.length, 1);
  }
});

test('a base that moved after approval fails closed with one explicit needs-branch-update notice instead of a generic error', async () => {
  const entries = [
    ['assessed PR already reports a different base', f => {f.state.pr.base.sha = 'c'.repeat(40);}],
    ['base branch advanced during final verification', f => {f.state.duringVerify = () => {f.state.base = 'c'.repeat(40);};}],
    ['PR base advanced during final verification', f => {f.state.duringVerify = () => {f.state.pr.base.sha = 'c'.repeat(40);};}],
  ];
  for (const [label, change] of entries) {
    const f = fixture(); change(f);
    await assert.rejects(f.check(), /^Error: Needs branch update: main moved after approval/, label);
    assert.equal(f.state.atomicCalls, 0, label); assert.equal(f.state.mutations.length, 0, label);
    assert.equal(f.state.comments.length, 1, label);
    assert.match(f.state.comments[0].body, /^<!-- clouseau-needs-branch-update:a{40}:/, label);
  }
  const both = fixture(); both.state.duringVerify = () => {both.state.base = 'c'.repeat(40); both.state.pr.head.sha = 'd'.repeat(40);};
  await assert.rejects(both.check(), /head, base or protection changed before the atomic write/);
  assert.equal(both.state.comments.length, 0, 'a changed head is a new revision, not a branch update request');
  const protectedBranch = fixture(); protectedBranch.state.duringVerify = () => {protectedBranch.state.base = 'c'.repeat(40); protectedBranch.state.protected = true;};
  await assert.rejects(protectedBranch.check(), /head, base or protection changed before the atomic write/);
  assert.equal(protectedBranch.state.comments.length, 0);
});
