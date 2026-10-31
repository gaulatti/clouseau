'use strict';

// GET /pulls/{n} asks GitHub to compute the diff statistics against the current base. For a branch that is far
// behind a base that has absorbed many changes it fails with "The request could not be processed because too
// many files changed", although the PR's own change is small. The PR's identity (state, draft, head and base,
// author) does not need those statistics, and the list endpoint, which does not compute them, serves it. The
// PR's own changed files come from the paginated files endpoint, never from a base-versus-head comparison.
const TOO_MANY = /too many files changed/i;

async function readPull(github, repo, number, extra = {}) {
  try {return await github.rest.pulls.get({...repo, pull_number: number, ...extra});} catch (error) {
    if (!TOO_MANY.test(String(error?.message))) throw error;
    for (let page = 1; page <= 10; page++) {
      const {data} = await github.rest.pulls.list({...repo, state: 'all', sort: 'updated', direction: 'desc', per_page: 100, page});
      const found = data.find(item => item.number === number);
      if (found) {
        const files = await github.paginate(github.rest.pulls.listFiles, {...repo, pull_number: number, per_page: 100});
        return {data: {...found, merged: Boolean(found.merged_at), changed_files: files.length}, headers: {}};
      }
      if (data.length < 100) break;
    }
    throw error;
  }
}

module.exports = {readPull, TOO_MANY};
