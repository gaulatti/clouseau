'use strict';

const {FACTORS, GATES, digest} = require('../../src/acceptance.cjs');

function factor(min = 1, max = min, evidence = ['source']) {
  return {min, max, evidence, reason: 'Established by the cited source and accepted contract.'};
}

function fixture() {
  const snapshot = {repository: 'example/upload-gateway', number: 3, policy_digest: 'c'.repeat(64), config_digest: 'd'.repeat(64), head_sha: 'a'.repeat(40), head_repository: {owner: 'example', repo: 'upload-gateway'}, paths: ['src/upload.rs'], files: [{path: 'src/upload.rs', base_source: 'base', head_source: 'head'}], sources: {
    contract: {authority: 'trusted', kind: 'contract', ref: 'b'.repeat(40), path: '.github/clouseau.md', content: 'Validate every upload before durable acceptance.\nMeaningful tests and exact coverage are required.'},
    head: {authority: 'untrusted', kind: 'source', ref: 'a'.repeat(40), path: 'src/upload.rs', content: 'validate(input)?;\naccept_durably(input)\n'},
  }};
  snapshot.digest = digest(snapshot);
  const group = (name, value) => Object.fromEntries(FACTORS[name].map(key => [key, factor(value)]));
  const report = {version: 2, snapshot: snapshot.digest, summary: 'Restores the established upload contract with direct validation and real regression tests.',
    evidence: [
      {id: 'contract', source: 'contract', start: 1, end: 2, quote: 'Validate every upload before durable acceptance.'},
      {id: 'source', source: 'head', start: 1, end: 2, quote: 'validate(input)?;'},
    ],
    units: [{id: 'upload-validation', title: 'Validate before acceptance', kind: 'capability', paths: snapshot.paths,
      obligation: 'Reject invalid uploads before accepting bytes.', fit: group('fit', 1),
      need: {...group('need', 1), binding: factor(1, 1, ['contract'])}, excess: group('excess', 0), alternative: ''}],
    findings: [], gates: GATES.map(name => ({name, state: 'satisfied', reason: 'The cited production path preserves the required boundary.', evidence: ['source']})),
    accounting: [{path: 'src/upload.rs', units: ['upload-validation'], reason: 'Implements the accepted validation obligation.', evidence: ['source']}],
    decisions: [], resolutions: []};
  return {snapshot, report};
}

function finding() {
  return {id: 'missing-rejection', title: 'Invalid input reaches durable acceptance', path: 'src/upload.rs',
    cause: 'The changed validation path no longer rejects invalid input.', trigger: 'A client supplies a malformed upload.',
    consequence: 'The gateway acknowledges work that violates its accepted contract.', obligation: 'Reject invalid uploads before acceptance.',
    evidence: ['source'], factors: Object.fromEntries(FACTORS.defect.map(name => [name, factor(1)])), blast_radius: 1,
    opportunity: {mechanical: false, beneficial: false, within_scope: false, verified: false}, repair_paths: ['src/upload.rs']};
}

module.exports = {factor, fixture, finding};
