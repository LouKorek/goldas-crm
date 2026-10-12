import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { serviceWorkerVersion, buildId } from './scripts/sw-version.js';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), serviceWorkerVersion()],
  // The running version, shown on the admin System screen and stamped on reported errors.
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  resolve: {
    alias: {
      lib: r('./src/lib'),
      components: r('./src/components'),
      pages: r('./src/pages'),
      data: r('./src/data'),
    },
  },
  // Keep the old CRA variable names working alongside Vite's own.
  envPrefix: ['VITE_', 'REACT_APP_'],
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 3000 },
});
