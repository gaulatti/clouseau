'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {CASES, prepareCase} = require('./acceptance-cases.cjs');
const {investigateChange, gradeInvestigations} = require('../src/acceptance-review.cjs');
const {PRICING, estimate} = require('../src/review-cost.cjs');

async function main() {
  const output = process.env.CLOUSEAU_EVALUATION_PATH || 'work/acceptance-evaluation.json';
  fs.mkdirSync(require('node:path').dirname(output), {recursive: true});
  const evaluation = {version: 2, synthetic: true, qualification_only: true, pricing: PRICING, cases: []};
  const save = () => fs.writeFileSync(output, JSON.stringify(evaluation, null, 2) + '\n');
  save();
  for (const scenario of CASES) {
    const context = await prepareCase(scenario);
    const models = {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grading_model: 'deepseek-flash'};
    console.log(`Acceptance qualification: ${scenario.name}`);
    const record = {name: scenario.name, expected: scenario.expected, results: [], observations: []};
    evaluation.cases.push(record); save();
    try {
      const investigation = await investigateChange({...context, config: models, log: console.log,
        observe: observation => {record.observations.push(observation); save();}});
      for (const grader of ['deepseek', 'typesafe']) {
        try {
          const result = await gradeInvestigations({...context, investigation, config: {...models, grader}, log: console.log});
          const cost = estimate(result.usage);
          record.results.push({grader, ...result, cost, passed: scenario.expected.includes(result.decision)}); save();
          console.log(JSON.stringify({case: scenario.name, grader, expected: scenario.expected, decision: result.decision, cost}));
        } catch (error) {record.results.push({grader, error: error.message, details: error.details || null, passed: false}); save();}
      }
      record.passed = record.results.every(result => result.passed) &&
        (record.results[0].decision === 'auto_approve') === (record.results[1].decision === 'auto_approve');
    } catch (error) {
      record.error = error.message; record.passed = false;
    }
    save();
  }
  evaluation.passed = evaluation.cases.every(record => record.passed); save();
  assert.ok(evaluation.passed, 'One or more qualification cases failed; inspect the complete retained case results');
  console.log('All qualification cases passed. These synthetic cases do not establish a genuine PR merge.');
}

main().catch(error => {console.error(error.message); process.exitCode = 1;});
