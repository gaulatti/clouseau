'use strict';

// Validate the shape of a provider credential WITHOUT ever echoing it. Every
// message names only the variable and a fixed problem class, so it is safe for
// logs, annotations and PR comments. A malformed value is never trimmed or
// repaired: the owner must fix the secret.
const MAX_LENGTH = 512;

function keyProblem(value) {
  if (typeof value !== 'string' || value === '') return 'is not configured';
  if (/\s/.test(value)) return 'contains whitespace or a line break';
  if (/[^\x21-\x7e]/.test(value)) return 'contains a non-printable or non-ASCII character';
  if (/^["']|["']$/.test(value)) return 'is wrapped in quotation marks';
  if (value.length > MAX_LENGTH) return `is longer than ${MAX_LENGTH} characters`;
  return null;
}

function assertProviderKey(name, env = process.env) {
  const problem = keyProblem(env[name]);
  if (!problem) return;
  const error = new Error(`${name} ${problem}`);
  error.code = 'PROVIDER_KEY';
  error.cause_code = problem === 'is not configured' ? 'provider_key_missing' : 'provider_key_invalid';
  throw error;
}

module.exports = {MAX_LENGTH, keyProblem, assertProviderKey};
