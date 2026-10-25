'use strict';

const {safePath} = require('./acceptance-sources.cjs');

function coverageParts(config, {allowUnsupported = false} = {}) {
  const fail = () => {throw new Error('Invalid local-only Clouseau coverage configuration');};
  if (!config || ![1, 2].includes(config.version)) fail();
  if (config.version === 2 && Object.keys(config).some(key =>
    !['version', 'base_branch', 'readme', 'repository_policy', 'verification', 'coverage'].includes(key))) fail();
  const parts = config.version === 1 ? [config.coverage] : config.coverage;
  if (!Array.isArray(parts) || !parts.length || parts.length > 32) fail();
  const reports = new Set();
  const roots = [];
  for (const part of parts) {
    if (!part || !(allowUnsupported ? typeof part.format === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(part.format) :
        (config.version === 1 ? ['llvm', 'istanbul', 'coveragepy'] : ['istanbul', 'coveragepy']).includes(part.format)) ||
      !safePath(part.report) || !(part.source_directory === '.' || safePath(part.source_directory))) fail();
    if (config.version === 2 && Object.keys(part).sort().join(',') !== 'format,report,source_directory') fail();
    if (reports.has(part.report) || roots.some(root => root === '.' || part.source_directory === '.' || part.source_directory === root ||
      part.source_directory.startsWith(root + '/') || root.startsWith(part.source_directory + '/'))) fail();
    reports.add(part.report);
    roots.push(part.source_directory);
  }
  return parts;
}

module.exports = {coverageParts};
