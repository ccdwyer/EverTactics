#!/usr/bin/env node
/**
 * Toggle individual WorldEnvironment layers at runtime and measure the
 * farTop/board luminance ratio for each configuration.
 *
 * Usage: node tools/_scratch/envprobe.mjs [--port 4173] [--scene battle-open]
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const port = Number(arg('port', 4173));
const scene = arg('scene', 'battle-open');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(`http://localhost:${port}/?shot=${encodeURIComponent(scene)}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__EVERTACTICS_READY__ === true, null, { timeout: 40000 });
await page.waitForTimeout(1200);

const configs = [
  ['all on', () => {}],
  ['env off', (e) => e.setEnabled(false)],
  ['sky off', (e) => (e.sky.mesh.visible = false)],
  ['backdrop off', (e) => (e.backdrop.visible = false)],
  ['haze off', (e) => (e.haze.visible = false)],
  ['motes off', (e) => (e.motes.points.visible = false)],
  ['sky+backdrop off', (e) => { e.sky.mesh.visible = false; e.backdrop.visible = false; }],
];

const rows = [];
for (const [label] of configs) {
  const r = await page.evaluate(async (label) => {
    const stage = window.__EVERTACTICS_STAGE__;
    const e = stage.environment;
    // reset
    e.setEnabled(true);
    e.sky.mesh.visible = true;
    e.backdrop.visible = true;
    e.haze.visible = true;
    e.motes.points.visible = true;
    if (label === 'env off') e.setEnabled(false);
    if (label === 'sky off' || label === 'sky+backdrop off') e.sky.mesh.visible = false;
    if (label === 'backdrop off' || label === 'sky+backdrop off') e.backdrop.visible = false;
    if (label === 'haze off') e.haze.visible = false;
    if (label === 'motes off') e.motes.points.visible = false;

    await new Promise((res) => setTimeout(res, 500));
    for (let i = 0; i < 40; i++) await new Promise((res) => requestAnimationFrame(res));

    const cv = stage.canvas;
    const W = 480, H = 270;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(cv, 0, 0, W, H);
    const im = g.getImageData(0, 0, W, H).data;
    const region = (x0, y0, x1, y1) => {
      let s = 0, n = 0;
      for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y++)
        for (let x = Math.floor(x0 * W); x < Math.floor(x1 * W); x++) {
          const i = (y * W + x) * 4;
          s += 0.2126 * im[i] + 0.7152 * im[i + 1] + 0.0722 * im[i + 2];
          n++;
        }
      return s / n;
    };
    const top = region(0, 0, 1, 0.15);
    const board = region(0.12, 0.3, 0.88, 0.85);
    return { farTop: +top.toFixed(2), board: +board.toFixed(2), ratio: +(top / board).toFixed(3) };
  }, label);
  rows.push({ config: label, ...r });
}
console.table(rows);
await browser.close();
