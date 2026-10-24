'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {isDeepStrictEqual} = require('node:util');
const {CASES, prepareCase} = require('./acceptance-cases.cjs');
const {investigateChange, gradeInvestigations, validateInspection, combine} = require('../src/acceptance-review.cjs');
const {digest, validateReport} = require('../src/acceptance.cjs');
const {decodeJSON} = require('../src/review-provider.cjs');
const {PRICING, estimate} = require('../src/review-cost.cjs');
const sourceRoot = path.resolve(__dirname, '..');

function protocolFingerprint(read) {
  const files = ['policy/change-acceptance.md', 'src/acceptance.cjs', 'src/acceptance-rubrics.cjs',
    'src/acceptance-grading.cjs', 'src/acceptance-review.cjs', 'src/acceptance-schema.cjs',
    'src/acceptance-sources.cjs', 'src/acceptance-ledger.cjs', 'src/config.cjs', 'test/acceptance-cases.cjs'];
  const provider = read('src/review-provider.cjs');
  const start = provider.indexOf('// A completed answer');
  const end = provider.indexOf('\nmodule.exports');
  assert.ok(start >= 0 && end > start, 'Cannot bind the provider request implementation');
  return digest([...files.map(file => [file, read(file)]),
    ['requests', provider.slice(start, end)], ['models', provider.match(/^const (?:MODELS|JEV_MODEL) = .+;$/gm)],
    ['roles', read('test/evaluate-acceptance.cjs').match(/const models = \{.+\};/)[0]]]);
}

function equivalentInputs(left, right) {
  const inputs = value => {
    const copy = structuredClone(value); delete copy.digest;
    // Reuse the original, real execution receipt for byte-identical fixtures.
    // Host runtime versions can differ; no execution receipt is rewritten.
    delete copy.sources.verification;
    return copy;
  };
  return isDeepStrictEqual(inputs(left), inputs(right));
}

function factualReplay(prior, models) {
  const records = prior.observations.filter(item => item.round !== undefined && item.transport?.raw)
    .map(item => ({role: item.role, snapshot: item.snapshot, raw: item.transport.raw, usage: item.usage}));
  if (prior.details?.raw_response) {
    const role = ['examiner', 'challenger'].find(role => models[role] === prior.details.model);
    assert.ok(role, 'Recorded role model changed');
    records.push({role, snapshot: Object.keys(prior.snapshots).at(-1), raw: prior.details.raw_response, usage: prior.details.usage});
  }
  for (const entry of records) {
    assert.equal(entry.usage.length, 1, 'Replay requires an untruncated recorded source response');
    assert.equal(entry.usage[0].requested_model, models[entry.role], 'Recorded source role changed');
  }
  return records;
}

async function main() {
  const graders = (process.env.CLOUSEAU_EVALUATION_GRADERS || 'routed').split(',');
  assert.ok(graders.length && new Set(graders).size === graders.length &&
    graders.every(grader => ['deepseek', 'typesafe', 'routed'].includes(grader)), 'Choose explicit distinct supported grading routes');
  const requestLimit = Number(process.env.CLOUSEAU_EVALUATION_REQUEST_LIMIT || 48);
  assert.ok(Number.isSafeInteger(requestLimit) && requestLimit >= 0 && requestLimit <= 48, 'Qualification permits at most forty-eight provider requests');
  const names = process.env.CLOUSEAU_EVALUATION_CASES?.split(',');
  assert.ok(!names || names.length && new Set(names).size === names.length && names.every(name => CASES.some(item => item.name === name)), 'Select distinct known qualification cases');
  const cases = names ? CASES.filter(item => names.includes(item.name)) : CASES;
  const output = process.env.CLOUSEAU_EVALUATION_PATH || 'work/acceptance-evaluation.json';
  fs.mkdirSync(require('node:path').dirname(output), {recursive: true});
  const fingerprint = protocolFingerprint(file => fs.readFileSync(path.join(sourceRoot, file), 'utf8'));
  const replayPath = process.env.CLOUSEAU_EVALUATION_REPLAY_PATH;
  const replay = replayPath ? JSON.parse(fs.readFileSync(replayPath, 'utf8')) : null;
  if (replay) {
    assert.deepEqual(replay.graders, graders, 'Recorded grading route changed');
    let recorded = replay.protocol_fingerprint;
    if (!recorded) {
      let ref = process.env.CLOUSEAU_EVALUATION_REPLAY_REF;
      if (!ref) {
        const runId = process.env.CLOUSEAU_EVALUATION_REPLAY_RUN_ID;
        assert.match(runId, /^[1-9][0-9]*$/);
        const run = JSON.parse(execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`], {encoding: 'utf8'}));
        assert.equal(run.event, 'workflow_dispatch');
        assert.equal(run.head_repository.full_name, process.env.GITHUB_REPOSITORY);
        ref = run.head_sha;
      }
      assert.match(ref, /^[a-f0-9]{40}$/);
      recorded = protocolFingerprint(file => execFileSync('git', ['show', `${ref}:${file}`], {encoding: 'utf8', cwd: sourceRoot}));
    }
    assert.equal(recorded, fingerprint, 'Source, policy, routing, rubric or request meaning changed; recorded judgments cannot be reused');
  }
  const historical = replay ? replay.request_budget.used + (replay.request_budget.historical_requests || 0) : 0;
  assert.ok(Number.isSafeInteger(historical) && historical >= 0 && historical <= 48, 'Invalid recorded provider request count');
  const evaluation = {version: 2, synthetic: true, qualification_only: true, mode: 'live_judgment_qualification', graders,
    corpus_digest: digest(CASES), selected_cases: cases.map(item => item.name), full_corpus: cases.length === CASES.length,
    protocol_fingerprint: fingerprint, replay_source: replay ? {digest: digest(replay), run_id: process.env.CLOUSEAU_EVALUATION_REPLAY_RUN_ID || null} : null,
    request_budget: {limit: requestLimit, used: 0, historical_requests: historical, hard_total_limit: 48}, live_usage: [], pricing: PRICING, cases: []};
  const save = () => {
    evaluation.incremental_cost = estimate(evaluation.live_usage);
    fs.writeFileSync(output, JSON.stringify(evaluation, null, 2) + '\n');
  };
  const budgetedFetch = async (...args) => {
    assert.ok(evaluation.request_budget.used < requestLimit && historical + evaluation.request_budget.used < 48, 'Live provider request budget exhausted');
    evaluation.request_budget.used++;
    const request = JSON.parse(args[1].body);
    const usage = {provider: args[0].includes('typesafe') ? 'typesafe' : 'deepseek', requested_model: request.model, model: request.model, tokens: null};
    evaluation.live_usage.push(usage); save();
    const response = await fetch(...args);
    try {const body = await response.clone().json(); usage.model = body.model || request.model; usage.tokens = body.usage || null;} catch {}
    save(); return response;
  };
  save();
  for (const scenario of cases) {
    const context = await prepareCase(scenario);
    const models = {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grading_model: 'deepseek-flash'};
    console.log(`Acceptance qualification: ${scenario.name}`);
    const record = {name: scenario.name, category: scenario.category, rationale: scenario.rationale, expected: scenario.expected, results: [], observations: [], snapshots: {}};
    evaluation.cases.push(record); save();
    const observe = (observation, grader) => {
      record.snapshots[context.snapshot.digest] ??= structuredClone(context.snapshot);
      record.observations.push({...observation, grader}); save();
    };
    try {
      const prior = replay?.cases.find(item => item.name === scenario.name);
      let cached = [];
      if (replay) {
        assert.ok(prior, 'Recorded qualification case missing');
        assert.deepEqual(prior.expected, scenario.expected, 'Case acceptance criteria changed');
        const saved = Object.values(prior.snapshots).find(snapshot => equivalentInputs(snapshot, context.snapshot));
        assert.ok(saved, 'Recorded immutable case inputs changed');
        context.snapshot = structuredClone(saved);
        record.reused_fixture_execution = true;
        if (prior.results.length) {
          for (const result of prior.results) {
            assert.ok(graders.includes(result.grader), 'Recorded grader changed');
            assert.equal(result.snapshot, saved.digest);
            assert.deepEqual(result.reviews.map(view => view.role).sort(), ['challenger', 'examiner']);
            for (const view of result.reviews) {
              const bound = validateInspection(view.report, saved, view.drafts);
              assert.deepEqual(validateReport(view.report, bound), view.scores, 'Recorded scores or blockers changed');
            }
            assert.equal(combine(result.reviews), result.decision);
          }
          record.results = structuredClone(prior.results); record.observations = structuredClone(prior.observations);
          record.snapshots = structuredClone(prior.snapshots); record.reused_complete_results = true;
          record.passed = record.results.length === graders.length && record.results.every(result => casePassed(scenario, result));
          save(); continue;
        }
        cached = factualReplay(prior, models);
      }
      const fetchForCase = async (...args) => {
        const body = JSON.parse(args[1].body);
        if (body.tools) {
          const role = body.messages[0].content.match(/Role: (examiner|challenger)\./)?.[1];
          const view = JSON.parse(body.messages[1].content);
          const entry = cached.find(item => !item.used && item.role === role && item.snapshot === view.digest && !view.earlier_concerns_by_this_role.length);
          if (entry) {
            entry.used = true; record.replayed_source_responses = (record.replayed_source_responses || 0) + 1; save();
            const decoded = decodeJSON(entry.raw);
            return {ok: true, json: async () => ({model: body.model, usage: entry.usage[0].tokens, choices: [{finish_reason: 'tool_calls', message: {tool_calls: [
              {function: {name: decoded.value.request_sources ? 'source_request' : 'acceptance_report', arguments: entry.raw}}]}}]})};
          }
        }
        return budgetedFetch(...args);
      };
      const investigation = await investigateChange({...context, config: models, log: console.log, fetchImpl: fetchForCase,
        observe});
      for (const grader of graders) {
        try {
          const result = await gradeInvestigations({...context, investigation, config: {...models, grader}, log: console.log, fetchImpl: fetchForCase,
            observe: observation => observe(observation, grader)});
          const cost = estimate(result.usage);
          record.results.push({grader, ...result, cost, passed: casePassed(scenario, result)}); save();
          console.log(JSON.stringify({case: scenario.name, grader, expected: scenario.expected, decision: result.decision, cost}));
        } catch (error) {record.results.push({grader, error: error.message, details: error.details || null, passed: false}); save();}
      }
      record.passed = record.results.length === graders.length && record.results.every(result => result.passed) &&
        new Set(record.results.map(result => result.decision === 'auto_approve')).size === 1;
    } catch (error) {
      record.snapshots[context.snapshot.digest] ??= structuredClone(context.snapshot);
      record.error = error.message; record.details = error.details || null;
      record.passed = scenario.unavailableSource === error.path && error.code === 'QUALIFICATION_MISSING_SOURCE' &&
        record.observations.some(item => item.report?.request_sources?.includes(scenario.unavailableSource));
      if (record.passed) record.fail_closed = {decision: 'review_incomplete', missing_source: error.path};
    }
    save();
  }
  evaluation.passed = evaluation.cases.every(record => record.passed); save();
  assert.ok(evaluation.passed, 'One or more qualification cases failed; inspect the complete retained case results');
  console.log('All selected qualification cases passed. Only a full corpus qualifies a route; synthetic cases do not establish a genuine PR merge.');
}

function casePassed(scenario, result) {
  return scenario.expected.includes(result.decision) && (!scenario.unavailableSource ||
    result.reviews.every(view => view.report.coverage.dependencies.some(item => item.path === scenario.unavailableSource && item.state === 'missing'))) && (!scenario.requiredFindingPath ||
    result.reviews.some(view => view.report.findings.some(item => item.path === scenario.requiredFindingPath &&
      view.scores.findings.some(score => score.id === item.id && score.disposition === 'blocking'))));
}

module.exports = {protocolFingerprint, equivalentInputs, factualReplay, casePassed, main};
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
