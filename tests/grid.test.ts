import { describe, expect, it } from 'vitest';
import type { AbilityRange, Battlefield, Team, Vec3 } from '../src/core/types';
import {
  areHostile,
  buildBattlefield,
  buildOccupancy,
  canEndOn,
  createBattlefield,
  facingBetween,
  generateMap,
  getMapDef,
  hasLineOfSight,
  heightDiff,
  isInRange,
  listMaps,
  MANDALIA_PLAINS,
  MAPS,
  moveCostInto,
  ORBONNE_COURTYARD,
  parseKey,
  pathCost,
  pathTo,
  reachableDestinations,
  reachableTiles,
  relativeFacing,
  tileKey,
  tilesInBurst,
  tilesInRange,
  type MapDef,
  type Mover,
  type Occupancy,
} from '../src/core/grid';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Build a throwaway field from ASCII layers. */
function testField(heights: string[], surfaces?: string[], blocked?: string[]): Battlefield {
  const height = heights.length;
  const width = heights[0]?.length ?? 0;
  const def: MapDef = {
    id: 'test',
    name: 'test',
    blurb: 'test',
    width,
    height,
    heights,
    surfaces: surfaces ?? heights.map((r) => '.'.repeat(r.length)),
    ...(blocked ? { blocked } : {}),
    waterLevel: 0,
    deckSurfaces: [],
    playerStarts: [],
    enemyStarts: [],
    lighting: {
      sunColor: 0xffffff,
      sunIntensity: 1,
      sunAzimuth: 0,
      sunElevation: 45,
      skyColor: 0xffffff,
      groundColor: 0x000000,
      ambientIntensity: 0.5,
      fogColor: 0xffffff,
      fogDensity: 0,
    },
  };
  return buildBattlefield(def);
}

function flat(size: number): Battlefield {
  return testField(new Array<string>(size).fill('0'.repeat(size)));
}

function mover(x: number, y: number, move: number, jump: number, team: Team = 'player'): Mover {
  return { pos: { x, y, z: 0 }, team, stats: { move, jump } };
}

function occ(entries: [number, number, Team][]): Occupancy {
  const m: Occupancy = new Map();
  for (const [x, y, t] of entries) m.set(tileKey(x, y), t);
  return m;
}

const RANGE = (over: Partial<AbilityRange>): AbilityRange => ({
  range: 1,
  radius: 0,
  vertical: Infinity,
  los: false,
  ...over,
});

function keys(tiles: Vec3[]): string[] {
  return tiles.map((t) => tileKey(t.x, t.y)).sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('tile keys and geometry helpers', () => {
  it('round-trips keys', () => {
    expect(tileKey(3, 7)).toBe('3,7');
    expect(parseKey('3,7')).toEqual({ x: 3, y: 7 });
    expect(parseKey(tileKey(0, 0))).toEqual({ x: 0, y: 0 });
    expect(() => parseKey('nonsense')).toThrow();
  });

  it('heightDiff is signed from a to b and reads both Vec3 and Tile', () => {
    const field = testField(['05']);
    const a = field.tileAt(0, 0);
    const b = field.tileAt(1, 0);
    expect(a && b && heightDiff(a, b)).toBe(5);
    expect(a && b && heightDiff(b, a)).toBe(-5);
    expect(heightDiff({ x: 0, y: 0, z: 2 }, { x: 0, y: 0, z: 6 })).toBe(4);
  });

  it('facingBetween points from a toward b', () => {
    const o = { x: 5, y: 5 };
    expect(facingBetween(o, { x: 5, y: 2 })).toBe('N');
    expect(facingBetween(o, { x: 5, y: 9 })).toBe('S');
    expect(facingBetween(o, { x: 9, y: 5 })).toBe('E');
    expect(facingBetween(o, { x: 1, y: 5 })).toBe('W');
    // Perfect diagonal ties resolve horizontally.
    expect(facingBetween(o, { x: 8, y: 8 })).toBe('E');
    expect(facingBetween(o, o)).toBe('S');
  });

  it('relativeFacing classifies front, side and back', () => {
    const defender = { pos: { x: 5, y: 5, z: 0 }, facing: 'N' as const };
    expect(relativeFacing({ pos: { x: 5, y: 2, z: 0 } }, defender)).toBe('front');
    expect(relativeFacing({ pos: { x: 5, y: 9, z: 0 } }, defender)).toBe('back');
    expect(relativeFacing({ pos: { x: 9, y: 5, z: 0 } }, defender)).toBe('side');
    expect(relativeFacing({ pos: { x: 1, y: 5, z: 0 } }, defender)).toBe('side');
  });

  it('team hostility groups players with allies and isolates neutrals', () => {
    expect(areHostile('player', 'enemy')).toBe(true);
    expect(areHostile('player', 'ally')).toBe(false);
    expect(areHostile('ally', 'enemy')).toBe(true);
    expect(areHostile('neutral', 'player')).toBe(true);
    expect(areHostile('neutral', 'neutral')).toBe(false);
  });
});

describe('createBattlefield', () => {
  it('bounds-checks tileAt', () => {
    const field = flat(4);
    expect(field.tileAt(0, 0)).toBeDefined();
    expect(field.tileAt(3, 3)).toBeDefined();
    expect(field.tileAt(-1, 0)).toBeUndefined();
    expect(field.tileAt(4, 0)).toBeUndefined();
    expect(field.tileAt(0, 4)).toBeUndefined();
    expect(field.tileAt(1.5, 0)).toBeUndefined();
  });

  it('rejects a mismatched tile array', () => {
    expect(() => createBattlefield(3, 3, [])).toThrow();
  });

  it('indexes row-major', () => {
    const field = testField(['012', '345']);
    expect(field.tileAt(2, 0)?.height).toBe(2);
    expect(field.tileAt(0, 1)?.height).toBe(3);
    expect(field.tileAt(2, 1)?.height).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Maps
// ─────────────────────────────────────────────────────────────────────────────

describe('handcrafted maps', () => {
  it('exposes both maps', () => {
    expect(Object.keys(MAPS).sort()).toEqual(['mandalia-plains', 'orbonne-courtyard']);
    expect(listMaps()).toHaveLength(2);
    expect(getMapDef('orbonne-courtyard')).toBe(ORBONNE_COURTYARD);
    expect(getMapDef('nope')).toBeUndefined();
    expect(() => generateMap('nope')).toThrow();
  });

  for (const def of [ORBONNE_COURTYARD, MANDALIA_PLAINS]) {
    describe(def.id, () => {
      const field = generateMap(def.id);

      it('has consistent layer dimensions and a full tile array', () => {
        expect(field.width).toBe(def.width);
        expect(field.height).toBe(def.height);
        expect(field.tiles).toHaveLength(def.width * def.height);
        for (let y = 0; y < field.height; y++) {
          for (let x = 0; x < field.width; x++) {
            const t = field.tileAt(x, y);
            expect(t).toBeDefined();
            expect(t?.x).toBe(x);
            expect(t?.y).toBe(y);
            expect(Number.isFinite(t?.height)).toBe(true);
          }
        }
      });

      it('is not a flat plane', () => {
        const hs = field.tiles.map((t) => t.height);
        const min = Math.min(...hs);
        const max = Math.max(...hs);
        expect(max - min).toBeGreaterThanOrEqual(6);
        expect(new Set(hs).size).toBeGreaterThanOrEqual(5);
      });

      it('has derived slopes somewhere', () => {
        expect(field.tiles.some((t) => t.slope !== 'flat')).toBe(true);
      });

      it('is fully connected for an ordinary Move 4 / Jump 2 unit', () => {
        const start = def.playerStarts[0]!;
        const walker: Mover = {
          pos: { x: start.x, y: start.y, z: field.tileAt(start.x, start.y)!.height },
          team: 'player',
          stats: { move: 9999, jump: 2 },
        };
        const reach = reachableTiles(field, walker, new Map());
        const stranded = field.tiles.filter(
          (t) => t.passable && Number.isFinite(moveCostInto(t)) && !reach.has(tileKey(t.x, t.y)),
        );
        expect(stranded.map((t) => tileKey(t.x, t.y))).toEqual([]);
      });

      it('has deployment tiles that are actually standable', () => {
        for (const p of [...def.playerStarts, ...def.enemyStarts]) {
          const t = field.tileAt(p.x, p.y);
          expect(t, `${def.id} start ${p.x},${p.y}`).toBeDefined();
          expect(t?.passable).toBe(true);
          expect(Number.isFinite(moveCostInto(t!))).toBe(true);
        }
      });
    });
  }

  it('orbonne has an impassable fountain and pillars that break sight lines', () => {
    const field = generateMap('orbonne-courtyard');
    expect(field.tileAt(6, 6)?.passable).toBe(false);
    expect(field.tileAt(7, 7)?.passable).toBe(false);
    // Across the garden through the fountain plinth: blocked.
    expect(hasLineOfSight(field, { x: 4, y: 6, z: 2 }, { x: 9, y: 6, z: 2 })).toBe(false);
    // Along the open garden row just south of it: clear.
    expect(hasLineOfSight(field, { x: 4, y: 8, z: 2 }, { x: 9, y: 8, z: 2 })).toBe(true);
    // The colonnade pillar at (3,1) blocks the north arcade.
    expect(field.tileAt(3, 1)?.passable).toBe(false);
    expect(field.tileAt(3, 1)?.height).toBe(10);
    expect(hasLineOfSight(field, { x: 1, y: 1, z: 6 }, { x: 5, y: 1, z: 6 })).toBe(false);
  });

  it('orbonne derives real ramps on the garden banks', () => {
    const field = generateMap('orbonne-courtyard');
    expect(field.tileAt(2, 5)?.slope).toBe('incline-w');
    expect(field.tileAt(11, 5)?.slope).toBe('incline-e');
    expect(field.tileAt(5, 12)?.slope).toBe('incline-s');
  });

  it('orbonne has a reflecting pool below the garden floor', () => {
    const field = generateMap('orbonne-courtyard');
    const pool = field.tileAt(4, 9);
    expect(pool?.surface).toBe('water');
    expect(pool?.height).toBe(0);
    expect(field.tileAt(3, 9)?.height).toBe(2);
  });

  it('mandalia has a river, a deep ford and a wooden bridge over it', () => {
    const field = generateMap('mandalia-plains');
    const water = field.tiles.filter((t) => t.surface === 'water' || t.surface === 'deepwater');
    expect(water.length).toBeGreaterThan(20);
    expect(water.every((t) => t.height === MANDALIA_PLAINS.waterLevel)).toBe(true);

    const deep = field.tiles.filter((t) => t.surface === 'deepwater');
    expect(deep.length).toBeGreaterThan(0);
    expect(deep.every((t) => t.submerged)).toBe(true);
    expect(moveCostInto(deep[0]!)).toBe(4);

    const bridge = field.tiles.filter((t) => t.surface === 'bridge');
    expect(bridge).toHaveLength(2);
    for (const b of bridge) {
      expect(b.passable).toBe(true);
      expect(moveCostInto(b)).toBe(1);
      // The deck stands above the river it spans.
      expect(b.height).toBeGreaterThan(MANDALIA_PLAINS.waterLevel);
    }
  });

  it('mandalia: the bridge is the cheap crossing, the ford is the expensive one', () => {
    const field = generateMap('mandalia-plains');
    const empty: Occupancy = new Map();
    // A scout with plenty of Move standing on the west bank next to the bridge.
    const u: Mover = { pos: { x: 6, y: 6, z: 2 }, team: 'player', stats: { move: 4, jump: 2 } };
    const reach = reachableTiles(field, u, empty);
    const overBridge = reach.get(tileKey(9, 6));
    expect(overBridge?.cost).toBe(3);

    // Wading the shallow river one row north costs more for the same distance.
    const wader: Mover = { pos: { x: 6, y: 5, z: 2 }, team: 'player', stats: { move: 6, jump: 2 } };
    const wet = reachableTiles(field, wader, empty);
    expect(wet.get(tileKey(9, 5))?.cost).toBe(5);

    // At the deep bend, wading straight across costs 4+4+1 = 9, so a unit with
    // the Move to spare detours over the bridge instead (7) rather than swim.
    const ford: Mover = { pos: { x: 7, y: 8, z: 2 }, team: 'player', stats: { move: 9, jump: 2 } };
    const forded = reachableTiles(field, ford, empty);
    expect(forded.get(tileKey(10, 8))?.cost).toBe(7);
    const detour = pathTo(field, ford, empty, { x: 10, y: 8 }, forded);
    expect(detour.some((p) => field.tileAt(p.x, p.y)?.surface === 'bridge')).toBe(true);
    expect(detour.some((p) => field.tileAt(p.x, p.y)?.surface === 'deepwater')).toBe(false);
    expect(field.tileAt(8, 8)?.submerged).toBe(true);

    // Straight through the ford really does cost 9, which is why it loses.
    expect(
      pathCost(field, [
        { x: 7, y: 8, z: 2 },
        { x: 8, y: 8, z: 0 },
        { x: 9, y: 8, z: 0 },
        { x: 10, y: 8, z: 2 },
      ]),
    ).toBe(9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pathfinding
// ─────────────────────────────────────────────────────────────────────────────

describe('reachableTiles', () => {
  it('floods a Manhattan diamond on flat ground', () => {
    const field = flat(11);
    const reach = reachableTiles(field, mover(5, 5, 4, 2), new Map());
    // 1 + 4 + 8 + 12 + 16
    expect(reach.size).toBe(41);
    expect(reach.get(tileKey(5, 5))?.cost).toBe(0);
    expect(reach.get(tileKey(5, 5))?.prev).toBeNull();
    expect(reach.get(tileKey(9, 5))?.cost).toBe(4);
    expect(reach.get(tileKey(7, 7))?.cost).toBe(4);
    expect(reach.get(tileKey(10, 5))).toBeUndefined();
  });

  it('clips at the field edge', () => {
    const field = flat(5);
    const reach = reachableTiles(field, mover(0, 0, 2, 2), new Map());
    expect(reach.size).toBe(6); // (0,0) plus the 5 in-bounds tiles within 2
    expect(reach.get(tileKey(2, 0))?.cost).toBe(2);
  });

  it('reports position z as the tile surface height', () => {
    const field = testField(['013']);
    const reach = reachableTiles(field, mover(0, 0, 4, 3), new Map());
    expect(reach.get(tileKey(1, 0))?.pos.z).toBe(1);
    expect(reach.get(tileKey(2, 0))?.pos.z).toBe(3);
  });

  describe('jump limits', () => {
    // x=2 is a 3-high ledge between two flat stretches.
    const field = testField(['00300']);

    it('blocks a step taller than Jump, in both directions', () => {
      const reach = reachableTiles(field, mover(0, 0, 5, 2), new Map());
      expect(reach.has(tileKey(1, 0))).toBe(true);
      expect(reach.has(tileKey(2, 0))).toBe(false);
      expect(reach.has(tileKey(3, 0))).toBe(false);

      // Standing on top, a Jump 2 unit cannot get down either.
      const onTop = reachableTiles(field, mover(2, 0, 5, 2), new Map());
      expect(onTop.size).toBe(1);
    });

    it('allows the step at exactly Jump', () => {
      const reach = reachableTiles(field, mover(0, 0, 5, 3), new Map());
      expect(reach.has(tileKey(2, 0))).toBe(true);
      expect(reach.get(tileKey(4, 0))?.cost).toBe(4);
    });

    it('Jump 0 pins a unit to level ground', () => {
      const field2 = testField(['00100']);
      const reach = reachableTiles(field2, mover(0, 0, 4, 0), new Map());
      expect(reach.size).toBe(2);
    });
  });

  describe('occupancy', () => {
    const field = flat(5);

    it('cannot path through an enemy', () => {
      const reach = reachableTiles(
        field,
        { pos: { x: 0, y: 0, z: 0 }, team: 'player', stats: { move: 4, jump: 2 } },
        occ([[2, 0, 'enemy']]),
      );
      expect(reach.has(tileKey(1, 0))).toBe(true);
      expect(reach.has(tileKey(2, 0))).toBe(false);
      // (3,0) is only reachable the long way round, which costs 5 > Move 4.
      expect(reach.has(tileKey(3, 0))).toBe(false);
    });

    it('paths through an ally but cannot stop on it', () => {
      const o = occ([[2, 0, 'player']]);
      const u = mover(0, 0, 4, 2);
      const reach = reachableTiles(field, u, o);
      expect(reach.has(tileKey(2, 0))).toBe(true);
      expect(reach.get(tileKey(3, 0))?.cost).toBe(3);

      expect(canEndOn(field, u, o, 2, 0)).toBe(false);
      expect(canEndOn(field, u, o, 3, 0)).toBe(true);
      const dests = reachableDestinations(field, u, o, reach);
      expect(dests.has(tileKey(2, 0))).toBe(false);
      expect(dests.has(tileKey(3, 0))).toBe(true);
      // A unit may always "end" where it already stands.
      expect(dests.has(tileKey(0, 0))).toBe(true);
    });

    it('neutral units block everybody', () => {
      const reach = reachableTiles(field, mover(0, 0, 4, 2), occ([[1, 0, 'neutral']]));
      expect(reach.has(tileKey(1, 0))).toBe(false);
    });

    it('buildOccupancy skips removed units', () => {
      const o = buildOccupancy([
        { pos: { x: 1, y: 0, z: 0 }, team: 'enemy' },
        { pos: { x: 2, y: 0, z: 0 }, team: 'enemy', removed: true },
      ]);
      expect(o.get(tileKey(1, 0))).toBe('enemy');
      expect(o.has(tileKey(2, 0))).toBe(false);
    });
  });

  describe('terrain cost', () => {
    it('charges 2 to wade shallow water', () => {
      const field = testField(['00000'], ['..w..']);
      const reach = reachableTiles(field, mover(0, 0, 3, 2), new Map());
      expect(reach.get(tileKey(1, 0))?.cost).toBe(1);
      expect(reach.get(tileKey(2, 0))?.cost).toBe(3);
      expect(reach.has(tileKey(3, 0))).toBe(false);
    });

    it('never enters impassable tiles', () => {
      const field = testField(['00000'], ['.....'], ['..#..']);
      const reach = reachableTiles(field, mover(0, 0, 4, 2), new Map());
      expect(reach.has(tileKey(2, 0))).toBe(false);
      expect(moveCostInto(field.tileAt(2, 0)!)).toBe(Infinity);
    });

    it('void surfaces are holes', () => {
      const field = testField(['00000'], ['..#..']);
      expect(field.tileAt(2, 0)?.passable).toBe(false);
      const reach = reachableTiles(field, mover(0, 0, 4, 2), new Map());
      expect(reach.has(tileKey(2, 0))).toBe(false);
    });

    it('prefers the cheap route around expensive terrain', () => {
      // Deep water in the middle: 4+1 through, 1+1+1+1 around.
      const field = testField(['000', '000', '000'], ['...', '.W.', '...']);
      const reach = reachableTiles(field, mover(1, 0, 4, 2), new Map());
      expect(reach.get(tileKey(1, 2))?.cost).toBe(4); // around, not 5 through
      const path = pathTo(field, mover(1, 0, 4, 2), new Map(), { x: 1, y: 2 }, reach);
      expect(path.some((p) => p.x === 1 && p.y === 1)).toBe(false);
    });
  });
});

describe('pathTo', () => {
  it('returns a contiguous orthogonal walk starting on the origin tile', () => {
    const field = flat(7);
    const u = mover(1, 1, 5, 2);
    const path = pathTo(field, u, new Map(), { x: 4, y: 2 });
    expect(path[0]).toEqual({ x: 1, y: 1, z: 0 });
    expect(path[path.length - 1]).toEqual({ x: 4, y: 2, z: 0 });
    expect(path).toHaveLength(5); // origin + 4 steps
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(1);
    }
    expect(pathCost(field, path)).toBe(4);
  });

  it('is a single-element path when targeting your own tile', () => {
    const field = flat(5);
    const u = mover(2, 2, 4, 2);
    expect(pathTo(field, u, new Map(), { x: 2, y: 2 })).toEqual([{ x: 2, y: 2, z: 0 }]);
  });

  it('returns nothing for unreachable or illegal destinations', () => {
    const field = flat(9);
    const u = mover(4, 4, 3, 2);
    expect(pathTo(field, u, new Map(), { x: 8, y: 8 })).toEqual([]);
    expect(pathTo(field, u, new Map(), { x: 40, y: 4 })).toEqual([]);
    // Reachable but occupied by an ally.
    const o = occ([[5, 4, 'player']]);
    expect(pathTo(field, u, o, { x: 5, y: 4 })).toEqual([]);
  });

  it('climbs a staircase whose individual steps are within Jump', () => {
    const field = testField(['01234']);
    const u = mover(0, 0, 4, 1);
    const path = pathTo(field, u, new Map(), { x: 4, y: 0 });
    expect(path.map((p) => p.z)).toEqual([0, 1, 2, 3, 4]);
  });

  it('walks the Orbonne ramp instead of scaling the cloister wall', () => {
    const field = generateMap('orbonne-courtyard');
    // A Jump 2 unit in the garden reaching the west cloister must use the bank.
    const u: Mover = { pos: { x: 5, y: 5, z: 2 }, team: 'player', stats: { move: 5, jump: 2 } };
    const path = pathTo(field, u, new Map(), { x: 1, y: 5 });
    expect(path.length).toBeGreaterThan(1);
    expect(path[path.length - 1]).toEqual({ x: 1, y: 5, z: 6 });
    expect(path.some((p) => p.x === 2 && p.z === 4)).toBe(true);
    for (let i = 1; i < path.length; i++) {
      expect(Math.abs(path[i]!.z - path[i - 1]!.z)).toBeLessThanOrEqual(2);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Line of sight
// ─────────────────────────────────────────────────────────────────────────────

describe('hasLineOfSight', () => {
  it('sees over terrain no taller than chest height', () => {
    expect(hasLineOfSight(testField(['00200']), { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 })).toBe(
      true,
    );
  });

  it('is blocked by terrain above chest height', () => {
    expect(hasLineOfSight(testField(['00300']), { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 })).toBe(
      false,
    );
  });

  it('never blocks on the origin or the target tile', () => {
    const field = testField(['500005']);
    expect(hasLineOfSight(field, { x: 0, y: 0, z: 5 }, { x: 5, y: 0, z: 5 })).toBe(true);
    expect(hasLineOfSight(field, { x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 5 })).toBe(true);
  });

  it('lets high ground shoot over a wall that blocks the low unit', () => {
    // A 6-high wall at x=2 between a low tile and a high plateau.
    const field = testField(['006008']);
    const wall = { x: 2, y: 0 };
    expect(field.tileAt(wall.x, wall.y)?.height).toBe(6);
    expect(hasLineOfSight(field, { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 })).toBe(false);
    expect(hasLineOfSight(field, { x: 5, y: 0, z: 8 }, { x: 4, y: 0, z: 0 })).toBe(true);
  });

  it('is symmetric', () => {
    const field = testField(['00400', '00000', '00400']);
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 4, y: 0, z: 0 };
    expect(hasLineOfSight(field, a, b)).toBe(hasLineOfSight(field, b, a));
  });

  it('works diagonally', () => {
    const field = testField(['000', '090', '000']);
    expect(hasLineOfSight(field, { x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 0 })).toBe(false);
    const open = testField(['000', '000', '000']);
    expect(hasLineOfSight(open, { x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 0 })).toBe(true);
  });

  it('treats off-map gaps as open air', () => {
    const field = flat(3);
    expect(hasLineOfSight(field, { x: 0, y: 0, z: 0 }, { x: 9, y: 0, z: 0 })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Range and AoE
// ─────────────────────────────────────────────────────────────────────────────

describe('tilesInRange', () => {
  const field = flat(11);
  const origin: Vec3 = { x: 5, y: 5, z: 0 };

  it('circle is a Manhattan diamond including the caster tile', () => {
    const tiles = tilesInRange(field, origin, RANGE({ range: 2 }));
    expect(tiles).toHaveLength(13);
    expect(keys(tiles)).toContain('5,5');
    expect(keys(tiles)).toContain('3,5');
    expect(keys(tiles)).not.toContain('4,3'); // distance 3
  });

  it('excludeOrigin drops the caster tile', () => {
    const tiles = tilesInRange(field, origin, RANGE({ range: 2 }), { excludeOrigin: true });
    expect(tiles).toHaveLength(12);
    expect(keys(tiles)).not.toContain('5,5');
  });

  it('cross is the four cardinal rays', () => {
    const tiles = tilesInRange(field, origin, RANGE({ range: 3, shape: 'cross' }));
    expect(tiles).toHaveLength(13);
    expect(tiles.every((t) => t.x === 5 || t.y === 5)).toBe(true);
  });

  it('line is a single ray along the facing', () => {
    const east = tilesInRange(field, origin, RANGE({ range: 3, shape: 'line' }), { facing: 'E' });
    expect(keys(east)).toEqual(['6,5', '7,5', '8,5']);
    const north = tilesInRange(field, origin, RANGE({ range: 3, shape: 'line' }), { facing: 'N' });
    expect(keys(north)).toEqual(['5,2', '5,3', '5,4']);
  });

  it('cone is a 90 degree wedge that never includes the caster', () => {
    const east = tilesInRange(field, origin, RANGE({ range: 3, shape: 'cone' }), { facing: 'E' });
    expect(keys(east)).toEqual(['6,4', '6,5', '6,6', '7,4', '7,5', '7,6', '8,5']);
    const south = tilesInRange(field, origin, RANGE({ range: 3, shape: 'cone' }), { facing: 'S' });
    expect(south).toHaveLength(7);
    expect(south.every((t) => t.y > 5)).toBe(true);
  });

  it('self targets only the caster tile', () => {
    const tiles = tilesInRange(field, origin, RANGE({ range: 4, self: true }));
    expect(tiles).toEqual([{ x: 5, y: 5, z: 0 }]);
  });

  it('honours the vertical tolerance', () => {
    const stepped = testField(['00035']);
    const from: Vec3 = { x: 0, y: 0, z: 0 };
    const loose = tilesInRange(stepped, from, RANGE({ range: 4, vertical: Infinity }));
    expect(loose).toHaveLength(5);
    const tight = tilesInRange(stepped, from, RANGE({ range: 4, vertical: 3 }));
    expect(keys(tight)).toEqual(['0,0', '1,0', '2,0', '3,0']);
  });

  it('honours line of sight', () => {
    const field2 = testField(['00500']);
    const from: Vec3 = { x: 0, y: 0, z: 0 };
    expect(tilesInRange(field2, from, RANGE({ range: 4, los: false }))).toHaveLength(5);
    // The wall tile itself is still targetable — you can see its top — but
    // everything hidden behind it is not.
    const seen = tilesInRange(field2, from, RANGE({ range: 4, los: true }));
    expect(keys(seen)).toEqual(['0,0', '1,0', '2,0']);
  });

  it('skips impassable tiles unless asked for them', () => {
    const field2 = testField(['000'], ['...'], ['.#.']);
    const from: Vec3 = { x: 0, y: 0, z: 0 };
    expect(tilesInRange(field2, from, RANGE({ range: 2 }))).toHaveLength(2);
    expect(
      tilesInRange(field2, from, RANGE({ range: 2 }), { includeImpassable: true }),
    ).toHaveLength(3);
  });

  it('reports the target tile surface height in z', () => {
    const stepped = testField(['047']);
    const tiles = tilesInRange(stepped, { x: 0, y: 0, z: 0 }, RANGE({ range: 2 }));
    expect(tiles.map((t) => t.z).sort((a, b) => a - b)).toEqual([0, 4, 7]);
  });
});

describe('tilesInBurst', () => {
  const field = flat(9);

  it('radius 0 is a single tile', () => {
    expect(tilesInBurst(field, { x: 4, y: 4, z: 0 }, RANGE({ radius: 0 }))).toHaveLength(1);
  });

  it('radius spreads as a diamond', () => {
    expect(tilesInBurst(field, { x: 4, y: 4, z: 0 }, RANGE({ radius: 1 }))).toHaveLength(5);
    expect(tilesInBurst(field, { x: 4, y: 4, z: 0 }, RANGE({ radius: 2 }))).toHaveLength(13);
  });

  it('does not spill onto ledges outside the vertical tolerance', () => {
    const stepped = testField(['090']);
    const hit = tilesInBurst(stepped, { x: 0, y: 0, z: 0 }, RANGE({ radius: 2, vertical: 2 }));
    expect(keys(hit)).toEqual(['0,0', '2,0']);
  });

  it('ignores line of sight — the burst has already landed', () => {
    const field2 = testField(['00900']);
    const hit = tilesInBurst(field2, { x: 4, y: 0, z: 0 }, RANGE({ radius: 4, vertical: Infinity, los: true }));
    expect(hit).toHaveLength(5);
  });
});

describe('isInRange', () => {
  const field = flat(11);
  const origin: Vec3 = { x: 5, y: 5, z: 0 };

  it('agrees with tilesInRange', () => {
    for (const shape of ['circle', 'cross', 'line', 'cone'] as const) {
      const range = RANGE({ range: 3, shape, los: true });
      const listed = new Set(keys(tilesInRange(field, origin, range, { facing: 'E' })));
      for (let y = 0; y < 11; y++) {
        for (let x = 0; x < 11; x++) {
          const t = field.tileAt(x, y)!;
          const inRange = isInRange(field, origin, { x, y, z: t.height }, range, { facing: 'E' });
          expect(inRange, `${shape} ${x},${y}`).toBe(listed.has(tileKey(x, y)));
        }
      }
    }
  });

  it('rejects off-map targets', () => {
    expect(isInRange(field, origin, { x: 50, y: 5, z: 0 }, RANGE({ range: 99 }))).toBe(false);
  });
});
