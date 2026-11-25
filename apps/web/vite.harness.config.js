// Dev only: serves dev/app.html with lib/db replaced by fixtures (dev/mock-db.js).
import { defineConfig, mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import base from './vite.config.js';
const r = (p) => fileURLToPath(new URL(p, import.meta.url));
export default mergeConfig(base, defineConfig({
  resolve: { alias: [{ find: /^lib\/db$/, replacement: r('./dev/mock-db.js') }, { find: /^data\/calendarSync$/, replacement: r('./dev/mock-calendarSync.js') }, { find: /^data\/youtube$/, replacement: r('./dev/mock-youtube.js') }, { find: /^lib\/highlights-cut$/, replacement: r('./dev/mock-highlights-cut.js') }, { find: /^data\/website$/, replacement: r('./dev/mock-website.js') }, { find: /^data\/admin$/, replacement: r('./dev/mock-admin.js') }, { find: /^data\/completeness$/, replacement: r('./dev/mock-completeness.js') }, { find: /^data\/playerPages$/, replacement: r('./dev/mock-playerPages.js') }, { find: /^data\/agreements$/, replacement: r('./dev/mock-agreements.js') }, { find: /^data\/push$/, replacement: r('./dev/mock-push.js') }, { find: /^data\/mail$/, replacement: r('./dev/mock-mail.js') }, { find: /^data\/golda$/, replacement: r('./dev/mock-golda.js') }] },
  server: { port: 3100, strictPort: true },
}));
