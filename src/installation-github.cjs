'use strict';

const cp = require('node:child_process');

function cliApi(execute = cp.execFileSync) {
  return async (method, endpoint, body) => {
    if (!['GET', 'POST'].includes(method) || typeof endpoint !== 'string' || !/^(?:user$|repos\/)/.test(endpoint)) {
      throw new Error('Unsupported initial-installation GitHub request');
    }
    const args = ['api', '--hostname', 'github.com', '--method', method, endpoint];
    if (body !== undefined) args.push('--input', '-');
    // Allow the bounded 3 MB receipt plus GitHub's base64/JSON representation.
    return JSON.parse(execute('gh', args, {encoding: 'utf8', maxBuffer: 4500000,
      ...(body === undefined ? {} : {input: JSON.stringify(body)})}));
  };
}

function githubFromApi(api) {
  const repo = args => `repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`;
  const query = values => Object.entries(values).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  const endpoint = (route, field) => async args => {
    const value = await api('GET', route(args));
    return {data: field ? value[field] : value};
  };
  const github = {rest: {
    repos: {getContent: endpoint(args => `${repo(args)}/contents/${args.path.split('/').map(encodeURIComponent).join('/')}?${query({ref: args.ref})}`)},
    git: {getBlob: endpoint(args => `${repo(args)}/git/blobs/${encodeURIComponent(args.file_sha)}`)},
    pulls: {
      get: endpoint(args => `${repo(args)}/pulls/${args.pull_number}`),
      listFiles: endpoint(args => `${repo(args)}/pulls/${args.pull_number}/files?${query({per_page: args.per_page, page: args.page})}`),
    },
    issues: {listComments: endpoint(args => `${repo(args)}/issues/${args.issue_number}/comments?${query({per_page: args.per_page, page: args.page})}`)},
    actions: {
      listWorkflowRuns: endpoint(args => `${repo(args)}/actions/workflows/${encodeURIComponent(args.workflow_id)}/runs?${query({event: args.event, head_sha: args.head_sha, per_page: args.per_page})}`),
      listJobsForWorkflowRun: endpoint(args => `${repo(args)}/actions/runs/${args.run_id}/jobs?${query({filter: args.filter, per_page: args.per_page, page: args.page})}`, 'jobs'),
    },
  }};
  github.paginate = async (method, args) => {
    const values = [];
    for (let page = 1; page <= 100; page++) {
      const result = (await method({...args, per_page: 100, page})).data;
      if (!Array.isArray(result)) throw new Error('Incomplete initial-installation GitHub collection');
      values.push(...result);
      if (result.length < 100) return values;
    }
    throw new Error('Initial-installation GitHub collection exceeds its complete evidence budget');
  };
  return github;
}

module.exports = {cliApi, githubFromApi};
