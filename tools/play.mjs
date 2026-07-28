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
 *   node tools/play.mjs --cdp 57038 --steps "key:ArrowDown,key:Enter,reload"
 *   node tools/play.mjs --cdp 57038 --steps "title-new,mark:world-map"
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const scene = arg('scene', null);
const outDir = resolve(arg('out', 'shots/play'));
const reportPath = arg('report', null);
// `localhost`, not `127.0.0.1`. `vite preview` binds the IPv6 loopback, and node's
// fetch refuses a bare 127.0.0.1 against it — so a 127.0.0.1 default made every
// run die with "dev server did not start" while curl to the same port returned 200.
const host = arg('host', 'localhost');
const port = Number(arg('port', 5173));
const width = Number(arg('w', 1600));
const height = Number(arg('h', 900));
const stepDelay = Number(arg('delay', 700));
const cdpPort = Number(arg('cdp', 0));
const verbose = argv.includes('--verbose');
const origin = `http://${host}:${port}`;
const SIGNATURE_CAPTURE_ABILITIES = new Set([
  'flare',
  'bahamut',
  'holy',
  'curaja',
  'dragon-dive',
  'slow',
  'firaja',
  'drain-life',
]);

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
    const r = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch {
    return false;
  }
}

let child = null;
if (!(await serverUp())) {
  child = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
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

const browser = cdpPort > 0
  ? await chromium.connectOverCDP(`http://localhost:${cdpPort}`)
  : await chromium.launch({
      args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
    });
let cdpContext;
if (cdpPort > 0) {
  const candidates = [];
  for (const context of browser.contexts()) {
    let campaignBytes = -1;
    for (const existingPage of context.pages()) {
      if (!existingPage.url().startsWith(`${origin}/`)) continue;
      const bytes = await existingPage.evaluate(
        () => localStorage.getItem('evertactics.campaign')?.length ?? 0,
      ).catch(() => 0);
      campaignBytes = Math.max(campaignBytes, bytes);
    }
    candidates.push({ context, campaignBytes });
  }
  candidates.sort((a, b) => b.campaignBytes - a.campaignBytes);
  cdpContext = candidates[0]?.context;
}
const page = cdpContext
  ? (
      await Promise.all(
        cdpContext.pages()
          .filter((existingPage) => existingPage.url().startsWith(`${origin}/`))
          .map((existingPage) => existingPage.close()),
      ),
      await cdpContext.newPage()
    )
  : await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
if (cdpPort > 0) await page.setViewportSize({ width, height });
if (cdpPort > 0) await page.bringToFront();

const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
const warnings = [];
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error') {
    consoleErrors.push({ message: m.text(), url: m.location().url });
  }
  else if (m.type() === 'warning') warnings.push(m.text());
  else logs.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('response', (response) => {
  if (response.status() >= 400) {
    failedResponses.push({ status: response.status(), url: response.url() });
  }
});

mkdirSync(outDir, { recursive: true });

// `scene=` opts into a live battle. With no explicit scene the normal app route
// boots the campaign world map. `debug=1` exposes state for the step report.
const query = new URLSearchParams({ debug: '1' });
if (scene) query.set('scene', scene);
const url = `${origin}/?${query}`;

const waitForBoot = async () => {
  try {
    await page.waitForFunction(() => window.__EVERTACTICS_READY__ === true, null, { timeout: 60000 });
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
      { timeout: 60000 },
    );
    return true;
  } catch {
    return false;
  }
};

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
let booted = await waitForBoot();
await page.waitForTimeout(1500);

const steps = [];
await page.screenshot({ path: `${outDir}/00-boot.png` });
steps.push({ step: 0, action: 'boot', shot: '00-boot.png' });

// Read whatever the app chooses to expose about its own state, so the report can
// say what the game thought was happening at each step rather than only showing pixels.
const probe = () =>
  page.evaluate(async () => {
    const g = window.__EVERTACTICS__;
    const state = g?.state;
    const activeId = state?.active;
    const active = activeId === undefined ? undefined : state?.units.get(activeId);
    const raw = localStorage.getItem('evertactics.campaign');
    const campaign = raw === null ? null : JSON.parse(raw);
    const digest = raw === null
      ? null
      : Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))),
          (byte) => byte.toString(16).padStart(2, '0'),
        ).join('');
    return {
      location: window.location.href,
      surface: g?.appSurface ?? null,
      screen: g?.ui.currentScreen ?? null,
      resultOutcome:
        document.querySelector('.et-result.is-open')?.dataset['outcome'] ?? null,
      mode: g?.mode.kind ?? null,
      phase: state?.phase ?? null,
      active: active?.name ?? null,
      campaign: campaign === null
        ? null
        : {
            digest,
            bytes: raw.length,
            gil: campaign.gil,
            inventory: campaign.inventory,
            completed: campaign.progress?.completed,
            current: campaign.progress?.current,
            roster: campaign.roster?.map((unit) => ({
              id: unit.id,
              level: unit.level,
              exp: unit.exp,
              totalExp: unit.totalExp,
              currentJob: unit.currentJob,
              equipment: unit.equipment,
              jobs: Object.fromEntries(
                Object.entries(unit.jobs ?? {}).map(([job, progress]) => [
                  job,
                  {
                    level: progress.level,
                    jp: progress.jp,
                    totalJp: progress.totalJp,
                    learned: progress.learned,
                  },
                ]),
              ),
            })),
          },
    };
  }).catch(() => ({}));

/**
 * A step is either a key press or a click. Movement cannot be driven by keys
 * alone — picking a destination tile is a click on the board — so a keys-only
 * harness can open the Move menu and never actually move, which produces a
 * filmstrip of identical poses that looks like "animation is broken" when
 * nothing was ever asked to walk.
 *
 *   --steps "key:Enter,click:0.42x0.55,burst:12x120"
 *   --steps "selector:.et-formation__confirm,reload,key:ArrowDown,key:Enter"
 *   --steps "title-new,wait:.et-worldmap,mark:new-game-world-map"
 *
 * `burst:NxM` captures N frames M ms apart without further input. That is the
 * only way to see a walk cycle: the traversal is over in well under a second,
 * so one screenshot per input lands after the motion has finished.
 */
const stepSpec = arg('steps', '');
const parsed = stepSpec
  ? stepSpec.split(',').map((s) => s.trim()).filter(Boolean)
  : keys.map((k) => `key:${k}`);

let shotIndex = 0;
let activeCastLabel = '';
const capture = async (label) => {
  shotIndex += 1;
  const safeLabel = label.replace(/[^a-z0-9_.-]+/gi, '-');
  const name = `${String(shotIndex).padStart(2, '0')}-${safeLabel}.png`;
  await page.screenshot({ path: `${outDir}/${name}`, timeout: 120000 });
  return name;
};

const clickCommand = async (label) => {
  const row = page.locator('.et-command__row').filter({ hasText: label });
  const count = await row.count();
  if (count !== 1) {
    throw new Error(`Expected one "${label}" command row, found ${count}`);
  }
  await row.click();
};

const battleDecision = (kind) =>
  page.evaluate((decisionKind) => {
    const game = window.__EVERTACTICS__;
    const state = game?.state;
    const active = state?.active === undefined
      ? undefined
      : state.units.get(state.active);
    if (!game || !state || !active) return null;

    const pointFor = (pos) => {
      const world = game.worldOf(pos);
      const point = game.camera.worldToScreen(world, game.screen);
      return { x: point.x, y: point.y };
    };
    const opponents = [...state.units.values()]
      .filter((unit) => !unit.removed && unit.team !== active.team);

    if (decisionKind === 'target' && game.mode.kind === 'target') {
      const legal = game.mode.legal;
      const target = opponents
        .filter((unit) => legal.has(`${unit.pos.x},${unit.pos.y}`))
        .sort((a, b) => a.stats.hp - b.stats.hp)[0];
      if (!target) return null;
      const points = [pointFor(target.pos), game.anchorFor(target)];
      const point = points.find((candidate) => {
        const picked = game.camera.screenToTile(
          candidate.x,
          candidate.y,
          state.field,
        );
        return picked !== undefined &&
          Math.max(
            Math.abs(picked.x - target.pos.x),
            Math.abs(picked.y - target.pos.y),
          ) <= 1;
      });
      return point ? { point, tile: { ...target.pos } } : null;
    }

    if (decisionKind === 'move' && game.mode.kind === 'move') {
      const choices = [...game.mode.reach.values()]
        .map((node) => node.pos)
        .filter((pos) => pos.x !== active.pos.x || pos.y !== active.pos.y)
        .filter((pos) => {
          const point = pointFor(pos);
          const picked = game.camera.screenToTile(point.x, point.y, state.field);
          return picked?.x === pos.x && picked.y === pos.y;
        })
        .sort((a, b) => {
          const distance = (pos) => Math.min(
            ...opponents.map((unit) =>
              Math.abs(unit.pos.x - pos.x) + Math.abs(unit.pos.y - pos.y),
            ),
          );
          return distance(a) - distance(b);
        });
      const destination = choices[0];
      return destination
        ? { point: pointFor(destination), tile: { ...destination } }
        : null;
    }
    return null;
  }, kind);

const autoplayBattle = async () => {
  let playerTurns = 0;
  while (playerTurns < 160) {
    await page.waitForFunction(
      () => {
        if (document.querySelector('.et-result.is-open')) return true;
        const game = window.__EVERTACTICS__;
        const state = game?.state;
        if (state?.phase === 'victory' || state?.phase === 'defeat') return true;
        const active = state?.active === undefined
          ? undefined
          : state.units.get(state.active);
        return game?.mode.kind === 'command' && active?.team === 'player';
      },
      null,
      { timeout: 120000 },
    );
    if (await page.locator('.et-result.is-open').count()) break;
    const phase = await page.evaluate(() => window.__EVERTACTICS__?.state.phase);
    if (phase === 'victory' || phase === 'defeat') {
      const presentation = page.locator(
        `.et-battle-presentation.is-open[data-kind="${phase}"]`,
      );
      await presentation.waitFor({ state: 'visible', timeout: 10000 }).catch(() => undefined);
      if (await presentation.isVisible().catch(() => false)) {
        steps.push({
          action: `autoplay-${phase}`,
          shot: await capture(`battle-${phase}`),
          state: await probe(),
        });
      }
      await page.locator('.et-result.is-open').waitFor({ state: 'visible', timeout: 120000 });
      break;
    }
    playerTurns += 1;
    if (verbose) {
      const active = await page.evaluate(() => {
        const game = window.__EVERTACTICS__;
        const activeId = game?.state.active;
        return activeId === undefined ? null : game.state.units.get(activeId)?.name ?? null;
      });
      console.error(`[play] player turn ${playerTurns}: ${active ?? 'unknown'}`);
    }

    await clickCommand('Attack');
    await page.waitForFunction(
      () => window.__EVERTACTICS__?.mode.kind === 'target',
      null,
      { timeout: 10000 },
    );
    let target = await battleDecision('target');
    if (!target) {
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => window.__EVERTACTICS__?.mode.kind === 'command',
        null,
        { timeout: 10000 },
      );
      await clickCommand('Move');
      await page.waitForFunction(
        () => window.__EVERTACTICS__?.mode.kind === 'move',
        null,
        { timeout: 10000 },
      );
      const destination = await battleDecision('move');
      if (destination) {
        await page.mouse.click(destination.point.x, destination.point.y);
        await page.waitForFunction(
          () => {
            const game = window.__EVERTACTICS__;
            return game?.mode.kind === 'command' ||
              document.querySelector('.et-result.is-open') !== null;
          },
          null,
          { timeout: 30000 },
        );
      } else {
        await page.keyboard.press('Escape');
      }
      if (await page.locator('.et-result.is-open').count()) break;
      await clickCommand('Attack');
      await page.waitForFunction(
        () => window.__EVERTACTICS__?.mode.kind === 'target',
        null,
        { timeout: 10000 },
      );
      target = await battleDecision('target');
    }

    if (target) {
      await page.mouse.click(target.point.x, target.point.y);
      await page.waitForFunction(
        () => {
          const game = window.__EVERTACTICS__;
          return game?.mode.kind === 'command' ||
            game?.state.phase === 'victory' ||
            game?.state.phase === 'defeat' ||
            document.querySelector('.et-result.is-open') !== null;
        },
        null,
        { timeout: 30000 },
      );
    } else {
      await page.keyboard.press('Escape');
    }

    if (await page.locator('.et-result.is-open').count()) break;
    const state = await page.evaluate(() => {
      const game = window.__EVERTACTICS__;
      return {
        mode: game?.mode.kind,
        phase: game?.state.phase,
        active: game?.state.active,
      };
    });
    if (state.mode === 'command' && state.phase === 'awaiting-command') {
      await clickCommand('Wait');
    }
  }
  await page.locator('.et-result.is-open').waitFor({ state: 'visible', timeout: 120000 });
  return playerTurns;
};

for (const spec of parsed) {
  const separator = spec.indexOf(':');
  const [kind, valueRaw] = spec === 'reload'
    ? ['reload', '']
    : ['title-new', 'clear-formation', 'autoplay', 'wait-cast'].includes(spec)
    ? [spec, '']
    : separator >= 0
    ? [spec.slice(0, separator), spec.slice(separator + 1)]
    : ['key', spec];
  const value = valueRaw ?? '';

  if (kind === 'cast') {
    if (!SIGNATURE_CAPTURE_ABILITIES.has(value)) {
      throw new Error(`Unknown signature capture ability "${value}"`);
    }
    const posed = await page.evaluate((abilityId) => {
      const game = window.__EVERTACTICS__;
      const state = game?.state;
      if (!game || !state) return null;
      const units = [...state.units.values()].filter((unit) => !unit.removed);
      const active = state.active === undefined ? undefined : state.units.get(state.active);
      const actor = active ?? units[0];
      if (!actor) return null;
      const beneficial = abilityId === 'curaja';
      const targetUnit = beneficial
        ? actor
        : units.find((unit) => unit.team !== actor.team) ?? actor;
      const target = { ...targetUnit.pos };

      window.__EVERTACTICS_CAPTURE_CAST_DONE__ = false;
      window.__EVERTACTICS_CAPTURE_CAST__ = { ability: abilityId, unit: actor.id, target };
      void game
        .play([{ kind: 'cast-fire', unit: actor.id, ability: abilityId, target }])
        .finally(() => {
          window.__EVERTACTICS_CAPTURE_CAST_DONE__ = true;
        });
      return { ability: abilityId, actor: actor.name, target: targetUnit.name };
    }, value);
    if (!posed) throw new Error(`Unable to pose cast for "${value}"`);
    activeCastLabel = value;
    await page.waitForTimeout(80);
    steps.push({
      action: spec,
      shot: await capture(`${value}-cast`),
      state: { ...(await probe()), posed },
    });
    continue;
  }

  if (kind === 'wait-cast') {
    await page.waitForFunction(
      () => window.__EVERTACTICS_CAPTURE_CAST_DONE__ === true,
      null,
      { timeout: 120000 },
    );
    await page.waitForTimeout(120);
    continue;
  }

  if (kind === 'title-new') {
    const newGame = page.getByText('New Game', { exact: true });
    await newGame.click();
    const beginAnew = page.getByText('Begin Anew', { exact: true });
    if (await beginAnew.isVisible().catch(() => false)) {
      await beginAnew.click();
    }
    await page.locator('.et-worldmap.is-open').waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(stepDelay);
    steps.push({ action: spec, shot: await capture('new-game-world-map'), state: await probe() });
    continue;
  }

  if (kind === 'wait') {
    await page.locator(value).waitFor({ state: 'visible', timeout: 120000 });
    continue;
  }

  if (kind === 'mark') {
    await page.waitForTimeout(stepDelay);
    steps.push({ action: spec, shot: await capture(value || 'mark'), state: await probe() });
    continue;
  }

  if (kind === 'clear-formation') {
    let deployed = page.locator('.et-slot:not(.is-empty)');
    while (await deployed.count()) {
      await deployed.first().click();
      await page.waitForTimeout(120);
      deployed = page.locator('.et-slot:not(.is-empty)');
    }
    const confirm = page.locator('.et-formation__confirm');
    steps.push({
      action: spec,
      shot: await capture('zero-deployment-disabled'),
      state: {
        ...(await probe()),
        confirmDisabled: await confirm.isDisabled(),
      },
    });
    continue;
  }

  if (kind === 'autoplay') {
    const playerTurns = await autoplayBattle();
    await page.waitForTimeout(stepDelay);
    steps.push({
      action: spec,
      shot: await capture('battle-result'),
      state: { ...(await probe()), playerTurns },
    });
    continue;
  }

  if (kind === 'reload') {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    booted = (await waitForBoot()) && booted;
    await page.waitForTimeout(stepDelay);
    steps.push({ action: spec, shot: await capture('reload'), state: await probe() });
    continue;
  }

  if (kind === 'selector') {
    await page.locator(value).click();
    await page.waitForTimeout(stepDelay);
    steps.push({ action: spec, shot: await capture('selector'), state: await probe() });
    continue;
  }

  if (kind === 'nav-selector') {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.locator(value).click(),
    ]);
    booted = (await waitForBoot()) && booted;
    await page.waitForTimeout(stepDelay);
    steps.push({ action: spec, shot: await capture('navigation'), state: await probe() });
    continue;
  }

  if (kind === 'click') {
    const [fx, fy] = value.split('x').map(Number);
    await page.mouse.move(fx * width, fy * height);
    await page.waitForTimeout(120);
    await page.mouse.click(fx * width, fy * height);
    await page.waitForTimeout(stepDelay);
    steps.push({ action: spec, shot: await capture(`click-${fx}-${fy}`), state: await probe() });
    continue;
  }

  if (kind === 'burst') {
    const [n, gap] = value.split('x').map(Number);
    for (let j = 0; j < (n || 8); j++) {
      await page.waitForTimeout(gap || 100);
      const label = activeCastLabel
        ? `${activeCastLabel}-burst${String(j).padStart(2, '0')}`
        : `burst${String(j).padStart(2, '0')}`;
      steps.push({ action: `burst${j}`, shot: await capture(label) });
    }
    continue;
  }

  await page.keyboard.press(value);
  await page.waitForTimeout(stepDelay);
  steps.push({ action: spec, shot: await capture(value), state: await probe() });
}

if (cdpPort > 0) await page.close();
await browser.close();
if (child) child.kill();

const isMissingFavicon = (failedUrl) => {
  try {
    return new URL(failedUrl).pathname === '/favicon.ico';
  } catch {
    return false;
  }
};
const onlyMissingFavicon =
  failedResponses.length + consoleErrors.length > 0 &&
  failedResponses.every(({ url: failedUrl }) => isMissingFavicon(failedUrl)) &&
  consoleErrors.every(({ url: errorUrl }) => isMissingFavicon(errorUrl));
const errors = [
  ...consoleErrors
    .filter(({ message }) => !(
      onlyMissingFavicon &&
      message.startsWith('Failed to load resource:')
    ))
    .map(({ message, url: errorUrl }) => errorUrl ? `${message} (${errorUrl})` : message),
  ...pageErrors,
];
const rejectedCommands = warnings.filter((message) => message.includes('[game] rejected command'));
const report = {
  booted,
  scene,
  outDir,
  steps,
  errors: errors.slice(0, 25),
  ignoredMissingFavicon: onlyMissingFavicon,
  failedResponses: failedResponses.slice(0, 25),
  warnings: warnings.slice(0, 25),
  rejectedCommands: rejectedCommands.slice(0, 25),
  logs: logs.slice(0, 25),
};
const reportJson = JSON.stringify(report, null, 2);
if (reportPath) {
  const absoluteReportPath = resolve(reportPath);
  mkdirSync(dirname(absoluteReportPath), { recursive: true });
  writeFileSync(absoluteReportPath, `${reportJson}\n`);
}
console.log(reportJson);
if (!booted) {
  console.error('WARN: app never signalled ready — frames may be incomplete.');
  process.exit(3);
}
if (errors.length) {
  console.error(`WARN: ${errors.length} console error(s) during play.`);
  process.exit(4);
}
if (rejectedCommands.length) {
  console.error(`WARN: ${rejectedCommands.length} reducer-rejected AI command(s) during play.`);
  process.exit(5);
}
