import { describe, expect, it } from 'vitest';
import {
  createRng,
  forkRng,
  mixSeed,
  pick,
  pickWeighted,
  rangeInt,
  restoreRng,
  seedFromString,
  shuffled,
} from '../src/core/rng';

function take(seedOrRng: number | ReturnType<typeof createRng>, n: number): number[] {
  const rng = typeof seedOrRng === 'number' ? createRng(seedOrRng) : seedOrRng;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rng.next());
  return out;
}

describe('createRng', () => {
  it('is deterministic for a given seed', () => {
    expect(take(1234, 20)).toEqual(take(1234, 20));
  });

  it('produces uncorrelated streams for adjacent seeds', () => {
    const a = take(1, 8);
    const b = take(2, 8);
    expect(a).not.toEqual(b);
    // Adjacent seeds must not merely be offset copies of one another.
    expect(a[0]).not.toBeCloseTo(b[0] ?? -1, 3);
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng(99);
    for (let i = 0; i < 20000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is roughly uniform', () => {
    const rng = createRng(7);
    const buckets = new Array<number>(10).fill(0);
    const n = 100000;
    for (let i = 0; i < n; i++) {
      const b = Math.min(9, Math.floor(rng.next() * 10));
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(n / 10 - n / 100);
      expect(count).toBeLessThan(n / 10 + n / 100);
    }
  });
});

describe('state / restore', () => {
  it('restores the exact continuation of a stream', () => {
    const original = createRng(0xbeef);
    for (let i = 0; i < 37; i++) original.next();
    const snapshot = original.state();

    const expected = take(original, 25);
    const resumed = restoreRng(snapshot);
    expect(take(resumed, 25)).toEqual(expected);
  });

  it('survives a restore taken after int() and chance() calls', () => {
    const original = createRng(5);
    original.int(6);
    original.chance(50);
    original.next();
    const resumed = restoreRng(original.state());
    expect(resumed.int(100)).toBe(original.int(100));
    expect(resumed.chance(37)).toBe(original.chance(37));
  });

  it('state is a plain 32-bit unsigned number', () => {
    const rng = createRng(3);
    for (let i = 0; i < 10; i++) rng.next();
    const s = rng.state();
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(2 ** 32);
  });
});

describe('int', () => {
  it('stays in [0, n)', () => {
    const rng = createRng(11);
    for (let i = 0; i < 5000; i++) {
      const v = rng.int(6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('hits every face of a d6', () => {
    const rng = createRng(12);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(rng.int(6));
    expect(seen.size).toBe(6);
  });

  it('degenerate sizes return 0 but still advance the stream', () => {
    const rng = createRng(13);
    const before = rng.state();
    expect(rng.int(0)).toBe(0);
    expect(rng.int(1)).toBe(0);
    expect(rng.state()).not.toBe(before);
  });
});

describe('chance', () => {
  it('is never true at 0 and always true at 100', () => {
    const rng = createRng(21);
    for (let i = 0; i < 500; i++) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(100)).toBe(true);
      expect(rng.chance(150)).toBe(true);
      expect(rng.chance(-20)).toBe(false);
    }
  });

  it('approximates the stated percentage', () => {
    const rng = createRng(22);
    let hits = 0;
    const n = 50000;
    for (let i = 0; i < n; i++) if (rng.chance(35)) hits++;
    expect(hits / n).toBeGreaterThan(0.34);
    expect(hits / n).toBeLessThan(0.36);
  });

  it('consumes exactly one roll regardless of the percentage', () => {
    const a = createRng(23);
    a.chance(0);
    const b = createRng(23);
    b.chance(100);
    expect(a.state()).toBe(b.state());
    expect(a.next()).toBe(b.next());
  });
});

describe('helpers', () => {
  it('rangeInt is inclusive on both ends', () => {
    const rng = createRng(31);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = rangeInt(rng, 3, 6);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect(seen.size).toBe(4);
  });

  it('pick returns a member, and undefined on empty', () => {
    const rng = createRng(32);
    const items = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) expect(items).toContain(pick(rng, items));
    expect(pick(rng, [])).toBeUndefined();
  });

  it('pickWeighted respects weights and skips zero-weight entries', () => {
    const rng = createRng(33);
    const counts = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 20000; i++) {
      const v = pickWeighted(rng, ['a', 'b', 'c'] as const, [1, 3, 0]);
      if (v) counts[v]++;
    }
    expect(counts.c).toBe(0);
    expect(counts.b / (counts.a + counts.b)).toBeGreaterThan(0.72);
    expect(counts.b / (counts.a + counts.b)).toBeLessThan(0.78);
  });

  it('shuffled is a permutation and does not mutate the input', () => {
    const rng = createRng(34);
    const src = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffled(rng, src);
    expect(src).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(out.slice().sort((a, b) => a - b)).toEqual(src);
    expect(out).not.toEqual(src);
  });

  it('shuffled is deterministic for a seed', () => {
    const src = ['a', 'b', 'c', 'd', 'e'];
    expect(shuffled(createRng(35), src)).toEqual(shuffled(createRng(35), src));
  });
});

describe('forkRng', () => {
  it('does not consume from the parent but derives from its state', () => {
    const parent = createRng(41);
    parent.next();
    const before = parent.state();
    const child = forkRng(parent, 'ai-scoring');
    expect(parent.state()).toBe(before);
    child.next();
    expect(parent.state()).toBe(before);
  });

  it('different labels give different streams; same label reproduces', () => {
    const p1 = createRng(42);
    const p2 = createRng(42);
    expect(take(forkRng(p1, 'vfx'), 5)).toEqual(take(forkRng(p2, 'vfx'), 5));
    expect(take(forkRng(p1, 'vfx'), 5)).not.toEqual(take(forkRng(p2, 'ai'), 5));
  });
});

describe('seed mixing', () => {
  it('mixSeed is a 32-bit unsigned avalanche', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const v = mixSeed(i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(2 ** 32);
      seen.add(v);
    }
    expect(seen.size).toBe(1000);
  });

  it('seedFromString is stable and collision-free over map ids', () => {
    expect(seedFromString('orbonne-courtyard')).toBe(seedFromString('orbonne-courtyard'));
    expect(seedFromString('orbonne-courtyard')).not.toBe(seedFromString('mandalia-plains'));
  });

  it('handles non-integer and non-finite seeds without producing NaN', () => {
    for (const seed of [1.7, -3.2, NaN, Infinity]) {
      const v = createRng(seed).next();
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
