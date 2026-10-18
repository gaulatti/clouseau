'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {CASES, prepareCase} = require('./acceptance-cases.cjs');
const {investigateChange, gradeInvestigations} = require('../src/acceptance-review.cjs');
const {PRICING, estimate} = require('../src/review-cost.cjs');

async function main() {
  const graders = (process.env.CLOUSEAU_EVALUATION_GRADERS || 'routed').split(',');
  assert.ok(graders.length && new Set(graders).size === graders.length &&
    graders.every(grader => ['deepseek', 'typesafe', 'routed'].includes(grader)), 'Choose explicit distinct supported grading routes');
  const requestLimit = Number(process.env.CLOUSEAU_EVALUATION_REQUEST_LIMIT || 40);
  assert.ok(Number.isSafeInteger(requestLimit) && requestLimit >= 0 && requestLimit <= 40, 'Qualification permits at most forty provider requests');
  const output = process.env.CLOUSEAU_EVALUATION_PATH || 'work/acceptance-evaluation.json';
  fs.mkdirSync(require('node:path').dirname(output), {recursive: true});
  const evaluation = {version: 2, synthetic: true, qualification_only: true, graders,
    request_budget: {limit: requestLimit, used: 0}, pricing: PRICING, cases: []};
  const save = () => fs.writeFileSync(output, JSON.stringify(evaluation, null, 2) + '\n');
  const budgetedFetch = async (...args) => {
    assert.ok(evaluation.request_budget.used < requestLimit, 'Live provider request budget exhausted');
    evaluation.request_budget.used++; save();
    return fetch(...args);
  };
  save();
  for (const scenario of CASES) {
    const context = await prepareCase(scenario);
    const models = {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grading_model: 'deepseek-flash'};
    console.log(`Acceptance qualification: ${scenario.name}`);
    const record = {name: scenario.name, expected: scenario.expected, results: [], observations: [], snapshots: {}};
    evaluation.cases.push(record); save();
    const observe = (observation, grader) => {
      record.snapshots[context.snapshot.digest] ??= structuredClone(context.snapshot);
      record.observations.push({...observation, grader}); save();
    };
    try {
      const investigation = await investigateChange({...context, config: models, log: console.log, fetchImpl: budgetedFetch,
        observe});
      for (const grader of graders) {
        try {
          const result = await gradeInvestigations({...context, investigation, config: {...models, grader}, log: console.log, fetchImpl: budgetedFetch,
            observe: observation => observe(observation, grader)});
          const cost = estimate(result.usage);
          record.results.push({grader, ...result, cost, passed: scenario.expected.includes(result.decision)}); save();
          console.log(JSON.stringify({case: scenario.name, grader, expected: scenario.expected, decision: result.decision, cost}));
        } catch (error) {record.results.push({grader, error: error.message, details: error.details || null, passed: false}); save();}
      }
      record.passed = record.results.length === graders.length && record.results.every(result => result.passed) &&
        new Set(record.results.map(result => result.decision === 'auto_approve')).size === 1;
    } catch (error) {
      record.snapshots[context.snapshot.digest] ??= structuredClone(context.snapshot);
      record.error = error.message; record.details = error.details || null; record.passed = false;
    }
    save();
  }
  evaluation.passed = evaluation.cases.every(record => record.passed); save();
  assert.ok(evaluation.passed, 'One or more qualification cases failed; inspect the complete retained case results');
  console.log('All qualification cases passed. These synthetic cases do not establish a genuine PR merge.');
}

main().catch(error => {console.error(error.message); process.exitCode = 1;});
