/**
 * Public surface of the UI layer.
 *
 * The game layer should only need `UIRoot` plus the view-model types:
 *
 *   const ui = new UIRoot(document.getElementById('ui')!);
 *   ui.on((intent) => dispatch(intent));
 *   ui.setTurnOrder(order);
 *   ui.showCommandMenu(commands);
 *
 * Nothing under `src/ui` imports three.js, and nothing here touches BattleState.
 */

export { UIRoot } from './UIRoot';
export type { BannerTone, HintDef } from './components/Banner';
export { play as playUISound, setSoundEnabled, setVolume } from './audio';
export {
  portrait,
  portraitFiles,
  portraitForId,
  portraitUrl,
  setPortraitBase,
} from './portraits';
export { PORTRAIT_ATLAS, PORTRAIT_FILES } from './portraitCatalog';
export { icon, hasIcon, statusTone, elementColor } from './icons';
export type * from './types';
