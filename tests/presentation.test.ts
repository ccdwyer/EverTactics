import { describe, expect, it } from 'vitest';

import {
  BATTLE_INTRO_DURATION_MS,
  BATTLE_OUTCOME_DURATION_MS,
  listenForPresentationSkip,
} from '../src/ui/screens/BattlePresentationScreen';

describe('battle presentation hold', () => {
  it('keeps the intro and outcome beats short', () => {
    expect(BATTLE_INTRO_DURATION_MS).toBe(2_200);
    expect(BATTLE_OUTCOME_DURATION_MS).toBe(2_000);
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
