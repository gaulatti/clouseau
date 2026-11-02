'use strict';

// The requirement text of the last accepted review of a branch, kept so that `clouseau refresh` does not need
// `--request-file` every time (docs/local-review.md, "Refreshing a pull request after its base moved").
//
// Reuse needs byte-identical input, so the text is stored byte for byte next to the review it belongs to
// (`reviews/<cache id>/request.txt` with a `requirement.json` that binds it), and one pointer per repository and branch
// (`requirements/<digest>.json`) names the newest accepted review. Nothing here is trusted merely because it is on disk: the
// pointer and the record must name the same repository, branch, head and cache id, the text must hash to the recorded digest,
// no part may be a link, and the caller must confirm that the recorded head belongs to the pull request being refreshed.
// A record that fails any check is refused with its reason; it is never repaired or guessed.
const fs = require('node:fs');
const path = require('node:path');
const {digest} = require('./acceptance.cjs');

const VERSION = 1;
const MAX_REQUEST_CHARACTERS = 20000;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;

const pointerFile = (state, repository, branch) => path.join(state, 'requirements', `${digest({repository, branch})}.json`);

function recordRequirement({state, repository, branch, head, cacheId, cache, request, additional}) {
  const identity = {version: VERSION, repository, branch, head_sha: head, cache_id: cacheId};
  fs.writeFileSync(path.join(cache, 'request.txt'), request, {mode: 0o600});
  fs.writeFileSync(path.join(cache, 'requirement.json'),
    JSON.stringify({...identity, request_digest: digest(request), has_additional_checks: additional.length > 0}), {mode: 0o600});
  fs.mkdirSync(path.join(state, 'requirements'), {recursive: true, mode: 0o700});
  fs.writeFileSync(pointerFile(state, repository, branch), JSON.stringify(identity), {mode: 0o600});
}

const check = (ok, why) => {if (!ok) throw new Error(why);};
const readText = filename => {
  check(fs.lstatSync(filename).isFile(), `${path.basename(filename)} is not a regular file`);
  return fs.readFileSync(filename, 'utf8');
};

// `contains(sha)` says whether that commit is part of the pull request being refreshed.
function readRequirement({state, repository, branch, contains}) {
  const pointerPath = pointerFile(state, repository, branch);
  if (!fs.existsSync(pointerPath)) {
    throw new Error(`No accepted review of ${repository} branch ${branch} is recorded here, so there is no requirement to default to; pass --request-file`);
  }
  let pointer; let requirement; let request; let cache;
  try {
    pointer = Object(JSON.parse(readText(pointerPath)));
    check(pointer.version === VERSION && pointer.repository === repository && pointer.branch === branch &&
      SHA.test(pointer.head_sha) && HASH.test(pointer.cache_id), 'the pointer is malformed or names another repository or branch');
    cache = path.join(state, 'reviews', pointer.cache_id);
    requirement = Object(JSON.parse(readText(path.join(cache, 'requirement.json'))));
    check(requirement.version === VERSION && requirement.repository === repository && requirement.branch === branch &&
      requirement.head_sha === pointer.head_sha && requirement.cache_id === pointer.cache_id &&
      HASH.test(requirement.request_digest) && typeof requirement.has_additional_checks === 'boolean', 'the record does not match its pointer');
    request = readText(path.join(cache, 'request.txt'));
    check(request.trim() !== '' && request.length <= MAX_REQUEST_CHARACTERS, 'the stored requirement is empty or too large');
    check(digest(request) === requirement.request_digest, 'the stored requirement differs from the one that was reviewed');
  } catch (error) {
    throw new Error(`Unusable requirement record (${error.message}); pass --request-file`);
  }
  if (requirement.has_additional_checks) {
    throw new Error('The last accepted review also used additional local checks, which are part of its input and are not stored; pass --request-file and --additional-checks');
  }
  if (!contains(pointer.head_sha)) {
    throw new Error(`The last accepted review of branch ${branch} was of head ${pointer.head_sha.slice(0, 12)}, which is not part of this pull request alone (it is missing from its history or already in the base); pass --request-file`);
  }
  return {file: path.join(cache, 'request.txt'), head_sha: pointer.head_sha};
}

module.exports = {recordRequirement, readRequirement};
