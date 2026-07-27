/**
 * EverTactics — core type contracts.
 *
 * This file is the frozen interface surface that every subsystem builds against.
 * Nothing here imports three.js: `core/` is pure, deterministic, testable game logic.
 * Rendering (`render/`) observes core state; it never mutates it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────

/** Grid coordinate. `x` runs east, `y` runs south, `z` is elevation in half-tiles. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A unit's facing. FFT uses four cardinal facings on a diamond grid. */
export type Facing = 'N' | 'E' | 'S' | 'W';

export const FACINGS: readonly Facing[] = ['N', 'E', 'S', 'W'] as const;

/** Terrain surface type — drives movement cost, VFX and geomancy. */
export type SurfaceKind =
  | 'grass'
  | 'dirt'
  | 'stone'
  | 'sand'
  | 'water'
  | 'deepwater'
  | 'swamp'
  | 'snow'
  | 'lava'
  | 'wood'
  | 'roof'
  | 'bridge'
  | 'void';

export interface Tile {
  readonly x: number;
  readonly y: number;
  /** Walkable surface height, in half-tile units (FFT convention). */
  height: number;
  /** Extra headroom above the surface before a ceiling; Infinity when open. */
  depth: number;
  surface: SurfaceKind;
  /** Slope descriptor for rendering and movement penalties. */
  slope: SlopeKind;
  /** Tiles that cannot be entered at all (walls, out-of-bounds). */
  passable: boolean;
  /** True when a unit standing here is treated as submerged (water depth >= 2). */
  submerged: boolean;
}

export type SlopeKind =
  | 'flat'
  | 'incline-n'
  | 'incline-e'
  | 'incline-s'
  | 'incline-w'
  | 'convex'
  | 'concave';

// ─────────────────────────────────────────────────────────────────────────────
// Jobs
// ─────────────────────────────────────────────────────────────────────────────

/** Where a job's design lineage comes from — used for tagging, not mechanics. */
export type JobOrigin = 'fft' | 'eq2' | 'wow' | 'original';

export type JobId = string;

export interface JobRequirement {
  job: JobId;
  level: number;
}

export interface JobGrowth {
  /** Lower is better — FFT growth constants. HP = raw / (growth + level). */
  hp: number;
  mp: number;
  pa: number;
  ma: number;
  spd: number;
}

export interface JobMultipliers {
  /** Percent multipliers applied to raw stats, FFT-style (100 = neutral). */
  hp: number;
  mp: number;
  pa: number;
  ma: number;
  spd: number;
}

export interface Job {
  readonly id: JobId;
  readonly name: string;
  readonly origin: JobOrigin;
  /** One-line flavour shown in the job menu. */
  readonly blurb: string;
  /** Long-form description for the job detail panel. */
  readonly description: string;
  /** Sprite sheet key in the asset manifest (e.g. `knight_male`). */
  readonly sprite: { male: string; female: string };
  readonly move: number;
  readonly jump: number;
  /** Evasion from the class itself, percent. */
  readonly cEvade: number;
  readonly growth: JobGrowth;
  readonly mult: JobMultipliers;
  /** Prerequisite job levels needed to unlock. Empty for starting jobs. */
  readonly requires: readonly JobRequirement[];
  /** The action ability set this job teaches. */
  readonly actionSet: AbilitySetId;
  /** Learnable ability ids with their JP cost. */
  readonly learnable: readonly LearnableAbility[];
  /** Equipment categories this job may equip natively. */
  readonly equip: readonly EquipCategory[];
  /** Innate abilities always active while this job is set. */
  readonly innate: readonly AbilityId[];
}

export interface LearnableAbility {
  ability: AbilityId;
  jp: number;
}

export type EquipCategory =
  | 'knife' | 'sword' | 'knightsword' | 'katana' | 'axe' | 'hammer' | 'spear'
  | 'staff' | 'rod' | 'flail' | 'bow' | 'crossbow' | 'gun' | 'instrument'
  | 'cloth' | 'book' | 'fist' | 'shield' | 'helm' | 'hat' | 'ribbon'
  | 'armor' | 'robe' | 'clothing' | 'accessory' | 'shoes' | 'armlet';

// ─────────────────────────────────────────────────────────────────────────────
// Abilities
// ─────────────────────────────────────────────────────────────────────────────

export type AbilityId = string;
export type AbilitySetId = string;

export type AbilitySlot =
  | 'action'      // primary/secondary command
  | 'reaction'    // triggers on being hit
  | 'support'     // passive
  | 'movement';   // passive movement modifier

/** How an ability picks its target tiles. */
export interface AbilityRange {
  /** Max distance in tiles (Chebyshev-free: FFT uses Manhattan on the grid). */
  range: number;
  /** 0 = single tile, n = radius of the burst. */
  radius: number;
  /** Vertical tolerance; Infinity for unlimited. */
  vertical: number;
  /** Line of sight required. */
  los: boolean;
  /** Ability targets the caster's own tile only. */
  self?: boolean;
  /** Ability is a linear/directional effect rather than a circular burst. */
  shape?: 'circle' | 'line' | 'cone' | 'cross';
}

export type Element =
  | 'none' | 'fire' | 'ice' | 'lightning' | 'wind' | 'earth'
  | 'water' | 'holy' | 'dark';

export interface Ability {
  readonly id: AbilityId;
  readonly name: string;
  readonly set: AbilitySetId;
  readonly slot: AbilitySlot;
  readonly description: string;
  /** MP cost. 0 for free abilities. */
  readonly mp: number;
  /** Charge time in CT ticks; 0 = instant. */
  readonly ct: number;
  /** Speed penalty applied while charging (unused for instant). */
  readonly element: Element;
  readonly range: AbilityRange;
  /** Damage/effect formula key resolved in `combat/formulas.ts`. */
  readonly formula: FormulaId;
  /** Formula coefficient (the "Q" in FFT formula tables). */
  readonly power: number;
  /** Base hit rate contribution, percent. */
  readonly accuracy: number;
  /** Statuses inflicted on hit. */
  readonly inflicts?: readonly StatusInfliction[];
  /** Statuses removed on hit. */
  readonly cures?: readonly StatusId[];
  /** Ability can target empty tiles (e.g. movement, summons, geomancy). */
  readonly targetsTiles?: boolean;
  /**
   * The ability's reach comes from the equipped weapon rather than from
   * `range.range` — FFT's generic Attack, where a bow strikes at five tiles and
   * a knife at one. `range.range` is the bare-handed floor.
   */
  readonly usesWeaponRange?: boolean;
  /** VFX key resolved by `render/vfx`. */
  readonly vfx: string;
  /** Sound key. */
  readonly sfx?: string;
  /** Animation key on the caster's sprite. */
  readonly castAnim?: AnimName;
}

export interface StatusInfliction {
  status: StatusId;
  /** Percent chance, applied after the ability's own hit roll. */
  chance: number;
  /** Duration in CT ticks; undefined = permanent until cured. */
  duration?: number;
}

export type FormulaId =
  | 'physical'        // PA * WP style weapon damage
  | 'magical'         // MA * Q
  | 'heal'
  | 'fixed'
  | 'percent-hp'
  | 'drain'
  | 'status-only'
  | 'buff'
  | 'move'
  | 'summon'
  | 'raise'
  | 'special';

// ─────────────────────────────────────────────────────────────────────────────
// Status effects
// ─────────────────────────────────────────────────────────────────────────────

export type StatusId =
  | 'ko' | 'crystal' | 'treasure' | 'petrify' | 'stop' | 'sleep' | 'charm'
  | 'confuse' | 'berserk' | 'blind' | 'silence' | 'oil' | 'poison' | 'undead'
  | 'frog' | 'slow' | 'haste' | 'regen' | 'protect' | 'shell' | 'reraise'
  | 'faith' | 'innocent' | 'float' | 'reflect' | 'transparent' | 'chicken'
  | 'death-sentence' | 'defending' | 'performing' | 'charging' | 'jumping'
  // EQ2/WoW-lineage additions
  | 'taunted' | 'rooted' | 'vulnerable' | 'empowered' | 'shielded'
  | 'bleeding' | 'burning' | 'mark' | 'stealth' | 'evade-next';

export interface StatusDef {
  readonly id: StatusId;
  readonly name: string;
  readonly description: string;
  /** Statuses this one cancels on application. */
  readonly cancels: readonly StatusId[];
  /** Statuses that block this one from applying. */
  readonly blockedBy: readonly StatusId[];
  /** True when the status prevents the unit from acting. */
  readonly disabling: boolean;
  /** Icon key for the UI status strip. */
  readonly icon: string;
  /** Tint/overlay applied to the unit sprite while active. */
  readonly tint?: [number, number, number];
}

export interface ActiveStatus {
  status: StatusId;
  /** Remaining CT ticks; -1 = permanent. */
  remaining: number;
  /** Unit id that applied it (for threat/attribution). */
  source?: UnitId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Units
// ─────────────────────────────────────────────────────────────────────────────

export type UnitId = string;
export type Team = 'player' | 'enemy' | 'ally' | 'neutral';
export type Gender = 'male' | 'female' | 'monster';

export interface Stats {
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  /** Raw stats — displayed values are derived through job multipliers. */
  pa: number;
  ma: number;
  spd: number;
  move: number;
  jump: number;
  brave: number;
  faith: number;
}

export interface Equipment {
  rightHand?: ItemId;
  leftHand?: ItemId;
  head?: ItemId;
  body?: ItemId;
  accessory?: ItemId;
}

export interface JobProgress {
  level: number;
  jp: number;
  /** Total JP ever earned in this job — gates job level. */
  totalJp: number;
  learned: Set<AbilityId>;
}

export interface Unit {
  readonly id: UnitId;
  name: string;
  team: Team;
  gender: Gender;
  /** Zodiac sign — drives the compatibility damage modifier. */
  zodiac: Zodiac;
  level: number;
  exp: number;

  currentJob: JobId;
  /** Per-job mastery record. */
  jobs: Map<JobId, JobProgress>;

  /** Secondary action command borrowed from another job. */
  secondaryAction?: AbilitySetId;
  reaction?: AbilityId;
  support?: AbilityId;
  movement?: AbilityId;

  stats: Stats;
  equipment: Equipment;

  pos: Vec3;
  facing: Facing;

  /** Charge Time accumulator; unit acts at >= 100. */
  ct: number;
  statuses: ActiveStatus[];

  /** Set during a turn to track the two-action economy. */
  turn: TurnFlags;

  /** True once the unit has left the field (dead + crystallised, or fled). */
  removed: boolean;

  /** Sprite sheet key + palette index resolved by the renderer. */
  sprite: SpriteRef;
}

export interface TurnFlags {
  moved: boolean;
  acted: boolean;
  /** Tile the unit began the turn on — used by move-then-act ordering rules. */
  origin: Vec3;
  originFacing: Facing;
}

export interface SpriteRef {
  sheet: string;
  /** Palette index 0-7 (battle palettes). Team colour by default. */
  palette: number;
}

export type Zodiac =
  | 'aries' | 'taurus' | 'gemini' | 'cancer' | 'leo' | 'virgo'
  | 'libra' | 'scorpio' | 'sagittarius' | 'capricorn' | 'aquarius' | 'pisces'
  | 'serpentarius';

// ─────────────────────────────────────────────────────────────────────────────
// Items
// ─────────────────────────────────────────────────────────────────────────────

export type ItemId = string;

export interface Item {
  readonly id: ItemId;
  readonly name: string;
  readonly category: EquipCategory | 'consumable';
  readonly description: string;
  readonly price: number;
  /** Weapon power. */
  readonly wp?: number;
  /** Weapon evade percent. */
  readonly wEvade?: number;
  /** Physical / magical evade granted by shields. */
  readonly pEvade?: number;
  readonly mEvade?: number;
  readonly range?: number;
  readonly element?: Element;
  readonly formula?: FormulaId;
  /** Flat stat modifiers granted while equipped. */
  readonly mods?: Partial<Pick<Stats, 'hp' | 'mp' | 'pa' | 'ma' | 'spd' | 'move' | 'jump'>>;
  readonly grantsStatus?: readonly StatusId[];
  /** Two-handed weapons occupy both hands. */
  readonly twoHanded?: boolean;
  /** Sprite frame index into the weapon atlas. */
  readonly icon?: number;
  readonly weaponSprite?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Battle state
// ─────────────────────────────────────────────────────────────────────────────

export interface Battlefield {
  readonly width: number;
  readonly height: number;
  readonly tiles: Tile[];
  /** Map identifier used to select the diorama scene. */
  readonly mapId: string;
  tileAt(x: number, y: number): Tile | undefined;
}

export type BattlePhase =
  | 'deploy'
  | 'tick'        // advancing CT until someone reaches 100
  | 'turn-start'
  | 'awaiting-command'
  | 'resolving'
  | 'turn-end'
  | 'victory'
  | 'defeat';

export interface BattleState {
  field: Battlefield;
  units: Map<UnitId, Unit>;
  /** Units in CT order; recomputed each tick. */
  order: UnitId[];
  active?: UnitId;
  phase: BattlePhase;
  /** Monotonic clock for deterministic replay. */
  tick: number;
  /** Seeded RNG state so battles replay identically. */
  rngState: number;
  log: BattleLogEntry[];
  objective: Objective;
}

export interface Objective {
  kind: 'defeat-all' | 'defeat-target' | 'survive' | 'reach-tile' | 'protect';
  targetUnit?: UnitId;
  targetTile?: { x: number; y: number };
  turns?: number;
  /** Loss conditions beyond the default "all player units KO'd". */
  loseIfDead?: readonly UnitId[];
}

export interface BattleLogEntry {
  tick: number;
  actor: UnitId;
  kind: 'move' | 'act' | 'damage' | 'heal' | 'status' | 'ko' | 'crystal' | 'levelup';
  text: string;
  data?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands — the only way to mutate BattleState
// ─────────────────────────────────────────────────────────────────────────────

export type Command =
  | { kind: 'move'; unit: UnitId; path: Vec3[] }
  | { kind: 'act'; unit: UnitId; ability: AbilityId; target: Vec3; targetUnit?: UnitId }
  | { kind: 'item'; unit: UnitId; item: ItemId; target: Vec3 }
  | { kind: 'face'; unit: UnitId; facing: Facing }
  | { kind: 'wait'; unit: UnitId }
  | { kind: 'defend'; unit: UnitId };

/** A resolved, renderable consequence of a command. Rendering replays these. */
export type BattleEvent =
  | { kind: 'moved'; unit: UnitId; path: Vec3[] }
  | { kind: 'faced'; unit: UnitId; facing: Facing }
  | { kind: 'cast-start'; unit: UnitId; ability: AbilityId; target: Vec3 }
  | { kind: 'cast-fire'; unit: UnitId; ability: AbilityId; target: Vec3 }
  | { kind: 'damage'; unit: UnitId; amount: number; element: Element; crit: boolean }
  | { kind: 'heal'; unit: UnitId; amount: number }
  | { kind: 'miss'; unit: UnitId }
  | { kind: 'status-add'; unit: UnitId; status: StatusId }
  | { kind: 'status-remove'; unit: UnitId; status: StatusId }
  | { kind: 'knockdown'; unit: UnitId }
  | { kind: 'crystal'; unit: UnitId }
  | { kind: 'jp'; unit: UnitId; amount: number }
  | { kind: 'exp'; unit: UnitId; amount: number }
  | { kind: 'levelup'; unit: UnitId; level: number }
  /**
   * A reaction ability triggered. `unit` is the reactor, `source` is whoever provoked it.
   * The reaction's mechanical consequences follow as ordinary events (damage, heal,
   * status-add, ...); this variant exists so the renderer can announce the name the way
   * FFT does before those land.
   */
  | { kind: 'reaction'; unit: UnitId; ability: AbilityId; source: UnitId }
  | { kind: 'turn-order-changed' };

// ─────────────────────────────────────────────────────────────────────────────
// Animation
// ─────────────────────────────────────────────────────────────────────────────

export type AnimName =
  | 'idle' | 'walk' | 'run' | 'attack' | 'cast' | 'charge' | 'item'
  | 'hurt' | 'ko' | 'crystal' | 'victory' | 'jump' | 'land' | 'defend'
  | 'sing' | 'dance' | 'aim' | 'throw' | 'punch' | 'kick';

/** Resolved sprite animation data produced by the asset pipeline. */
export interface SpriteAnimation {
  name: AnimName;
  facingFrames: Record<Facing, number[]>;
  /** Frame durations in milliseconds, parallel to the frame arrays. */
  durations: number[];
  loop: boolean;
}

export interface SpriteSheetMeta {
  key: string;
  url: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  /** Pixel offset from frame bottom-centre to the unit's feet. */
  anchor: { x: number; y: number };
  animations: Record<string, SpriteAnimation>;
  /** Palette swap textures, indexed 0-7. */
  palettes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic RNG contract
// ─────────────────────────────────────────────────────────────────────────────

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Integer in [0, n). */
  int(n: number): number;
  /** True with the given percent chance. */
  chance(percent: number): boolean;
  /** Current internal state, for save/replay. */
  state(): number;
}
