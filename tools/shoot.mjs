#!/usr/bin/env node
/**
 * Screenshot harness for the visual-critic loop.
 *
 * Boots the dev server (if not already up), drives the game to a named scenario
 * via the `?shot=` query parameter, waits for the renderer to report a settled
 * frame, and writes a PNG.
 *
 * Usage:
 *   node tools/shoot.mjs                       # default scenario, shots/current.png
 *   node tools/shoot.mjs --scene battle-open --out shots/battle.png
 *   node tools/shoot.mjs --scene battle-open --w 1920 --h 1080 --wait 4000
 *
 * The page is expected to set `window.__EVERTACTICS_READY__ = true` once the
 * first fully-converged frame (TAA settled, assets loaded) has been presented.
 * If that flag never appears we still shoot after `--wait` ms and report it,
 * so a broken build produces a diagnosable black frame rather than a hang.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const scene = arg('scene', 'battle-open');
const out = resolve(arg('out', `shots/${scene}.png`));
const width = Number(arg('w', 1920));
const height = Number(arg('h', 1080));
const maxWait = Number(arg('wait', 30000));
const port = Number(arg('port', 5173));
const url = `http://localhost:${port}/?shot=${encodeURIComponent(scene)}`;

async function serverUp() {
  try {
    const r = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForServer(deadlineMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await serverUp()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

let child = null;
if (!(await serverUp())) {
  child = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    cwd: resolve(dirname(new URL(import.meta.url).pathname), '..'),
    stdio: 'ignore',
    detached: false,
  });
  if (!(await waitForServer())) {
    console.error('FAIL: dev server did not come up on port ' + port);
    child?.kill();
    process.exit(2);
  }
}

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-webgpu',
  ],
});
const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: Number(arg('dpr', 1)),
});

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

let ready = false;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__EVERTACTICS_READY__ === true, null, {
    timeout: maxWait,
  });
  ready = true;
} catch {
  // fall through — shoot anyway so the failure is visible
}

// let post-processing / TAA settle
await page.waitForTimeout(Number(arg('settle', 1200)));

mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out, type: 'png' });

await browser.close();
if (child) child.kill();

console.log(JSON.stringify({ ok: ready, scene, out, width, height, errors: errors.slice(0, 20) }, null, 2));
if (!ready) {
  console.error('WARN: page never signalled __EVERTACTICS_READY__ — screenshot may be incomplete.');
  process.exit(existsSync(out) ? 3 : 4);
}
