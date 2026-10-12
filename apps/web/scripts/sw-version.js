// Gives the service worker a cache name that changes on every build, so
// nobody has to bump CACHE_NAME by hand after a CSS/JS change any more.
//
// public/sw.js keeps the literal `__BUILD_ID__`; this plugin replaces it in
// the built copy (dist/sw.js) with the git commit or a timestamp.
import { execSync } from 'node:child_process';

export function buildId() {
  const env = process.env.COMMIT_REF || process.env.GITHUB_SHA; // Netlify / GitHub Actions
  if (env) return env.slice(0, 10);
  try {
    return execSync('git rev-parse --short=10 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return String(Date.now());
  }
}

export function serviceWorkerVersion() {
  const id = buildId();
  return {
    name: 'goldas-sw-version',
    apply: 'build',
    generateBundle() {
      // Nothing here: public/ files are copied by Vite; we patch after write.
    },
    closeBundle: {
      sequential: true,
      async handler() {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const file = path.resolve(process.cwd(), 'dist/sw.js');
        if (!fs.existsSync(file)) return;
        const src = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, src.replaceAll('__BUILD_ID__', id));
        // eslint-disable-next-line no-console
        console.log(`[sw-version] cache name goldas-crm-${id}`);
      },
    },
  };
}
