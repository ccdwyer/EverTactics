import type { UISound } from './audio';
import type { UIIntent } from './types';

export type UIIntentAudioSource =
  | 'interaction'
  | 'state-result'
  | 'interaction-and-state'
  | 'none';

export type UIIntentAudioPolicy =
  | {
      sounds: readonly [UISound, ...UISound[]];
      source: Exclude<UIIntentAudioSource, 'none'>;
      reason: string;
      /** A conditional path that is intentionally silent even though other paths are audible. */
      silentReason?: string;
    }
  | {
      sounds: readonly [];
      source: 'none';
      reason: string;
      silentReason: string;
    };

/**
 * Total audit of player-facing UI intent audio.
 *
 * This is deliberately descriptive, not an auto-play dispatcher. Interaction
 * components already own cursor/confirm timing, while result-dependent actions
 * such as purchases must wait for the state layer to choose confirm or error.
 * Auto-playing this table would duplicate those cues.
 */
export const UI_INTENT_AUDIO_POLICY = {
  'title-new-game': {
    sounds: ['confirm', 'open'],
    source: 'interaction-and-state',
    reason: 'The title choice confirms, then a successful campaign opens the world map.',
  },
  'title-continue': {
    sounds: ['confirm', 'open', 'error'],
    source: 'interaction-and-state',
    reason: 'The title choice confirms; routing opens the map or reports a stale save.',
  },
  command: {
    sounds: ['confirm'],
    source: 'interaction',
    reason: 'The battle command list confirms before emitting the chosen row.',
  },
  ability: {
    sounds: ['confirm'],
    source: 'interaction',
    reason: 'The ability list confirms before entering target selection.',
  },
  item: {
    sounds: [],
    source: 'none',
    reason: 'The contract retains this battle-item variant for command routing.',
    silentReason: 'No current UI component emits item; the Item command uses ability rows.',
  },
  'ability-highlight': {
    sounds: ['cursor'],
    source: 'interaction',
    reason: 'Player list navigation supplies the cursor tick.',
    silentReason: 'Initial programmatic selection is silent so opening a menu does not double-chime.',
  },
  'command-highlight': {
    sounds: ['cursor'],
    source: 'interaction',
    reason: 'Player list navigation supplies the cursor tick.',
    silentReason: 'Initial programmatic selection is silent so opening a menu does not double-chime.',
  },
  cancel: {
    sounds: ['cancel'],
    source: 'interaction',
    reason: 'Menu and field-level back actions share the same low cancel cue.',
  },
  'inspect-unit': {
    sounds: [],
    source: 'none',
    reason: 'Turn-order inspection is passive presentation.',
    silentReason: 'Hover can emit repeatedly and camera focus already supplies visual feedback.',
  },
  camera: {
    sounds: [],
    source: 'none',
    reason: 'Camera changes are continuous presentation controls.',
    silentReason: 'Repeated rotation and zoom should not produce menu chatter.',
  },
  'set-job': {
    sounds: ['confirm', 'error'],
    source: 'interaction-and-state',
    reason: 'The chosen job confirms, then campaign mutation confirms or refuses it.',
  },
  'inspect-job': {
    sounds: ['cursor'],
    source: 'interaction',
    reason: 'Keyboard tree navigation supplies the cursor tick.',
    silentReason: 'Pointer hover is deliberately silent because it can emit across several nodes.',
  },
  'learn-ability': {
    sounds: ['confirm', 'error'],
    source: 'interaction-and-state',
    reason: 'The list confirms selection and campaign mutation reports success or refusal.',
  },
  'assign-slot': {
    sounds: ['cursor', 'confirm', 'error'],
    source: 'interaction-and-state',
    reason: 'Loadout cycling acknowledges selection and campaign mutation reports its result.',
  },
  'formation-assign': {
    sounds: ['confirm', 'cancel', 'error'],
    source: 'interaction-and-state',
    reason: 'Placing, clearing, and refused deployment edits have distinct feedback.',
  },
  'formation-confirm': {
    sounds: ['confirm', 'error', 'close'],
    source: 'interaction-and-state',
    reason: 'Deploy confirms or refuses in state, then closes the slate on success.',
  },
  'world-node-select': {
    sounds: ['confirm', 'error', 'open'],
    source: 'interaction-and-state',
    reason: 'Travel confirms or refuses, and valid destinations open their next screen.',
  },
  'world-open-jobs': {
    sounds: ['confirm', 'close', 'open'],
    source: 'interaction',
    reason: 'The map action confirms while the world screen gives way to the job screen.',
  },
  'world-open-roster': {
    sounds: ['confirm', 'close', 'open'],
    source: 'interaction',
    reason: 'The map action confirms while the world screen gives way to the roster.',
  },
  'shop-buy': {
    sounds: ['confirm', 'error'],
    source: 'interaction-and-state',
    reason: 'Affordable selection confirms; the campaign reports purchase success or refusal.',
  },
  'shop-sell': {
    sounds: ['confirm', 'error'],
    source: 'interaction-and-state',
    reason: 'Selection confirms and the campaign reports sale success or refusal.',
  },
  'open-job-screen': {
    sounds: ['confirm', 'error', 'close', 'open'],
    source: 'interaction-and-state',
    reason: 'Roster selection confirms, validates the unit, and transitions screens.',
  },
  'equip-item': {
    sounds: ['confirm', 'error'],
    source: 'interaction-and-state',
    reason: 'Inventory selection confirms and campaign mutation reports its result.',
  },
  'unequip-item': {
    sounds: ['confirm', 'error'],
    source: 'interaction-and-state',
    reason: 'Equipment selection confirms and campaign mutation reports its result.',
  },
  'rename-unit': {
    sounds: ['confirm', 'error'],
    source: 'state-result',
    reason: 'Accepted prompt input is acknowledged only after campaign validation.',
  },
  'dismiss-unit': {
    sounds: ['confirm', 'error'],
    source: 'state-result',
    reason: 'Accepted dismissal is acknowledged only after campaign validation.',
  },
  'close-screen': {
    sounds: ['cancel', 'close'],
    source: 'interaction',
    reason: 'The close action acknowledges Back, then the screen supplies its exit cue.',
  },
  'result-dismiss': {
    sounds: ['confirm', 'close', 'open'],
    source: 'interaction-and-state',
    reason: 'Results confirm and close before the campaign map opens.',
  },
} as const satisfies Record<UIIntent['kind'], UIIntentAudioPolicy>;
