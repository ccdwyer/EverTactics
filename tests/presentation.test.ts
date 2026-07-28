import { describe, expect, it } from 'vitest';

import { OUTCOME_STING_PROFILES } from '../src/ui/audio';
import {
  BATTLE_DEFEAT_OUTCOME_DURATION_MS,
  BATTLE_INTRO_DURATION_MS,
  BATTLE_VICTORY_OUTCOME_DURATION_MS,
  battleOutcomeDurationMs,
  listenForPresentationSkip,
} from '../src/ui/screens/BattlePresentationScreen';

describe('battle presentation hold', () => {
  it('keeps the intro and outcome beats short', () => {
    expect(BATTLE_INTRO_DURATION_MS).toBe(2_200);
    expect(BATTLE_VICTORY_OUTCOME_DURATION_MS).toBe(2_800);
    expect(BATTLE_DEFEAT_OUTCOME_DURATION_MS).toBe(2_200);
    expect(battleOutcomeDurationMs('victory')).toBeGreaterThan(
      battleOutcomeDurationMs('defeat'),
    );
    expect(BATTLE_VICTORY_OUTCOME_DURATION_MS).toBeGreaterThan(
      OUTCOME_STING_PROFILES.victory.duration * 1_000,
    );
    expect(BATTLE_DEFEAT_OUTCOME_DURATION_MS).toBeGreaterThan(
      OUTCOME_STING_PROFILES.defeat.duration * 1_000,
    );
  });

  it.each(['keydown', 'pointerdown', 'wheel'])('skips and consumes %s input', (kind) => {
    const target = new EventTarget();
    let skips = 0;
    const stop = listenForPresentationSkip(target, () => {
      skips++;
    });
    const event = new Event(kind, { cancelable: true });

    target.dispatchEvent(event);
    expect(skips).toBe(1);
    expect(event.defaultPrevented).toBe(true);

    stop();
    target.dispatchEvent(new Event(kind, { cancelable: true }));
    expect(skips).toBe(1);
  });
});
