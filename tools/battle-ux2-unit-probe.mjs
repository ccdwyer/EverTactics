/**
 * Measure the rendered team palette rows and the inspected-unit loadout panel.
 *
 * Usage:
 *   node tools/battle-ux2-unit-probe.mjs \
 *     --origin http://localhost:4173 \
 *     --report shots/battle-ux2/units-after.json \
 *     --cdp http://localhost:56250
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
const reportPath = resolve(arg('report', 'shots/battle-ux2/units-after.json'));
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

await page.goto(`${origin}/?shot=battle-open`, {
  waitUntil: 'domcontentloaded',
  timeout: 30_000,
});
await page.waitForFunction(() => window.__EVERTACTICS_READY__ === true, null, {
  timeout: 60_000,
});
await page.waitForTimeout(1_200);

const result = await page.evaluate(() => {
  const game = window.__EVERTACTICS__;
  if (!game) throw new Error('Battle game was not exposed');
  game.stage.stop();
  game.stage.renderOnce(0);

  const paletteRows = [...game.state.units.values()].map((unit) => {
    const sprite = game.sprites.get(unit.id);
    return {
      id: unit.id,
      name: unit.name,
      team: unit.team,
      sheet: unit.sprite.sheet,
      legacyPalette: unit.sprite.palette,
      renderedRow: sprite?.bundle?.uniforms?.uPaletteRow?.value ?? null,
      selectedTeamRow: sprite?.sheet?.slotForTeam(unit.team) ?? null,
    };
  });
  const panel = document.querySelector('.et-hud__right .et-unitinfo');
  const rect = panel?.getBoundingClientRect();
  return {
    paletteRows,
    palettesMatchingTeamSelection: paletteRows.filter(
      (entry) => entry.renderedRow === entry.selectedTeamRow,
    ).length,
    inspectedTeam: panel?.dataset['team'] ?? null,
    equipmentRows: panel?.querySelectorAll('.et-loadout__equipment-row').length ?? 0,
    abilityGroups: panel?.querySelectorAll('.et-loadout__ability-group').length ?? 0,
    statCells: panel?.querySelectorAll('.et-statcell').length ?? 0,
    panelBounds: rect
      ? {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom,
        }
      : null,
    panelText: panel?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  };
});

const report = { ...result, errors, failedResponses };
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (report.palettesMatchingTeamSelection !== report.paletteRows.length) {
  throw new Error('At least one unit did not render with its selected ACT team row');
}
if (report.inspectedTeam !== 'enemy') {
  throw new Error(`Expected the default inspected unit to be enemy, got ${report.inspectedTeam}`);
}
if (report.equipmentRows !== 5 || report.abilityGroups < 4 || report.statCells < 5) {
  throw new Error('Inspected-unit panel is missing loadout or derived-stat rows');
}
if (errors.length > 0 || failedResponses.length > 0) {
  throw new Error('Browser errors were recorded');
}

await context.close();
await browser.close();
