// Dev only: serves dev/app.html with lib/db replaced by fixtures (dev/mock-db.js).
import { defineConfig, mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import base from './vite.config.js';
const r = (p) => fileURLToPath(new URL(p, import.meta.url));
export default mergeConfig(base, defineConfig({
  resolve: { alias: [{ find: /^lib\/db$/, replacement: r('./dev/mock-db.js') }, { find: /^data\/calendarSync$/, replacement: r('./dev/mock-calendarSync.js') }] },
  server: { port: 3100, strictPort: true },
}));
