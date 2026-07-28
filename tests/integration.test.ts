/**
 * Whole-system integration.
 *
 * The unit suites prove each system is correct in isolation. This file proves they are actually
 * WIRED TOGETHER — the failure mode where a subsystem is fully implemented, fully tested, and
 * never called by anything. Reaction abilities shipped in exactly that state once: `rollReaction`
 * existed, passed its tests, and no code path invoked it.
 *
 * Every assertion here is about emergent behaviour in a real battle, not about a function.
 */
import { describe, it, expect } from 'vitest';
import type { BattleEvent } from '../src/core/types';
import { runAiBattle as battle } from './helpers/aiBattle';

const kindsOf = (events: BattleEvent[]) => new Set(events.map((e) => e.kind));

describe('systems are wired into real battles', () => {
  it('reaction abilities actually trigger during play', () => {
    // Across several seeds so this does not hinge on one lucky Brave roll.
    const fired: Record<string, number> = {};
    let total = 0;

    for (const seed of [1234, 99, 7, 4321, 555]) {
      for (const e of battle(seed).events) {
        if (e.kind !== 'reaction') continue;
        total++;
        const ability = (e as { ability?: string }).ability ?? 'unknown';
        fired[ability] = (fired[ability] ?? 0) + 1;
      }
    }

    expect(total, 'no reaction ever fired in five full battles').toBeGreaterThan(0);
    // More than one KIND, or the trigger is hardcoded to a single ability.
    expect(Object.keys(fired).length).toBeGreaterThan(1);
  });

  it('reaction events carry enough data to render them', () => {
    const events = battle(1234).events;
    const reaction = events.find((e) => e.kind === 'reaction') as
      | { kind: string; unit?: string; ability?: string; source?: string }
      | undefined;

    expect(reaction, 'expected at least one reaction in this seeded battle').toBeDefined();
    expect(reaction!.unit, 'reaction must name the reacting unit').toBeTruthy();
    expect(reaction!.ability, 'reaction must name which ability fired').toBeTruthy();
  });

  it('reaction chains terminate — a battle with reactions still ends', () => {
    const { state, turns } = battle(1234);
    expect(turns).toBeLessThan(400);
    expect(['victory', 'defeat']).toContain(state.phase);
  });

  it('stays deterministic with reactions live', () => {
    const a = battle(1234);
    const b = battle(1234);
    expect(a.turns).toBe(b.turns);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it('exercises the full combat vocabulary in one battle', () => {
    // If any of these never appears, some system is implemented but unreachable.
    const kinds = kindsOf(battle(1234).events);
    for (const required of ['moved', 'damage', 'knockdown', 'jp', 'exp', 'reaction']) {
      expect(kinds, `no "${required}" event in a full battle`).toContain(required);
    }
  });

  it('resolves both shipped maps', () => {
    for (const map of ['battle-open', 'mandalia-ford']) {
      const { state, turns } = battle(2468, map);
      expect(turns, `${map} hit the turn cap`).toBeLessThan(400);
      expect(['victory', 'defeat'], `${map} did not resolve`).toContain(state.phase);
    }
  });

  it(
    'accepts every AI command across eight seeds on both shipped maps',
    () => {
      const seedsByMap = {
        'battle-open': [8, 12, 5, 3, 1, 13, 777, 1234],
        'mandalia-ford': [5, 6, 4321, 2, 1234, 20260727, 2468, 11],
      } as const;
      let battles = 0;
      let commands = 0;
      let rejectedCommands = 0;

      for (const [map, seeds] of Object.entries(seedsByMap)) {
        for (const seed of seeds) {
          const result = battle(seed, map, true, 400, false);
          expect(result.turns, `${map} seed ${seed} hit the turn cap`).toBeLessThan(400);
          expect(['victory', 'defeat'], `${map} seed ${seed} did not resolve`).toContain(
            result.state.phase,
          );
          battles++;
          commands += result.commands;
          rejectedCommands += result.rejectedCommands;
        }
      }

      console.info(
        `[integration] AI command sweep: battles=${battles}, commands=${commands}, ` +
          `rejected=${rejectedCommands}`,
      );
      expect(battles).toBe(16);
      expect(commands).toBeGreaterThan(0);
      expect(rejectedCommands).toBe(0);
    },
    30_000,
  );
});
