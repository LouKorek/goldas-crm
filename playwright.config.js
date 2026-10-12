// End-to-end smoke tests for the built app. CI builds first, then serves the
// dist folder with `vite preview` and opens it in Chromium. Locally the same
// command works after `npm run build`; set PW_CHROMIUM to use an installed
// browser instead of the one Playwright downloads.
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    ...devices['Desktop Chrome'],
    ...(process.env.PW_CHROMIUM ? { launchOptions: { executablePath: process.env.PW_CHROMIUM } } : {}),
  },
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    cwd: 'apps/web',
    url: `http://127.0.0.1:${PORT}/manifest.json`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
