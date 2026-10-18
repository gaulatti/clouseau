'use strict';

const {requestWiki} = require('./provider.cjs');
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

const objectSchema = properties => ({type: 'object', additionalProperties: false, required: Object.keys(properties), properties});
const textSchema = {type: 'string'};
const planSchema = objectSchema({pages: {type: 'array', items: objectSchema({path: {type: 'string', pattern: '^[A-Za-z0-9_][A-Za-z0-9 _-]{0,99}\\.md$'}, reason: {type: 'string', pattern: '^\\S[^\\r\\n]{0,999}$'}})}});
const reviewSchema = pages => objectSchema({pages: objectSchema(Object.fromEntries(pages.map(page => [page.path, objectSchema({source_id: textSchema, findings: {type: 'string', pattern: '^[\\s\\S]{0,2000}$'}, supported: {type: 'boolean'}})])))});

const RULES = require('node:fs').readFileSync(require('node:path').join(__dirname, '../policy/wiki-maintenance.md'), 'utf8');

async function planWiki({identity, source, wiki, complete = requestWiki, report = () => {}, diagnostic = () => {}, allowCorrection = true}) {
  validateIdentity(identity);
  assert(Buffer.byteLength(JSON.stringify({source, wiki})) <= 1000000, 'Wiki evidence exceeds the complete-context limit');
  const ask = async (instruction, evidence, schema) => {
    const content = JSON.stringify(evidence);
    assert(Buffer.byteLength(content) <= 1000000, 'Wiki request exceeds the complete-context limit');
    // A malformed JSON envelope is a transport-format failure, not a review
    // decision. Regenerate once from the same evidence; never trim or accept
    // a prefix, and never retry schema, link, scope, or deployment failures.
    for (let formatAttempt = 1; formatAttempt <= 2; formatAttempt++) {
      const result = await complete({report, schema, messages: [
        {role: 'system', content: `${RULES}\n${instruction}\nReturn exactly ONE JSON object. Escape Markdown line breaks inside the content string. Do not append another object, prose, or code fences outside the JSON. ${formatAttempt === 2 ? 'The previous envelope was not valid JSON; regenerate the exact requested object from the same evidence.' : ''}`},
        {role: 'user', content},
      ]});
      assert(!result.failure, 'Wiki model completion failed; nothing will be published');
      try {return JSON.parse(result.content);}
      catch {
        report(`Wiki generation JSON envelope invalid (attempt ${formatAttempt}/2)`);
      }
    }
    throw new Error('Wiki model returned invalid JSON twice; nothing will be published');
  };
  const manifest = await ask('Return {"pages":[{"path":"Page.md","reason":"evidence-based reason"}]} planning all necessary page changes. Use flat Markdown filenames, and list each path exactly once with a concise nonblank reason. Use an empty pages array when documentation already matches. Include navigation updates for new pages.', {identity, source, wiki}, planSchema);
  const checkPlan = (condition, message) => {
    if (!condition) diagnostic({version: 1, identity, revision: 0, stage: 'planning', plan: manifest});
    assert(condition, message);
  };
  checkPlan(exact(manifest, ['pages']) && Array.isArray(manifest.pages) && manifest.pages.length <= 20, 'Invalid wiki page plan');
  const names = new Set();
  for (const page of manifest.pages) {
    checkPlan(exact(page, ['path', 'reason']) && pageName(page.path) && !names.has(page.path) && typeof page.reason === 'string' &&
      page.reason.trim().length > 0 && page.reason.length <= 1000, 'Invalid wiki planned page');
    names.add(page.path);
  }
  report(`Wiki generation planned ${manifest.pages.length} pages`);
  const generate = async (previous = [], findings = []) => {
    const updates = [];
    for (const page of manifest.pages) {
      const pageFindings = findings.filter(finding => finding.startsWith(`${page.path}: `));
      if (previous.length > 0 && pageFindings.length === 0) {
        updates.push(previous.find(value => value.path === page.path));
        report(`Wiki generation preserved unchanged page ${updates.length}/${manifest.pages.length}`);
        continue;
      }
      const rendered = await ask(`Return exactly {"path":${JSON.stringify(page.path)},"content":"complete Markdown page"}. Generate only this one requested page, consistently with the shared plan and previously generated pages. Preserve existing wording except claims that must change. When review_findings are supplied, correct the actual unsupported claims using production source, not by changing their labels or ignoring the review.`, {identity, source, wiki, plan: manifest.pages, requested_page: page.path, proposed_pages: updates, previous_update: previous, review_findings: pageFindings}, objectSchema({path: {type: 'string', enum: [page.path]}, content: textSchema}));
      assert(rendered.path === page.path, 'Model returned a different wiki page');
      updates.push(rendered);
      report(`Wiki generation completed page ${updates.length}/${manifest.pages.length}`);
    }
    return updates;
  };
  // Controller-owned source references preserve exact text, including blank
  // lines. The model selects an existing line ID; it never retypes a quotation.
  const sourceEvidence = Object.fromEntries(Object.entries(source).flatMap(([file, content]) =>
    content.split('\n').map((line, index) => [`${file}:L${index + 1}`, line])));
  const reviewUpdate = async (updates, revision) => {
    const raw = await ask('Fact-check every factual statement in every proposed page against current production control flow, including retained text. Existing wiki prose may be stale. For EACH requested page, select ONE relevant nonblank source_id, write a concise findings string containing ONLY unresolved false or unsupported claims (empty string if none), and decide supported LAST for that page. Never list supported statements, audit commentary, or "no finding" prose in findings. Set a page supported true exactly when its findings string is empty. Check authentication/status/error/retry semantics and protocol distinctions. Copy source IDs exactly. Do not enumerate every claim or source line: the report has exactly one checklist entry per planned page.', {identity, source_evidence: sourceEvidence, wiki, proposed_update: updates}, reviewSchema(updates));
    diagnostic({version: 1, identity, revision, stage: 'factual-review', updates, review: raw, source_evidence: sourceEvidence});
    const paths = updates.map(page => page.path);
    assert(exact(raw, ['pages']) && exact(raw.pages, paths), 'Invalid wiki factual review');
    const findings = [];
    for (const page of paths) {
      const item = raw.pages[page];
      assert(exact(item, ['source_id', 'findings', 'supported']) && typeof item.supported === 'boolean' &&
        typeof item.findings === 'string' && item.findings.length <= 2000, 'Invalid wiki factual review');
      assert(typeof item.source_id === 'string' && Object.hasOwn(sourceEvidence, item.source_id) &&
        sourceEvidence[item.source_id].trim().length > 0, 'Wiki factual review requires exact source evidence');
      const finding = item.findings.trim();
      assert(item.supported === (finding.length === 0), 'Wiki factual verdict contradicts page findings');
      if (finding) findings.push(`${page}: ${finding}`);
    }
    return {supported: findings.length === 0, findings};
  };
  let updates = await generate();
  let bundle = validateBundle({version: 1, ...identity, updates}, identity, wiki);
  if (updates.length === 0) return bundle;
  let review = await reviewUpdate(updates, 0);
  const signature = pages => JSON.stringify(pages.map(page => [page.path, page.content]));
  const rejected = new Set([signature(updates)]);
  for (let revision = 1; allowCorrection && !review.supported && revision <= 3; revision++) {
    report(`Wiki factual review rejected the draft; generating corrected batch ${revision}/3 from its findings`);
    const previous = updates;
    updates = await generate(previous, review.findings);
    bundle = validateBundle({version: 1, ...identity, updates}, identity, wiki);
    const key = signature(updates);
    assert(!rejected.has(key), 'Wiki correction did not change or revisited rejected text; nothing will be published');
    rejected.add(key);
    review = await reviewUpdate(updates, revision);
  }
  assert(review.supported, 'Wiki factual review did not support the complete update; nothing will be published');
  report(`Wiki factual review supported all ${updates.length} updated pages with exact source evidence`);
  return bundle;
}

async function evaluateWiki({complete = requestWiki, report = () => {}} = {}) {
  const identity = {repository: 'example/gateway', source_sha: 'a'.repeat(40), wiki_base_sha: 'b'.repeat(40), deployment_run_id: 1};
  const source = {'src/auth.rs': 'fn authentication_status(failure: Failure) -> u16 { match failure { Failure::Denied => 401, Failure::Unavailable => 502 } }'};
  const wiki = {'Home.md': '# Authentication'};
  for (const [name, content, supported] of [
    ['supported-authentication', '# Authentication\nDenied credentials return 401. Temporary upstream unavailability returns 502.', true],
    ['false-denial-classification', '# Authentication\nTemporary upstream unavailability is treated as denied credentials and returns 401.', false],
  ]) {
    let calls = 0, error;
    try {
      await planWiki({identity, source, wiki, report, allowCorrection: false, complete: async request => {
        calls++;
        if (calls === 1) return {content: JSON.stringify({pages: [{path: 'Home.md', reason: 'Authentication contract'}]})};
        if (calls === 2) return {content: JSON.stringify({path: 'Home.md', content})};
        return complete(request);
      }});
    } catch (failure) {error = failure;}
    if (supported && error) throw error;
    assert(supported || error?.message === 'Wiki factual review did not support the complete update; nothing will be published', 'Live wiki evaluation failed to reject the false authentication claim');
    report(`Live wiki evaluation ${name}: ${supported ? 'supported' : 'rejected'}`);
  }
}

module.exports = {validateConfig, validateIdentity, validateBundle, planWiki, evaluateWiki};
