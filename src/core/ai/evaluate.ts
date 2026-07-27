/**
 * EverTactics — AI evaluation.
 *
 * Enumerates every legal (destination, ability, target) triple for the active
 * unit and scores it. Scoring is split into named terms (see `personalities.ts`)
 * so that archetypes are pure weight vectors over the same evidence.
 *
 * Dependency shape: this module imports ONLY `../types` and `./personalities`.
 * Everything it needs from the rest of core (pathfinding, real combat formulas,
 * the ability table) is reached through the `AiWorld` seam, which `battle.ts`
 * can fill with the authoritative implementations. A complete, honest default
 * implementation lives here so the AI is testable and playable on its own — the
 * defaults are *estimators*, which is what an AI wants anyway: it reasons about
 * expected outcomes, and the battle reducer remains the source of truth.
 *
 * Pure: no three.js, no Math.random.
 */

import type {
  Ability,
  AbilityId,
  BattleState,
  Battlefield,
  Element,
  Facing,
  Item,
  ItemId,
  Job,
  JobId,
  StatusId,
  SurfaceKind,
  Team,
  Tile,
  Unit,
  UnitId,
  Vec3,
  Zodiac,
} from '../types';
import { battleCaution, type Personality, type ScoreTerm } from './personalities';

// ─────────────────────────────────────────────────────────────────────────────
// Small geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

export function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function sameTile(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}

export function tileKey(x: number, y: number): number {
  // Battlefields are far smaller than 1024 on a side; a packed int keys faster
  // than a template string and keeps the hot loops allocation-free.
  return (y << 10) | x;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Facing a unit at `from` would take to look at `to`. Ties break to the larger axis. */
export function facingToward(from: { x: number; y: number }, to: { x: number; y: number }): Facing {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx === 0 && dy === 0) return 'S';
    return dx >= 0 ? 'E' : 'W';
  }
  return dy >= 0 ? 'S' : 'N';
}

export type RelativeFacing = 'front' | 'side' | 'back';

/**
 * Where `attackerPos` sits relative to a unit standing at `targetPos` facing
 * `targetFacing`. FFT: back attacks ignore evasion entirely, side attacks halve it.
 */
export function relativeFacing(
  attackerPos: { x: number; y: number },
  targetPos: { x: number; y: number },
  targetFacing: Facing,
): RelativeFacing {
  const dx = attackerPos.x - targetPos.x;
  const dy = attackerPos.y - targetPos.y;
  if (dx === 0 && dy === 0) return 'front';
  // Component of the attacker offset along the direction the target faces.
  let along = 0;
  let across = 0;
  switch (targetFacing) {
    case 'N': along = -dy; across = Math.abs(dx); break;
    case 'S': along = dy; across = Math.abs(dx); break;
    case 'E': along = dx; across = Math.abs(dy); break;
    case 'W': along = -dx; across = Math.abs(dy); break;
  }
  if (across > Math.abs(along)) return 'side';
  return along >= 0 ? 'front' : 'back';
}

export function hasStatus(unit: Unit, id: StatusId): boolean {
  for (const s of unit.statuses) if (s.status === id) return true;
  return false;
}

export function statusSource(unit: Unit, id: StatusId): UnitId | undefined {
  for (const s of unit.statuses) if (s.status === id) return s.source;
  return undefined;
}

export function isActive(unit: Unit): boolean {
  return !unit.removed && !hasStatus(unit, 'ko') && !hasStatus(unit, 'crystal') && !hasStatus(unit, 'treasure');
}

/** KO'd but still on the field — a valid Raise target. */
export function isDowned(unit: Unit): boolean {
  return !unit.removed && hasStatus(unit, 'ko') && !hasStatus(unit, 'crystal');
}

const PLAYER_SIDE: ReadonlySet<Team> = new Set<Team>(['player', 'ally']);

export function isAllyOf(a: Unit, b: Unit): boolean {
  if (a.id === b.id) return true;
  if (a.team === 'neutral' || b.team === 'neutral') return false;
  return PLAYER_SIDE.has(a.team) === PLAYER_SIDE.has(b.team);
}

export function isHostileTo(a: Unit, b: Unit): boolean {
  if (a.id === b.id) return false;
  if (a.team === 'neutral' || b.team === 'neutral') return false;
  return PLAYER_SIDE.has(a.team) !== PLAYER_SIDE.has(b.team);
}

/** Statuses that flip who a unit considers an enemy. */
export function isCharmedOrConfused(unit: Unit): boolean {
  return hasStatus(unit, 'charm') || hasStatus(unit, 'confuse');
}

// ─────────────────────────────────────────────────────────────────────────────
// Battlefield queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Movement cost of stepping onto a surface. FFT charges extra for bad footing.
 *
 * This MUST mirror `SURFACE_MOVE_COST` in `grid.ts`, which is what the reducer
 * charges when it validates the path. An AI that under-costs a surface plans
 * routes the reducer then throws `IllegalCommandError` on, which kills the turn
 * mid-plan. (`tests/ai.test.ts` pins the two tables together.)
 */
const SURFACE_COST: Readonly<Record<SurfaceKind, number>> = {
  grass: 1, dirt: 1, stone: 1, sand: 1, wood: 1, roof: 1, bridge: 1,
  snow: 2, swamp: 2, water: 2, lava: 3, deepwater: 4, void: Infinity,
};

/** How much a unit hates standing here, 0..1. Lava burns; deep water drowns. */
const SURFACE_HAZARD: Readonly<Record<SurfaceKind, number>> = {
  grass: 0, dirt: 0, stone: 0, sand: 0, wood: 0, roof: 0.05, bridge: 0,
  snow: 0.05, swamp: 0.35, water: 0.15, deepwater: 0.7, lava: 1, void: 1,
};

export function occupancyMap(state: BattleState): Map<number, Unit> {
  const map = new Map<number, Unit>();
  for (const unit of state.units.values()) {
    if (unit.removed) continue;
    map.set(tileKey(unit.pos.x, unit.pos.y), unit);
  }
  return map;
}

export interface MoveOption {
  /** Destination tile, with `z` set to the tile's walkable height. */
  pos: Vec3;
  /** Full step path from the unit's current tile to `pos`, inclusive of both. */
  path: Vec3[];
  cost: number;
}

interface ReachNode {
  x: number;
  y: number;
  z: number;
  cost: number;
  prev: number; // packed tile key of the predecessor, -1 for the origin
}

/**
 * Dijkstra over the battlefield honouring Move, Jump, surface cost, occupancy
 * and headroom. Units may pass through allies but never end on an occupied tile.
 */
export function computeReachable(
  state: BattleState,
  unit: Unit,
  opts: { move?: number; jump?: number; ignoreOccupancy?: boolean } = {},
): MoveOption[] {
  const origin: Vec3 = { x: unit.pos.x, y: unit.pos.y, z: unit.pos.z };
  const originOption: MoveOption = { pos: origin, path: [origin], cost: 0 };

  const immobile =
    hasStatus(unit, 'stop') || hasStatus(unit, 'petrify') || hasStatus(unit, 'sleep') ||
    hasStatus(unit, 'rooted') || hasStatus(unit, 'crystal') || hasStatus(unit, 'ko');
  const move = Math.max(0, Math.floor(opts.move ?? unit.stats.move));
  const jump = Math.max(0, Math.floor(opts.jump ?? unit.stats.jump));
  if (immobile || move <= 0) return [originOption];

  const occupied = opts.ignoreOccupancy ? new Map<number, Unit>() : occupancyMap(state);
  const field = state.field;

  const nodes = new Map<number, ReachNode>();
  const startKey = tileKey(origin.x, origin.y);
  nodes.set(startKey, { x: origin.x, y: origin.y, z: origin.z, cost: 0, prev: -1 });

  // Costs are small integers; a bucket queue beats a binary heap here and keeps
  // ordering fully deterministic.
  const buckets: number[][] = [];
  const push = (cost: number, key: number): void => {
    let bucket = buckets[cost];
    if (bucket === undefined) {
      bucket = [];
      buckets[cost] = bucket;
    }
    bucket.push(key);
  };
  push(0, startKey);

  const STEPS: readonly (readonly [number, number])[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  for (let cost = 0; cost <= move; cost++) {
    const bucket = buckets[cost];
    if (bucket === undefined) continue;
    for (let i = 0; i < bucket.length; i++) {
      const key = bucket[i];
      if (key === undefined) continue;
      const node = nodes.get(key);
      if (node === undefined || node.cost !== cost) continue;

      for (const step of STEPS) {
        const nx = node.x + step[0];
        const ny = node.y + step[1];
        const tile = field.tileAt(nx, ny);
        if (tile === undefined || !tile.passable || tile.surface === 'void') continue;
        if (tile.depth < 1) continue; // no headroom to stand
        if (Math.abs(tile.height - node.z) > jump) continue;

        // No Float discount here: the reducer charges the surface either way, so
        // discounting it only produces paths it will refuse.
        const surfaceCost = SURFACE_COST[tile.surface] ?? 1;
        if (!Number.isFinite(surfaceCost)) continue;
        const next = cost + surfaceCost;
        if (next > move) continue;

        const blocker = occupied.get(tileKey(nx, ny));
        if (blocker !== undefined && isHostileTo(unit, blocker)) continue; // cannot pass through enemies

        const nKey = tileKey(nx, ny);
        const existing = nodes.get(nKey);
        if (existing !== undefined && existing.cost <= next) continue;
        nodes.set(nKey, { x: nx, y: ny, z: tile.height, cost: next, prev: key });
        push(next, nKey);
      }
    }
  }

  const out: MoveOption[] = [originOption];
  for (const [key, node] of nodes) {
    if (key === startKey) continue;
    const blocker = occupied.get(key);
    if (blocker !== undefined && blocker.id !== unit.id) continue; // cannot stop on someone
    const path: Vec3[] = [];
    let cursor: ReachNode | undefined = node;
    while (cursor !== undefined) {
      path.push({ x: cursor.x, y: cursor.y, z: cursor.z });
      cursor = cursor.prev === -1 ? undefined : nodes.get(cursor.prev);
    }
    path.reverse();
    out.push({ pos: { x: node.x, y: node.y, z: node.z }, path, cost: node.cost });
  }
  // Deterministic ordering regardless of Map iteration details.
  out.sort((a, b) => a.cost - b.cost || a.pos.y - b.pos.y || a.pos.x - b.pos.x);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation distance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far apart two tiles really are *for a unit that has to walk it*.
 *
 * Manhattan distance is a lie on a map with elevation. Two units either side of
 * a wall, or on plateaus separated by a cliff taller than their Jump, are two
 * tiles apart on paper and half a map apart in practice. Every term that asks
 * "how close am I to the enemy?" — the approach term, threat, facing, the
 * destination pruner — was reading that lie, so a squad standing across a gorge
 * from its target believed it was already engaged: the approach term was fully
 * satisfied, nothing else had a gradient, and no unit on either side ever had a
 * reason to take a step. That is the stand-off, and it is not a preference the
 * AI settled into — it is the AI correctly optimising a distance function that
 * did not describe the battlefield.
 *
 * A `NavGraph` answers the same question with a Dijkstra over the walkable
 * graph, honouring surface cost, Jump and headroom, so "close" means "close to
 * being able to hit you".
 */
export interface NavGraph {
  /**
   * Movement points a unit with this graph's Jump spends walking from `pos` to
   * the tile `target` stands on. Occupancy is ignored: bodies move.
   *
   * When no path exists the result stays finite and keeps a gradient —
   * `manhattan + board span` — so a unit cut off from every enemy still shuffles
   * toward the nearest one instead of going blind and idling.
   */
  distance(pos: { x: number; y: number }, target: Unit): number;
}

/** Safety valve: a Dijkstra over the walkable graph can never legitimately exceed this. */
function maxNavCost(field: Battlefield): number {
  return field.width * field.height * 4 + 4;
}

/**
 * A `NavGraph` for a unit with the given Jump. Distance fields are computed
 * lazily, once per target unit, and cached for the life of the graph (one AI
 * turn), so the cost is one Dijkstra per hostile per turn.
 */
export function createNavGraph(field: Battlefield, jump: number): NavGraph {
  const cache = new Map<UnitId, Map<number, number>>();
  const fallbackBase = field.width + field.height;
  const ceiling = maxNavCost(field);

  const standable = (tile: Tile | undefined): tile is Tile =>
    tile !== undefined && tile.passable && tile.surface !== 'void' && tile.depth >= 1;

  const fieldFor = (target: Unit): Map<number, number> => {
    const cached = cache.get(target.id);
    if (cached !== undefined) return cached;

    const dist = new Map<number, number>();
    const heights = new Map<number, number>();
    const surfaces = new Map<number, SurfaceKind>();

    const startKey = tileKey(target.pos.x, target.pos.y);
    const anchor = field.tileAt(target.pos.x, target.pos.y);
    dist.set(startKey, 0);
    heights.set(startKey, target.pos.z);
    surfaces.set(startKey, anchor?.surface ?? 'grass');

    // Integer costs in a tiny range; a bucket queue is faster than a heap and
    // keeps expansion order fully deterministic.
    const buckets: number[][] = [];
    const push = (cost: number, key: number): void => {
      let bucket = buckets[cost];
      if (bucket === undefined) {
        bucket = [];
        buckets[cost] = bucket;
      }
      bucket.push(key);
    };
    push(0, startKey);

    for (let cost = 0; cost < buckets.length && cost <= ceiling; cost++) {
      const bucket = buckets[cost];
      if (bucket === undefined) continue;
      for (let i = 0; i < bucket.length; i++) {
        const key = bucket[i];
        if (key === undefined) continue;
        if (dist.get(key) !== cost) continue;
        const zn = heights.get(key);
        const sn = surfaces.get(key);
        if (zn === undefined || sn === undefined) continue;

        // The search runs outward from the target, so the edge we are pricing is
        // the *forward* step neighbour → node: it lands on this node's surface.
        const step = SURFACE_COST[sn] ?? 1;
        if (!Number.isFinite(step)) continue;
        const next = cost + step;
        if (next > ceiling) continue;

        const x = key & 0x3ff;
        const y = key >> 10;
        for (const [dx, dy] of NAV_STEPS) {
          const nx = x + dx;
          const ny = y + dy;
          const tile = field.tileAt(nx, ny);
          if (!standable(tile)) continue;
          if (Math.abs(tile.height - zn) > jump) continue;

          const nKey = tileKey(nx, ny);
          const existing = dist.get(nKey);
          if (existing !== undefined && existing <= next) continue;
          dist.set(nKey, next);
          heights.set(nKey, tile.height);
          surfaces.set(nKey, tile.surface);
          push(next, nKey);
        }
      }
    }

    cache.set(target.id, dist);
    return dist;
  };

  return {
    distance(pos, target) {
      const found = fieldFor(target).get(tileKey(pos.x, pos.y));
      if (found !== undefined) return found;
      return manhattan(pos, target.pos) + fallbackBase;
    },
  };
}

const NAV_STEPS: readonly (readonly [number, number])[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** Terrain line of sight. Units do not block; raised terrain does. */
export function hasLineOfSight(field: Battlefield, from: Vec3, to: Vec3): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy)) * 2;
  if (steps <= 1) return true;
  // Sight is cast from roughly eye height (one half-tile above the feet).
  const z0 = from.z + 1;
  const z1 = to.z + 1;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const sx = Math.round(from.x + dx * t);
    const sy = Math.round(from.y + dy * t);
    if (sx === from.x && sy === from.y) continue;
    if (sx === to.x && sy === to.y) continue;
    const tile = field.tileAt(sx, sy);
    if (tile === undefined) continue;
    const beam = z0 + (z1 - z0) * t;
    if (!tile.passable && tile.height > beam) return false;
    if (tile.height > beam + 1) return false;
  }
  return true;
}

/** Tiles covered by an ability centred on `epicentre`, cast from `origin`. */
export function tilesInAoe(
  field: Battlefield,
  ability: Ability,
  origin: Vec3,
  epicentre: Vec3,
): Vec3[] {
  const { radius, shape, vertical } = ability.range;
  const out: Vec3[] = [];
  const push = (x: number, y: number): void => {
    const tile = field.tileAt(x, y);
    if (tile === undefined || tile.surface === 'void') return;
    if (Number.isFinite(vertical) && Math.abs(tile.height - epicentre.z) > vertical + 2) return;
    out.push({ x, y, z: tile.height });
  };

  if (radius <= 0 && (shape === undefined || shape === 'circle')) {
    push(epicentre.x, epicentre.y);
    return out;
  }

  switch (shape) {
    case 'cross': {
      push(epicentre.x, epicentre.y);
      for (let d = 1; d <= radius; d++) {
        push(epicentre.x + d, epicentre.y);
        push(epicentre.x - d, epicentre.y);
        push(epicentre.x, epicentre.y + d);
        push(epicentre.x, epicentre.y - d);
      }
      return out;
    }
    case 'line': {
      const facing = facingToward(origin, epicentre);
      const step = FACING_STEP[facing];
      const length = Math.max(1, ability.range.range);
      for (let d = 1; d <= length; d++) push(origin.x + step[0] * d, origin.y + step[1] * d);
      return out;
    }
    case 'cone': {
      const facing = facingToward(origin, epicentre);
      const step = FACING_STEP[facing];
      const length = Math.max(1, ability.range.range);
      for (let d = 1; d <= length; d++) {
        const halfWidth = Math.min(d - 1, radius);
        for (let w = -halfWidth; w <= halfWidth; w++) {
          const x = origin.x + step[0] * d + step[1] * w;
          const y = origin.y + step[1] * d + step[0] * w;
          push(x, y);
        }
      }
      return out;
    }
    default: {
      for (let dx = -radius; dx <= radius; dx++) {
        const span = radius - Math.abs(dx);
        for (let dy = -span; dy <= span; dy++) push(epicentre.x + dx, epicentre.y + dy);
      }
      return out;
    }
  }
}

const FACING_STEP: Readonly<Record<Facing, readonly [number, number]>> = {
  N: [0, -1],
  S: [0, 1],
  E: [1, 0],
  W: [-1, 0],
};

/** Range/vertical/LOS legality of aiming `ability` at `epicentre` from `from`. */
export function inRange(field: Battlefield, ability: Ability, from: Vec3, epicentre: Vec3): boolean {
  const r = ability.range;
  if (r.self === true) return sameTile(from, epicentre);
  const d = manhattan(from, epicentre);
  if (d > r.range) return false;
  if (Number.isFinite(r.vertical) && Math.abs(from.z - epicentre.z) > r.vertical) return false;
  if (!shapeAllows(r.shape ?? 'circle', from, epicentre, d)) return false;
  if (r.los && !hasLineOfSight(field, from, epicentre)) return false;
  return true;
}

/**
 * Whether an ability's targeting shape permits this aim point.
 *
 * `core/battle.ts` validates the aim by deriving the caster's facing from the
 * direction to the target and then running `grid.isInRange`. So the only
 * shape-dependent question is whether the aim point lies on a legal ray for that
 * derived facing:
 *
 *   circle — any tile inside the diamond.
 *   line   — a single ray along the facing, so the target must be cardinal.
 *   cross  — the four cardinal rays; same test.
 *   cone   — a 90-degree wedge about the facing, which by construction always
 *            contains the tile the facing was derived from.
 *
 * Omitting this test is not a scoring inaccuracy: it makes the evaluator propose
 * commands the reducer then throws on, which kills the turn.
 */
function shapeAllows(
  shape: NonNullable<Ability['range']['shape']>,
  from: Vec3,
  epicentre: Vec3,
  distance: number,
): boolean {
  if (shape === 'circle') return true;
  if (distance === 0) return shape !== 'line' && shape !== 'cone';
  if (shape === 'cone') return true;
  return from.x === epicentre.x || from.y === epicentre.y;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zodiac compatibility (FFT table: trine good, square bad, opposition extreme)
// ─────────────────────────────────────────────────────────────────────────────

const ZODIAC_ORDER: readonly Zodiac[] = [
  'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
  'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces',
];

export function zodiacMultiplier(a: Unit, b: Unit): number {
  if (a.zodiac === 'serpentarius' || b.zodiac === 'serpentarius') {
    return a.zodiac === b.zodiac ? 1.25 : 1;
  }
  const ia = ZODIAC_ORDER.indexOf(a.zodiac);
  const ib = ZODIAC_ORDER.indexOf(b.zodiac);
  if (ia < 0 || ib < 0) return 1;
  const d = (ia - ib + 12) % 12;
  if (d === 0) return 1.25;                       // same sign — good
  if (d === 4 || d === 8) return 1.25;            // trine — good
  if (d === 3 || d === 9) return 0.75;            // square — bad
  if (d === 6) {                                   // opposition — best or worst
    const monster = a.gender === 'monster' || b.gender === 'monster';
    if (monster) return 1;
    return a.gender === b.gender ? 0.5 : 1.5;
  }
  return 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// The AiWorld seam
// ─────────────────────────────────────────────────────────────────────────────

export interface EstimateInput {
  state: BattleState;
  actor: Unit;
  actorPos: Vec3;
  /** Facing the actor will have when the ability resolves. */
  facing: Facing;
  ability: Ability;
  target: Unit;
  targetPos: Vec3;
}

/** Everything the scorer needs to know about applying one ability to one unit. */
export interface AbilityOutcome {
  /** 0..1 probability the effect lands at all. */
  hitChance: number;
  /** Expected HP removed on a hit (pre-hit-chance). */
  damage: number;
  /** Expected HP restored on a hit (pre-hit-chance). */
  heal: number;
  /** Expected MP removed on a hit. */
  mpDamage: number;
  /** Statuses that would be applied, with their post-hit percentage. */
  statuses: readonly { status: StatusId; chance: number }[];
  /** Statuses that would be removed. */
  cures: readonly StatusId[];
  /** True when the ability would raise a KO'd unit. */
  revives: boolean;
  /** True when the target would bounce the spell back at us. */
  reflected: boolean;
}

const NO_OUTCOME: AbilityOutcome = {
  hitChance: 0, damage: 0, heal: 0, mpDamage: 0,
  statuses: [], cures: [], revives: false, reflected: false,
};

export interface AiWorld {
  /** Action abilities the unit can legally use right now (MP, silence, slot). */
  abilitiesFor(state: BattleState, unit: Unit): readonly Ability[];
  /** Tiles the unit can reach this turn, including its current tile. */
  reachable(state: BattleState, unit: Unit): readonly MoveOption[];
  /** Expected result of one ability applied to one unit. */
  estimate(input: EstimateInput): AbilityOutcome;
  ability(id: AbilityId): Ability | undefined;
  item(id: ItemId): Item | undefined;
  job(id: JobId): Job | undefined;
}

export interface AiWorldOptions {
  abilities?: ReadonlyMap<AbilityId, Ability>;
  items?: ReadonlyMap<ItemId, Item>;
  jobs?: ReadonlyMap<JobId, Job>;
  /** Replace any part of the default world with the authoritative implementation. */
  overrides?: Partial<AiWorld>;
}

/**
 * The generic Attack command. Every unit always has it; its numbers come from
 * the equipped weapon at estimate time. If the real ability table defines an
 * `attack` entry it wins (see `createAiWorld`).
 */
export const BASIC_ATTACK: Ability = {
  id: 'attack',
  name: 'Attack',
  set: 'basic',
  slot: 'action',
  description: 'Strike with the equipped weapon.',
  mp: 0,
  ct: 0,
  element: 'none',
  range: { range: 1, radius: 0, vertical: 3, los: false },
  formula: 'physical',
  power: 1,
  accuracy: 100,
  vfx: 'hit-physical',
  castAnim: 'attack',
};

/**
 * `Ability.usesWeaponRange` means the record's `range.range` is only the
 * bare-handed floor — `core/battle.ts` widens it to the equipped weapon before
 * validating the aim. The evaluator has to widen it too, or an Archer's basic
 * shot is priced as a one-tile poke and never gets proposed.
 */
function withWeaponRange(ability: Ability, reach: number): Ability {
  if (ability.usesWeaponRange !== true || reach <= ability.range.range) return ability;
  return { ...ability, range: { ...ability.range, range: reach, los: true } };
}

interface WeaponProfile {
  wp: number;
  range: number;
  element: Element;
  evade: number;
  magical: boolean;
}

export function createAiWorld(opts: AiWorldOptions = {}): AiWorld {
  const abilities = opts.abilities;
  const items = opts.items;
  const jobs = opts.jobs;

  const lookupAbility = (id: AbilityId): Ability | undefined => {
    const found = abilities?.get(id);
    if (found !== undefined) return found;
    return id === BASIC_ATTACK.id ? BASIC_ATTACK : undefined;
  };
  const lookupItem = (id: ItemId): Item | undefined => items?.get(id);
  const lookupJob = (id: JobId): Job | undefined => jobs?.get(id);

  const weaponOf = (unit: Unit): WeaponProfile => {
    const right = unit.equipment.rightHand !== undefined ? lookupItem(unit.equipment.rightHand) : undefined;
    const left = unit.equipment.leftHand !== undefined ? lookupItem(unit.equipment.leftHand) : undefined;
    const weapon = right ?? (left?.wp !== undefined ? left : undefined);
    if (weapon === undefined) {
      // Bare hands: FFT scales unarmed damage off PA and Brave.
      const brave = clamp(unit.stats.brave, 0, 100) / 100;
      return {
        wp: Math.max(1, Math.round(unit.stats.pa * (0.5 + brave * 0.5))),
        range: 1,
        element: 'none',
        evade: 0,
        magical: false,
      };
    }
    return {
      wp: weapon.wp ?? 1,
      range: weapon.range ?? 1,
      element: weapon.element ?? 'none',
      evade: weapon.wEvade ?? 0,
      magical: weapon.formula === 'magical',
    };
  };

  const evadeOf = (unit: Unit): { physical: number; magical: number } => {
    const job = lookupJob(unit.currentJob);
    const classEvade = job?.cEvade ?? 5;
    let physical = classEvade;
    let magical = 0;
    for (const slot of ['rightHand', 'leftHand', 'head', 'body', 'accessory'] as const) {
      const id = unit.equipment[slot];
      if (id === undefined) continue;
      const item = lookupItem(id);
      if (item === undefined) continue;
      physical += item.pEvade ?? 0;
      magical += item.mEvade ?? 0;
      if (slot === 'leftHand' && item.wEvade !== undefined) physical += item.wEvade;
    }
    return { physical, magical };
  };

  const defaultAbilitiesFor = (_state: BattleState, unit: Unit): readonly Ability[] => {
    const out: Ability[] = [];
    out.push(withWeaponRange(lookupAbility(BASIC_ATTACK.id) ?? BASIC_ATTACK, weaponOf(unit).range));
    if (abilities === undefined) return out;

    const silenced = hasStatus(unit, 'silence');
    const seen = new Set<AbilityId>([BASIC_ATTACK.id]);
    const consider = (id: AbilityId): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const ability = abilities.get(id);
      if (ability === undefined || ability.slot !== 'action') return;
      if (ability.mp > unit.stats.mp) return;
      if (silenced && ability.mp > 0) return;
      out.push(ability);
    };

    const primary = unit.jobs.get(unit.currentJob);
    if (primary !== undefined) for (const id of primary.learned) consider(id);
    if (unit.secondaryAction !== undefined) {
      for (const progress of unit.jobs.values()) {
        for (const id of progress.learned) {
          const ability = abilities.get(id);
          if (ability !== undefined && ability.set === unit.secondaryAction) consider(id);
        }
      }
    }
    return out;
  };

  const defaultEstimate = (input: EstimateInput): AbilityOutcome => {
    const { actor, actorPos, ability, target, targetPos, facing } = input;
    const beneficial = isBeneficialFormula(ability);
    const downed = isDowned(target);

    if (downed && ability.formula !== 'raise') return NO_OUTCOME;
    if (!downed && !isActive(target)) return NO_OUTCOME;
    if (ability.formula === 'raise' && !downed) return NO_OUTCOME;

    const weapon = weaponOf(actor);
    const zodiac = zodiacMultiplier(actor, target);
    const evade = evadeOf(target);
    const facingOfTarget = target.id === actor.id ? facing : target.facing;
    const side = relativeFacing(actorPos, targetPos, facingOfTarget);
    const sideFactor = side === 'back' ? 0 : side === 'side' ? 0.5 : 1;

    const undefended =
      hasStatus(target, 'sleep') || hasStatus(target, 'stop') || hasStatus(target, 'petrify') ||
      hasStatus(target, 'charging') || hasStatus(target, 'performing') || hasStatus(target, 'frog') ||
      hasStatus(actor, 'transparent');

    const magical = ability.formula === 'magical' || ability.formula === 'summon' ||
      ability.formula === 'drain' || ability.formula === 'heal';

    let hit = clamp01(ability.accuracy / 100);
    if (beneficial) {
      hit = 1;
    } else {
      const raw = magical ? evade.magical : evade.physical;
      const applied = undefended ? 0 : (raw / 100) * sideFactor;
      hit *= 1 - clamp01(applied);
      if (hasStatus(actor, 'blind') && !magical) hit *= 0.5;
      if (hasStatus(target, 'innocent') && magical) hit = 0;
      if (hasStatus(target, 'transparent')) hit *= 0.6;
      // Height: attacking upward is harder, downward easier (FFT ranged rule,
      // generalised here as a small accuracy nudge).
      const dz = actorPos.z - targetPos.z;
      hit *= clamp(1 + dz * 0.03, 0.8, 1.2);
    }
    hit = clamp01(hit);
    if (hit <= 0) return NO_OUTCOME;

    const faithA = clamp(actor.stats.faith, 0, 100) / 100;
    const faithB = clamp(target.stats.faith, 0, 100) / 100;
    const power = ability.power;

    let damage = 0;
    let heal = 0;
    let mpDamage = 0;
    let revives = false;

    switch (ability.formula) {
      case 'physical': {
        const base = actor.stats.pa * weapon.wp * Math.max(0.25, power);
        damage = base * zodiac;
        if (hasStatus(target, 'protect')) damage *= 2 / 3;
        if (hasStatus(target, 'defending')) damage *= 0.5;
        break;
      }
      case 'magical':
      case 'summon': {
        const base = actor.stats.ma * Math.max(1, power);
        damage = base * faithA * faithB * zodiac;
        if (hasStatus(target, 'shell')) damage *= 2 / 3;
        break;
      }
      case 'drain': {
        const base = actor.stats.ma * Math.max(1, power);
        damage = base * faithA * faithB * zodiac;
        break;
      }
      case 'heal': {
        const base = actor.stats.ma * Math.max(1, power);
        const amount = base * faithA * faithB;
        if (hasStatus(target, 'undead')) damage = amount;
        else heal = amount;
        break;
      }
      case 'fixed': {
        if (beneficial) heal = power; else damage = power;
        break;
      }
      case 'percent-hp': {
        const amount = (target.stats.maxHp * power) / 100;
        if (beneficial) heal = amount; else damage = amount;
        break;
      }
      case 'raise': {
        revives = true;
        heal = Math.max(1, (target.stats.maxHp * Math.max(1, power)) / 100);
        break;
      }
      case 'status-only':
      case 'buff':
      case 'move':
      case 'special':
        break;
    }

    if (ability.element !== 'none') {
      damage *= elementalFactor(ability.element, target);
    }
    damage = Math.max(0, Math.floor(damage));
    heal = Math.max(0, Math.floor(heal));

    // Drain steals MP when the formula is aimed at the pool rather than HP.
    if (ability.formula === 'drain') mpDamage = Math.floor(damage * 0.25);

    const statuses = (ability.inflicts ?? []).filter((s) => canReceiveStatus(target, s.status));
    const cures = (ability.cures ?? []).filter((s) => hasStatus(target, s));

    const reflected =
      hasStatus(target, 'reflect') && magical && !beneficial && ability.range.radius === 0;

    return {
      hitChance: hit,
      damage,
      heal,
      mpDamage,
      statuses: statuses.map((s) => ({ status: s.status, chance: clamp(s.chance, 0, 100) })),
      cures,
      revives,
      reflected,
    };
  };

  const base: AiWorld = {
    abilitiesFor: defaultAbilitiesFor,
    reachable: (state, unit) => computeReachable(state, unit, { jump: lookupJob(unit.currentJob)?.jump }),
    estimate: defaultEstimate,
    ability: lookupAbility,
    item: lookupItem,
    job: lookupJob,
  };
  return { ...base, ...(opts.overrides ?? {}) };
}

function elementalFactor(element: Element, target: Unit): number {
  if (element === 'fire' && hasStatus(target, 'oil')) return 2;
  if (element === 'fire' && hasStatus(target, 'burning')) return 1.25;
  if (element === 'earth' && hasStatus(target, 'float')) return 0;
  if (element === 'holy' && hasStatus(target, 'undead')) return 1.5;
  if (element === 'dark' && hasStatus(target, 'undead')) return 0.5;
  return 1;
}

function canReceiveStatus(target: Unit, status: StatusId): boolean {
  if (hasStatus(target, status)) return false;
  if (status !== 'ko' && hasStatus(target, 'ko')) return false;
  return true;
}

/** Formulas whose intent is to help the target rather than hurt it. */
export function isBeneficialFormula(ability: Ability): boolean {
  switch (ability.formula) {
    case 'heal':
    case 'raise':
    case 'buff':
      return true;
    case 'status-only':
      return (ability.cures?.length ?? 0) > 0 && (ability.inflicts?.length ?? 0) === 0;
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status valuation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How much it is worth to put `status` on an enemy (positive) or to have it on
 * an ally (negative for debuffs, positive for buffs). Scale is roughly
 * "fraction of a unit's usefulness", so 1.0 ≈ removing the unit from the fight.
 */
const STATUS_VALUE: Partial<Record<StatusId, number>> = {
  ko: 1, crystal: 1, petrify: 1, stop: 0.85, sleep: 0.7, charm: 0.9, confuse: 0.65,
  'death-sentence': 0.8, frog: 0.6, chicken: 0.5, berserk: 0.45, silence: 0.5,
  blind: 0.4, slow: 0.4, poison: 0.3, oil: 0.2, rooted: 0.45, vulnerable: 0.35,
  bleeding: 0.3, burning: 0.3, mark: 0.25, taunted: 0.3, undead: 0.4,
  // Buffs — value of having them on your own side.
  haste: -0.5, protect: -0.35, shell: -0.35, regen: -0.3, reraise: -0.6,
  shielded: -0.4, empowered: -0.4, float: -0.1, reflect: -0.35, transparent: -0.4,
  faith: -0.15, innocent: -0.15, 'evade-next': -0.25, stealth: -0.3, defending: -0.1,
};

/** Positive: bad to receive. Negative: good to receive. */
export function statusValue(status: StatusId): number {
  return STATUS_VALUE[status] ?? 0.1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Threat analysis
// ─────────────────────────────────────────────────────────────────────────────

export interface ThreatSource {
  unit: Unit;
  /** Expected damage this unit can put on the actor if it commits its turn. */
  damage: number;
  /** Move + best ability range: the radius within which it can reach us. */
  reach: number;
  /** True when it has an area ability — makes clustering dangerous. */
  aoe: boolean;
}

export interface ThreatField {
  sources: readonly ThreatSource[];
  /** Expected incoming damage at a tile, in raw HP. */
  at(pos: Vec3): number;
  /** Threat-weighted list of directions we should not turn our back on. */
  weightedSources: readonly ThreatSource[];
}

export function buildThreatField(
  state: BattleState,
  actor: Unit,
  world: AiWorld,
  nav?: NavGraph,
): ThreatField {
  const graph = nav ?? createNavGraph(state.field, world.job(actor.currentJob)?.jump ?? actor.stats.jump);
  const sources: ThreatSource[] = [];
  for (const other of state.units.values()) {
    if (!isActive(other) || !isHostileTo(actor, other)) continue;
    const abilities = world.abilitiesFor(state, other);
    let best = 0;
    let aoe = false;
    for (const ability of abilities) {
      if (ability.range.radius > 0) aoe = true;
      if (isBeneficialFormula(ability)) continue;
      const outcome = world.estimate({
        state,
        actor: other,
        actorPos: other.pos,
        facing: other.facing,
        ability,
        target: actor,
        targetPos: actor.pos,
      });
      const expected = outcome.damage * outcome.hitChance;
      if (expected > best) best = expected;
    }
    let reach = other.stats.move;
    for (const ability of abilities) {
      if (isBeneficialFormula(ability)) continue;
      reach = Math.max(reach, other.stats.move + ability.range.range);
    }
    if (hasStatus(other, 'stop') || hasStatus(other, 'sleep') || hasStatus(other, 'petrify')) {
      // It is not getting a turn any time soon; discount heavily.
      best *= 0.2;
    }
    sources.push({ unit: other, damage: best, reach, aoe });
  }

  const at = (pos: Vec3): number => {
    let total = 0;
    for (const src of sources) {
      // Walking distance, not Manhattan: an enemy on the far side of a cliff it
      // cannot climb is not a threat to this tile no matter how near it looks.
      const d = graph.distance(pos, src.unit);
      const envelope = src.reach + 2;
      if (d > envelope) continue;
      // Danger grows smoothly as the gap closes rather than switching on at the
      // edge of the reach envelope. A step function there is a wall in the score
      // landscape sitting exactly where two advancing squads meet, and neither
      // side will ever be the one to climb it: both hold at reach + 1 and the
      // battle never happens. It is also the more honest model — a unit that has
      // to spend its whole move to touch you is less dangerous than one already
      // in your face, which can strike and still reposition.
      const proximity = clamp01((envelope - d) / envelope);
      // Standing well above an attacker is genuinely safer: it costs Jump and
      // movement to come up after you.
      const dz = pos.z - src.unit.pos.z;
      const heightGuard = dz > 0 ? clamp(1 - dz * 0.06, 0.6, 1) : clamp(1 - dz * 0.03, 1, 1.2);
      total += src.damage * proximity * heightGuard;
    }
    return total;
  };

  return { sources, at, weightedSources: sources };
}

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

export interface AiBudget {
  /** Hard cap on destination tiles examined. */
  maxTiles: number;
  /** Hard cap on epicentres per ability. */
  maxEpicentres: number;
  /** Hard cap on scored candidates. */
  maxCandidates: number;
}

export const DEFAULT_BUDGET: AiBudget = {
  maxTiles: 60,
  maxEpicentres: 24,
  maxCandidates: 4000,
};

export interface AiContext {
  state: BattleState;
  actor: Unit;
  world: AiWorld;
  personality: Personality;
  weights: Record<ScoreTerm, number>;
  hostiles: Unit[];
  friends: Unit[];
  downedFriends: Unit[];
  threat: ThreatField;
  occupied: Map<number, Unit>;
  /** Unit whose taunt currently compels us, if any. */
  taunter?: Unit;
  /** Ally this unit is assigned to protect. */
  guardTarget?: Unit;
  budget: AiBudget;
  /**
   * Walking distance over the terrain, for this actor's Jump. Every "how close
   * am I?" question goes through here rather than through `manhattan`.
   */
  nav: NavGraph;
  /** True when the personality's survival mindset is engaged. */
  survival: boolean;
  /**
   * The distance this unit actually wants to hold, which is the personality's
   * intent clamped by what it can reach from there. See `effectiveStandoff`.
   */
  standoff: number;
  /**
   * Separation at which terrain and facing tactics stop meaning anything —
   * the furthest a hostile could strike us from, or we them. See `scorePosition`.
   */
  contactRadius: number;
  /** Board-scale denominator for the long tail of the approach term. */
  approachScale: number;
  /**
   * 1 early in a battle, decaying toward `MIN_CAUTION` as the clock runs.
   * Scales the self-preservation terms. See `battleCaution`.
   */
  caution: number;
}

export interface BuildContextOptions {
  world: AiWorld;
  personality: Personality;
  weights: Record<ScoreTerm, number>;
  survival: boolean;
  guardTarget?: UnitId;
  budget?: AiBudget;
}

export function buildContext(
  state: BattleState,
  actor: Unit,
  opts: BuildContextOptions,
): AiContext {
  const hostiles: Unit[] = [];
  const friends: Unit[] = [];
  const downedFriends: Unit[] = [];
  const flipped = isCharmedOrConfused(actor);

  for (const other of state.units.values()) {
    if (other.removed || other.id === actor.id) continue;
    let hostile = isHostileTo(actor, other);
    let ally = isAllyOf(actor, other);
    if (flipped) {
      const swap = hostile;
      hostile = ally;
      ally = swap;
    }
    if (isActive(other)) {
      if (hostile) hostiles.push(other);
      else if (ally) friends.push(other);
    } else if (isDowned(other) && ally) {
      downedFriends.push(other);
    }
  }
  // Deterministic ordering — Map iteration order is insertion order, but scenario
  // loaders may vary; sorting by id makes AI output reproducible.
  hostiles.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  friends.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  downedFriends.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const taunterId = statusSource(actor, 'taunted');
  const taunterUnit = taunterId !== undefined ? state.units.get(taunterId) : undefined;
  const taunter = taunterUnit !== undefined && isActive(taunterUnit) ? taunterUnit : undefined;

  const guardUnit = opts.guardTarget !== undefined ? state.units.get(opts.guardTarget) : undefined;

  const nav = createNavGraph(
    state.field,
    opts.world.job(actor.currentJob)?.jump ?? actor.stats.jump,
  );
  const threat = buildThreatField(state, actor, opts.world, nav);
  const standoff = effectiveStandoff(state, actor, opts.world, opts.personality);

  const ctx: AiContext = {
    state,
    actor,
    world: opts.world,
    personality: opts.personality,
    weights: opts.weights,
    hostiles,
    friends,
    downedFriends,
    threat,
    occupied: occupancyMap(state),
    budget: opts.budget ?? DEFAULT_BUDGET,
    nav,
    survival: opts.survival,
    standoff,
    contactRadius: contactRadius(actor, threat, standoff),
    approachScale: Math.max(APPROACH_SPAN, state.field.width + state.field.height),
    caution: battleCaution(state.tick),
  };
  if (taunter !== undefined) ctx.taunter = taunter;
  if (guardUnit !== undefined && isActive(guardUnit)) ctx.guardTarget = guardUnit;
  return ctx;
}

/** Tiles of separation over which the approach term pulls hardest. */
const APPROACH_SPAN = 12;

/**
 * The distance this unit actually wants to hold from the nearest hostile.
 *
 * A personality's `standoff` is an *intent* ("casters hang back"), not a
 * capability. A unit whose longest offensive reach is a dagger cannot pot-shot
 * from five tiles, and scoring it as though it could is what turns two cautious
 * squads into a staring contest: both sides sit at their nominal standoff, both
 * are out of range of everything they own, and nobody ever throws a punch.
 */
function effectiveStandoff(
  state: BattleState,
  actor: Unit,
  world: AiWorld,
  personality: Personality,
): number {
  let reach = 1;
  for (const ability of world.abilitiesFor(state, actor)) {
    if (ability.slot !== 'action') continue;
    if (ability.range.self === true) continue;
    if (isBeneficialFormula(ability)) continue;
    if (ability.mp > actor.stats.mp) continue;
    if (ability.range.range > reach) reach = ability.range.range;
  }
  return Math.max(1, Math.min(personality.standoff, reach));
}

/**
 * The separation beyond which terrain and facing stop being tactics and become
 * decoration: the furthest a hostile could strike us from, or we them.
 *
 * Height, chokepoints, clustering and body-blocking are all priced against the
 * *engagement that is about to happen*. Priced against units half a map away
 * they are noise with a large weight attached, and that noise is a landscape:
 * every archetype rolls downhill into whichever corner of the map is tallest
 * and stays there. Ramping those terms off with distance is what lets the
 * approach term own the open field without lobotomising the tactician.
 */
function contactRadius(actor: Unit, threat: ThreatField, standoff: number): number {
  let radius = actor.stats.move + standoff;
  for (const source of threat.sources) {
    if (source.reach > radius) radius = source.reach;
  }
  return Math.max(2, radius);
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate enumeration
// ─────────────────────────────────────────────────────────────────────────────

export interface Candidate {
  /** Destination. Equal to the actor's current tile when it stays put. */
  pos: Vec3;
  /** Undefined when the candidate does not move. */
  move?: MoveOption;
  /**
   * Set when the ability is executed *before* the move — the strike-and-retreat
   * pattern. The value is the tile the ability is cast from (always the actor's
   * starting tile); `pos` is where the unit ends up afterwards.
   */
  actFrom?: Vec3;
  ability?: Ability;
  /** Tile the ability is aimed at. */
  targetTile?: Vec3;
  /** Primary unit the ability is aimed at, when it targets a unit. */
  targetUnit?: UnitId;
  /** Facing the actor ends the turn with. */
  facing: Facing;
  /** True when the same ability+target is legal from the actor's starting tile. */
  actableFromOrigin: boolean;
  score: number;
  terms: Record<ScoreTerm, number>;
  /** Debug/telemetry: probability a charged ability still connects. */
  prediction: number;
}

/**
 * The facing that leaves us least exposed at `pos`, weighted by how much damage
 * each threat can actually deliver. Ties resolve N→E→S→W for determinism.
 */
export function bestDefensiveFacing(ctx: AiContext, pos: Vec3): Facing {
  const relevant = ctx.threat.sources.filter(
    (s) => ctx.nav.distance(pos, s.unit) <= s.reach + 1,
  );
  if (relevant.length === 0) {
    // Nobody can reach us — look at whatever we are most likely to engage next.
    let nearest: Unit | undefined;
    let best = Infinity;
    for (const hostile of ctx.hostiles) {
      const d = ctx.nav.distance(pos, hostile);
      if (d < best) {
        best = d;
        nearest = hostile;
      }
    }
    return nearest === undefined ? ctx.actor.facing : facingToward(pos, nearest.pos);
  }
  let bestFacing: Facing = 'N';
  let bestExposure = Infinity;
  for (const facing of ['N', 'E', 'S', 'W'] as const) {
    let exposure = 0;
    for (const source of relevant) {
      const side = relativeFacing(source.unit.pos, pos, facing);
      const weight = Math.max(1, source.damage);
      exposure += weight * (side === 'back' ? 1 : side === 'side' ? 0.5 : 0);
    }
    if (exposure < bestExposure) {
      bestExposure = exposure;
      bestFacing = facing;
    }
  }
  return bestFacing;
}

function emptyTerms(): Record<ScoreTerm, number> {
  return {
    damage: 0, kill: 0, mpDrain: 0, statusInflict: 0, overkill: 0,
    heal: 0, revive: 0, statusCure: 0,
    friendlyFire: 0, friendlyStatus: 0, mpCost: 0, wasteRisk: 0,
    height: 0, facingSafety: 0, flankRisk: 0, threatExposure: 0, clusterRisk: 0,
    chokepoint: 0, guardAlly: 0, closeDistance: 0, keepDistance: 0,
    lowHpTarget: 0, squishyTarget: 0, taunt: 0,
    terrainHazard: 0, selfRisk: 0, idle: 0,
  };
}

/**
 * Trim the reachable set to the budget, keeping the tiles most likely to matter:
 * the origin, tiles near hostiles, tiles on high ground, and low-threat tiles.
 */
function pruneDestinations(ctx: AiContext, options: readonly MoveOption[]): MoveOption[] {
  if (options.length <= ctx.budget.maxTiles) return [...options];
  const origin = ctx.actor.pos;
  const scored = options.map((option) => {
    let value = 0;
    let nearest = Infinity;
    for (const hostile of ctx.hostiles) {
      const d = ctx.nav.distance(option.pos, hostile);
      if (d < nearest) nearest = d;
      value += (option.pos.z - hostile.pos.z) * 0.15;
    }
    if (Number.isFinite(nearest)) {
      value -= Math.abs(nearest - ctx.standoff) * 0.8;
    }
    value -= ctx.threat.at(option.pos) / Math.max(1, ctx.actor.stats.maxHp) * 2;
    if (sameTile(option.pos, origin)) value += 5; // always keep "stand still"
    return { option, value };
  });
  scored.sort((a, b) => b.value - a.value);
  return scored.slice(0, ctx.budget.maxTiles).map((s) => s.option);
}

/**
 * Candidate aim points for an ability, computed once per ability rather than
 * once per (tile, ability) pair. For single-tile abilities these are simply the
 * units worth hitting; for area abilities we also consider offsets around them
 * so the AI can find multi-hit placements, and predicted positions for charged
 * spells so it can lead a moving target.
 */
function candidateEpicentres(ctx: AiContext, ability: Ability): Vec3[] {
  const field = ctx.state.field;
  const seen = new Set<number>();
  const out: Vec3[] = [];
  const push = (x: number, y: number): void => {
    const key = tileKey(x, y);
    if (seen.has(key)) return;
    const tile = field.tileAt(x, y);
    if (tile === undefined || tile.surface === 'void') return;
    seen.add(key);
    out.push({ x, y, z: tile.height });
  };

  if (ability.range.self === true) {
    push(ctx.actor.pos.x, ctx.actor.pos.y);
    return out;
  }

  const beneficial = isBeneficialFormula(ability);
  const anchors: Unit[] = beneficial
    ? [ctx.actor, ...ctx.friends, ...(ability.formula === 'raise' ? ctx.downedFriends : [])]
    : ctx.hostiles;

  const radius = ability.range.radius;
  for (const anchor of anchors) {
    push(anchor.pos.x, anchor.pos.y);
    if (radius > 0) {
      for (let dx = -radius; dx <= radius; dx++) {
        const span = radius - Math.abs(dx);
        for (let dy = -span; dy <= span; dy++) {
          if (dx === 0 && dy === 0) continue;
          push(anchor.pos.x + dx, anchor.pos.y + dy);
        }
      }
    }
    if (ability.ct > 0 && !beneficial) {
      const predicted = predictPosition(ctx, anchor, ability.ct);
      if (predicted !== undefined) push(predicted.x, predicted.y);
    }
    if (out.length >= ctx.budget.maxEpicentres * 4) break;
  }
  return out;
}

/**
 * Where a unit is likely to be after `ticks` clock ticks. Units walk toward the
 * nearest thing they want to hit; that is a good enough model to lead a spell.
 * Returns undefined when the unit will not act in time or cannot move.
 */
export function predictPosition(ctx: AiContext, unit: Unit, ticks: number): Vec3 | undefined {
  const turns = expectedTurns(unit, ticks);
  if (turns <= 0) return undefined;
  if (hasStatus(unit, 'stop') || hasStatus(unit, 'sleep') || hasStatus(unit, 'petrify') ||
      hasStatus(unit, 'rooted') || hasStatus(unit, 'charging')) {
    return undefined;
  }
  // The unit's own goal: the nearest unit hostile to it.
  let goal: Unit | undefined;
  let bestDistance = Infinity;
  for (const other of ctx.state.units.values()) {
    if (!isActive(other) || !isHostileTo(unit, other)) continue;
    const d = manhattan(unit.pos, other.pos);
    if (d < bestDistance) {
      bestDistance = d;
      goal = other;
    }
  }
  if (goal === undefined) return undefined;

  const budget = Math.min(turns * unit.stats.move, Math.max(0, bestDistance - 1));
  if (budget <= 0) return undefined;

  // Walk greedily along the dominant axis, then the other, respecting terrain.
  let x = unit.pos.x;
  let y = unit.pos.y;
  let z = unit.pos.z;
  const field = ctx.state.field;
  for (let step = 0; step < budget; step++) {
    const dx = goal.pos.x - x;
    const dy = goal.pos.y - y;
    if (dx === 0 && dy === 0) break;
    const tryOrder: [number, number][] = Math.abs(dx) >= Math.abs(dy)
      ? [[Math.sign(dx), 0], [0, Math.sign(dy)]]
      : [[0, Math.sign(dy)], [Math.sign(dx), 0]];
    let moved = false;
    for (const [sx, sy] of tryOrder) {
      if (sx === 0 && sy === 0) continue;
      const tile = field.tileAt(x + sx, y + sy);
      if (tile === undefined || !tile.passable || tile.surface === 'void') continue;
      if (Math.abs(tile.height - z) > unit.stats.jump) continue;
      x += sx;
      y += sy;
      z = tile.height;
      moved = true;
      break;
    }
    if (!moved) break;
  }
  if (x === unit.pos.x && y === unit.pos.y) return undefined;
  return { x, y, z };
}

/** How many turns a unit is expected to take within `ticks` clock ticks. */
export function expectedTurns(unit: Unit, ticks: number): number {
  const spd = Math.max(1, unit.stats.spd);
  const slowed = hasStatus(unit, 'slow') ? 0.66 : hasStatus(unit, 'haste') ? 1.5 : 1;
  return Math.floor((unit.ct + spd * slowed * ticks) / 100);
}

/**
 * Probability that a charged ability aimed at `epicentre` still catches
 * `target` when it fires. 1 for instant abilities and immobilised targets.
 */
export function chargePrediction(
  ctx: AiContext,
  ability: Ability,
  target: Unit,
  covered: ReadonlySet<number>,
): number {
  if (ability.ct <= 0) return 1;
  const turns = expectedTurns(target, ability.ct);
  if (turns <= 0) return 1;
  if (hasStatus(target, 'stop') || hasStatus(target, 'sleep') || hasStatus(target, 'petrify') ||
      hasStatus(target, 'rooted') || hasStatus(target, 'charging') || hasStatus(target, 'performing')) {
    return 1;
  }

  const coversCurrent = covered.has(tileKey(target.pos.x, target.pos.y));
  const predicted = predictPosition(ctx, target, ability.ct);
  const coversPredicted =
    predicted !== undefined && covered.has(tileKey(predicted.x, predicted.y));

  // Spread of plausible destinations after `turns` moves, as a diamond area.
  const spread = Math.max(1, turns * Math.max(1, target.stats.move));
  const spreadArea = 2 * spread * spread + 2 * spread + 1;
  const areaRatio = clamp01(covered.size / spreadArea);

  let p = areaRatio * 0.3;
  if (coversCurrent) p += 0.3;      // targets often hold position or come back
  if (coversPredicted) p += 0.45;   // we led the shot correctly
  return clamp01(p);
}

/**
 * Every legal (destination, ability, aim point) triple, scored.
 * Sorted best-first. Always contains at least one entry (stand still and wait).
 */
export function enumerateCandidates(ctx: AiContext): Candidate[] {
  const { state, actor, world } = ctx;
  const field = state.field;
  const destinations = pruneDestinations(ctx, world.reachable(state, actor));
  const abilities = filterAbilities(ctx, world.abilitiesFor(state, actor));

  const epicentresByAbility = new Map<AbilityId, Vec3[]>();
  for (const ability of abilities) epicentresByAbility.set(ability.id, candidateEpicentres(ctx, ability));

  const candidates: Candidate[] = [];

  for (const destination of destinations) {
    const isOrigin = sameTile(destination.pos, actor.pos);

    // ── pure movement (no action) ──
    const moveOnly: Candidate = {
      pos: destination.pos,
      facing: bestDefensiveFacing(ctx, destination.pos),
      actableFromOrigin: false,
      score: 0,
      terms: emptyTerms(),
      prediction: 1,
    };
    if (!isOrigin) moveOnly.move = destination;
    scoreCandidate(ctx, moveOnly);
    candidates.push(moveOnly);

    for (const ability of abilities) {
      const base = epicentresByAbility.get(ability.id);
      if (base === undefined) continue;
      // After a move the actor's own aim point is the destination, not the tile
      // it is standing on now — otherwise it can never buff itself and then walk.
      const epicentres =
        !isOrigin && isBeneficialFormula(ability) ? [destination.pos, ...base] : base;
      let used = 0;
      for (const epicentre of epicentres) {
        if (used >= ctx.budget.maxEpicentres) break;
        if (!inRange(field, ability, destination.pos, epicentre)) continue;
        used++;

        const covered = tilesInAoe(field, ability, destination.pos, epicentre);
        if (covered.length === 0) continue;
        const affected = unitsOnTiles(ctx, covered, destination.pos);
        if (affected.length === 0 && ability.targetsTiles !== true) continue;

        const primary = pickPrimaryTarget(ctx, ability, epicentre, affected);
        const candidate: Candidate = {
          pos: destination.pos,
          ability,
          targetTile: epicentre,
          facing: facingToward(destination.pos, epicentre),
          actableFromOrigin: isOrigin || inRange(field, ability, actor.pos, epicentre),
          score: 0,
          terms: emptyTerms(),
          prediction: 1,
        };
        if (!isOrigin) candidate.move = destination;
        if (primary !== undefined) candidate.targetUnit = primary.id;
        scoreCandidate(ctx, candidate, covered, affected, primary);
        candidates.push(candidate);

        if (candidates.length >= ctx.budget.maxCandidates) break;
      }
      if (candidates.length >= ctx.budget.maxCandidates) break;
    }
    if (candidates.length >= ctx.budget.maxCandidates) break;
  }

  // ── strike-and-retreat pass ──
  // Everything above ties the action to the tile we end on. FFT lets a unit act
  // first and *then* move, which is how you attack and step back out of reach.
  // Take the best few "act from where I stand" plans and re-price them with a
  // move appended.
  const fromOrigin = candidates
    .filter((c) => c.ability !== undefined && c.move === undefined && c.actFrom === undefined)
    .sort(compareCandidates)
    .slice(0, RETREAT_SEEDS);

  for (const seed of fromOrigin) {
    for (const destination of destinations) {
      if (sameTile(destination.pos, actor.pos)) continue;
      const variant: Candidate = {
        pos: destination.pos,
        move: destination,
        actFrom: { ...actor.pos },
        facing: bestDefensiveFacing(ctx, destination.pos),
        actableFromOrigin: true,
        score: 0,
        terms: emptyTerms(),
        prediction: 1,
      };
      if (seed.ability !== undefined) variant.ability = seed.ability;
      if (seed.targetTile !== undefined) variant.targetTile = seed.targetTile;
      if (seed.targetUnit !== undefined) variant.targetUnit = seed.targetUnit;
      scoreCandidate(ctx, variant);
      candidates.push(variant);
    }
  }

  candidates.sort(compareCandidates);
  return candidates;
}

/** How many "act without moving" plans get a strike-and-retreat variant. */
const RETREAT_SEEDS = 4;

/** Deterministic best-first ordering. */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score;
  // Stable tie-breaks so replays match: prefer acting, then the nearer tile.
  const aActs = a.ability === undefined ? 1 : 0;
  const bActs = b.ability === undefined ? 1 : 0;
  if (aActs !== bActs) return aActs - bActs;
  const aCost = a.move?.cost ?? 0;
  const bCost = b.move?.cost ?? 0;
  if (aCost !== bCost) return aCost - bCost;
  if (a.pos.y !== b.pos.y) return a.pos.y - b.pos.y;
  return a.pos.x - b.pos.x;
}

/** Drop abilities we cannot pay for or that a status forbids this turn. */
function filterAbilities(ctx: AiContext, abilities: readonly Ability[]): Ability[] {
  const actor = ctx.actor;
  const silenced = hasStatus(actor, 'silence');
  const berserk = hasStatus(actor, 'berserk');
  const out: Ability[] = [];
  for (const ability of abilities) {
    if (ability.slot !== 'action') continue;
    if (ability.mp > actor.stats.mp) continue;
    if (silenced && ability.mp > 0) continue;
    // Berserk removes access to everything except the plain attack.
    if (berserk && ability.id !== BASIC_ATTACK.id) continue;
    out.push(ability);
  }
  if (out.length === 0) out.push(BASIC_ATTACK);
  return out;
}

/**
 * Units standing on `tiles`.
 *
 * `actorPos` is where the actor will be standing when the ability lands, which is
 * not where it is standing now whenever the plan moves first. Without this the
 * evaluator will happily aim a self-buff at the tile the actor is about to
 * vacate: the occupancy snapshot still shows it there, the candidate scores as a
 * valid self-target, and the reducer then rejects the command because nothing is
 * on the aim tile by the time it arrives.
 */
function unitsOnTiles(ctx: AiContext, tiles: readonly Vec3[], actorPos?: Vec3): Unit[] {
  const out: Unit[] = [];
  const fromKey = tileKey(ctx.actor.pos.x, ctx.actor.pos.y);
  const toKey = actorPos === undefined ? fromKey : tileKey(actorPos.x, actorPos.y);
  const moving = toKey !== fromKey;

  for (const tile of tiles) {
    const key = tileKey(tile.x, tile.y);
    if (moving) {
      if (key === fromKey) continue; // the actor will have left this tile
      if (key === toKey) {
        out.push(ctx.actor);
        continue;
      }
    }
    const unit = ctx.occupied.get(key);
    if (unit === undefined || unit.removed) continue;
    out.push(unit);
  }
  return out;
}

function pickPrimaryTarget(
  ctx: AiContext,
  ability: Ability,
  epicentre: Vec3,
  affected: readonly Unit[],
): Unit | undefined {
  const beneficial = isBeneficialFormula(ability);
  let best: Unit | undefined;
  let bestScore = -Infinity;
  for (const unit of affected) {
    const wanted = beneficial ? !isHostileTo(ctx.actor, unit) : isHostileTo(ctx.actor, unit);
    if (!wanted && affected.length > 1) continue;
    // Prefer the unit standing on the aim point, then the most relevant one.
    let score = sameTile(unit.pos, epicentre) ? 10 : 0;
    score += wanted ? 5 : 0;
    score += 1 - unit.stats.hp / Math.max(1, unit.stats.maxHp);
    if (score > bestScore) {
      bestScore = score;
      best = unit;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fill in `candidate.terms` and `candidate.score`.
 * `covered`/`affected`/`primary` are passed in when already computed by the
 * enumerator; they are recomputed otherwise so this stays callable standalone.
 */
export function scoreCandidate(
  ctx: AiContext,
  candidate: Candidate,
  coveredIn?: readonly Vec3[],
  affectedIn?: readonly Unit[],
  primaryIn?: Unit,
): Candidate {
  const { actor, state, world, personality } = ctx;
  const terms = candidate.terms;
  const maxHp = Math.max(1, actor.stats.maxHp);

  // ── action terms ──
  if (candidate.ability !== undefined && candidate.targetTile !== undefined) {
    const ability = candidate.ability;
    const epicentre = candidate.targetTile;
    // When the plan is strike-then-retreat the ability resolves from the tile we
    // are standing on now, not from where we end the turn.
    const actPos = candidate.actFrom ?? candidate.pos;
    const actFacing = facingToward(actPos, epicentre);
    const covered = coveredIn ?? tilesInAoe(state.field, ability, actPos, epicentre);
    const affected = affectedIn ?? unitsOnTiles(ctx, covered);
    const primary = primaryIn ?? pickPrimaryTarget(ctx, ability, epicentre, affected);

    const coveredKeys = new Set<number>();
    for (const tile of covered) coveredKeys.add(tileKey(tile.x, tile.y));

    let prediction = 1;
    let dealt = 0;

    for (const unit of affected) {
      const outcome = world.estimate({
        state,
        actor,
        actorPos: actPos,
        facing: actFacing,
        ability,
        target: unit,
        targetPos: unit.pos,
      });
      if (outcome.hitChance <= 0) continue;

      const unitPrediction = chargePrediction(ctx, ability, unit, coveredKeys);
      if (isHostileTo(actor, unit)) prediction = Math.min(prediction, unitPrediction);

      const hostile = isHostileTo(actor, unit);
      const targetMax = Math.max(1, unit.stats.maxHp);
      // `gambler` softens the probability discount so risk-takers chase upsets.
      const rawP = outcome.hitChance * unitPrediction;
      const p = clamp01(rawP + (1 - rawP) * personality.gambler * 0.3);

      if (outcome.reflected) {
        // The spell comes back at us — treat as self-inflicted damage.
        terms.friendlyFire += (outcome.damage / maxHp) * outcome.hitChance;
        continue;
      }

      if (outcome.damage > 0) {
        const effective = Math.min(outcome.damage, unit.stats.hp);
        const waste = Math.max(0, outcome.damage - unit.stats.hp);
        if (hostile) {
          terms.damage += (effective / targetMax) * p;
          terms.overkill += (waste / targetMax) * p;
          terms.kill += outcome.damage >= unit.stats.hp ? p : 0;
          dealt += effective * p;
        } else {
          // Our own side (or ourselves) caught in the blast.
          terms.friendlyFire += (effective / targetMax) * rawP;
          if (outcome.damage >= unit.stats.hp) terms.friendlyFire += 1.2 * rawP;
        }
      }

      if (outcome.heal > 0) {
        const missing = Math.max(0, unit.stats.maxHp - unit.stats.hp);
        const effective = Math.min(outcome.heal, Math.max(missing, outcome.revives ? outcome.heal : 0));
        if (!hostile) {
          terms.heal += (effective / targetMax) * p;
          if (outcome.revives) terms.revive += p;
        }
      }

      if (outcome.mpDamage > 0 && hostile) {
        terms.mpDrain += (outcome.mpDamage / Math.max(1, unit.stats.maxMp)) * p;
      }

      for (const inflicted of outcome.statuses) {
        const chance = p * clamp01(inflicted.chance / 100);
        const value = statusValue(inflicted.status);
        if (hostile) {
          if (value > 0) terms.statusInflict += value * chance;
          else terms.friendlyStatus += -value * chance * 0.5; // buffing an enemy
        } else {
          if (value > 0) terms.friendlyStatus += value * chance;
          else terms.statusCure += -value * chance;
        }
      }

      for (const cured of outcome.cures) {
        const value = statusValue(cured);
        if (!hostile && value > 0) terms.statusCure += value * p;
        if (hostile && value < 0) terms.statusInflict += -value * p * 0.5; // stripping a buff
      }
    }

    candidate.prediction = prediction;
    terms.wasteRisk = 1 - prediction;
    terms.mpCost = (ability.mp / Math.max(1, actor.stats.maxMp)) / Math.max(0.1, personality.mpFreedom);

    if (primary !== undefined) {
      terms.lowHpTarget = 1 - primary.stats.hp / Math.max(1, primary.stats.maxHp);
      terms.squishyTarget = squishiness(ctx, primary);
      if (ctx.taunter !== undefined && primary.id === ctx.taunter.id && dealt > 0) terms.taunt = 1;
    }
  } else {
    // A turn that lands no ability is idle whether or not we shuffled our feet.
    // Discounting the penalty for having moved pays a unit to wander: parked on
    // a positional optimum it will step off and step back forever, because both
    // halves of the shuffle score better than holding still. Whatever a step is
    // actually worth is already priced by the positional terms.
    terms.idle = 1;
  }

  // ── positional terms (independent of the action) ──
  scorePosition(ctx, candidate);

  let total = 0;
  for (const key of Object.keys(terms) as ScoreTerm[]) {
    const weight = ctx.weights[key];
    total += terms[key] * weight;
  }
  candidate.score = total;
  return candidate;
}

/** Positional half of the evaluation: where we end up and which way we look. */
export function scorePosition(ctx: AiContext, candidate: Candidate): void {
  const { actor, state, threat } = ctx;
  const terms = candidate.terms;
  const pos = candidate.pos;
  const maxHp = Math.max(1, actor.stats.maxHp);
  const field = state.field;

  // Distance to the nearest hostile, and the engagement-distance fit. This is
  // walking distance (see `NavGraph`): if the enemy is two tiles away across a
  // gorge, we are not engaged and the approach term must still be pulling.
  let nearest = Infinity;
  for (const hostile of ctx.hostiles) {
    const d = ctx.nav.distance(pos, hostile);
    if (d < nearest) nearest = d;
  }
  const standoff = ctx.standoff;
  if (Number.isFinite(nearest)) {
    const gap = nearest - standoff;
    if (gap <= 0) {
      // Inside our preferred range: still fine, but crowding a caster's face is
      // worse than sitting at the sweet spot.
      terms.closeDistance = clamp01(1 + gap / Math.max(2, standoff));
    } else {
      // Two pieces. The near band is the one that actually drives an advance;
      // the shallow board-scale tail exists so that a unit stranded on the far
      // side of a large map still gains something by taking the step in, rather
      // than sitting on a plateau where every destination scores identically.
      const near = 1 - clamp01(gap / APPROACH_SPAN);
      const far = 1 - clamp01(gap / ctx.approachScale);
      terms.closeDistance = near * 0.8 + far * 0.2;
    }
    // Backing off only buys anything up to the range we can still shoot from.
    terms.keepDistance = clamp01(nearest / Math.max(1, standoff)) * ctx.caution;
  } else {
    terms.closeDistance = 0;
    terms.keepDistance = 1;
  }

  // How much the positional game matters here: 1 in contact, tapering to 0 out
  // where nobody can reach anybody. Smooth on purpose — a hard cutoff is a cliff
  // in the score landscape, and a unit straddling a cliff oscillates across it.
  const engagement = Number.isFinite(nearest)
    ? clamp01((ctx.contactRadius + 2 - nearest) / (ctx.contactRadius + 2))
    : 0;

  // Height advantage over the hostiles that matter (the three nearest).
  const nearestHostiles = [...ctx.hostiles]
    .sort((a, b) => ctx.nav.distance(pos, a) - ctx.nav.distance(pos, b))
    .slice(0, 3);
  if (nearestHostiles.length > 0) {
    let sum = 0;
    for (const hostile of nearestHostiles) sum += pos.z - hostile.pos.z;
    terms.height = clamp(sum / nearestHostiles.length / 4, -1.5, 1.5) * engagement;
  }

  // Threat and lethality.
  const incoming = threat.at(pos);
  terms.threatExposure = (incoming / maxHp) * ctx.caution;
  const lethality = clamp01(incoming / Math.max(1, actor.stats.hp));
  terms.selfRisk = lethality * lethality * ctx.caution;

  // Facing: never end a turn with your back to a real threat.
  let exposure = 0;
  let exposureWeight = 0;
  let flankAxes = 0;
  let adjacentHostiles = 0;
  let hasWest = false;
  let hasEast = false;
  let hasNorth = false;
  let hasSouth = false;
  for (const source of threat.sources) {
    const hostile = source.unit;
    const d = ctx.nav.distance(pos, hostile);
    if (d > source.reach + 1) continue;
    const weight = Math.max(1, source.damage);
    const side = relativeFacing(hostile.pos, pos, candidate.facing);
    exposure += weight * (side === 'back' ? 1 : side === 'side' ? 0.5 : 0);
    exposureWeight += weight;
    if (d <= 1) {
      adjacentHostiles++;
      if (hostile.pos.x < pos.x) hasWest = true;
      if (hostile.pos.x > pos.x) hasEast = true;
      if (hostile.pos.y < pos.y) hasNorth = true;
      if (hostile.pos.y > pos.y) hasSouth = true;
    }
  }
  terms.facingSafety = exposureWeight > 0 ? 1 - exposure / exposureWeight : 1;
  if (hasWest && hasEast) flankAxes++;
  if (hasNorth && hasSouth) flankAxes++;
  terms.flankRisk = flankAxes * 0.5 + Math.max(0, adjacentHostiles - 1) * 0.25;

  // Clustering: standing shoulder-to-shoulder is a gift to an AoE caster.
  let adjacentFriends = 0;
  for (const friend of ctx.friends) if (manhattan(pos, friend.pos) <= 1) adjacentFriends++;
  const enemyHasAoe = threat.sources.some((s) => s.aoe);
  terms.clusterRisk = (adjacentFriends / 3) * (enemyHasAoe ? 1 : 0.25) * engagement;

  // Chokepoint: a narrow tile is only worth holding if it actually gates them.
  const openNeighbours = countOpenNeighbours(field, pos);
  terms.chokepoint = clamp01((4 - openNeighbours) / 3) * engagement;

  // Guarding: stand adjacent to the charge and between it and the threat.
  if (ctx.guardTarget !== undefined) {
    const guard = ctx.guardTarget;
    const distance = manhattan(pos, guard.pos);
    let value = clamp01(1 - Math.abs(distance - 1) / 4);
    let blocking = 0;
    for (const hostile of ctx.hostiles) {
      const guardToEnemy = manhattan(guard.pos, hostile.pos);
      const meToEnemy = manhattan(pos, hostile.pos);
      if (meToEnemy < guardToEnemy) blocking++;
    }
    if (ctx.hostiles.length > 0) value += (blocking / ctx.hostiles.length) * 0.5;
    terms.guardAlly = value * engagement;
  }

  // Terrain hazard at the destination.
  const tile = field.tileAt(pos.x, pos.y);
  if (tile !== undefined) {
    let hazard = SURFACE_HAZARD[tile.surface] ?? 0;
    if (hasStatus(actor, 'float') && (tile.surface === 'water' || tile.surface === 'deepwater' || tile.surface === 'lava')) {
      hazard = 0;
    }
    if (tile.submerged) hazard = Math.max(hazard, 0.3);
    terms.terrainHazard = hazard;
  }
}

function countOpenNeighbours(field: Battlefield, pos: Vec3): number {
  let open = 0;
  for (const step of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
    const tile: Tile | undefined = field.tileAt(pos.x + step[0], pos.y + step[1]);
    if (tile === undefined || !tile.passable || tile.surface === 'void') continue;
    if (Math.abs(tile.height - pos.z) > 2) continue;
    open++;
  }
  return open;
}

/** 0..1 — how attractive a unit is as a burst target. */
export function squishiness(ctx: AiContext, unit: Unit): number {
  const hpFloor = Math.max(1, ctx.actor.stats.maxHp);
  const relativeHp = clamp01(1 - unit.stats.maxHp / (hpFloor * 1.5));
  const caster = unit.stats.ma > unit.stats.pa ? 0.25 : 0;
  const noArmour = unit.equipment.body === undefined ? 0.15 : 0;
  return clamp01(relativeHp * 0.6 + caster + noArmour);
}
