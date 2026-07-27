/**
 * UI preview harness.
 *
 * Runs the whole interface against sample view-models with no engine attached —
 * `npm run dev`, then open /src/ui/dev/preview.html. It is also what the visual
 * review pass screenshots. Nothing outside src/ui is imported.
 */

import { UIRoot } from '../UIRoot';
import type { UIIntent } from '../types';
import {
  ABILITIES,
  AGRIAS,
  COMMANDS,
  FORMATION,
  JOB_SCREEN,
  RAMZA,
  RESULT,
  ROSTER_SCREEN,
  TARGET,
  TURN_ORDER,
  WIZARD,
} from './demoData';

const mount = document.getElementById('ui');
if (!mount) throw new Error('preview: #ui mount is missing');

const ui = new UIRoot(mount, { portraitBase: '/assets/portraits/' });

ui.setTurnOrder(TURN_ORDER);
ui.setActiveUnit(RAMZA);
ui.setInspectedUnit(WIZARD);
ui.showCommandMenu(COMMANDS);
ui.setTargetPreview(TARGET);
ui.banner('Battle Start', { subtitle: 'Orbonne Monastery', tone: 'player', duration: 2600 });

ui.on((intent: UIIntent) => {
  // eslint-disable-next-line no-console -- the harness exists to observe intents
  console.log('[intent]', intent);
  switch (intent.kind) {
    case 'command':
      if (intent.id === 'act' || intent.id === 'item') {
        ui.showAbilityMenu(ABILITIES, { title: intent.id === 'item' ? 'Items' : 'Guts', mp: RAMZA.mp, maxMp: RAMZA.maxMp });
      } else if (intent.id === 'wait') {
        ui.closeMenus();
        ui.banner('Turn End', { tone: 'neutral', duration: 1200 });
        window.setTimeout(() => ui.showCommandMenu(COMMANDS), 1400);
      }
      break;
    case 'ability':
      ui.hideAbilityMenu();
      demoHit();
      break;
    case 'cancel':
      ui.hideAbilityMenu();
      break;
    case 'inspect-unit': {
      const unit = [RAMZA, AGRIAS, WIZARD].find((u) => u.id === intent.unitId);
      if (unit) ui.setInspectedUnit(unit);
      break;
    }
    case 'inspect-job':
      ui.updateJobScreen({ ...JOB_SCREEN, selectedJob: intent.jobId });
      break;
    case 'close-screen':
    case 'result-dismiss':
      ui.closeScreen();
      break;
    default:
      break;
  }
});

/** A representative damage burst so the floating text can be judged in motion. */
function demoHit(): void {
  const x = window.innerWidth * 0.52;
  const y = window.innerHeight * 0.42;
  ui.floatBurst([
    { kind: 'damage', value: 62, element: 'fire', x, y },
    { kind: 'crit', value: 118, element: 'fire', x: x + 30, y: y - 14 },
    { kind: 'status', text: 'Burning', x: x + 10, y: y + 22 },
    { kind: 'miss', x: x - 78, y: y + 6 },
    { kind: 'heal', value: 44, x: x - 150, y: y - 8 },
    { kind: 'jp', value: 32, x: x + 96, y: y + 40 },
  ], 220);
  const hurt = { ...WIZARD, hp: Math.max(0, WIZARD.hp - 62) };
  ui.setInspectedUnit(hurt);
}

// Screen shortcuts — digits are not bound by the UI's own key map.
window.addEventListener('keydown', (ev) => {
  switch (ev.key) {
    case '1': ui.openJobScreen(JOB_SCREEN); break;
    case '2': ui.openFormationScreen(FORMATION); break;
    case '3': ui.openRosterScreen(ROSTER_SCREEN); break;
    case '4': ui.showResult(RESULT); break;
    case '5': demoHit(); break;
    case '0': ui.closeScreen(); break;
    default: break;
  }
});

// The headless screenshot runner waits on this flag.
declare global {
  interface Window {
    __EVERTACTICS_READY__?: boolean;
    __ET_UI__?: UIRoot;
  }
}
window.__ET_UI__ = ui;
requestAnimationFrame(() => {
  window.__EVERTACTICS_READY__ = true;
});
