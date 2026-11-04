'use strict';

const {patchOf} = require('../src/acceptance.cjs');
const {hostedForm} = require('../src/receipt-patch.cjs');

// The pull request file list GitHub would report for a signed snapshot: the same hunks, in GitHub's form.
// GitHub omits `patch` for a change that shows no text (an empty added file, a pure rename).
const hostedFiles = snapshot => snapshot.files.map(file => {
  const patch = hostedForm(patchOf(snapshot, file), {filename: file.path, status: file.status});
  return {filename: file.path, status: file.status, ...(patch === '' ? {} : {patch})};
});

module.exports = {hostedFiles};
