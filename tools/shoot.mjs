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
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
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
/** Extra query string appended verbatim, e.g. `--query postdebug=coc`. Diagnostics only. */
const extraQuery = arg('query', '');
const url =
  `http://localhost:${port}/?shot=${encodeURIComponent(scene)}` +
  (extraQuery ? `&${extraQuery}` : '');

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

const cdpEndpoint = process.env.EVERTACTICS_CDP_ENDPOINT;
const browser = cdpEndpoint
  ? await chromium.connectOverCDP(cdpEndpoint)
  : await chromium.launch({
      args: [
        '--use-gl=angle',
        '--use-angle=metal',
        '--enable-gpu',
        '--ignore-gpu-blocklist',
        '--enable-unsafe-webgpu',
      ],
    });
const page = cdpEndpoint
  ? await browser.contexts()[0].newPage()
  : await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: Number(arg('dpr', 1)),
    });
if (cdpEndpoint) await page.setViewportSize({ width, height });
if (cdpEndpoint) await page.bringToFront();

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

let ready = false;
let splashGone = false;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__EVERTACTICS_READY__ === true, null, {
    timeout: maxWait,
  });
  ready = true;

  // The READY flag fires on renderer convergence, but the opaque #boot splash is
  // removed later, on a different event. Shooting between those two moments
  // captures a black rectangle and reports success — so wait for the splash to
  // actually be gone (or fully transparent) before believing the frame.
  await page.waitForFunction(
    () => {
      const boot = document.getElementById('boot');
      if (boot === null) return true;
      const style = window.getComputedStyle(boot);
      return style.display === 'none' || Number(style.opacity) < 0.02;
    },
    null,
    { timeout: maxWait },
  );
  splashGone = true;
} catch {
  // fall through — shoot anyway so the failure is visible
}

// let post-processing / TAA settle
await page.waitForTimeout(Number(arg('settle', 1200)));

/**
 * Re-verify right before the shutter.
 *
 * Against the vite DEV server, any agent saving a file triggers an HMR reload —
 * the page goes back to the boot splash AFTER we already saw it clear, and the
 * capture is black again. This bit us with agents editing concurrently.
 * Re-check, and if the splash is back, wait it out once more.
 * For fully deterministic captures, build and use `vite preview` (see --port).
 */
const splashBack = await page
  .evaluate(() => {
    const boot = document.getElementById('boot');
    if (boot === null) return false;
    const s = window.getComputedStyle(boot);
    return s.display !== 'none' && Number(s.opacity) > 0.02;
  })
  .catch(() => false);

if (splashBack) {
  console.error('WARN: boot splash reappeared (HMR reload?) — waiting again.');
  try {
    await page.waitForFunction(() => window.__EVERTACTICS_READY__ === true, null, { timeout: maxWait });
    await page.waitForFunction(
      () => {
        const boot = document.getElementById('boot');
        if (boot === null) return true;
        const s = window.getComputedStyle(boot);
        return s.display === 'none' || Number(s.opacity) < 0.02;
      },
      null,
      { timeout: maxWait },
    );
    await page.waitForTimeout(Number(arg('settle', 1200)));
  } catch {
    splashGone = false;
  }
}

mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out, type: 'png' });

/**
 * Verify the captured frame actually contains an image.
 *
 * A harness that green-lights a black frame invalidates every visual judgement
 * made through it, so this is not optional bookkeeping — it is the check that
 * makes `ok: true` mean something. Decoding happens in the same browser, on a
 * downscaled draw, so it costs nothing and needs no image dependency.
 */
async function frameStats(pngPath) {
  const probe = cdpEndpoint
    ? await browser.contexts()[0].newPage()
    : await browser.newPage({ viewport: { width: 160, height: 90 } });
  if (cdpEndpoint) await probe.setViewportSize({ width: 160, height: 90 });
  try {
    const b64 = readFileSync(pngPath).toString('base64');
    const stats = await probe.evaluate(async (src) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = src;
      });
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 90;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 160, 90);
      const { data } = ctx.getImageData(0, 0, 160, 90);
      // Bucket colours coarsely; a real frame spreads across many buckets, a
      // splash or a clear-colour fill collapses into one.
      const buckets = new Map();
      let lum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] >> 4, g = data[i + 1] >> 4, b = data[i + 2] >> 4;
        const k = (r << 8) | (g << 4) | b;
        buckets.set(k, (buckets.get(k) ?? 0) + 1);
        lum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      }
      const total = data.length / 4;
      const modal = Math.max(...buckets.values()) / total;
      return { modalShare: modal, distinct: buckets.size, meanLuma: lum / total };
    }, `data:image/png;base64,${b64}`);
    return stats;
  } finally {
    await probe.close();
  }
}

let stats = null;
try {
  stats = await frameStats(out);
} catch {
  // Verification is best-effort; a failure to measure is not a failure to render.
}

await page.close();
await browser.close();
if (child) child.kill();

// >92% of the frame in a single coarse colour bucket means we captured a flat
// fill — the boot splash, a clear colour, or a crashed renderer.
const blank = stats !== null && (stats.modalShare > 0.92 || stats.distinct < 12);

/**
 * A material that fails to compile does NOT blank the frame — three.js falls back
 * and the scene still renders, just wrong. The ground plane rendering as a flat
 * grey block passed both the splash check and the blank check while an `env-ground`
 * fragment shader was failing on a reserved word. Surface that as a failure, and
 * name the offending materials, rather than burying it in a console-error list
 * nobody reads.
 */
const shaderErrors = errors.filter((e) => /Shader Error|not compiled|Illegal use of reserved word/i.test(e));
const brokenMaterials = [
  ...new Set(shaderErrors.flatMap((e) => [...e.matchAll(/Material Name:\s*(\S+)/g)].map((m) => m[1]))),
];

const ok = ready && splashGone && !blank && shaderErrors.length === 0;

console.log(JSON.stringify(
  {
    ok, ready, splashGone, blank, stats, scene, out, width, height,
    brokenMaterials,
    errors: errors.slice(0, 20),
  },
  null,
  2,
));

if (!ready) {
  console.error('FAIL: page never signalled __EVERTACTICS_READY__.');
  process.exit(existsSync(out) ? 3 : 4);
}
if (!splashGone) {
  console.error('FAIL: boot splash never cleared — the frame is the splash, not the game.');
  process.exit(5);
}
if (blank) {
  console.error(
    `FAIL: captured frame is effectively blank ` +
      `(modal colour ${(stats.modalShare * 100).toFixed(1)}% of pixels, ` +
      `${stats.distinct} distinct buckets, mean luma ${stats.meanLuma.toFixed(1)}). ` +
      `Do not judge this image.`,
  );
  process.exit(6);
}
if (shaderErrors.length) {
  console.error(
    `FAIL: ${shaderErrors.length} shader(s) failed to compile` +
      (brokenMaterials.length ? ` — ${brokenMaterials.join(', ')}` : '') +
      `. The frame rendered, but with fallback materials, so it does not show what the code says. ` +
      `Do not judge this image.`,
  );
  process.exit(7);
}
