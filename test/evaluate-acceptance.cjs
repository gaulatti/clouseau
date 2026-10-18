'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {CASES, prepareCase} = require('./acceptance-cases.cjs');
const {investigateChange, gradeInvestigations} = require('../src/acceptance-review.cjs');

async function main() {
  const output = process.env.CLOUSEAU_EVALUATION_PATH || 'work/acceptance-evaluation.json';
  fs.mkdirSync(require('node:path').dirname(output), {recursive: true});
  const evaluation = {version: 2, synthetic: true, qualification_only: true, cases: []};
  const save = () => fs.writeFileSync(output, JSON.stringify(evaluation, null, 2) + '\n');
  save();
  for (const scenario of CASES) {
    const context = await prepareCase(scenario);
    const models = {examiner: 'deepseek-flash', challenger: 'deepseek-flash', grading_model: 'deepseek-flash'};
    console.log(`Acceptance qualification: ${scenario.name}`);
    const investigation = await investigateChange({...context, config: models, log: console.log});
    const record = {name: scenario.name, expected: scenario.expected, results: []};
    evaluation.cases.push(record); save();
    for (const grader of ['deepseek', 'typesafe']) {
      const result = await gradeInvestigations({...context, investigation, config: {...models, grader}, log: console.log});
      record.results.push({grader, ...result}); save();
      console.log(JSON.stringify({case: scenario.name, grader, expected: scenario.expected, decision: result.decision, requests: result.usage.length}));
      assert.ok(scenario.expected.includes(result.decision), `${scenario.name}: ${grader} produced ${result.decision}`);
    }
    assert.equal(record.results[0].decision === 'auto_approve', record.results[1].decision === 'auto_approve', 'Hybrid and baseline must agree on merge eligibility');
  }
  evaluation.passed = true; save();
  console.log('All qualification cases passed. These synthetic cases do not establish a genuine PR merge.');
}

main().catch(error => {console.error(error.message); process.exitCode = 1;});
