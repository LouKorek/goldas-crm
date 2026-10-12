// Bundles every Netlify function with esbuild the way Netlify does, so a bad
// require or a syntax error fails CI instead of the deploy. Then it loads each
// bundle and checks that `handler` is still exported: a file parsed as ESM
// (anything under a package with "type": "module", such as apps/web/public)
// that assigns `module.exports` inside a CommonJS bundle silently replaces the
// function's own exports, and Netlify answers 502 "handler is undefined".
import { build } from 'esbuild';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const dir = 'netlify/functions';
const out = resolve('node_modules/.cache/check-functions');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
let failed = 0;
for (const f of files) {
  try {
    const r = await build({
      entryPoints: [`${dir}/${f}`], bundle: true, platform: 'node', target: 'node20', format: 'cjs', write: false,
      logLevel: 'silent', external: Object.keys(require('../package.json').dependencies),
    });
    const p = resolve(out, f);
    writeFileSync(p, r.outputFiles[0].text);
    const mod = require(p);
    if (typeof mod.handler !== 'function') throw new Error(`bundle exports ${JSON.stringify(Object.keys(mod))}, no handler`);
    console.log(`ok   ${f}`);
  } catch (e) {
    failed++; console.error(`FAIL ${f}\n${e.message}`);
  }
}
if (failed) process.exit(1);
console.log(`${files.length} functions bundle cleanly and export a handler`);
