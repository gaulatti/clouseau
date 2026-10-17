'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validateConfig(config) {
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  const strings = value => Array.isArray(value) && value.length > 0 && value.every(nonempty) && new Set(value).size === value.length;
  const relative = value => nonempty(value) && !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes('..') && !value.includes('\\');
  const workflow = value => relative(value) && /^[a-zA-Z0-9_.-]+\.ya?ml$/.test(value);
  if (!config || config.version !== 1 || !nonempty(config.base_branch) ||
      !workflow(config.workflow) || !nonempty(config.verification?.job) ||
      !strings(config.verification?.steps) ||
      !config.verification.steps.includes('Enforce 100% line and branch coverage') ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(config.manual_reviewer || '') ||
      !relative(config.repository_policy) || !relative(config.readme) ||
      !Array.isArray(config.sensitive_paths) || !config.sensitive_paths.every(relative) ||
      !(config.deployment === null || (workflow(config.deployment?.workflow) &&
        strings(config.deployment?.paths) && config.deployment.paths.every(relative)))) {
    throw new Error('Invalid Clouseau configuration; see examples/colombo.json (version 1)');
  }
  return structuredClone(config);
}

function loadConfig(filename) {
  if (!filename) throw new Error('A trusted repository configuration path is required');
  return validateConfig(JSON.parse(fs.readFileSync(filename, 'utf8')));
}

module.exports = {validateConfig, loadConfig};
