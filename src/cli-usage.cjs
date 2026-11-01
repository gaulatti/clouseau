'use strict';

// One line per command. Installation commands list their accepted options from the table that parses them,
// so the help can never drift from what the command actually accepts.
const LOCAL = [
  ['init-identity', 'Enroll a signing identity for the authenticated GitHub user', ''],
  ['review', 'Review the committed change against a requirement',
    '--request-file FILE [--directory PATH] [--base REF] [--agent claude|codex|opencode | --harness codex|claude] [--identity FILE] [--additional-checks FILE] [--output FILE] [--engine latest]'],
  ['respond', 'Answer one request of an agent-driven review', '--agent-request FILE --answer FILE --session ID'],
  ['publish', 'Publish a signed receipt for the current checkout', '--directory PATH --receipt FILE'],
];
const INSTALLATION = {
  'public-identity': 'Print the public half of the enrolled signing identity',
  'installation-engine': 'Print the installed engine revision and digest to enroll',
  'installation-prepare': 'Write the initial-installation manifest the repository owner authorizes',
  'installation-authorize': 'Post the owner authorization for a prepared manifest',
  'installation-review': 'Review the frozen initial installation and issue its installation-only receipt',
  'installation-publish': 'Publish the installation-only receipt',
  'installation-check': 'Verify a published initial installation on its pull request',
};

const line = (name, text, options) => `  ${name.padEnd(24)}${text}${options ? `: ${options}` : ''}`;

function usage() {
  const {COMMANDS} = require('./installation-cli.cjs');
  const flags = name => COMMANDS[name].map(option => `--${option}`).join(' ');
  return ['Usage: clouseau <command> [options]   (clouseau --help lists every command)', '',
    'Local review:', ...LOCAL.map(([name, text, options]) => line(name, text, options)), '',
    'Initial installation (owner-authorized bootstrap of a new repository):',
    ...Object.entries(INSTALLATION).map(([name, text]) => line(name, text, COMMANDS[name].length ? `[${flags(name)}]` : ''))].join('\n') + '\n';
}

module.exports = {LOCAL, INSTALLATION, usage};
