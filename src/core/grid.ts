/**
 * EverTactics — battlefield geometry, pathfinding, and range/AoE resolution.
 *
 * Pure logic. Nothing here imports three.js and nothing here calls `Math.random()`.
 * The renderer consumes `Battlefield` + the `MapDef` metadata to build its diorama;
 * the AI and UI consume the pathfinding and targeting queries.
 *
 * Conventions (matching `types.ts`)
 * ---------------------------------
 * - `x` runs east, `y` runs south. `z` / `Tile.height` is elevation in **half-tiles**,
 *   the FFT unit: a normal step up a stair is 1, a unit is about 4 tall.
 * - Grid distance is **Manhattan** (FFT's diamond), never Chebyshev.
 * - Tiles are addressed by the string key `"x,y"` (`tileKey`). Maps keyed this way
 *   are used everywhere instead of nested arrays so that sparse results stay cheap.
 */

import type {
  AbilityRange,
  Battlefield,
  Facing,
  SlopeKind,
  SurfaceKind,
  Team,
  Tile,
  Vec3,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Small geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface Vec2 {
  x: number;
  y: number;
}

/** Canonical tile key. Every `Map<string, …>` in this module is keyed with it. */
export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Inverse of `tileKey`. Throws on malformed input rather than returning NaN. */
export function parseKey(key: string): Vec2 {
  const comma = key.indexOf(',');
  const x = Number(key.slice(0, comma));
  const y = Number(key.slice(comma + 1));
  if (comma < 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`grid: malformed tile key "${key}"`);
  }
  return { x, y };
}

/** Anything that carries an elevation: a `Vec3` (`z`) or a `Tile` (`height`). */
export type Elevated = Vec3 | Tile | { z: number } | { height: number };

/** Elevation in half-tiles of a `Vec3` or a `Tile`. */
export function elevationOf(e: Elevated): number {
  return 'z' in e ? e.z : e.height;
}

/**
 * Signed elevation change going **from `a` to `b`**, in half-tiles.
 * Positive means `b` is higher. Callers that only care about traversability
 * (Jump checks) take `Math.abs`.
 */
export function heightDiff(a: Elevated, b: Elevated): number {
  return elevationOf(b) - elevationOf(a);
}

/** FFT grid distance: Manhattan on the horizontal plane. */
export function tileDistance(a: Vec2, b: Vec2): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** The four orthogonal neighbour offsets, in N, E, S, W order. */
export const NEIGHBOUR_OFFSETS: readonly Readonly<Vec2>[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
] as const;

const FACING_VECTOR: Record<Facing, Readonly<Vec2>> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};

const OPPOSITE_FACING: Record<Facing, Facing> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** Unit direction vector for a facing (`y` positive = south). */
export function facingVector(f: Facing): Readonly<Vec2> {
  return FACING_VECTOR[f];
}

export function oppositeFacing(f: Facing): Facing {
  return OPPOSITE_FACING[f];
}

/**
 * The cardinal facing that points from `a` toward `b`.
 * Ties (perfect diagonals) resolve to the horizontal axis, matching FFT's
 * preference for E/W when a unit is attacked from exactly 45°.
 * Returns `'S'` when the two positions coincide.
 */
export function facingBetween(a: Vec2, b: Vec2): Facing {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return 'S';
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'E' : 'W';
  return dy > 0 ? 'S' : 'N';
}

export type RelativeFacing = 'front' | 'side' | 'back';

/**
 * Where the attacker stands relative to the defender's facing.
 * FFT applies +/- hit rate and evade from this: `front` lets the defender use
 * full evade, `side` halves it, `back` removes it entirely.
 */
export function relativeFacing(
  attacker: { pos: Vec3 },
  defender: { pos: Vec3; facing: Facing },
): RelativeFacing {
  const toward = facingBetween(defender.pos, attacker.pos);
  if (toward === defender.facing) return 'front';
  if (toward === OPPOSITE_FACING[defender.facing]) return 'back';
  return 'side';
}

/** Two teams are hostile when they sit on opposite sides of the field. */
export function areHostile(a: Team, b: Team): boolean {
  return teamSide(a) !== teamSide(b);
}

function teamSide(t: Team): number {
  if (t === 'player' || t === 'ally') return 0;
  if (t === 'enemy') return 1;
  return 2; // neutral — hostile to everyone, allied with nobody
}

// ─────────────────────────────────────────────────────────────────────────────
// Terrain rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cost, in Move points, of stepping **into** a tile of this surface.
 * FFT charges 1 for ordinary ground and penalises anything you have to wade,
 * slog, or scramble through.
 */
export const SURFACE_MOVE_COST: Readonly<Record<SurfaceKind, number>> = {
  grass: 1,
  dirt: 1,
  stone: 1,
  sand: 1,
  wood: 1,
  roof: 1,
  bridge: 1,
  snow: 2,
  swamp: 2,
  water: 2,
  lava: 3,
  deepwater: 4,
  void: Infinity,
};

/** Surfaces a unit is considered submerged in (halved PA, no ranged fire in FFT). */
const SUBMERGING: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>(['deepwater']);

/** Move cost of entering `tile`, or `Infinity` if it cannot be entered at all. */
export function moveCostInto(tile: Tile): number {
  if (!tile.passable) return Infinity;
  return SURFACE_MOVE_COST[tile.surface];
}

// ─────────────────────────────────────────────────────────────────────────────
// Battlefield construction
// ─────────────────────────────────────────────────────────────────────────────

class Field implements Battlefield {
  readonly width: number;
  readonly height: number;
  readonly tiles: Tile[];
  readonly mapId: string;

  constructor(width: number, height: number, tiles: Tile[], mapId: string) {
    if (tiles.length !== width * height) {
      throw new Error(
        `grid: expected ${width * height} tiles for a ${width}x${height} field, got ${tiles.length}`,
      );
    }
    this.width = width;
    this.height = height;
    this.tiles = tiles;
    this.mapId = mapId;
  }

  tileAt(x: number, y: number): Tile | undefined {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return undefined;
    return this.tiles[y * this.width + x];
  }
}

/**
 * Wrap a row-major tile array (index `y * width + x`) into a `Battlefield`.
 * The array is taken by reference; callers must not resize it afterwards.
 */
export function createBattlefield(
  width: number,
  height: number,
  tiles: Tile[],
  mapId = 'custom',
): Battlefield {
  return new Field(width, height, tiles, mapId);
}

/** Convenience: the tile under a `Vec3`/`Vec2`. */
export function tileAtPos(field: Battlefield, p: Vec2): Tile | undefined {
  return field.tileAt(p.x, p.y);
}

/** A `Vec3` snapped to the walkable surface of the tile at `(x, y)`. */
export function positionOn(field: Battlefield, x: number, y: number): Vec3 | undefined {
  const t = field.tileAt(x, y);
  if (!t) return undefined;
  return { x, y, z: t.height };
}

/** Iterate every tile with its coordinates. */
export function forEachTile(
  field: Battlefield,
  fn: (tile: Tile, x: number, y: number) => void,
): void {
  for (let y = 0; y < field.height; y++) {
    for (let x = 0; x < field.width; x++) {
      const t = field.tileAt(x, y);
      if (t) fn(t, x, y);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Map authoring format
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Character codes used by the `surfaces` layer of a `MapDef`.
 * Lower case is "soft/low", upper case is the deeper or colder variant.
 */
const SURFACE_CHARS: Readonly<Record<string, SurfaceKind>> = {
  '.': 'grass',
  d: 'dirt',
  s: 'stone',
  n: 'sand',
  w: 'water',
  W: 'deepwater',
  m: 'swamp',
  S: 'snow',
  l: 'lava',
  o: 'wood',
  r: 'roof',
  b: 'bridge',
  '#': 'void',
};

const SLOPE_CHARS: Readonly<Record<string, SlopeKind>> = {
  '.': 'flat',
  N: 'incline-n',
  E: 'incline-e',
  S: 'incline-s',
  W: 'incline-w',
  v: 'convex',
  c: 'concave',
};

/**
 * A handcrafted map, authored as parallel character grids so that the terrain is
 * readable and editable as text. One character per tile, one string per row,
 * row index = `y`.
 *
 * The renderer reads this alongside the `Battlefield` (via `getMapDef(field.mapId)`)
 * for the things geometry alone cannot express: where the water plane sits, how
 * the sun is angled, and which surfaces are decks over open air rather than
 * solid columns of earth.
 */
export interface MapDef {
  readonly id: string;
  readonly name: string;
  /** One-line description, used by the scenario browser and debug HUD. */
  readonly blurb: string;
  readonly width: number;
  readonly height: number;
  /**
   * Elevation layer. One base-36 digit per tile (`0`-`9`, then `a`-`z`), giving
   * heights 0–35 in half-tiles.
   */
  readonly heights: readonly string[];
  /** Surface layer; see `SURFACE_CHARS`. */
  readonly surfaces: readonly string[];
  /** Optional impassability overlay: `#` blocks the tile, anything else allows it. */
  readonly blocked?: readonly string[];
  /** Optional slope overlay; omitted tiles get their slope derived from neighbours. */
  readonly slopes?: readonly string[];
  /**
   * Height of the water surface in half-tiles. The renderer draws one continuous
   * water plane at this elevation over every `water`/`deepwater` tile.
   */
  readonly waterLevel: number;
  /**
   * Surfaces that should be rendered as a thin deck standing on supports rather
   * than as a solid extruded block — the bridge over the Mandalia river.
   */
  readonly deckSurfaces: readonly SurfaceKind[];
  /** Suggested deployment tiles. Scenarios may override. */
  readonly playerStarts: readonly Vec2[];
  readonly enemyStarts: readonly Vec2[];
  /** Per-map lighting/grade so each diorama has its own time of day. */
  readonly lighting: MapLighting;
}

export interface MapLighting {
  /** Key light colour, 0xRRGGBB. */
  readonly sunColor: number;
  readonly sunIntensity: number;
  /** Compass angle of the sun in degrees; 0 = from the north, 90 = from the east. */
  readonly sunAzimuth: number;
  /** Elevation above the horizon in degrees. */
  readonly sunElevation: number;
  /** Hemisphere fill: sky colour and bounced ground colour. */
  readonly skyColor: number;
  readonly groundColor: number;
  readonly ambientIntensity: number;
  readonly fogColor: number;
  /** Exponential fog density; 0 disables fog. */
  readonly fogDensity: number;
}

function decodeHeight(ch: string, where: string): number {
  const v = parseInt(ch, 36);
  if (Number.isNaN(v)) throw new Error(`grid: bad height char "${ch}" at ${where}`);
  return v;
}

function charAt(rows: readonly string[], x: number, y: number): string | undefined {
  const row = rows[y];
  if (row === undefined) return undefined;
  return row[x];
}

/** Build a live `Battlefield` from an authored `MapDef`. Validates the layers. */
export function buildBattlefield(def: MapDef): Battlefield {
  const { width, height } = def;
  validateLayer(def.id, 'heights', def.heights, width, height);
  validateLayer(def.id, 'surfaces', def.surfaces, width, height);
  if (def.blocked) validateLayer(def.id, 'blocked', def.blocked, width, height);
  if (def.slopes) validateLayer(def.id, 'slopes', def.slopes, width, height);

  const tiles: Tile[] = new Array<Tile>(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const where = `${def.id} (${x},${y})`;
      const hc = charAt(def.heights, x, y);
      const sc = charAt(def.surfaces, x, y);
      if (hc === undefined || sc === undefined) {
        throw new Error(`grid: missing layer data at ${where}`);
      }
      const surface = SURFACE_CHARS[sc];
      if (surface === undefined) throw new Error(`grid: bad surface char "${sc}" at ${where}`);
      const blockedHere = def.blocked ? charAt(def.blocked, x, y) === '#' : false;
      tiles[y * width + x] = {
        x,
        y,
        height: decodeHeight(hc, where),
        depth: Infinity,
        surface,
        slope: 'flat',
        passable: surface !== 'void' && !blockedHere,
        submerged: SUBMERGING.has(surface),
      };
    }
  }

  const field = createBattlefield(width, height, tiles, def.id);
  applySlopes(field, def);
  return field;
}

function validateLayer(
  id: string,
  name: string,
  rows: readonly string[],
  width: number,
  height: number,
): void {
  if (rows.length !== height) {
    throw new Error(`grid: map "${id}" layer ${name} has ${rows.length} rows, expected ${height}`);
  }
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    if (row === undefined || row.length !== width) {
      throw new Error(
        `grid: map "${id}" layer ${name} row ${y} has ${row?.length ?? 0} chars, expected ${width}`,
      );
    }
  }
}

/**
 * Fill in each tile's `slope`. An explicit `slopes` layer wins; otherwise the
 * slope is derived from the neighbourhood, which is what lets a hand-authored
 * height ramp (…4, 2, 0…) automatically read as a ramp in the diorama instead
 * of a staircase of blocks.
 */
function applySlopes(field: Battlefield, def: MapDef): void {
  for (let y = 0; y < field.height; y++) {
    for (let x = 0; x < field.width; x++) {
      const tile = field.tileAt(x, y);
      if (!tile) continue;
      const explicit = def.slopes ? charAt(def.slopes, x, y) : undefined;
      if (explicit !== undefined && explicit !== '.') {
        const kind = SLOPE_CHARS[explicit];
        if (kind === undefined) {
          throw new Error(`grid: bad slope char "${explicit}" at ${def.id} (${x},${y})`);
        }
        tile.slope = kind;
        continue;
      }
      tile.slope = deriveSlope(field, x, y);
    }
  }
}

/** Max height change across a single tile that still reads as a ramp, not a cliff. */
const MAX_RAMP_SPAN = 4;

function deriveSlope(field: Battlefield, x: number, y: number): SlopeKind {
  const here = field.tileAt(x, y);
  if (!here) return 'flat';
  const n = field.tileAt(x, y - 1);
  const s = field.tileAt(x, y + 1);
  const e = field.tileAt(x + 1, y);
  const w = field.tileAt(x - 1, y);

  let best: SlopeKind = 'flat';
  let bestSpan = 0;

  if (e && w) {
    const span = e.height - w.height;
    if (span !== 0 && Math.abs(span) <= MAX_RAMP_SPAN && here.height * 2 === e.height + w.height) {
      best = span > 0 ? 'incline-e' : 'incline-w';
      bestSpan = Math.abs(span);
    }
  }
  if (n && s) {
    const span = s.height - n.height;
    if (
      span !== 0 &&
      Math.abs(span) <= MAX_RAMP_SPAN &&
      here.height * 2 === n.height + s.height &&
      Math.abs(span) > bestSpan
    ) {
      best = span > 0 ? 'incline-s' : 'incline-n';
      bestSpan = Math.abs(span);
    }
  }
  if (best !== 'flat') return best;

  // Not a ramp: is it a pit or a knob? Both get a bevel treatment in the mesh.
  const around = [n, s, e, w].filter((t): t is Tile => t !== undefined);
  if (around.length === 4) {
    if (around.every((t) => t.height > here.height)) return 'concave';
    if (around.every((t) => t.height < here.height)) return 'convex';
  }
  return 'flat';
}

// ─────────────────────────────────────────────────────────────────────────────
// The handcrafted maps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Orbonne Monastery's cloister garden.
 *
 * ROUND 3: THE SILHOUETTE.
 *
 * The previous plan was still, underneath its void bites, a square ring of walls
 * of one height around a flat lawn. Critics named it every round: "a symmetric
 * rectangular donut parked dead-centre", "its silhouette is a rectangle from
 * every camera yaw". The fix is not a material — it is the plan itself.
 *
 * Two rules drive this layout.
 *
 * **1. Every exterior elevation is terraced, never a single slab.** A wall that
 * runs from its parapet straight down to the diorama's underside is a brick
 * billboard, and the near face of the map is 40% of the frame. So the ranges are
 * fronted by a low outer plinth one to three half-tiles high — `blocked`, not
 * `void`, so it is real geometry that the camera sees but pathfinding ignores.
 * From outside, the north reads plinth 2/3 → arcade 6 → pier 10; the west reads
 * shelf 1/3 → walk 6; the south reads threshold 2/3/4 → path 3 → lawn 2. Three
 * masses at three depths instead of one face.
 *
 * **2. The footprint is ragged on all four sides, so no yaw sees a rectangle.**
 * The apse (`x` 12–13, `y` 0–3) is gone. The whole **south-east quarter** is gone
 * — `x` ≥ 11 south of row 9, and `x` ≥ 12 south of row 8 — which is what lets the
 * default south-east camera look straight into the garden instead of over a
 * parapet. The east range survives only as a tower between rows 4 and 8, dropping
 * 8 → 7 → 5 as it goes south. The north plinth is broken by gaps at `x` 4 and 9.
 * The west shelf stops entirely at rows 8–10.
 *
 * Inside, the play space has five levels, not one lawn: the reflecting pool at 0,
 * the garden at 2, the south path and the turf shoulder at 3, the west walk / east
 * bank / plank bridge at 4, and the north-east chapel terrace at 5, reached by the
 * 3 → 4 → 5 steps at (8,4)/(9,4). The fountain plinth is stepped 7/6/6/5 and the
 * colonnade piers spike to 10, so the vertical read is never uniform.
 *
 * The banks at column 2, column 11 and row 12 are true ramps (the height triple
 * either side satisfies `deriveSlope`), so the mesh gets sloped stone there rather
 * than a staircase of cubes.
 *
 * Elevations: pool 0, outer plinth 1–3, garden 2, south path 3, banks/ledges 4,
 * chapel terrace 5, cloister walk 6, fountain 5–7, east tower 7–8, piers 10.
 */
export const ORBONNE_COURTYARD: MapDef = {
  id: 'orbonne-courtyard',
  name: 'Orbonne Monastery — Cloister Garden',
  blurb: 'A terraced garden under a half-fallen cloister; the whole south-east quarter is gone.',
  width: 14,
  height: 14,
  heights: [
    '03240232412100',
    '266a36a66a6400',
    '36444444555400',
    '36422223554400',
    '26422223342460',
    '36422233222468',
    '06442376322468',
    '2a443365322467',
    '12233333333350',
    '02220403222200',
    '24420403222100',
    '14422223222000',
    '23333333321000',
    '02233432010000',
  ],
  surfaces: [
    '#sss#ssssddd##',
    'sssssssssssd##',
    'ssdssssssssd##',
    'ssd....sssdd##',
    'ssd....sss.ds#',
    'ssd...ss...dss',
    '#sds.ssss..dss',
    'dsds.ssss..dss',
    'dsdssssssssds#',
    '#sd.wbwd....##',
    'dsd.wbwd...d##',
    'dsd....d...###',
    'ssddddddddd###',
    '#sssssss#d####',
  ],
  blocked: [
    '.###.#######..',
    '#..#..#..#....',
    '#.............',
    '#.............',
    '#.............',
    '#............#',
    '......##.....#',
    '##....##.....#',
    '#.............',
    '..............',
    '#..........#..',
    '#.............',
    '#.........#...',
    '.####.##.#....',
  ],
  waterLevel: 0,
  deckSurfaces: ['bridge'],
  playerStarts: [
    { x: 4, y: 12 },
    { x: 5, y: 12 },
    { x: 6, y: 12 },
    { x: 7, y: 12 },
    { x: 8, y: 12 },
    { x: 6, y: 11 },
  ],
  enemyStarts: [
    { x: 4, y: 2 },
    { x: 5, y: 2 },
    { x: 8, y: 2 },
    { x: 9, y: 2 },
    { x: 4, y: 1 },
    { x: 7, y: 1 },
  ],
  lighting: {
    // Late afternoon through the arcade: warm key, cool stone bounce.
    sunColor: 0xffd9a8,
    sunIntensity: 2.1,
    sunAzimuth: 132,
    sunElevation: 34,
    skyColor: 0x9fbcd8,
    groundColor: 0x6b5c4a,
    ambientIntensity: 0.55,
    fogColor: 0xc8d4e0,
    fogDensity: 0.012,
  },
};

/**
 * Mandalia Plains. A river cuts the field north to south, meandering east
 * around the middle, with a single wooden bridge at row 6. Wading is possible
 * — shallow water costs 2 — but the deep bend at rows 7–9 costs 4 and submerges
 * whoever tries it, so the bridge genuinely matters. Grass hills roll up to the
 * west, a stone outcrop rises to elevation 8 in the north-east and dominates
 * sight lines, and swampy ground fouls the south bank.
 *
 * Elevations: river bed 0, banks 2, hills 3–5, outcrop 7–8.
 */
export const MANDALIA_PLAINS: MapDef = {
  id: 'mandalia-plains',
  name: 'Mandalia Plains — River Crossing',
  blurb: 'Open grassland split by a river; one bridge, one deep ford.',
  width: 16,
  height: 14,
  heights: [
    '5544320023334455',
    '5443320023344566',
    '4433222002345786',
    '4332222002345775',
    '3322222002234554',
    '3222222002233444',
    '2222222332223344',
    '2222222200223344',
    '2233222200223334',
    '3333222200222333',
    '3343322002222333',
    '3444322002223332',
    '4454332002233322',
    '4554432002333222',
  ],
  surfaces: [
    '.....nwwn.......',
    '.....nwwn.....ss',
    '......nwwn..ssss',
    '......nwwn..sss.',
    '......nwwn......',
    '......nwwn......',
    '......obbo......',
    '.......nWWn.....',
    '..ss...nWWn.....',
    '.......nWWn.....',
    '......mwwmm.....',
    '......mwwm......',
    '......nwwn......',
    '......nwwn......',
  ],
  waterLevel: 0,
  deckSurfaces: ['bridge'],
  playerStarts: [
    { x: 2, y: 11 },
    { x: 3, y: 11 },
    { x: 2, y: 12 },
    { x: 3, y: 12 },
    { x: 1, y: 12 },
    { x: 2, y: 13 },
  ],
  enemyStarts: [
    { x: 12, y: 2 },
    { x: 13, y: 3 },
    { x: 11, y: 3 },
    { x: 12, y: 4 },
    { x: 13, y: 5 },
    { x: 14, y: 4 },
  ],
  lighting: {
    // High, clean midday over open grass.
    sunColor: 0xfff3d6,
    sunIntensity: 2.6,
    sunAzimuth: 208,
    sunElevation: 52,
    skyColor: 0xa8c8ea,
    groundColor: 0x5d7a44,
    ambientIntensity: 0.62,
    fogColor: 0xd6e4f0,
    fogDensity: 0.006,
  },
};

export const MAPS: Readonly<Record<string, MapDef>> = {
  [ORBONNE_COURTYARD.id]: ORBONNE_COURTYARD,
  [MANDALIA_PLAINS.id]: MANDALIA_PLAINS,
};

export function listMaps(): MapDef[] {
  return Object.values(MAPS);
}

export function getMapDef(id: string): MapDef | undefined {
  return MAPS[id];
}

/** Build the `Battlefield` for a known map id. Throws if the id is unknown. */
export function generateMap(id: string): Battlefield {
  const def = MAPS[id];
  if (!def) {
    throw new Error(`grid: unknown map "${id}" (known: ${Object.keys(MAPS).join(', ')})`);
  }
  return buildBattlefield(def);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pathfinding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimum a pathfinding query needs to know about a unit. `Unit` from
 * `types.ts` satisfies this structurally, so callers just pass the unit.
 */
export interface Mover {
  pos: Vec3;
  team: Team;
  stats: { move: number; jump: number };
}

export interface ReachNode {
  /** Accumulated Move cost from the unit's starting tile. */
  cost: number;
  /** Key of the previous tile on the cheapest path, or `null` at the origin. */
  prev: string | null;
  /** Tile position with its surface elevation, ready to hand to a `move` command. */
  pos: Vec3;
}

/** Occupancy snapshot: tile key -> the team of whoever is standing there. */
export type Occupancy = Map<string, Team>;

/** Build an occupancy map from live units. Removed/KO'd units still block in FFT. */
export function buildOccupancy(units: Iterable<{ pos: Vec3; team: Team; removed?: boolean }>): Occupancy {
  const occ: Occupancy = new Map();
  for (const u of units) {
    if (u.removed) continue;
    occ.set(tileKey(u.pos.x, u.pos.y), u.team);
  }
  return occ;
}

/** Minimal binary heap keyed on numeric cost. Ties keep insertion order stable. */
class MinHeap {
  private keys: number[] = [];
  private seq: number[] = [];
  private vals: string[] = [];
  private counter = 0;

  get size(): number {
    return this.vals.length;
  }

  push(cost: number, value: string): void {
    this.keys.push(cost);
    this.seq.push(this.counter++);
    this.vals.push(value);
    this.up(this.vals.length - 1);
  }

  pop(): string | undefined {
    const n = this.vals.length;
    if (n === 0) return undefined;
    const top = this.vals[0];
    const lastKey = this.keys[n - 1];
    const lastSeq = this.seq[n - 1];
    const lastVal = this.vals[n - 1];
    this.keys.pop();
    this.seq.pop();
    this.vals.pop();
    if (n > 1 && lastKey !== undefined && lastSeq !== undefined && lastVal !== undefined) {
      this.keys[0] = lastKey;
      this.seq[0] = lastSeq;
      this.vals[0] = lastVal;
      this.down(0);
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    const ka = this.keys[a] ?? Infinity;
    const kb = this.keys[b] ?? Infinity;
    if (ka !== kb) return ka < kb;
    return (this.seq[a] ?? 0) < (this.seq[b] ?? 0);
  }

  private swap(a: number, b: number): void {
    const ka = this.keys[a];
    const kb = this.keys[b];
    const sa = this.seq[a];
    const sb = this.seq[b];
    const va = this.vals[a];
    const vb = this.vals[b];
    if (ka === undefined || kb === undefined) return;
    if (sa === undefined || sb === undefined) return;
    if (va === undefined || vb === undefined) return;
    this.keys[a] = kb;
    this.keys[b] = ka;
    this.seq[a] = sb;
    this.seq[b] = sa;
    this.vals[a] = vb;
    this.vals[b] = va;
  }

  private up(i: number): void {
    let idx = i;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (!this.less(idx, parent)) break;
      this.swap(idx, parent);
      idx = parent;
    }
  }

  private down(i: number): void {
    let idx = i;
    const n = this.vals.length;
    for (;;) {
      const l = idx * 2 + 1;
      const r = l + 1;
      let best = idx;
      if (l < n && this.less(l, best)) best = l;
      if (r < n && this.less(r, best)) best = r;
      if (best === idx) break;
      this.swap(idx, best);
      idx = best;
    }
  }
}

/**
 * Uniform-cost (Dijkstra) flood fill of everywhere `unit` can walk this turn.
 *
 * FFT movement rules, all enforced here:
 * - entering a tile costs `SURFACE_MOVE_COST[surface]` — 1 for ordinary ground,
 *   more for water, swamp, snow and lava;
 * - total cost may not exceed the unit's `Move`;
 * - a step whose absolute height change exceeds the unit's `Jump` is impossible,
 *   in either direction (you cannot climb it and you will not drop off it);
 * - impassable tiles (walls, voids, fountain plinths) are never entered;
 * - **hostile units block the step entirely** — you cannot walk through an enemy;
 * - **allied units are walked through freely** but cannot be stood on.
 *
 * The returned map contains every tile that can be *reached*, including tiles
 * occupied by allies. Use `canEndOn`/`reachableDestinations` to get the tiles
 * that are legal move *destinations*.
 */
export function reachableTiles(
  field: Battlefield,
  unit: Mover,
  occupied: Occupancy,
): Map<string, ReachNode> {
  const result = new Map<string, ReachNode>();
  const start = field.tileAt(unit.pos.x, unit.pos.y);
  if (!start) return result;

  const move = Math.max(0, Math.floor(unit.stats.move));
  const jump = Math.max(0, Math.floor(unit.stats.jump));
  const startKey = tileKey(start.x, start.y);
  result.set(startKey, {
    cost: 0,
    prev: null,
    pos: { x: start.x, y: start.y, z: start.height },
  });

  const heap = new MinHeap();
  heap.push(0, startKey);
  const settled = new Set<string>();

  while (heap.size > 0) {
    const key = heap.pop();
    if (key === undefined) break;
    if (settled.has(key)) continue;
    settled.add(key);
    const node = result.get(key);
    if (!node) continue;
    if (node.cost >= move) continue; // no budget left to take another step

    const from = field.tileAt(node.pos.x, node.pos.y);
    if (!from) continue;

    for (const off of NEIGHBOUR_OFFSETS) {
      const nx = node.pos.x + off.x;
      const ny = node.pos.y + off.y;
      const to = field.tileAt(nx, ny);
      if (!to) continue;

      const step = moveCostInto(to);
      if (!Number.isFinite(step)) continue;
      if (Math.abs(to.height - from.height) > jump) continue;

      const nKey = tileKey(nx, ny);
      const holder = occupied.get(nKey);
      if (holder !== undefined && areHostile(holder, unit.team)) continue;

      const cost = node.cost + step;
      if (cost > move) continue;
      const existing = result.get(nKey);
      if (existing !== undefined && existing.cost <= cost) continue;
      result.set(nKey, { cost, prev: key, pos: { x: nx, y: ny, z: to.height } });
      heap.push(cost, nKey);
    }
  }

  return result;
}

/**
 * May `unit` finish its move standing on this tile? Reachability is necessary
 * but not sufficient: the tile must also be unoccupied (its own tile aside).
 */
export function canEndOn(
  field: Battlefield,
  unit: Mover,
  occupied: Occupancy,
  x: number,
  y: number,
): boolean {
  const tile = field.tileAt(x, y);
  if (!tile || !tile.passable) return false;
  if (!Number.isFinite(moveCostInto(tile))) return false;
  const key = tileKey(x, y);
  if (key === tileKey(unit.pos.x, unit.pos.y)) return true;
  return !occupied.has(key);
}

/** `reachableTiles` filtered down to tiles the unit may actually stop on. */
export function reachableDestinations(
  field: Battlefield,
  unit: Mover,
  occupied: Occupancy,
  reach: Map<string, ReachNode> = reachableTiles(field, unit, occupied),
): Map<string, ReachNode> {
  const out = new Map<string, ReachNode>();
  for (const [key, node] of reach) {
    if (canEndOn(field, unit, occupied, node.pos.x, node.pos.y)) out.set(key, node);
  }
  return out;
}

/**
 * The cheapest walk from the unit's current tile to `target`.
 *
 * **The returned path includes the unit's starting tile as element 0**, so a
 * single-tile step is `[origin, destination]` and a no-op move is `[origin]`.
 * Returns `[]` when the target is not reachable or is not a legal place to stop.
 */
export function pathTo(
  field: Battlefield,
  unit: Mover,
  occupied: Occupancy,
  target: Vec2,
  reach: Map<string, ReachNode> = reachableTiles(field, unit, occupied),
): Vec3[] {
  const key = tileKey(target.x, target.y);
  const node = reach.get(key);
  if (!node) return [];
  if (!canEndOn(field, unit, occupied, target.x, target.y)) return [];

  const path: Vec3[] = [];
  let cursor: string | null = key;
  const guard = new Set<string>();
  while (cursor !== null) {
    if (guard.has(cursor)) break; // defensive: malformed prev chain
    guard.add(cursor);
    const n: ReachNode | undefined = reach.get(cursor);
    if (!n) break;
    path.push({ x: n.pos.x, y: n.pos.y, z: n.pos.z });
    cursor = n.prev;
  }
  path.reverse();
  return path;
}

/** Total Move cost of walking `path` (which is expected to include the origin). */
export function pathCost(field: Battlefield, path: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const step = path[i];
    if (!step) continue;
    const tile = field.tileAt(step.x, step.y);
    if (!tile) return Infinity;
    total += moveCostInto(tile);
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// Line of sight
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Height of a unit's chest above the tile it stands on, in half-tiles.
 * FFT casts line of sight from roughly the middle of the sprite, which is why a
 * knee-high wall between two units does not break the shot but a pillar does.
 */
export const EYE_HEIGHT = 2;

const LOS_EPSILON = 1e-6;

/**
 * True when nothing on the terrain between `from` and `to` rises above the
 * straight line joining the two units' chests.
 *
 * The segment is walked through every grid cell it actually crosses (dense
 * parametric sampling — deterministic, no floating-point luck involved), and a
 * cell blocks when its walkable surface is strictly higher than the ray at the
 * moment the ray is over that cell. Origin and destination cells never block.
 */
export function hasLineOfSight(
  field: Battlefield,
  from: Vec3,
  to: Vec3,
  eyeHeight = EYE_HEIGHT,
): boolean {
  if (from.x === to.x && from.y === to.y) return true;

  const x0 = from.x + 0.5;
  const y0 = from.y + 0.5;
  const x1 = to.x + 0.5;
  const y1 = to.y + 0.5;
  const z0 = from.z + eyeHeight;
  const z1 = to.z + eyeHeight;

  const dx = x1 - x0;
  const dy = y1 - y0;
  const planar = Math.hypot(dx, dy);
  const steps = Math.max(2, Math.ceil(planar * 8));

  let lastX = from.x;
  let lastY = from.y;

  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const cx = Math.floor(x0 + dx * t);
    const cy = Math.floor(y0 + dy * t);
    if (cx === lastX && cy === lastY) continue;
    lastX = cx;
    lastY = cy;
    if ((cx === from.x && cy === from.y) || (cx === to.x && cy === to.y)) continue;
    const tile = field.tileAt(cx, cy);
    if (!tile) continue; // off-map gaps are open air, not walls
    const rayZ = z0 + (z1 - z0) * t;
    if (tile.height > rayZ + LOS_EPSILON) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Range and area-of-effect resolution
// ─────────────────────────────────────────────────────────────────────────────

export interface RangeOptions {
  /**
   * Direction used by the `line` and `cone` shapes. Defaults to the caster's
   * facing when you pass one; otherwise `'S'`.
   */
  facing?: Facing;
  /** Include tiles that cannot be walked on (walls, voids). Default false. */
  includeImpassable?: boolean;
  /** Drop the origin tile from the result. Default false. */
  excludeOrigin?: boolean;
}

function shapeAccepts(
  shape: NonNullable<AbilityRange['shape']>,
  dx: number,
  dy: number,
  facing: Facing,
): boolean {
  if (shape === 'circle') return true;
  const v = FACING_VECTOR[facing];
  // Distance along the facing axis, and lateral offset from it.
  const along = dx * v.x + dy * v.y;
  const lateral = dx * v.y - dy * v.x;
  switch (shape) {
    case 'line':
      return lateral === 0 && along > 0;
    case 'cone':
      return along > 0 && Math.abs(lateral) <= along;
    case 'cross':
      return dx === 0 || dy === 0;
  }
}

/**
 * Every tile an ability with this `AbilityRange` may be aimed at from `origin`.
 *
 * Honoured: `range` (Manhattan), `vertical` tolerance, `los`, `self`, and
 * `shape` — `circle` (the default FFT diamond), `cross` (the four cardinal
 * rays), `line` (a single ray along `facing`) and `cone` (a 90° wedge about
 * `facing`).
 */
export function tilesInRange(
  field: Battlefield,
  origin: Vec3,
  range: AbilityRange,
  opts: RangeOptions = {},
): Vec3[] {
  const out: Vec3[] = [];
  const originTile = field.tileAt(origin.x, origin.y);

  if (range.self) {
    if (originTile) out.push({ x: origin.x, y: origin.y, z: originTile.height });
    return out;
  }

  const facing = opts.facing ?? 'S';
  const shape = range.shape ?? 'circle';
  const maxR = Math.max(0, Math.floor(range.range));
  const vertical = range.vertical;

  for (let dy = -maxR; dy <= maxR; dy++) {
    const budget = maxR - Math.abs(dy);
    for (let dx = -budget; dx <= budget; dx++) {
      if (dx === 0 && dy === 0) {
        if (opts.excludeOrigin) continue;
        if (shape === 'line' || shape === 'cone') continue;
      } else if (!shapeAccepts(shape, dx, dy, facing)) {
        continue;
      }
      const x = origin.x + dx;
      const y = origin.y + dy;
      const tile = field.tileAt(x, y);
      if (!tile) continue;
      if (!opts.includeImpassable && !tile.passable) continue;
      if (Math.abs(tile.height - origin.z) > vertical) continue;
      if (range.los && !(dx === 0 && dy === 0)) {
        if (!hasLineOfSight(field, origin, { x, y, z: tile.height })) continue;
      }
      out.push({ x, y, z: tile.height });
    }
  }
  return out;
}

/**
 * The tiles actually hit once an ability lands on `center`.
 *
 * `radius` 0 is a single tile. Larger radii spread as a Manhattan diamond, and
 * the same `vertical` tolerance applies — an explosion at the bottom of a
 * stairwell does not reach the units on the landing above. Line-of-sight is
 * deliberately **not** re-checked: the burst has already arrived.
 */
export function tilesInBurst(field: Battlefield, center: Vec3, range: AbilityRange): Vec3[] {
  const out: Vec3[] = [];
  const radius = Math.max(0, Math.floor(range.radius));
  for (let dy = -radius; dy <= radius; dy++) {
    const budget = radius - Math.abs(dy);
    for (let dx = -budget; dx <= budget; dx++) {
      const x = center.x + dx;
      const y = center.y + dy;
      const tile = field.tileAt(x, y);
      if (!tile) continue;
      if (!tile.passable) continue;
      if (Math.abs(tile.height - center.z) > range.vertical) continue;
      out.push({ x, y, z: tile.height });
    }
  }
  return out;
}

/** Convenience predicate: can `origin` legally target `target` with `range`? */
export function isInRange(
  field: Battlefield,
  origin: Vec3,
  target: Vec3,
  range: AbilityRange,
  opts: RangeOptions = {},
): boolean {
  if (range.self) return origin.x === target.x && origin.y === target.y;
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const d = Math.abs(dx) + Math.abs(dy);
  if (d > Math.max(0, Math.floor(range.range))) return false;
  const shape = range.shape ?? 'circle';
  if (d === 0) {
    if (shape === 'line' || shape === 'cone') return false;
  } else if (!shapeAccepts(shape, dx, dy, opts.facing ?? 'S')) {
    return false;
  }
  const tile = field.tileAt(target.x, target.y);
  if (!tile) return false;
  if (!opts.includeImpassable && !tile.passable) return false;
  if (Math.abs(tile.height - origin.z) > range.vertical) return false;
  if (range.los && d > 0 && !hasLineOfSight(field, origin, { x: target.x, y: target.y, z: tile.height })) {
    return false;
  }
  return true;
}
