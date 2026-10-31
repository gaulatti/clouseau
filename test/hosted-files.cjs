'use strict';

const {patchOf} = require('../src/acceptance.cjs');
const {hostedForm} = require('../src/receipt-patch.cjs');

// The pull request file list GitHub would report for a signed snapshot: the same hunks, in GitHub's form.
const hostedFiles = snapshot => snapshot.files.map(file => ({filename: file.path, status: file.status,
  patch: hostedForm(patchOf(snapshot, file), {filename: file.path, status: file.status})}));

module.exports = {hostedFiles};
