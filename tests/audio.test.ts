import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BATTLE_EVENT_AUDIO_POLICY,
  battleAudioCues,
  createBattleAudioObserver,
} from '../src/ui/battleAudio';
import {
  BATTLE_VOICE_CAP,
  BattleVoiceLimiter,
  battlePitchDetune,
  battleSoundProfile,
  type BattleSound,
} from '../src/ui/audio';
import { runAiBattle } from './helpers/aiBattle';

function battleEventKindsFromEngine(): string[] {
  const source = readFileSync(new URL('../src/core/types.ts', import.meta.url), 'utf8');
  const block = /export type BattleEvent =([\s\S]*?)\n\n\/\/ ─+/.exec(source)?.[1];
  if (!block) throw new Error('BattleEvent union not found in src/core/types.ts');
  return [...block.matchAll(/kind:\s*'([^']+)'/g)].map((match) => match[1]!);
}

describe('battle audio event observer', () => {
  it('classifies every battle event as audible or explicitly silent', () => {
    expect(Object.keys(BATTLE_EVENT_AUDIO_POLICY).sort()).toEqual(
      battleEventKindsFromEngine().sort(),
    );
    expect(new Set(Object.values(BATTLE_EVENT_AUDIO_POLICY))).toEqual(
      new Set(['audible', 'silent']),
    );
  });

  it('turns damage fraction into measurably different hit parameters', () => {
    const small = battleAudioCues(
      { kind: 'damage', unit: 'target', amount: 8, element: 'none', crit: false },
      { maxHp: 100 },
    );
    const large = battleAudioCues(
      { kind: 'damage', unit: 'target', amount: 80, element: 'none', crit: false },
      { maxHp: 100 },
    );

    expect(small).toHaveLength(1);
    expect(large).toHaveLength(1);

    const smallProfile = battleSoundProfile('hit', small[0]?.options);
    const largeProfile = battleSoundProfile('hit', large[0]?.options);
    expect(largeProfile.brightness).toBeGreaterThan(smallProfile.brightness);
    expect(largeProfile.decay).toBeGreaterThan(smallProfile.decay);
  });

  it('jitter gives every battle sound a bounded pitch range', () => {
    const sounds: readonly BattleSound[] = [
      'step',
      'swing',
      'hit',
      'crit',
      'miss',
      'heal',
      'cast',
      'ko',
      'counter',
    ];
    for (const sound of sounds) {
      const low = battlePitchDetune(sound, 0);
      const high = battlePitchDetune(sound, 1);
      expect(low, sound).toBeLessThan(0);
      expect(high, sound).toBeGreaterThan(0);
      expect(high - low, sound).toBeLessThanOrEqual(48);
    }
  });

  it('drops the ninth overlapping battle voice but accepts later cues', () => {
    const limiter = new BattleVoiceLimiter();
    const accepted = Array.from(
      { length: BATTLE_VOICE_CAP },
      () => limiter.reserve(0, 0.5),
    );
    expect(accepted.filter(Boolean)).toHaveLength(8);
    expect(limiter.reserve(0.1, 0.4)).toBe(false);
    expect(limiter.reserve(0.5, 0.7)).toBe(true);
  });

  it('imports and observes events under node without an AudioContext', () => {
    expect(typeof globalThis.AudioContext).toBe('undefined');
    const observe = createBattleAudioObserver();
    expect(() => {
      observe(
        { kind: 'damage', unit: 'target', amount: 12, element: 'none', crit: false },
        { maxHp: 80 },
      );
    }).not.toThrow();
  });

  it('does not perturb a seeded battle event stream when attached', () => {
    const baseline = runAiBattle(1234);
    const observe = createBattleAudioObserver();
    const observed = runAiBattle(1234, 'battle-open', false, 400, true, (events, state) => {
      for (const event of events) {
        const unit = 'unit' in event ? state.units.get(event.unit) : undefined;
        observe(event, { maxHp: unit?.stats.maxHp });
      }
    });

    expect(observed.turns).toBe(baseline.turns);
    expect(JSON.stringify(observed.events)).toBe(JSON.stringify(baseline.events));
  });
});
