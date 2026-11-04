'use strict';

// Compact seam excerpts (chunked review cost). A cross-unit seam used to carry the whole changed hunk of both ends,
// so one hub file imported by 49 modules was repeated 49 times next to 49 whole module patches (1.27 MB of seams for
// a 928 KB change). The integration pass only needs the lines that make the edge: the import statement and the
// lines that use a consumed export on the importing side, the changed lines that declare or touch those exports on
// the changed side, and the size of the change. Everything here is pure and model-free, and a pure function of the
// signed snapshot, so CI recomputes the same excerpts. Nothing is dropped silently: `truncated` is set whenever a
// matching line was left out or cut, and `added`/`removed` always give the full size of the changed side.

const {patchOf} = require('./acceptance.cjs');

const LIMITS = Object.freeze({excerptLines: 6, lineCap: 160});

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const changedLines = patch => patch.split('\n').filter(line => /^[+-]/.test(line) && !/^(?:\+\+\+|---)/.test(line));
const named = (line, names) => names.some(name => new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(line));
const EXPORTISH = /\bexports?\b/;

// Lines of the importing file's head source that contain the import specifier, then lines that use a consumed
// export, each prefixed with its line number.
function importerLines(content, specifier, names) {
  const numbered = content.split('\n').map((text, index) => ({text, label: `${index + 1}: ${text.trim()}`}));
  const imports = numbered.filter(line => line.text.includes(specifier));
  const uses = numbered.filter(line => !imports.includes(line) && named(line.text, names));
  return [...imports, ...uses].map(line => line.label);
}

// Changed lines of the other end's patch that touch a consumed export, or declare an export when none is named.
const calleeLines = (patch, names) => changedLines(patch).filter(line => (names.length ? named(line, names) : EXPORTISH.test(line)));

// Removed lines of a test patch: what the test stopped asserting.
const removedLines = patch => changedLines(patch).filter(line => line.startsWith('-'));

function sizeOf(patch) {
  const lines = changedLines(patch);
  return {added: lines.filter(line => line.startsWith('+')).length, removed: lines.filter(line => line.startsWith('-')).length};
}

// One end of a seam: where it is, how big its change is, and at most `excerptLines` candidate lines, each cut to
// `lineCap` and all together to `excerptCap` characters.
function excerptOf({snapshot, file, unit, candidates, excerptCap, excerptLines = LIMITS.excerptLines, lineCap = LIMITS.lineCap}) {
  const lines = []; let used = 0; let truncated = false;
  for (const candidate of candidates) {
    const text = candidate.length > lineCap ? candidate.slice(0, lineCap) : candidate;
    if (text !== candidate) truncated = true;
    if (lines.length >= excerptLines || used + text.length > excerptCap) {truncated = true; continue;}
    lines.push(text); used += text.length;
  }
  return {path: file.path, unit, status: file.status, ...sizeOf(patchOf(snapshot, file)), lines, truncated};
}

module.exports = {LIMITS, importerLines, calleeLines, removedLines, excerptOf};
