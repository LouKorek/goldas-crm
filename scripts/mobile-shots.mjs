// Phone screenshots of apps/web/dev/harness.html (dark + light, 390px). Start
// `npx vite --port 3000 --host 127.0.0.1` in apps/web first, then
// `node scripts/mobile-shots.mjs <out-dir>`; prints the frozen band height and
// any button or chip whose text overflows.
import { chromium, devices } from '@playwright/test';
const out = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'he-IL', hasTouch: true });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
for (const s of ['calendar', 'tm', 'player', 'players', 'snapshot']) {
  for (const light of ['', '1']) {
    await page.goto(`http://127.0.0.1:3000/dev/harness.html?s=${s}&light=${light}`);
    await page.waitForSelector('.page-header');
    await page.waitForTimeout(600);
    const band = await page.evaluate(() => { const h = document.querySelector('.page-header'); const r = h.getBoundingClientRect(); return { top: r.top, h: r.height, w: r.width, sw: document.documentElement.scrollWidth, mainSw: document.querySelector('.main-content').scrollWidth, mainCw: document.querySelector('.main-content').clientWidth }; });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.btn, .chip')].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent.trim()));
    console.log(s, light ? 'light' : 'dark', JSON.stringify(band), 'overflow:', JSON.stringify(overflow));
    await page.screenshot({ path: `${out}/${s}${light ? '-light' : ''}.png`, fullPage: false });
    await page.evaluate(() => document.querySelector('.main-content').scrollTo(0, 400));
    await page.waitForTimeout(200);
    if (!light) await page.screenshot({ path: `${out}/${s}-scrolled.png`, fullPage: false });
  }
}
console.log('errors:', errs.filter((e) => !/scraper-status|Failed to load resource|fonts.googleapis|flagcdn/.test(e)));
await browser.close();
