import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const outDir = new URL('./shots/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const jobs = process.argv.slice(2);
if (jobs.length === 0) jobs.push('base:');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
for (const job of jobs) {
  const idx = job.indexOf(':');
  const name = job.slice(0, idx);
  const query = job.slice(idx + 1);
  await page.goto(`http://localhost:5173/lab.html?${query}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__EVERTACTICS_READY__ === true', { timeout: 20000 }); }
  catch { console.error(`TIMEOUT ${name}`); }
  const c = process.env.CROP ? process.env.CROP.split(',').map(Number) : null;
  await page.screenshot({ path: `${outDir}${name}.png`, ...(c ? { clip: { x: c[0], y: c[1], width: c[2], height: c[3] } } : {}) });
  console.log(`shot ${name}`);
}
if (errors.length) { console.log('--- console ---'); for (const e of [...new Set(errors)]) console.log(e); }
await browser.close();
