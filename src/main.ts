/**
 * EverTactics — entry point.
 *
 * Reads `?shot=<scenario>` (the screenshot harness's contract), builds that
 * scenario, and hands control to `state/game.ts`. Everything else lives there;
 * this file exists to own the boot sequence, the failure path, and the handful
 * of globals the tooling looks for.
 *
 * Query parameters:
 *   `?shot=<id>`   build the named scenario and pose it for a screenshot
 *   `?scene=<id>`  same scenario, but play it (no shot mode)
 *   `?debug`       expose `window.__EVERTACTICS__` with the live Game
 */

import { Game } from '@state/game';
import { contentSummary } from '@state/content';
import { DEFAULT_SCENARIO, listScenarios } from '@state/scenarios';

declare global {
  interface Window {
    __EVERTACTICS_READY__?: boolean;
    __EVERTACTICS__?: Game;
  }
}

const params = new URLSearchParams(window.location.search);
const shotScenario = params.get('shot');
const sceneScenario = params.get('scene');
const scenarioId = shotScenario ?? sceneScenario ?? DEFAULT_SCENARIO;
const shotMode = shotScenario !== null;

function hideBootSplash(): void {
  const boot = document.getElementById('boot');
  if (boot) {
    boot.classList.add('hidden');
    window.setTimeout(() => boot.remove(), 800);
  }
}

/**
 * A boot failure must still produce a legible frame. The screenshot harness
 * shoots whatever is on screen when `__EVERTACTICS_READY__` never arrives, so a
 * black rectangle is the worst possible outcome — print the reason instead.
 */
function showFatal(error: unknown): void {
  console.error('[evertactics] boot failed:', error);
  const boot = document.getElementById('boot') ?? document.body;
  boot.classList.remove('hidden');
  boot.setAttribute(
    'style',
    'position:fixed;inset:0;display:grid;place-items:center;background:#0a0608;' +
      'color:#e8b4a0;font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'padding:6vw;text-align:left;white-space:pre-wrap;z-index:1000;letter-spacing:0',
  );
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);
  boot.textContent = `EverTactics failed to start\n\nscenario: ${scenarioId}\n\n${message}`;
}

async function main(): Promise<void> {
  const summary = contentSummary();
  const game = new Game({ scenarioId, shot: shotMode, params });

  console.info(
    `[evertactics] ${game.scenario.name} · ${game.state.units.size} units · ` +
      `${summary.jobs} jobs, ${summary.abilities} abilities, ${summary.items} items · ` +
      `scenarios: ${listScenarios().map((s) => s.id).join(', ')}`,
  );

  if (params.has('debug') || shotMode) window.__EVERTACTICS__ = game;

  await game.boot();
  hideBootSplash();

  // Hand the turn over once the opening frame has converged, so the first thing
  // a player sees is the same composed frame the critic loop grades.
  if (!shotMode) {
    game.stage.onConverged(() => {
      void game.beginTurn();
    });
  }
}

main().catch(showFatal);
