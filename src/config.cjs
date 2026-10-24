'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validateConfig(config) {
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  const strings = value => Array.isArray(value) && value.length > 0 && value.every(nonempty) && new Set(value).size === value.length;
  const relative = value => nonempty(value) && !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes('..') && !value.includes('\\');
  const workflow = value => relative(value) && /^[a-zA-Z0-9_.-]+\.ya?ml$/.test(value);
  if (!config || ![1, 2].includes(config.version) || !nonempty(config.base_branch) ||
      !workflow(config.workflow) || !nonempty(config.verification?.job) ||
      !strings(config.verification?.steps) ||
      !config.verification.steps.includes('Enforce 100% line and branch coverage') ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(config.manual_reviewer || '') ||
      !relative(config.repository_policy) || !relative(config.readme) ||
      !Array.isArray(config.sensitive_paths) || !config.sensitive_paths.every(relative) ||
      !(config.deployment === null || (workflow(config.deployment?.workflow) &&
        strings(config.deployment?.paths) && config.deployment.paths.every(relative)))) {
    throw new Error('Invalid Clouseau configuration; see examples/colombo.json');
  }
  if (config.version === 2) {
    const review = config.acceptance;
    if (!review || !['deepseek-flash', 'deepseek-v4-pro'].includes(review.examiner) ||
        !['deepseek-flash', 'deepseek-v4-pro'].includes(review.challenger) ||
        !['deepseek', 'typesafe', 'routed'].includes(review.grader) || review.grading_model !== 'deepseek-flash' ||
        review.repair_attempts !== 2 || Object.keys(review).sort().join(',') !==
          ['challenger', 'examiner', 'grader', 'grading_model', 'repair_attempts'].join(',')) {
      throw new Error('Invalid Clouseau acceptance configuration; explicit qualified roles and two bounded repair attempts are required');
    }
  }
  if (config.local_review !== undefined) {
    require('./local-receipt.cjs').validateTrust(config.local_review);
    if (config.version !== 2) throw new Error('Local receipt integration requires acceptance protocol version two');
  }
  if (config.merge_mode !== undefined &&
      (config.version !== 2 || !['automatic', 'manual'].includes(config.merge_mode))) {
    throw new Error('Invalid Clouseau merge mode; protocol version two requires automatic or manual');
  }
  return structuredClone(config);
}

function loadConfig(filename) {
  if (!filename) throw new Error('A trusted repository configuration path is required');
  return validateConfig(JSON.parse(fs.readFileSync(filename, 'utf8')));
}

module.exports = {validateConfig, loadConfig};
