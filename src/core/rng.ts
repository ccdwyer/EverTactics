/**
 * EverTactics — deterministic random number generation.
 *
 * Every random decision in `core/` goes through this module. `Math.random()` is
 * banned in core because a battle must replay bit-for-bit from `(seed, commands)`.
 *
 * The generator is **mulberry32**: a 32-bit-state PRNG with a full 2^32 period,
 * excellent avalanche for its size, and — crucially for us — a state that is a
 * single `number`, which is exactly what `BattleState.rngState` and the `Rng`
 * contract in `types.ts` can carry.
 *
 * Determinism contract
 * --------------------
 * - `next()` is the only primitive that advances the stream. `int()` and
 *   `chance()` each consume **exactly one** `next()`, unconditionally.
 *   They never short-circuit — `chance(0)` still burns a roll — so the stream
 *   position depends only on the *sequence of calls*, never on stat-derived
 *   values. That is what makes replay robust when a formula is retuned.
 * - `state()` returns the value you pass to `restoreRng()` to resume the exact
 *   same stream.
 */

import type { Rng } from './types';

/** Number of distinct values a 32-bit state can take. */
const TWO_POW_32 = 4294967296;

/** mulberry32's increment constant. */
const MULBERRY_INC = 0x6d2b79f5;

/**
 * Avalanche a user-supplied seed so that adjacent seeds (1, 2, 3 …) produce
 * completely unrelated streams. Only applied by `createRng`; `restoreRng`
 * deliberately skips it because a saved state is already mixed.
 */
export function mixSeed(seed: number): number {
  let h = Number.isFinite(seed) ? Math.trunc(seed) | 0 : 0;
  h = Math.imul(h ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** FNV-1a over a string — handy for seeding a battle from a scenario id. */
export function seedFromString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Internal factory: builds an Rng over an already-mixed 32-bit state. */
function makeRng(initialState: number): Rng {
  let s = initialState >>> 0;

  const next = (): number => {
    s = (s + MULBERRY_INC) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / TWO_POW_32;
  };

  return {
    next,
    int(n: number): number {
      const r = next();
      if (!Number.isFinite(n) || n <= 1) return 0;
      const v = Math.floor(r * n);
      // Guard against the float landing exactly on n through rounding.
      return v >= n ? n - 1 : v;
    },
    chance(percent: number): boolean {
      const r = next();
      if (!Number.isFinite(percent)) return false;
      return r * 100 < percent;
    },
    state(): number {
      return s >>> 0;
    },
  };
}

/**
 * Create a fresh generator from a human-meaningful seed (a battle id, a level
 * number, `Date.now()` at the start of a run — anything). The seed is mixed, so
 * `createRng(1)` and `createRng(2)` are uncorrelated.
 */
export function createRng(seed: number): Rng {
  return makeRng(mixSeed(seed));
}

/**
 * Resume a generator from a value previously returned by `Rng.state()`.
 * `restoreRng(r.state())` produces a generator that yields exactly the values
 * `r` would have yielded next — this is the battle-replay / save-load path.
 */
export function restoreRng(state: number): Rng {
  return makeRng(state >>> 0);
}

/**
 * Fork a child generator that is deterministically derived from `parent`'s
 * current state plus a label. Used when a subsystem (AI scoring, cosmetic VFX
 * jitter) wants randomness that must not perturb the combat stream.
 * Consumes nothing from the parent.
 */
export function forkRng(parent: Rng, label: string): Rng {
  return makeRng(mixSeed(parent.state() ^ seedFromString(label)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience helpers — all consume from the given Rng, all deterministic.
// ─────────────────────────────────────────────────────────────────────────────

/** Integer in `[min, max]`, inclusive on both ends. */
export function rangeInt(rng: Rng, min: number, max: number): number {
  if (max <= min) {
    rng.next();
    return min;
  }
  return min + rng.int(max - min + 1);
}

/** Float in `[min, max)`. */
export function rangeFloat(rng: Rng, min: number, max: number): number {
  return min + rng.next() * (max - min);
}

/** Uniform choice from a non-empty array. Returns `undefined` for an empty one. */
export function pick<T>(rng: Rng, items: readonly T[]): T | undefined {
  if (items.length === 0) {
    rng.next();
    return undefined;
  }
  return items[rng.int(items.length)];
}

/**
 * Weighted choice. `weights[i]` is the relative weight of `items[i]`.
 * Non-positive weights are treated as zero. Consumes exactly one roll.
 */
export function pickWeighted<T>(
  rng: Rng,
  items: readonly T[],
  weights: readonly number[],
): T | undefined {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const w = weights[i];
    if (w !== undefined && w > 0) total += w;
  }
  const roll = rng.next() * total;
  if (total <= 0 || items.length === 0) return undefined;
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const w = weights[i];
    if (w === undefined || w <= 0) continue;
    acc += w;
    if (roll < acc) return items[i];
  }
  return items[items.length - 1];
}

/** Fisher–Yates, returning a new array. The input is not mutated. */
export function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}
