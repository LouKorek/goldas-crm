// Screenshots of the app shell through apps/web/dev/harness.html: phone (390)
// and desktop (1366), day and night. Start `npx vite --port 3000 --host
// 127.0.0.1` in apps/web first, then `node scripts/shell-shots.mjs <out-dir>`.
// Prints the frozen band height, any control whose text overflows, and page
// errors (Firestore permission errors are expected: the harness is signed out).
import { chromium, devices } from '@playwright/test';
const out = process.argv[2];
const only = process.argv[3]; // optional: "phone" | "desktop"
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' });
const errs = [];
const shots = [
  ['home', ''], ['players', ''], ['calendar', ''], ['snapshot', ''],
  ['home', '&more=1'], ['home', '&login=1'],
];
for (const kind of ['phone', 'desktop']) {
  if (only && only !== kind) continue;
  const ctx = kind === 'phone'
    ? await browser.newContext({ ...devices['iPhone 13'], locale: 'he-IL', hasTouch: true })
    : await browser.newContext({ viewport: { width: 1366, height: 860 }, locale: 'he-IL' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  for (const [s, extra] of shots) {
    for (const theme of ['light', 'dark']) {
      await page.goto(`http://127.0.0.1:3000/dev/harness.html?s=${s}&theme=${theme}${extra}`);
      await page.waitForSelector(extra.includes('login') ? '.login-card' : '.main-content > *');
      await page.waitForTimeout(700);
      if (extra.includes('more')) {
        const btn = kind === 'phone' ? page.locator('.bottom-nav-item').last() : page.locator('.me-btn');
        await btn.click();
        await page.waitForTimeout(300);
      }
      const name = `${kind}-${s}${extra.includes('more') ? '-more' : extra.includes('login') ? '-login' : ''}-${theme}`;
      const info = await page.evaluate(() => {
        const h = document.querySelector('.page-header');
        const r = h ? h.getBoundingClientRect() : { top: 0, height: 0 };
        const main = document.querySelector('.main-content');
        return { bandTop: Math.round(r.top), bandH: Math.round(r.height), docSw: document.documentElement.scrollWidth, mainSw: main?.scrollWidth, mainCw: main?.clientWidth };
      });
      const overflow = await page.evaluate(() => [...document.querySelectorAll('.btn, .chip, .rail nav a, .bottom-nav-item, .menu > button')].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent.trim()).slice(0, 8));
      console.log(name, JSON.stringify(info), 'overflow:', JSON.stringify(overflow));
      await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
    }
  }
  await ctx.close();
}
console.log('errors:', [...new Set(errs.filter((e) => !/permission|PERMISSION|Missing or insufficient|Failed to load resource|fonts.googleapis|flagcdn|WebChannel|transport errored/.test(e)))]);
await browser.close();
