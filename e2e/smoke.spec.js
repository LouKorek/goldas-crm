// The main flows a user hits before signing in, against the real build:
// the shell loads in Hebrew and right-to-left, the PWA pieces are served,
// the service worker carries the build's cache name, and the login screen
// shows the Google button, and the one page without sign-in (the YouTube
// upload link) sends a file. Signed-in flows need Firebase credentials and
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

test('the YouTube upload link opens without sign-in and sends the file in pieces', async ({ page }) => {
  const token = 'a'.repeat(48);
  const ranges = [];
  await page.route('**/.netlify/functions/youtube-upload**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ json: { status: 'awaiting_file', player: 'Noam Barzilay', title: 'Noam Barzilay | LB / CB | 2026/27', privacy: 'public', link: null } });
    const body = JSON.parse(req.postData());
    if (body.action === 'session') return route.fulfill({ json: { uploadUrl: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=TEST' } });
    return route.fulfill({ json: { link: `https://youtu.be/${body.videoId}` } });
  });
  // A stand-in for YouTube's resumable upload: 308 until the last piece arrives.
  await page.route('https://www.googleapis.com/upload/**', async (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Range' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'PUT', 'access-control-allow-headers': 'content-range' } });
    const range = route.request().headers()['content-range'];
    ranges.push(range);
    const [, , to, total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range).map(Number);
    if (to + 1 === total) return route.fulfill({ status: 200, headers: cors, json: { id: 'NEWvideo123' } });
    return route.fulfill({ status: 308, headers: { ...cors, range: `bytes=0-${to}` } });
  });
  await page.goto(`/yt/${token}`);
  await expect(page.getByRole('heading', { name: 'העלאת סרטון ליוטיוב' })).toBeVisible();
  await expect(page.getByRole('button', { name: /google/i })).toHaveCount(0);
  await expect(page.locator('main')).toContainText('Noam Barzilay | LB / CB | 2026/27');
  const size = 9 * 1024 * 1024;       // one full piece and a remainder
  await page.setInputFiles('input[type=file]', { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(size, 1) });
  await expect(page.getByRole('heading', { name: 'הסרטון עלה' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'פתח ביוטיוב' })).toHaveAttribute('href', 'https://youtu.be/NEWvideo123');
  expect(ranges).toEqual([`bytes 0-8388607/${size}`, `bytes 8388608-${size - 1}/${size}`]);
});

test('a malformed upload link is not the upload page', async ({ page }) => {
  await page.goto('/yt/not-a-token');
  await expect(page.getByRole('button', { name: /google/i })).toBeVisible({ timeout: 15_000 });
});
