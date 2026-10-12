// The main flows a user hits before signing in, against the real build:
// the shell loads in Hebrew and right-to-left, the PWA pieces are served,
// the service worker carries the build's cache name, and the login screen
// shows the Google button. Signed-in flows need Firebase credentials and
// are covered by the function and domain tests instead.
import { test, expect } from '@playwright/test';

test('login screen renders in Hebrew, right-to-left', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page).toHaveTitle(/Gold A&S/);
  // The splash fades, then the login card appears with the Google sign-in.
  await expect(page.getByRole('button', { name: /google/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('body')).toContainText(/Gold A&S/);
  expect(errors, 'no uncaught errors on the login screen').toEqual([]);
});

test('PWA manifest and service worker are served, cache name is versioned', async ({ request }) => {
  const manifest = await request.get('/manifest.json');
  expect(manifest.ok()).toBeTruthy();
  const m = await manifest.json();
  expect(m.name || m.short_name).toMatch(/Gold/);

  const sw = await request.get('/sw.js');
  expect(sw.ok()).toBeTruthy();
  const src = await sw.text();
  const match = /const CACHE_NAME = 'goldas-crm-([^']+)'/.exec(src);
  expect(match, 'CACHE_NAME present').toBeTruthy();
  expect(match[1], 'placeholder replaced by the build').not.toBe('__BUILD_ID__');
});

test('unknown routes fall back to the app shell (SPA redirect)', async ({ page }) => {
  const res = await page.goto('/scouting/tm-watch');
  expect(res.status()).toBeLessThan(400);
  await expect(page.locator('#root')).toBeAttached();
});
