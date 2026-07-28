import type { BattleEvent } from '@core/types';
import {
  playBattle,
  type BattleSound,
  type BattleSoundOptions,
} from './audio';

export type BattleEventAudioPolicy = 'audible' | 'silent';

/**
 * Runtime mirror of the BattleEvent contract. The Record is deliberate: adding
 * an event variant without deciding its audio policy fails typecheck.
 */
export const BATTLE_EVENT_AUDIO_POLICY = {
  moved: 'audible',
  faced: 'silent',
  'cast-start': 'audible',
  'cast-fire': 'audible',
  damage: 'audible',
  heal: 'audible',
  miss: 'audible',
  'status-add': 'silent',
  'status-remove': 'silent',
  knockdown: 'audible',
  crystal: 'silent',
  jp: 'silent',
  exp: 'silent',
  levelup: 'silent',
  reaction: 'audible',
  'turn-order-changed': 'silent',
} as const satisfies Record<BattleEvent['kind'], BattleEventAudioPolicy>;

export interface BattleAudioContext {
  maxHp?: number;
  /** Presentation classification supplied from authored ability metadata. */
  abilitySound?: 'swing' | 'cast';
  /** Suppress a provisional KO when the same event batch carries an attributed one. */
  suppressKnockdown?: boolean;
}

export interface BattleAudioCue {
  sound: BattleSound;
  options?: BattleSoundOptions;
}

export type BattleSoundPlayer = (
  sound: BattleSound,
  opts?: BattleSoundOptions,
) => void;

const STEP_SECONDS = 1 / 4.2;

function severity(amount: number, maxHp: number | undefined): number {
  if (maxHp === undefined || maxHp <= 0) return 0.35;
  return Math.max(0, Math.min(1, amount / maxHp));
}

/** Pure event-to-cue mapping. It can be imported and exercised without a browser. */
export function battleAudioCues(
  event: BattleEvent,
  context: BattleAudioContext = {},
): readonly BattleAudioCue[] {
  switch (event.kind) {
    case 'moved':
      return Array.from({ length: Math.max(0, event.path.length - 1) }, (_, index) => ({
        sound: 'step' as const,
        options: { delay: index * STEP_SECONDS },
      }));
    case 'cast-start':
      return [{ sound: 'cast' }];
    case 'cast-fire':
      return [{ sound: context.abilitySound ?? 'swing' }];
    case 'damage': {
      const options = { severity: severity(event.amount, context.maxHp) };
      return event.crit
        ? [{ sound: 'hit', options }, { sound: 'crit', options }]
        : [{ sound: 'hit', options }];
    }
    case 'heal':
      return [{
        sound: 'heal',
        options: { severity: severity(event.amount, context.maxHp) },
      }];
    case 'miss':
      return [{ sound: 'miss' }];
    case 'knockdown':
      return context.suppressKnockdown ? [] : [{ sound: 'ko' }];
    case 'reaction':
      return [{ sound: 'counter' }];
    case 'faced':
    case 'status-add':
    case 'status-remove':
    case 'crystal':
    case 'jp':
    case 'exp':
    case 'levelup':
    case 'turn-order-changed':
      return [];
  }
}

export type BattleAudioObserver = (
  event: BattleEvent,
  context?: BattleAudioContext,
) => void;

/** Build the one observer subscribed to the renderer's BattleEvent stream. */
export function createBattleAudioObserver(
  output: BattleSoundPlayer = playBattle,
): BattleAudioObserver {
  return (event, context = {}) => {
    for (const cue of battleAudioCues(event, context)) {
      output(cue.sound, cue.options);
    }
  };
}
