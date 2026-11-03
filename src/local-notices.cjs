'use strict';

const {numbered} = require('./receipt-rejection.cjs');

// Notices of the local review itself (what `clouseau review` prints and returns). Each carries a fixed cause class, one
// sentence and numbered steps, like every CI notice (docs/notices.md). Only a program or module name that matches a plain
// name pattern is ever shown; command output is searched for fixed phrases and never quoted.
const RECIPE = '.clouseau-local.json';
const NAME = /^[A-Za-z0-9._+-]{1,60}$/;

// How to get a missing tool. Anything else gets the generic step.
const INSTALL = Object.freeze({
  coverage: 'Install coverage.py: `python3 -m pip install -r requirements-test.txt` (or `python3 -m pip install coverage`), or put a virtualenv that has it first on PATH.',
  c8: 'Install the repository\'s dev dependencies, which include c8: `npm ci` (or `npm install --save-dev c8`).',
  python3: 'Install Python 3 and make sure `python3` is on PATH.',
  node: 'Install Node.js and make sure `node` is on PATH.',
  npm: 'Install Node.js (it provides `npm`) and make sure `npm` is on PATH.',
});

const tail = command => `${command.stdout ?? ''}\n${command.stderr ?? ''}`;

// Python's own words when `python -m X` meets a directory named X before the installed module: the directory wins.
const SHADOW = /No module named '?[A-Za-z0-9_.]{1,40}\.__main__'?; '([A-Za-z0-9_]{1,40})' is a package and cannot be directly executed/;

// The modules a directory of the working tree hides from `python -m`, in order, once each, at most three.
function shadowedModules(technical) {
  const found = [];
  for (const command of technical?.commands ?? []) {
    const name = command.exit_code !== 0 ? SHADOW.exec(tail(command))?.[1] : null;
    if (name) found.push(name);
  }
  return [...new Set(found)].slice(0, 3);
}

// The programs or modules the verification could not find, in order, once each, at most three.
function missingTools(technical) {
  const found = [];
  for (const command of technical?.commands ?? []) {
    if (command.exit_code !== 0 && SHADOW.test(tail(command))) continue;
    const program = String(command.argv?.[0] ?? '');
    const module = /No module named '?([A-Za-z0-9_.]{1,40})/.exec(tail(command))?.[1];
    const shell = /(?:^|[\s:])([A-Za-z0-9._-]{1,40}): (?:command )?not found/m.exec(tail(command))?.[1];
    if (command.error?.code === 'ENOENT') found.push(NAME.test(program) ? program : null);
    else if (command.exit_code !== 0 && module) found.push(module.split('.')[0]);
    else if (command.exit_code !== 0 && shell) found.push(shell);
  }
  return [...new Set(found)].slice(0, 3);
}

function describeTool(name) {
  return {cause: 'verification_tool_missing',
    sentence: name ? `the verification command needs \`${name}\`, which is not installed` : 'a verification command could not start because its program is not installed',
    steps: [Object.hasOwn(INSTALL, name) ? INSTALL[name] : `Install ${name ? `\`${name}\`` : 'the missing program'} and put it on PATH.`,
      'Run the review again on the same commit; the verification outcome is recorded fresh each time.']};
}

function describeShadow(name) {
  return {cause: 'verification_tool_shadowed',
    sentence: `a directory named \`${name}\` in the directory the verification runs from is found before the \`${name}\` Python module, so \`python -m ${name}\` cannot run`,
    steps: [`Move or delete the \`${name}/\` directory (typically a leftover report directory) in the repository root, or run the verification from a directory without one.`,
      `If the failure remains with no \`${name}/\` directory, the module is not installed in the Python on PATH: ${Object.hasOwn(INSTALL, name) ? INSTALL[name] : `install \`${name}\` there, or put a virtualenv that has it first on PATH.`}`,
      'Run the review again on the same commit; the verification outcome is recorded fresh each time.']};
}

function describeRecipe(baseBranch) {
  return {cause: 'local_recipe_edited',
    sentence: `this change edits \`${RECIPE}\`, so the local review verified the recipe from \`${baseBranch}\`, not your edit (a change cannot weaken its own checks)`,
    steps: ['If the edit is wanted, land it in its own pull request first and review this change on top of the new base.',
      `Otherwise revert the edit to \`${RECIPE}\`.`,
      'Either way the review result you have now reflects the base recipe; nothing else needs to be re-run for that reason.']};
}

// All local notices for one review: `paths` are the changed paths of the snapshot.
function localNotices({paths, technical, baseBranch}) {
  const found = [...shadowedModules(technical).map(describeShadow), ...missingTools(technical).map(describeTool)];
  if (paths.includes(RECIPE)) found.push(describeRecipe(baseBranch));
  return found;
}

const render = notice => `Local review notice (cause: \`${notice.cause}\`): ${notice.sentence}.\n\n${numbered(notice.steps)}`;

module.exports = {RECIPE, INSTALL, missingTools, shadowedModules, describeShadow, describeTool, describeRecipe, localNotices, render};
