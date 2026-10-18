'use strict';

const {requestReview} = require('./provider.cjs');
const assert = (condition, message) => {if (!condition) throw new Error(message);};
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const pageName = value => typeof value === 'string' &&
  /^[A-Za-z0-9_][A-Za-z0-9 _-]{0,99}\.md$/.test(value) && value.toLowerCase() !== 'agents.md';
const slug = value => value.replace(/\.md$/i, '').replace(/ /g, '-').toLowerCase();

function validateConfig(config) {
  assert(exact(config, ['version', 'source_paths', 'deployment_workflow', 'deployment_job', 'wiki_branch']), 'Invalid wiki configuration');
  assert(config.version === 1 && Array.isArray(config.source_paths) && config.source_paths.length > 0 &&
    config.source_paths.length <= 50 && new Set(config.source_paths).size === config.source_paths.length, 'Invalid wiki source paths');
  for (const name of config.source_paths) {
    assert(typeof name === 'string' && name.length <= 200 && !name.startsWith('/') && !name.includes('..') &&
      !name.includes('\\') && !/[\x00-\x1f]/.test(name) && name.length > 0, 'Unsafe wiki source path');
  }
  assert(typeof config.deployment_workflow === 'string' && typeof config.deployment_job === 'string' &&
    typeof config.wiki_branch === 'string' && /^[A-Za-z0-9_-]+\.ya?ml$/.test(config.deployment_workflow) &&
    /^[A-Za-z0-9_-]+$/.test(config.deployment_job) && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(config.wiki_branch), 'Invalid wiki deployment boundary');
  return config;
}

function validateIdentity(identity) {
  assert(typeof identity.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repository) &&
    sha(identity.source_sha) && sha(identity.wiki_base_sha) && Number.isSafeInteger(identity.deployment_run_id) &&
    identity.deployment_run_id > 0, 'Invalid wiki update identity');
}

function pageLinks(content) {
  const blocks = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
  assert(!/^\s*(?:```|~~~)/m.test(blocks), 'Unclosed documentation code fence');
  const text = blocks.replace(/`[^`\n]*`/g, '');
  assert(!/\[\[|(?<!!)\[[^\]\n]*\]\[[^\]\n]*\]|<a\b/i.test(text), 'Use inline Markdown links in generated wiki pages');
  const links = [...text.matchAll(/(?<!!)\[[^\]\n]+\]\((?:<([^>\n]+)>|([^\s)\n]+))\)/g)];
  assert(links.length === [...text.matchAll(/(?<!!)\[[^\]\n]+\]\(/g)].length, 'Unsupported documentation link syntax');
  return links.map(match => match[1] || match[2])
    .filter(target => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target))
    .map(target => slug(decodeURIComponent(target.split('#')[0])));
}

function validateBundle(bundle, expected, wiki) {
  assert(exact(bundle, ['version', 'repository', 'source_sha', 'wiki_base_sha', 'deployment_run_id', 'updates']), 'Invalid wiki update schema');
  validateIdentity(bundle);
  assert(bundle.version === 1 && ['repository', 'source_sha', 'wiki_base_sha', 'deployment_run_id'].every(key => bundle[key] === expected[key]), 'Wiki update identity does not match this deployment');
  assert(Array.isArray(bundle.updates) && bundle.updates.length <= 20, 'Invalid wiki page count');
  const paths = new Set();
  for (const page of bundle.updates) {
    assert(exact(page, ['path', 'content']) && pageName(page.path) && !paths.has(page.path), 'Unsafe or duplicate wiki page');
    assert(typeof page.content === 'string' && page.content.trim().length > 0 && Buffer.byteLength(page.content) <= 128000 &&
      !page.content.includes('\0'), 'Invalid wiki page content');
    paths.add(page.path);
  }
  assert(Buffer.byteLength(JSON.stringify(bundle)) <= 512000, 'Wiki update exceeds the complete-publication limit');
  const pages = {...wiki, ...Object.fromEntries(bundle.updates.map(page => [page.path, page.content]))};
  assert(typeof pages['Home.md'] === 'string', 'An initialized wiki Home page is required');
  const available = new Map(Object.keys(pages).map(name => [slug(name), name]));
  assert(available.size === Object.keys(pages).length, 'Ambiguous wiki page names');
  const graph = new Map();
  for (const [name, body] of Object.entries(pages)) {
    const links = pageLinks(body);
    assert(links.every(target => available.has(target)), 'Broken internal wiki page link');
    graph.set(slug(name), links);
  }
  const reachable = new Set(['home', '_sidebar', '_footer']);
  const queue = [...reachable];
  for (const current of queue) {
    for (const target of graph.get(current) || []) {
      if (!reachable.has(target)) {reachable.add(target); queue.push(target);}
    }
  }
  assert(bundle.updates.every(page => Object.hasOwn(wiki, page.path) || reachable.has(slug(page.path))), 'New wiki pages must be linked from Home or navigation');
  return bundle;
}

const RULES = require('node:fs').readFileSync(require('node:path').join(__dirname, '../policy/wiki-maintenance.md'), 'utf8');

async function planWiki({identity, source, wiki, complete = requestReview, report}) {
  validateIdentity(identity);
  assert(Buffer.byteLength(JSON.stringify({source, wiki})) <= 1000000, 'Wiki evidence exceeds the complete-context limit');
  const ask = async (instruction, evidence) => {
    const result = await complete({report, messages: [
      {role: 'system', content: `${RULES}\n${instruction}`},
      {role: 'user', content: JSON.stringify(evidence)},
    ]});
    assert(!result.failure, 'Wiki model completion failed; nothing will be published');
    return JSON.parse(result.content);
  };
  const manifest = await ask('Return {"pages":[{"path":"Page.md","reason":"evidence-based reason"}]} planning all necessary page changes. Use an empty pages array when documentation already matches. Include navigation updates for new pages.', {identity, source, wiki});
  assert(exact(manifest, ['pages']) && Array.isArray(manifest.pages) && manifest.pages.length <= 20, 'Invalid wiki page plan');
  const names = new Set();
  for (const page of manifest.pages) {
    assert(exact(page, ['path', 'reason']) && pageName(page.path) && !names.has(page.path) && typeof page.reason === 'string' &&
      page.reason.trim().length > 0 && page.reason.length <= 1000, 'Invalid wiki planned page');
    names.add(page.path);
  }
  const updates = [];
  for (const page of manifest.pages) {
    const rendered = await ask('Return exactly {"path":"requested page name","content":"complete Markdown page"}. Generate only the requested page, consistently with the shared plan and previously generated pages.', {identity, source, wiki, plan: manifest.pages, requested_page: page.path, proposed_pages: updates});
    assert(rendered.path === page.path, 'Model returned a different wiki page');
    updates.push(rendered);
  }
  return validateBundle({version: 1, ...identity, updates}, identity, wiki);
}

module.exports = {validateConfig, validateIdentity, validateBundle, planWiki};
