/**
 * Capture a default and keyboard-panned field, then verify that a first pan key
 * during an ability camera push cancels the cinematic and takes control.
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
const beforePath = resolve(arg('before', 'shots/battle-ux2/06-camera-before.png'));
const afterPath = resolve(arg('after', 'shots/battle-ux2/06-camera-after.png'));
const reportPath = resolve(arg('report', 'shots/battle-ux2/camera-after.json'));
const cdpEndpoint = arg('cdp', process.env.EVERTACTICS_CDP_ENDPOINT ?? '');
for (const path of [beforePath, afterPath, reportPath]) {
  mkdirSync(dirname(path), { recursive: true });
}

const browser = cdpEndpoint
  ? await chromium.connectOverCDP(cdpEndpoint)
  : await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
const errors = [];
const failedResponses = [];

function observe(page) {
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
}

async function openBattle() {
  const page = await context.newPage();
  observe(page);
  await page.goto(`${origin}/?shot=battle-open`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForFunction(() => window.__EVERTACTICS_READY__ === true, null, {
    timeout: 60_000,
  });
  await page.waitForTimeout(1_200);
  return page;
}

function cameraPose() {
  const game = window.__EVERTACTICS__;
  const active = game?.state.active === undefined
    ? undefined
    : game.state.units.get(game.state.active);
  return {
    focus: game?.camera.focusPoint.toArray() ?? null,
    yawIndex: game?.camera.yawIndex ?? null,
    activeScreen: active && game
      ? game.camera.worldToScreen(game.worldOf(active.pos), game.screen)
      : null,
  };
}

const page = await openBattle();
await page.waitForFunction(() => window.__EVERTACTICS__?.camera.settled === true);
const before = await page.evaluate(cameraPose);
await page.screenshot({ path: beforePath, type: 'png' });
for (let press = 0; press < 3; press++) {
  await page.keyboard.press('l');
  await page.waitForTimeout(40);
}
await page.waitForFunction(() => window.__EVERTACTICS__?.camera.settled === true);
const after = await page.evaluate(cameraPose);
await page.screenshot({ path: afterPath, type: 'png' });
const hintText = await page.locator('.et-hints').textContent();
await page.close();

const castPage = await openBattle();
const cast = await castPage.evaluate(() => {
  const game = window.__EVERTACTICS__;
  if (!game || game.state.active === undefined) return null;
  const actor = game.state.units.get(game.state.active);
  const target = [...game.state.units.values()].find((unit) => unit.team !== actor?.team);
  if (!actor || !target) return null;
  window.__EVERTACTICS_CAMERA_PAN_DONE__ = false;
  const focusBefore = game.camera.focusPoint.toArray();
  void game.play([
    { kind: 'cast-fire', unit: actor.id, ability: 'attack', target: { ...target.pos } },
    { kind: 'damage', unit: target.id, amount: 37, element: 'none', crit: false },
  ]).finally(() => {
    window.__EVERTACTICS_CAMERA_PAN_DONE__ = true;
  });
  return { actor: actor.name, target: target.name, focusBefore };
});
if (!cast) throw new Error('Could not pose the mid-cast camera handoff');
await castPage.waitForTimeout(60);
await castPage.keyboard.press('l');
await castPage.waitForFunction(
  () => window.__EVERTACTICS_CAMERA_PAN_DONE__ === true,
  null,
  { timeout: 30_000 },
);
await castPage.waitForFunction(() => window.__EVERTACTICS__?.camera.settled === true);
const focusAfterMidCastPan = await castPage.evaluate(
  () => window.__EVERTACTICS__?.camera.focusPoint.toArray() ?? null,
);
await castPage.close();

const distance = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const report = {
  before,
  after,
  panDistanceTiles: distance(before.focus, after.focus),
  activeScreenShift: {
    x: after.activeScreen.x - before.activeScreen.x,
    y: after.activeScreen.y - before.activeScreen.y,
  },
  hintText: hintText?.replace(/\s+/g, ' ').trim() ?? '',
  midCast: {
    actor: cast.actor,
    target: cast.target,
    focusBefore: cast.focusBefore,
    focusAfter: focusAfterMidCastPan,
    firstPanDistanceTiles: distance(cast.focusBefore, focusAfterMidCastPan),
  },
  errors,
  failedResponses,
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (Math.abs(report.panDistanceTiles - 3) > 0.001) {
  throw new Error(`Expected a three-tile pan, got ${report.panDistanceTiles}`);
}
if (report.activeScreenShift.x >= -1) {
  throw new Error('Screen-relative right pan did not move the old subject left');
}
if (!report.hintText.includes('I') || !report.hintText.includes('L')) {
  throw new Error('Camera pan binding is missing from the controls hint');
}
if (Math.abs(report.midCast.firstPanDistanceTiles - 1) > 0.001) {
  throw new Error('The first pan input during a cast did not take camera control');
}
if (errors.length > 0 || failedResponses.length > 0) {
  throw new Error('Browser errors were recorded');
}

await context.close();
await browser.close();
