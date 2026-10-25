'use strict';

const {createHash} = require('node:crypto');
const {LIMITS} = require('./source-bank.cjs');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const requireBlob = condition => {if (!condition) throw new Error('Complete immutable textual source blob is unavailable or substituted');};

async function readTextBlob({github, repo, filename, ref}) {
  let {data} = await github.rest.repos.getContent({...repo, path: filename, ref});
  requireBlob(data && Number.isSafeInteger(data.size) && data.size >= 0 && data.size <= LIMITS.source_bytes);
  let immutable = null;
  if (data.encoding === 'none') {
    requireBlob(data.type === 'file' && sha(data.sha));
    immutable = data;
    ({data} = await github.rest.git.getBlob({...repo, file_sha: immutable.sha}));
    requireBlob(data && data.sha === immutable.sha && data.size === immutable.size);
  }
  requireBlob(data.encoding === 'base64' && typeof data.content === 'string');
  const encoded = data.content.replace(/\r?\n/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  requireBlob(bytes.toString('base64') === encoded && bytes.length === data.size);
  if (immutable || data.sha !== undefined) requireBlob(sha(data.sha) && createHash('sha1')
    .update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === data.sha);
  const content = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  requireBlob(!content.includes('\0'));
  return content;
}

module.exports = {readTextBlob};
