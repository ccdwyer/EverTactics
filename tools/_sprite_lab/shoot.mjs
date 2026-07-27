import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.env.OUT_DIR ?? '/tmp/spriteshots';
const PORT = process.env.PORT ?? '5199';
mkdirSync(OUT, { recursive: true });
const shots = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (m.type()==='error'||m.type()==='warning') logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
for (const spec of shots) {
  const i = spec.indexOf('|');
  const name = i<0?spec:spec.slice(0,i);
  const query = i<0?'':spec.slice(i+1);
  await page.goto(`http://localhost:${PORT}/tools/_sprite_lab/harness.html?${query}`, { waitUntil: 'domcontentloaded' });
  try { await page.waitForFunction(() => window.__READY__ || window.__ERR__, null, { timeout: 25000 }); }
  catch { logs.push(`${name}: TIMEOUT`); }
  const err = await page.evaluate(() => window.__ERR__ ?? null);
  if (err) logs.push(`${name}: ${err}`);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}
await browser.close();
console.log(logs.slice(0,30).join('\n') || 'clean');
