#!/usr/bin/env node
/**
 * Screenshot the scene with a runtime tweak applied, for A/B diagnosis.
 * Usage: node tools/_scratch/envshot.mjs --out shots/x.png --js "e.backdrop.visible=false"
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const port = Number(arg('port', 4173));
const scene = arg('scene', 'battle-open');
const out = resolve(arg('out', 'shots/_probe.png'));
const js = arg('js', '');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(`http://localhost:${port}/?shot=${encodeURIComponent(scene)}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__EVERTACTICS_READY__ === true, null, { timeout: 40000 });
await page.waitForTimeout(1200);

const info = await page.evaluate(async (js) => {
  const stage = window.__EVERTACTICS_STAGE__;
  const e = stage.environment;
  if (js) new Function('stage', 'e', 'scene', js)(stage, e, stage.scene);
  await new Promise((r) => setTimeout(r, 400));
  for (let i = 0; i < 40; i++) await new Promise((r) => requestAnimationFrame(r));
  const s = stage.scene;
  return {
    background: s.background ? (s.background.isColor ? '#' + s.background.getHexString() : s.background.type) : null,
    fog: s.fog ? { type: s.fog.type, color: '#' + s.fog.color.getHexString(), near: s.fog.near, far: s.fog.far, density: s.fog.density } : null,
    clear: '#' + stage.renderer.getClearColor(new (Object.getPrototypeOf(s.background ?? {}).constructor ?? Object)()).getHexString?.(),
  };
}, js);
console.log(JSON.stringify(info, null, 2));

mkdirSync(dirname(out), { recursive: true });
const buf = await page.screenshot({ type: 'png' });
writeFileSync(out, buf);
console.log('wrote', out);
await browser.close();
