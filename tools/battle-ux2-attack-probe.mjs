/**
 * Measure when the ordinary attack sprite motion begins relative to the ability
 * camera landing, plus the post-landing pose displacement visible on screen.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

function arg(name, fallback) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const origin = arg('origin', 'http://localhost:4173');
const reportPath = resolve(arg('report', 'shots/battle-ux2/attack-after.json'));
const cdpEndpoint = arg('cdp', process.env.EVERTACTICS_CDP_ENDPOINT ?? '');
mkdirSync(dirname(reportPath), { recursive: true });

const browser = cdpEndpoint
  ? await chromium.connectOverCDP(cdpEndpoint)
  : await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const errors = [];
const failedResponses = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (
    message.type() === 'error'
    && !message.text().startsWith('Failed to load resource:')
  ) {
    errors.push(message.text());
  }
});
page.on('response', (response) => {
  if (response.status() >= 400) {
    failedResponses.push({ status: response.status(), url: response.url() });
  }
});

await page.goto(`${origin}/?debug=1&scene=battle-open`, {
  waitUntil: 'domcontentloaded',
  timeout: 30_000,
});
await page.waitForFunction(() => window.__EVERTACTICS_READY__ === true, null, {
  timeout: 60_000,
});
await page.waitForTimeout(1_200);

const timing = await page.evaluate(async () => {
  const game = window.__EVERTACTICS__;
  if (!game || game.state.active === undefined) {
    throw new Error('No active battle unit was available');
  }
  const actor = game.state.units.get(game.state.active);
  if (!actor) throw new Error('Active unit record is missing');
  const sprite = game.sprites.get(actor.id);
  if (!sprite) throw new Error('Active unit sprite is missing');

  const started = performance.now();
  let cameraLanded = 0;
  let motionStarted = 0;
  let motionEnded = 0;
  let impact = 0;
  let done = false;
  const samples = [];

  const originalCinematic = game.camera.cinematic.bind(game.camera);
  game.camera.cinematic = async (...args) => {
    await originalCinematic(...args);
    cameraLanded = performance.now();
  };

  const originalPlayOnce = sprite.playOnce.bind(sprite);
  sprite.playOnce = async (name, options) => {
    if (name === 'attack' && motionStarted === 0) motionStarted = performance.now();
    await originalPlayOnce(name, options);
    if (name === 'attack' && motionEnded === 0) motionEnded = performance.now();
  };

  const originalVfxPlay = game.vfx.play.bind(game.vfx);
  game.vfx.play = async (key, options) => {
    const onImpact = options.onImpact;
    return originalVfxPlay(key, {
      ...options,
      onImpact: (...args) => {
        if (impact === 0) impact = performance.now();
        onImpact?.(...args);
      },
    });
  };

  const initialTile = game.camera.worldToScreen(game.worldOf(actor.pos), {});
  const initialMesh = game.camera.worldToScreen(sprite.mesh.position, {});
  const initialOffset = {
    x: initialMesh.x - initialTile.x,
    y: initialMesh.y - initialTile.y,
  };
  const sample = () => {
    const tile = game.camera.worldToScreen(game.worldOf(actor.pos), {});
    const mesh = game.camera.worldToScreen(sprite.mesh.position, {});
    samples.push({
      timeMs: performance.now() - started,
      x: mesh.x - tile.x - initialOffset.x,
      y: mesh.y - tile.y - initialOffset.y,
    });
    if (!done) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  await game.play([
    { kind: 'cast-fire', unit: actor.id, ability: 'attack', target: { ...actor.pos } },
    { kind: 'damage', unit: actor.id, amount: 37, element: 'none', crit: false },
  ]);
  done = true;
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const relative = (value) => value === 0 ? null : value - started;
  const landedMs = relative(cameraLanded);
  const afterLanding = landedMs === null
    ? []
    : samples.filter((entry) => entry.timeMs >= landedMs);
  return {
    actor: actor.name,
    cameraLandedMs: landedMs,
    motionStartedMs: relative(motionStarted),
    motionEndedMs: relative(motionEnded),
    impactMs: relative(impact),
    motionStartRelativeToCameraMs:
      cameraLanded === 0 || motionStarted === 0 ? null : motionStarted - cameraLanded,
    postLandingMaxPosePixels: afterLanding.reduce(
      (max, entry) => Math.max(max, Math.hypot(entry.x, entry.y)),
      0,
    ),
    samples: samples.length,
  };
});

const report = { ...timing, errors, failedResponses };
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (report.motionStartedMs === null || report.cameraLandedMs === null) {
  throw new Error('Attack motion or camera landing was not observed');
}
if (errors.length > 0 || failedResponses.length > 0) {
  throw new Error('Browser errors were recorded');
}

await context.close();
await browser.close();
