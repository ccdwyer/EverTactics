/**
 * Capture a stopped movement-range frame and an identical no-overlay control,
 * then measure the same reachable-tile centre patches in both images.
 *
 * Usage:
 *   node tools/battle-ux2-move-probe.mjs \
 *     --origin http://localhost:4173 \
 *     --highlighted shots/battle-ux2/02-move-range-before.png \
 *     --control shots/battle-ux2/02-move-range-before-control.png \
 *     --report shots/battle-ux2/02-move-range-before.json
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
const highlightedPath = resolve(
  arg('highlighted', 'shots/battle-ux2/02-move-range.png'),
);
const controlPath = resolve(
  arg('control', 'shots/battle-ux2/02-move-range-control.png'),
);
const reportPath = resolve(
  arg('report', 'shots/battle-ux2/02-move-range.json'),
);
const width = Number(arg('width', '1600'));
const height = Number(arg('height', '900'));
const radius = Number(arg('radius', '10'));
const cdpEndpoint = arg(
  'cdp',
  process.env.EVERTACTICS_CDP_ENDPOINT ?? '',
);

for (const path of [highlightedPath, controlPath, reportPath]) {
  mkdirSync(dirname(path), { recursive: true });
}

const browser = cdpEndpoint
  ? await chromium.connectOverCDP(cdpEndpoint)
  : await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width, height },
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

await page.goto(`${origin}/?shot=battle-open`, {
  waitUntil: 'domcontentloaded',
  timeout: 30_000,
});
await page.waitForFunction(() => window.__EVERTACTICS_READY__ === true, null, {
  timeout: 60_000,
});
await page.waitForFunction(
  () => {
    const boot = document.getElementById('boot');
    if (boot === null) return true;
    const style = getComputedStyle(boot);
    return style.display === 'none' || Number(style.opacity) < 0.02;
  },
  null,
  { timeout: 60_000 },
);
await page.waitForTimeout(1_500);

await page.locator(".et-command__row[data-index='0']").click();
await page.waitForFunction(() => window.__EVERTACTICS__?.mode.kind === 'move');
await page.waitForTimeout(350);

const pose = await page.evaluate(() => {
  const game = window.__EVERTACTICS__;
  if (!game || !game.terrain || game.mode.kind !== 'move') {
    throw new Error('Move mode did not expose a live terrain range');
  }

  game.stage.stop();
  game.terrain.elapsed = 0;
  for (let index = 0; index < 8; index += 1) game.stage.renderOnce(0);

  const occupied = new Set(
    [...game.state.units.values()]
      .filter((unit) => !unit.removed)
      .map((unit) => `${unit.pos.x},${unit.pos.y}`),
  );
  const canvas = game.stage.canvas;
  const points = [...game.mode.reach.values()]
    .map((node) => {
      const point = game.camera.worldToScreen(game.worldOf(node.pos), game.screen);
      const picked = game.camera.screenToTile(
        point.x,
        point.y,
        game.state.field,
      );
      const topInteractive = document.elementsFromPoint(point.x, point.y)
        .find((element) => getComputedStyle(element).pointerEvents !== 'none');
      return {
        tile: `${node.pos.x},${node.pos.y},${node.pos.z}`,
        x: point.x,
        y: point.y,
        visible: point.visible,
        occupied: occupied.has(`${node.pos.x},${node.pos.y}`),
        resolvesToTile:
          picked?.x === node.pos.x
          && picked?.y === node.pos.y,
        canvasVisible: topInteractive === canvas,
      };
    })
    .filter(
      (point) =>
        point.visible
        && !point.occupied
        && point.resolvesToTile
        && point.canvasVisible
        && point.x >= 24
        && point.y >= 24
        && point.x < window.innerWidth - 24
        && point.y < window.innerHeight - 24,
    );

  return {
    points,
    reachableTiles: game.mode.reach.size,
    active: game.state.active,
    activeName: game.state.active === undefined
      ? null
      : game.state.units.get(game.state.active)?.name ?? null,
    camera: {
      focus: game.camera.focusPoint.toArray(),
      pixelScale: game.camera.devicePixelsPerTexel,
      yawIndex: game.camera.yawIndex,
    },
  };
});

if (pose.activeName !== 'Aldric') {
  throw new Error(`Expected Aldric active, got ${pose.activeName ?? 'none'}`);
}
if (pose.reachableTiles !== 15) {
  throw new Error(`Expected 15 reachable tiles, got ${pose.reachableTiles}`);
}
if (pose.points.length === 0) {
  throw new Error('No unobscured reachable tile centres were available to sample');
}

const highlightedBuffer = await page.screenshot({
  path: highlightedPath,
  type: 'png',
});

await page.evaluate(() => {
  const game = window.__EVERTACTICS__;
  game?.terrain?.clearHighlights('move');
  for (let index = 0; index < 8; index += 1) game?.stage.renderOnce(0);
});
const controlBuffer = await page.screenshot({
  path: controlPath,
  type: 'png',
});

const measurements = await page.evaluate(
  async ({ highlighted, control, points, radius: sampleRadius }) => {
    async function pixels(base64) {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('2D canvas unavailable');
      ctx.drawImage(image, 0, 0);
      return {
        width: canvas.width,
        height: canvas.height,
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      };
    }

    function sample(image, point) {
      let saturation = 0;
      let luminance = 0;
      let count = 0;
      const cx = Math.round(point.x);
      const cy = Math.round(point.y);
      for (let y = cy - sampleRadius; y <= cy + sampleRadius; y += 1) {
        for (let x = cx - sampleRadius; x <= cx + sampleRadius; x += 1) {
          const dx = x - cx;
          const dy = y - cy;
          if (dx * dx + dy * dy > sampleRadius * sampleRadius) continue;
          if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
          const offset = (y * image.width + x) * 4;
          const r = image.data[offset] ?? 0;
          const g = image.data[offset + 1] ?? 0;
          const b = image.data[offset + 2] ?? 0;
          const maximum = Math.max(r, g, b);
          const minimum = Math.min(r, g, b);
          saturation += maximum === 0 ? 0 : (maximum - minimum) / maximum;
          luminance += 0.2126 * r + 0.7152 * g + 0.0722 * b;
          count += 1;
        }
      }
      return {
        saturation: count === 0 ? 0 : saturation / count,
        luminance: count === 0 ? 0 : luminance / count,
        pixels: count,
      };
    }

    const [highlightedImage, controlImage] = await Promise.all([
      pixels(highlighted),
      pixels(control),
    ]);
    const tiles = points.map((point) => ({
      tile: point.tile,
      screen: { x: point.x, y: point.y },
      highlighted: sample(highlightedImage, point),
      control: sample(controlImage, point),
    }));
    const mean = (key, field) =>
      tiles.reduce((sum, tile) => sum + tile[key][field], 0) / Math.max(1, tiles.length);
    const highlightedMeanSaturation = mean('highlighted', 'saturation');
    const controlMeanSaturation = mean('control', 'saturation');
    const highlightedMeanLuminance = mean('highlighted', 'luminance');
    const controlMeanLuminance = mean('control', 'luminance');

    return {
      sampleRadius,
      sampledTiles: tiles.length,
      highlighted: {
        meanSaturation: highlightedMeanSaturation,
        meanLuminance: highlightedMeanLuminance,
      },
      control: {
        meanSaturation: controlMeanSaturation,
        meanLuminance: controlMeanLuminance,
      },
      delta: {
        meanSaturation: highlightedMeanSaturation - controlMeanSaturation,
        meanLuminance: highlightedMeanLuminance - controlMeanLuminance,
      },
      tiles,
    };
  },
  {
    highlighted: highlightedBuffer.toString('base64'),
    control: controlBuffer.toString('base64'),
    points: pose.points,
    radius,
  },
);

await browser.close();

const round = (value) => Math.round(value * 1_000) / 1_000;
const report = {
  origin,
  highlighted: highlightedPath,
  control: controlPath,
  formula: {
    saturation: '(maxRGB - minRGB) / maxRGB',
    luminance: '0.2126R + 0.7152G + 0.0722B',
  },
  pose,
  measurements: {
    ...measurements,
    highlighted: {
      meanSaturation: round(measurements.highlighted.meanSaturation),
      meanLuminance: round(measurements.highlighted.meanLuminance),
    },
    control: {
      meanSaturation: round(measurements.control.meanSaturation),
      meanLuminance: round(measurements.control.meanLuminance),
    },
    delta: {
      meanSaturation: round(measurements.delta.meanSaturation),
      meanLuminance: round(measurements.delta.meanLuminance),
    },
  },
  errors,
  failedResponses,
};

writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (errors.length > 0 || failedResponses.length > 0) {
  throw new Error(
    `Capture reported ${errors.length} errors and ${failedResponses.length} failed responses`,
  );
}
console.log(
  JSON.stringify(
    {
      highlighted: report.highlighted,
      control: report.control,
      reachableTiles: pose.reachableTiles,
      sampledTiles: measurements.sampledTiles,
      measurements: report.measurements,
      errors,
      failedResponses,
    },
    null,
    2,
  ),
);
