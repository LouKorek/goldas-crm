// Bundles every Netlify function with esbuild the way Netlify does, so a bad
// require or a syntax error fails CI instead of the deploy.
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dir = 'netlify/functions';
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
let failed = 0;
for (const f of files) {
  try {
    await build({
      entryPoints: [`${dir}/${f}`], bundle: true, platform: 'node', target: 'node20', write: false,
      logLevel: 'silent', external: Object.keys(require('../package.json').dependencies),
    });
    console.log(`ok   ${f}`);
  } catch (e) {
    failed++; console.error(`FAIL ${f}\n${e.message}`);
  }
}
if (failed) process.exit(1);
console.log(`${files.length} functions bundle cleanly`);
