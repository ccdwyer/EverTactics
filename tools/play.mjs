#!/usr/bin/env node
/**
 * Interactive-play harness.
 *
 * The screenshot harness (`shoot.mjs`) poses a scene; it proves the renderer works but says nothing
 * about whether a human can actually play. This drives the real input path — keyboard and mouse into
 * the live app — and captures a frame after each step, so a turn can be inspected as a filmstrip.
 *
 * It asserts nothing on its own. It reports what happened (including any console error) and leaves
 * the frames on disk for a human or a critic agent to look at.
 *
 * Usage:
 *   node tools/play.mjs                                  # scripted opening turn
 *   node tools/play.mjs --keys "ArrowDown,Enter,Escape" --out shots/play
 *   node tools/play.mjs --scene battle-open --shot-mode off
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const scene = arg('scene', 'battle-open');
const outDir = resolve(arg('out', 'shots/play'));
const port = Number(arg('port', 5173));
const width = Number(arg('w', 1600));
const height = Number(arg('h', 900));
const stepDelay = Number(arg('delay', 700));

// A scripted opening turn: open the command menu, walk it, pick Move, cancel, pick Act.
const DEFAULT_KEYS = [
  'ArrowDown', 'ArrowDown', 'ArrowUp',
  'Enter',
  'Escape',
  'ArrowDown', 'Enter',
  'Escape',
];
const keys = arg('keys', '') ? arg('keys', '').split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_KEYS;

async function serverUp() {
  try {
    const r = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch {
    return false;
  }
}

let child = null;
if (!(await serverUp())) {
  child = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    cwd: resolve(dirname(new URL(import.meta.url).pathname), '..'),
    stdio: 'ignore',
  });
  const start = Date.now();
  while (Date.now() - start < 60000 && !(await serverUp())) {
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!(await serverUp())) {
    console.error('FAIL: dev server did not start');
    child?.kill();
    process.exit(2);
  }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });

const errors = [];
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  else logs.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(String(e)));

mkdirSync(outDir, { recursive: true });

// `scene=` (as opposed to `shot=`) boots a live, interactive battle rather than a
// posed screenshot frame. `debug=1` exposes window.__EVERTACTICS__ so each step
// can report what the game thought was happening, not just what it looked like.
const url = `http://localhost:${port}/?scene=${encodeURIComponent(scene)}&debug=1`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

let booted = true;
try {
  await page.waitForFunction(() => window.__EVERTACTICS_READY__ === true, null, { timeout: 40000 });
  // Same trap `shoot.mjs` hit: READY fires on renderer convergence, but the
  // opaque #boot splash is removed on a later event. Waiting only on READY
  // captures a black rectangle and reports booted:true with zero errors.
  await page.waitForFunction(
    () => {
      const boot = document.getElementById('boot');
      if (boot === null) return true;
      const style = window.getComputedStyle(boot);
      return style.display === 'none' || Number(style.opacity) < 0.02;
    },
    null,
    { timeout: 40000 },
  );
} catch {
  booted = false;
}
await page.waitForTimeout(1500);

const steps = [];
await page.screenshot({ path: `${outDir}/00-boot.png` });
steps.push({ step: 0, action: 'boot', shot: '00-boot.png' });

// Read whatever the app chooses to expose about its own state, so the report can
// say what the game thought was happening at each step rather than only showing pixels.
const probe = () =>
  page.evaluate(() => {
    const g = window.__EVERTACTICS__ ?? {};
    return {
      phase: g.phase ?? null,
      active: g.activeUnitName ?? null,
      menu: g.openMenu ?? null,
      focus: g.focusedItem ?? null,
    };
  }).catch(() => ({}));

for (let i = 0; i < keys.length; i++) {
  const key = keys[i];
  await page.keyboard.press(key);
  await page.waitForTimeout(stepDelay);
  const name = `${String(i + 1).padStart(2, '0')}-${key}.png`;
  await page.screenshot({ path: `${outDir}/${name}` });
  steps.push({ step: i + 1, action: key, shot: name, state: await probe() });
}

await browser.close();
if (child) child.kill();

console.log(JSON.stringify({ booted, scene, outDir, steps, errors: errors.slice(0, 25) }, null, 2));
if (!booted) {
  console.error('WARN: app never signalled ready — frames may be incomplete.');
  process.exit(3);
}
if (errors.length) {
  console.error(`WARN: ${errors.length} console error(s) during play.`);
  process.exit(4);
}
