// Keeps docs/architecture.md honest. It reads the parts of the system from the
// code (server functions and their schedules, server modules, migrations,
// screens, routes, the web data layer, the shared domain, Firestore
// collections, environment variable names and Golda's tools) and compares
// each list with the matching block of the document:
//
//   <!-- inventory:functions -->  ...  <!-- /inventory:functions -->
//
// Inside a block every `backticked` name made only of letters, digits and
// _ - / : . is one item. A part that exists in the code and is missing from
// its block fails the run, and so does a name in a block that the code no
// longer has. A scheduled function must also show its cron on its own row,
// and a number written as <!-- count:functions -->54<!-- /count --> must be
// the real count.
//
//   node scripts/check-architecture.mjs          check (used by npm test)
//   node scripts/check-architecture.mjs --list   print what the code holds
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DOC = 'docs/architecture.md';
const FUNCTIONS = 'netlify/functions';
const LIB = `${FUNCTIONS}/lib`;
const WEB = 'apps/web/src';
const DOMAIN = 'packages/domain/src';

const read = (p) => readFileSync(p, 'utf8');
const files = (dir, ext) => readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(ext)).map((e) => e.name).sort();
const base = (name) => name.replace(/\.[a-z]+$/, '');
const uniq = (list) => [...new Set(list)].sort();

function walk(dir, ext, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (ext.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

// ---- what the code holds ---------------------------------------------------

function functions() { return files(FUNCTIONS, '.js').map(base); }

// schedule('cron', handler): Netlify needs the cron as a string literal in the
// function's own file, so a literal is all this has to read.
function schedules() {
  const out = {};
  for (const f of files(FUNCTIONS, '.js')) {
    const m = read(join(FUNCTIONS, f)).match(/schedule\(\s*['"]([^'"]+)['"]/);
    if (m) out[base(f)] = m[1];
  }
  return out;
}

function libs() { return files(LIB, '.js').map(base); }
function migrations() { return files(`${LIB}/migrations`, '.js').map(base).filter((n) => /^\d{3}-/.test(n)); }
function pages() { return files(`${WEB}/pages`, '.jsx').map(base); }
function dataLayer() { return files(`${WEB}/data`, '.js').map(base); }

function routes() {
  const src = read(`${WEB}/App.jsx`);
  const out = [];
  for (const m of src.matchAll(/<Route\s+path="([^"]+)"/g)) out.push(m[1] === '/' || m[1] === '*' ? m[1] : `/${m[1].replace(/^\//, '')}`);
  return uniq(out.filter((p) => p !== '*'));
}

function domain() {
  const top = files(DOMAIN, '.ts').map(base).filter((n) => n !== 'index');
  const engines = files(`${DOMAIN}/engines`, '.ts').map(base).filter((n) => n !== 'index').map((n) => `engines/${n}`);
  return [...top, ...engines].sort();
}

// A collection is named by a string literal, either in place or through a
// constant of the same file (const COL = 'agreements'; db.collection(COL)).
// The web also names collections in PATHS (packages/domain constants).
function collections() {
  const out = [];
  const sources = [...walk(FUNCTIONS, ['.js']), ...walk(WEB, ['.js', '.jsx'])];
  for (const p of sources) {
    const src = read(p);
    const consts = {};
    for (const m of src.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*'([A-Za-z][A-Za-z0-9_]*)'\s*;/g)) consts[m[1]] = m[2];
    for (const m of src.matchAll(/\.collection\(\s*'([A-Za-z][A-Za-z0-9_]*)'/g)) out.push(m[1]);
    for (const m of src.matchAll(/\.collection\(\s*(?:[a-z][A-Za-z]*\.)?([A-Z][A-Z0-9_]*)\s*\)/g)) if (consts[m[1]]) out.push(consts[m[1]]);
    for (const m of src.matchAll(/\.doc\(\s*'([A-Za-z][A-Za-z0-9_]*)\//g)) out.push(m[1]);
    for (const m of src.matchAll(/\b(?:collection|doc)\(\s*db\s*,\s*'([A-Za-z][A-Za-z0-9_]*)'/g)) out.push(m[1]);
    for (const m of src.matchAll(/\b(?:collection|doc)\(\s*db\s*,\s*([A-Z][A-Z0-9_]*)\s*[,)]/g)) if (consts[m[1]]) out.push(consts[m[1]]);
  }
  const server = walk(FUNCTIONS, ['.js']).map(read);
  // Constants that another file reaches as module.CONST (agreements.DRAFTS, store.MESSAGES).
  const reached = new Set();
  for (const src of server) for (const m of src.matchAll(/\.collection\(\s*[a-z][A-Za-z]*\.([A-Z][A-Z0-9_]*)\s*\)/g)) reached.add(m[1]);
  for (const src of server) {
    for (const m of src.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*'([a-z][a-z0-9]*_[a-z0-9_]+)'\s*;/g)) if (reached.has(m[1])) out.push(m[2]);
    // A document path kept as a pair: const STATE = ['mail_state', 'sync'].
    for (const m of src.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*\['([a-z][A-Za-z0-9_]*)',\s*'[A-Za-z0-9_]+'\]/g)) {
      if (new RegExp(`\\.collection\\(\\s*${m[1]}\\[0\\]`).test(src)) out.push(m[2]);
    }
    // The migrations runner reads and writes through store.load(col) / store.set(col, ...).
    for (const m of src.matchAll(/\bstore\.(?:load|set)\(\s*'([A-Za-z][A-Za-z0-9_]*)'/g)) out.push(m[1]);
  }
  const paths = `${DOMAIN}/constants.ts`;
  if (existsSync(paths)) {
    const block = (read(paths).match(/PATHS\s*=\s*\{([\s\S]*?)\}/) || [])[1] || '';
    for (const m of block.matchAll(/:\s*'([A-Za-z][A-Za-z0-9_]*)'/g)) out.push(m[1]);
  }
  return uniq(out);
}

// A function reads process.env.X, or env.X where env is a parameter that
// defaults to process.env (so tests can pass their own). The web reads
// import.meta.env.X at build time.
function env() {
  const out = [];
  for (const p of walk(FUNCTIONS, ['.js'])) for (const m of read(p).matchAll(/(?<![\w.])(?:process\.)?env\.([A-Z][A-Z0-9_]*)/g)) out.push(m[1]);
  for (const p of walk(WEB, ['.js', '.jsx'])) for (const m of read(p).matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]*)/g)) out.push(m[1]);
  return uniq(out).filter((n) => !RUNTIME_ENV.has(n));
}
// Set by Netlify or Node themselves, not configured by us.
const RUNTIME_ENV = new Set(['URL', 'NODE_ENV', 'CONTEXT', 'DEPLOY_URL', 'DEPLOY_PRIME_URL', 'SITE_ID', 'SITE_NAME', 'NETLIFY', 'NETLIFY_DEV', 'AWS_LAMBDA_FUNCTION_NAME', 'COMMIT_REF', 'TZ', 'MODE', 'DEV', 'PROD', 'BASE_URL', 'SSR']);

// A tool Golda can call: { name: 'x', description: '...', input_schema: ... }.
function tools() {
  const out = [];
  for (const p of walk(LIB, ['.js'])) for (const m of read(p).matchAll(/\{\s*name:\s*'([a-z][a-z0-9_]*)',\s*description:/g)) out.push(m[1]);
  return uniq(out);
}

const CODE = { functions, libs, migrations, pages, routes, data: dataLayer, domain, collections, env, tools };
const WHERE = {
  functions: `${FUNCTIONS}/*.js`, libs: `${LIB}/*.js`, migrations: `${LIB}/migrations`, pages: `${WEB}/pages`,
  routes: `${WEB}/App.jsx`, data: `${WEB}/data`, domain: DOMAIN, collections: 'collection names in the code',
  env: `process.env.* / env.* in ${FUNCTIONS}, import.meta.env.* in ${WEB}`, tools: "Golda's tool definitions in " + LIB,
};

// ---- what the document says -------------------------------------------------

function blocks(doc) {
  const out = {};
  for (const m of doc.matchAll(/<!--\s*inventory:([a-z]+)\s*-->([\s\S]*?)<!--\s*\/inventory:\1\s*-->/g)) {
    out[m[1]] = { text: m[2], items: uniq([...m[2].matchAll(/`([A-Za-z0-9_\-/:.]+)`/g)].map((x) => x[1])) };
  }
  return out;
}

function main() {
  const inventory = Object.fromEntries(Object.entries(CODE).map(([k, f]) => [k, f()]));
  const crons = schedules();
  if (process.argv.includes('--list')) { console.log(JSON.stringify({ ...inventory, schedules: crons }, null, 2)); return; }

  if (!existsSync(DOC)) { console.error(`${DOC} is missing.`); process.exit(1); }
  const found = blocks(read(DOC));
  const problems = [];
  for (const [kind, names] of Object.entries(inventory)) {
    const block = found[kind];
    if (!block) { problems.push(`${DOC} has no <!-- inventory:${kind} --> block.`); continue; }
    const missing = names.filter((n) => !block.items.includes(n));
    const stale = block.items.filter((n) => !names.includes(n));
    if (missing.length) problems.push(`In the code (${WHERE[kind]}) but not in the "${kind}" block: ${missing.join(', ')}`);
    if (stale.length) problems.push(`In the "${kind}" block but no longer in the code: ${stale.join(', ')}`);
  }
  if (found.functions) {
    const rows = found.functions.text.split('\n');
    for (const [fn, cron] of Object.entries(crons)) {
      const row = rows.find((r) => r.includes(`\`${fn}\``));
      if (row && !row.includes(`\`${cron}\``)) problems.push(`The row of ${fn} must show its schedule \`${cron}\` (UTC).`);
    }
  }
  for (const m of read(DOC).matchAll(/<!--\s*count:([a-z]+)\s*-->\s*(\d+)\s*<!--\s*\/count\s*-->/g)) {
    const real = m[1] === 'schedules' ? Object.keys(crons).length : (inventory[m[1]] || []).length;
    if (Number(m[2]) !== real) problems.push(`The document says ${m[2]} ${m[1]}; the code has ${real}.`);
  }
  if (problems.length) {
    console.error(`${DOC} does not match the code:\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\nUpdate ${DOC} in the same change: add each new part to its block with one line on what it does,`);
    console.error('remove what is gone, and add a line to the change log at the end of the document.');
    console.error('`node scripts/check-architecture.mjs --list` prints what the code holds.');
    process.exit(1);
  }
  const total = Object.values(inventory).reduce((n, list) => n + list.length, 0);
  console.log(`${DOC} matches the code: ${Object.entries(inventory).map(([k, v]) => `${v.length} ${k}`).join(', ')} (${total} parts).`);
}

main();
