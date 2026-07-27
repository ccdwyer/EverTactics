/**
 * EverTactics — named scenarios.
 *
 * `?shot=<id>` selects one of these; `tools/shoot.mjs --scene <id>` drives it.
 * A scenario is a complete, playable battle plus the presentation choices that
 * frame it: which map, which lighting preset and colour grade, where the camera
 * sits, and which render layers are enabled (so a critic can look at terrain
 * alone, or the UI alone, without the rest getting in the way).
 *
 * Everything here is real content — real jobs, real abilities from the ability
 * table, real equipment from `state/items.ts` — and everything is deterministic:
 * one seed in, the same battle every time.
 */

import { jobActions, jobSkillset } from './abilityIndex';
import { bootstrapContent } from './content';

import { getMapDef, generateMap, positionOn, tileKey } from '@core/grid';
import { getJob } from '@core/jobs';
import { createRng } from '@core/rng';
import { createUnit, deriveStats } from '@core/unit';
import type {
  AbilityId,
  BattleState,
  Battlefield,
  Equipment,
  Facing,
  Gender,
  JobId,
  Objective,
  Team,
  Unit,
  UnitId,
  Vec3,
  Zodiac,
} from '@core/types';
import type { PersonalityId } from '@core/ai';
import type { LightingPresetName } from '@render/lighting';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ScenarioId = string;

/** Which parts of the renderer a scenario wants. Used for isolated critique. */
export interface ScenarioLayers {
  terrain: boolean;
  sprites: boolean;
  ui: boolean;
  post: boolean;
  /** Draw the movement-range overlay for the active unit. */
  highlights: boolean;
}

export interface ScenarioCamera {
  /** 0 = looking from the south-east, then 90° clockwise per step. */
  yawIndex: 0 | 1 | 2 | 3;
  /** Frame the whole field, then apply the overrides below. */
  frameField: boolean;
  /** Device pixels per sprite texel. Overrides the framing choice when set. */
  pixelScale?: number;
  /** Grid cell to centre on after framing. */
  focusTile?: { x: number; y: number; z: number };
  /** Downward tilt in degrees. */
  pitchDegrees?: number;
}

export interface UnitPlacement {
  id: UnitId;
  name: string;
  job: JobId;
  gender: Gender;
  team: Team;
  level: number;
  zodiac: Zodiac;
  brave: number;
  faith: number;
  at: { x: number; y: number };
  facing: Facing;
  equipment: Equipment;
  /** Extra abilities beyond the automatic "everything cheap in the job" grant. */
  learn?: readonly AbilityId[];
  secondary?: JobId;
  reaction?: AbilityId;
  support?: AbilityId;
  movement?: AbilityId;
  personality?: PersonalityId;
  /** Start the unit part-way up the CT clock so the first turn is not a tie. */
  ct?: number;
}

/**
 * Per-scenario post tuning. `PostStack` tone maps and exposes on its own, so the
 * lighting preset's `exposure` field never reaches the renderer — the value is
 * carried here instead and pushed into the stack at boot.
 */
export interface ScenarioPost {
  /** Linear exposure multiplier applied just before the tonemapper. */
  exposure?: number;
  /** 0 disables the tilt-shift band entirely; 1 is the stack's default strength. */
  dof?: number;
  ao?: number;
  bloom?: number;
  vignette?: number;
}

export interface Scenario {
  readonly id: ScenarioId;
  readonly name: string;
  readonly blurb: string;
  readonly mapId: string;
  readonly seed: number;
  readonly lighting: LightingPresetName;
  readonly grade: string;
  readonly layers: ScenarioLayers;
  readonly camera: ScenarioCamera;
  readonly post?: ScenarioPost;
  readonly objective: Objective;
  readonly units: readonly UnitPlacement[];
  /**
   * Advance the clock to the first player turn and open the command menu, so the
   * screenshot shows the game in its normal playing state rather than mid-boot.
   */
  readonly openCommandMenu: boolean;
  /** UI banner shown on entry. */
  readonly banner?: { title: string; subtitle?: string };
}

export interface BuiltScenario {
  scenario: Scenario;
  state: BattleState;
  personalities: Map<UnitId, PersonalityId>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Placement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snap a requested cell onto a legal, unoccupied tile.
 *
 * Authored placements are checked against the live map rather than trusted: a
 * map edit that turns a start tile into a fountain plinth should shuffle the unit
 * one tile aside, not throw at boot. The spiral is deterministic, so the fallback
 * is as reproducible as the original placement.
 */
function resolvePlacement(
  field: Battlefield,
  wanted: { x: number; y: number },
  taken: Set<string>,
): Vec3 {
  const rings = 4;
  for (let r = 0; r <= rings; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = wanted.x + dx;
        const y = wanted.y + dy;
        const key = tileKey(x, y);
        if (taken.has(key)) continue;
        const tile = field.tileAt(x, y);
        if (!tile || !tile.passable || tile.surface === 'void') continue;
        if (tile.surface === 'deepwater' || tile.surface === 'lava') continue;
        taken.add(key);
        return positionOn(field, x, y) ?? { x, y, z: tile.height };
      }
    }
  }
  throw new Error(`scenario: no legal tile near (${wanted.x},${wanted.y})`);
}

/**
 * Everything the unit's own job teaches for under `budget` JP, so its command
 * menu is populated with real abilities from the first turn. Deliberately not
 * "everything": a level-12 Black Mage should have Fire and Fira, not Firaja.
 */
function grantedAbilities(job: JobId, budget: number, extra: readonly AbilityId[] = []): AbilityId[] {
  const out: AbilityId[] = [];
  for (const skill of jobSkillset(getJob(job))) {
    if (skill.jp <= budget) out.push(skill.ability.id);
  }
  for (const id of extra) if (!out.includes(id)) out.push(id);
  return out;
}

/** JP a unit of this level would plausibly have banked in its own job. */
function jpFor(level: number): number {
  return 120 + level * 90;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────

export function buildScenario(scenario: Scenario): BuiltScenario {
  bootstrapContent();

  const field = generateMap(scenario.mapId);
  const rng = createRng(scenario.seed);
  const units = new Map<UnitId, Unit>();
  const personalities = new Map<UnitId, PersonalityId>();
  const taken = new Set<string>();

  for (const placement of scenario.units) {
    const pos = resolvePlacement(field, placement.at, taken);
    const budget = jpFor(placement.level);
    const learned = grantedAbilities(placement.job, budget, placement.learn ?? []);

    const unit = createUnit({
      id: placement.id,
      name: placement.name,
      team: placement.team,
      job: placement.job,
      gender: placement.gender,
      zodiac: placement.zodiac,
      level: placement.level,
      brave: placement.brave,
      faith: placement.faith,
      pos,
      facing: placement.facing,
      equipment: placement.equipment,
      learned: { [placement.job]: learned },
      jp: { [placement.job]: budget },
      ...(placement.secondary !== undefined
        ? { secondaryAction: getJob(placement.secondary).actionSet }
        : {}),
      ...(placement.reaction !== undefined ? { reaction: placement.reaction } : {}),
      ...(placement.support !== undefined ? { support: placement.support } : {}),
      ...(placement.movement !== undefined ? { movement: placement.movement } : {}),
    });

    if (placement.secondary !== undefined) {
      // The borrowed skillset must actually be learned or the menu is empty.
      const secondaryJob = getJob(placement.secondary);
      const progress = unit.jobs.get(placement.job);
      const borrowed = jobActions(secondaryJob).filter((s) => s.jp <= budget * 0.6);
      if (progress) for (const skill of borrowed) progress.learned.add(skill.ability.id);
    }

    // Stagger the clock so the turn order is a real ordering, not a tie-break.
    unit.ct = placement.ct ?? rng.int(40);
    units.set(unit.id, unit);
    if (placement.personality) personalities.set(unit.id, placement.personality);
  }

  const state: BattleState = {
    field,
    units,
    order: [],
    active: undefined,
    phase: 'deploy',
    tick: 0,
    rngState: createRng(scenario.seed ^ 0x5f3759df).state(),
    log: [],
    objective: scenario.objective,
  };

  // Prime the derived stat mirrors so the first UI paint is not showing 1 HP.
  for (const unit of units.values()) {
    const derived = deriveStats(unit);
    unit.stats.maxHp = derived.maxHp;
    unit.stats.maxMp = derived.maxMp;
    unit.stats.hp = derived.maxHp;
    unit.stats.mp = derived.maxMp;
  }

  return { scenario, state, personalities };
}

// ─────────────────────────────────────────────────────────────────────────────
// Equipment loadouts
// ─────────────────────────────────────────────────────────────────────────────

const KNIGHT_KIT: Equipment = {
  rightHand: 'broadsword', leftHand: 'buckler',
  head: 'bronze-helm', body: 'chain-mail', accessory: 'bracer',
};
const VETERAN_KNIGHT_KIT: Equipment = {
  rightHand: 'long-sword', leftHand: 'round-shield',
  head: 'bronze-helm', body: 'chain-mail', accessory: 'battle-boots',
};
const WHITE_MAGE_KIT: Equipment = {
  rightHand: 'white-staff', head: 'feather-hat', body: 'linen-robe', accessory: 'bracer',
};
const BLACK_MAGE_KIT: Equipment = {
  rightHand: 'flame-rod', head: 'feather-hat', body: 'silk-robe', accessory: 'battle-boots',
};
const TIME_MAGE_KIT: Equipment = {
  rightHand: 'oak-staff', head: 'feather-hat', body: 'linen-robe', accessory: 'reflect-ring',
};
const ARCHER_KIT: Equipment = {
  rightHand: 'long-bow', head: 'green-beret', body: 'leather-outfit', accessory: 'spike-shoes',
};
const HUNTER_KIT: Equipment = {
  rightHand: 'silver-bow', head: 'green-beret', body: 'leather-outfit', accessory: 'battle-boots',
};
const MONK_KIT: Equipment = {
  head: 'headband', body: 'leather-outfit', accessory: 'bracer',
};
const THIEF_KIT: Equipment = {
  rightHand: 'mythril-knife', head: 'green-beret', body: 'leather-outfit', accessory: 'battle-boots',
};
const CUTPURSE_KIT: Equipment = {
  rightHand: 'dagger', head: 'green-beret', body: 'leather-outfit', accessory: 'battle-boots',
};

// ─────────────────────────────────────────────────────────────────────────────
// battle-open — Orbonne Monastery, cloister garden
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Six against six across the sunken garden. The player squad holds the south
 * steps at elevation 3–4; the enemy occupies the north cloister and the raised
 * east and west walks. The 2×2 fountain plinth at the centre is impassable and
 * genuinely breaks line of sight, and the reflecting pool in the south-west
 * corner is elevation 0 — three metres below the walk that overlooks it.
 *
 * Placements are chosen so that at any camera yaw at least three distinct
 * elevation bands are occupied, which is what makes the diorama read as a
 * diorama rather than as a chessboard.
 */
const BATTLE_OPEN_UNITS: readonly UnitPlacement[] = [
  // ── Player: the south steps and the west walk ────────────────────────────
  {
    id: 'p-aldric', name: 'Aldric', job: 'knight', gender: 'male', team: 'player',
    level: 14, zodiac: 'leo', brave: 72, faith: 58,
    at: { x: 6, y: 12 }, facing: 'N', equipment: KNIGHT_KIT,
    secondary: 'squire', reaction: 'counter', support: 'defense-up', movement: 'move-plus-1',
    ct: 82,
  },
  {
    id: 'p-seryn', name: 'Seryn', job: 'white-mage', gender: 'female', team: 'player',
    level: 13, zodiac: 'virgo', brave: 55, faith: 78,
    at: { x: 6, y: 13 }, facing: 'N', equipment: WHITE_MAGE_KIT,
    secondary: 'chemist', reaction: 'regenerator', support: 'half-mp', movement: 'move-hp-up',
    ct: 34,
  },
  {
    id: 'p-belric', name: 'Belric', job: 'archer', gender: 'male', team: 'player',
    level: 13, zodiac: 'sagittarius', brave: 68, faith: 52,
    at: { x: 2, y: 11 }, facing: 'N', equipment: ARCHER_KIT,
    secondary: 'squire', reaction: 'arrow-guard', support: 'concentrate', movement: 'jump-plus-2',
    ct: 61,
  },
  {
    id: 'p-ivane', name: 'Ivane', job: 'black-mage', gender: 'female', team: 'player',
    level: 13, zodiac: 'scorpio', brave: 48, faith: 82,
    at: { x: 8, y: 13 }, facing: 'N', equipment: BLACK_MAGE_KIT,
    secondary: 'time-mage', reaction: 'absorb-mp', support: 'magick-attack-up',
    movement: 'move-mp-up',
    ct: 47,
  },
  {
    id: 'p-torvald', name: 'Torvald', job: 'monk', gender: 'male', team: 'player',
    level: 14, zodiac: 'aries', brave: 80, faith: 45,
    at: { x: 8, y: 11 }, facing: 'N', equipment: MONK_KIT,
    secondary: 'knight', reaction: 'brave-up', support: 'martial-arts', movement: 'move-plus-2',
    ct: 25,
  },
  {
    id: 'p-nessa', name: 'Nessa', job: 'thief', gender: 'female', team: 'player',
    level: 12, zodiac: 'gemini', brave: 66, faith: 60,
    at: { x: 4, y: 12 }, facing: 'N', equipment: THIEF_KIT,
    secondary: 'archer', reaction: 'sunken-state', support: 'gained-jp-up', movement: 'move-plus-2',
    ct: 55,
  },

  // ── Enemy: the north cloister, the plinth flanks, the east walk ──────────
  {
    id: 'e-corvin', name: 'Corvin', job: 'knight', gender: 'male', team: 'enemy',
    level: 14, zodiac: 'taurus', brave: 74, faith: 50,
    at: { x: 6, y: 4 }, facing: 'S', equipment: VETERAN_KNIGHT_KIT,
    secondary: 'squire', reaction: 'counter', support: 'defense-up', movement: 'move-plus-1',
    personality: 'defensive', ct: 40,
  },
  {
    id: 'e-sable', name: 'Sable', job: 'archer', gender: 'female', team: 'enemy',
    level: 14, zodiac: 'capricorn', brave: 70, faith: 48,
    at: { x: 11, y: 3 }, facing: 'S', equipment: HUNTER_KIT,
    secondary: 'thief', reaction: 'arrow-guard', support: 'concentrate', movement: 'jump-plus-2',
    personality: 'assassin', ct: 30,
  },
  {
    id: 'e-halden', name: 'Halden', job: 'black-mage', gender: 'male', team: 'enemy',
    level: 13, zodiac: 'aquarius', brave: 44, faith: 80,
    at: { x: 7, y: 2 }, facing: 'S', equipment: { ...BLACK_MAGE_KIT, rightHand: 'rod' },
    secondary: 'mystic', reaction: 'absorb-mp', support: 'magick-attack-up',
    movement: 'move-mp-up',
    personality: 'tactician', ct: 18,
  },
  {
    id: 'e-bram', name: 'Bram', job: 'monk', gender: 'male', team: 'enemy',
    level: 13, zodiac: 'cancer', brave: 82, faith: 42,
    at: { x: 4, y: 4 }, facing: 'S', equipment: MONK_KIT,
    secondary: 'squire', reaction: 'brave-up', support: 'martial-arts', movement: 'move-plus-2',
    personality: 'aggressive', ct: 52,
  },
  {
    id: 'e-quill', name: 'Quill', job: 'thief', gender: 'female', team: 'enemy',
    level: 12, zodiac: 'pisces', brave: 64, faith: 55,
    at: { x: 9, y: 5 }, facing: 'S', equipment: CUTPURSE_KIT,
    secondary: 'squire', reaction: 'sunken-state', support: 'gained-jp-up', movement: 'move-plus-3',
    personality: 'assassin', ct: 44,
  },
  {
    id: 'e-maelor', name: 'Maelor', job: 'time-mage', gender: 'male', team: 'enemy',
    level: 13, zodiac: 'libra', brave: 46, faith: 76,
    at: { x: 10, y: 1 }, facing: 'S', equipment: TIME_MAGE_KIT,
    secondary: 'white-mage', reaction: 'regenerator', support: 'half-mp', movement: 'move-mp-up',
    personality: 'support', ct: 12,
  },
];

const BATTLE_OPEN: Scenario = {
  id: 'battle-open',
  name: 'Orbonne Monastery — Cloister Garden',
  blurb: 'Six against six across the sunken garden. Height, cover and a reflecting pool.',
  mapId: 'orbonne-courtyard',
  seed: 20260727,
  lighting: 'dawn',
  grade: 'cathedral',
  layers: { terrain: true, sprites: true, ui: true, post: true, highlights: true },
  camera: { yawIndex: 0, frameField: true, focusTile: { x: 6, y: 7, z: 3 } },
  // The reference games are clean. A tactics board has to stay readable across
  // the whole frame, so the tilt-shift band is a hint of miniature depth rather
  // than the wall of blur the stack defaults to.
  post: { exposure: 1.55, dof: 0.3, ao: 0.85, bloom: 1.0, vignette: 0.7 },
  objective: { kind: 'defeat-all' },
  units: BATTLE_OPEN_UNITS,
  openCommandMenu: true,
  banner: { title: 'Orbonne Monastery', subtitle: 'The cloister garden' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Isolation scenarios
// ─────────────────────────────────────────────────────────────────────────────

const TERRAIN_ONLY: Scenario = {
  ...BATTLE_OPEN,
  id: 'terrain-only',
  name: 'Orbonne Monastery — terrain only',
  blurb: 'The diorama with no units, no UI and no overlays. For judging geometry and light.',
  layers: { terrain: true, sprites: false, ui: false, post: true, highlights: false },
  camera: { yawIndex: 0, frameField: true, focusTile: { x: 6, y: 6, z: 3 } },
  openCommandMenu: false,
  units: [],
};

/**
 * Sprites at their real gameplay density against a bare stage — no terrain to
 * hide behind and no post to flatter them, so the pixel snap, the palette swap
 * and the grounding shadow are all judged on their own.
 */
const SPRITES_ONLY: Scenario = {
  ...BATTLE_OPEN,
  id: 'sprites-only',
  name: 'Sprite parade',
  blurb: 'Every unit in the roster, no terrain, no post. For judging the billboards.',
  lighting: 'overcast',
  layers: { terrain: false, sprites: true, ui: false, post: false, highlights: false },
  camera: { yawIndex: 0, frameField: false, pixelScale: 4, focusTile: { x: 6, y: 7, z: 2 } },
  openCommandMenu: false,
  units: BATTLE_OPEN_UNITS.map((u, i) => ({
    ...u,
    // Two ranks of six across the flat garden floor, all facing the camera.
    at: { x: 2 + (i % 6) * 2, y: i < 6 ? 8 : 4 },
    facing: 'S' as Facing,
  })),
};

const UI_ONLY: Scenario = {
  ...BATTLE_OPEN,
  id: 'ui-only',
  name: 'Interface only',
  blurb: 'The full battle HUD over an empty stage. For judging the chrome and typography.',
  layers: { terrain: false, sprites: false, ui: true, post: false, highlights: false },
  openCommandMenu: true,
};

/**
 * Mandalia Plains — the second authored map. Not required by the harness, but a
 * water/river diorama is a completely different lighting and material problem
 * from a stone cloister and is worth being able to shoot.
 */
const MANDALIA: Scenario = {
  id: 'mandalia-ford',
  name: 'Mandalia Plains — River Crossing',
  blurb: 'One bridge, one deep ford, and a stone outcrop that owns the sight lines.',
  mapId: 'mandalia-plains',
  seed: 20260728,
  lighting: 'dusk',
  grade: 'dusk-plains',
  layers: { terrain: true, sprites: true, ui: true, post: true, highlights: true },
  camera: { yawIndex: 0, frameField: true },
  objective: { kind: 'defeat-all' },
  openCommandMenu: true,
  banner: { title: 'Mandalia Plains', subtitle: 'The river crossing' },
  units: BATTLE_OPEN_UNITS.map((u, i) => ({
    ...u,
    at: u.team === 'player' ? { x: 2 + (i % 3) * 2, y: 10 + Math.floor(i / 3) } : { x: 10 + (i % 3) * 2, y: 2 + Math.floor(i / 3) },
  })),
};

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export const SCENARIOS: Readonly<Record<ScenarioId, Scenario>> = {
  'battle-open': BATTLE_OPEN,
  'terrain-only': TERRAIN_ONLY,
  'sprites-only': SPRITES_ONLY,
  'ui-only': UI_ONLY,
  'mandalia-ford': MANDALIA,
};

export const DEFAULT_SCENARIO: ScenarioId = 'battle-open';

export function listScenarios(): readonly Scenario[] {
  return Object.values(SCENARIOS);
}

export function getScenario(id: string | null | undefined): Scenario {
  if (id) {
    const found = SCENARIOS[id];
    if (found) return found;
    if (id !== DEFAULT_SCENARIO) {
      console.warn(`[scenarios] unknown scenario "${id}"; falling back to ${DEFAULT_SCENARIO}.`);
    }
  }
  return SCENARIOS[DEFAULT_SCENARIO] as Scenario;
}

/** Map metadata for the lighting rig and the debug HUD. */
export function scenarioMapDef(scenario: Scenario) {
  return getMapDef(scenario.mapId);
}

/**
 * Query-string overrides, for the visual-critic loop.
 *
 * `?lighting=dusk&grade=ivalice-noon&exposure=1.4&yaw=2&zoom=3&banner=0` lets a
 * frame be re-shot with one variable changed without editing this file, which is
 * the difference between a five-second iteration and a rebuild.
 */
export function overrideScenario(scenario: Scenario, params: URLSearchParams): Scenario {
  const lighting = params.get('lighting') as LightingPresetName | null;
  const grade = params.get('grade');
  const yaw = params.get('yaw');
  const zoom = params.get('zoom');
  const pitch = params.get('pitch');
  const banner = params.get('banner');
  const exposure = params.get('exposure');
  const dof = params.get('dof');

  const camera: ScenarioCamera = { ...scenario.camera };
  if (yaw !== null) {
    const index = Number(yaw);
    if (index >= 0 && index <= 3) camera.yawIndex = index as 0 | 1 | 2 | 3;
  }
  if (zoom !== null && Number.isFinite(Number(zoom))) {
    camera.pixelScale = Number(zoom);
    camera.frameField = false;
  }
  if (pitch !== null && Number.isFinite(Number(pitch))) camera.pitchDegrees = Number(pitch);

  const post: ScenarioPost = { ...scenario.post };
  if (exposure !== null && Number.isFinite(Number(exposure))) post.exposure = Number(exposure);
  if (dof !== null && Number.isFinite(Number(dof))) post.dof = Number(dof);

  const next: Scenario = {
    ...scenario,
    camera,
    post,
    ...(lighting && lighting in LIGHTING_PRESET_NAMES ? { lighting } : {}),
    ...(grade !== null ? { grade } : {}),
  };
  if (banner === '0') {
    const stripped: Scenario = { ...next };
    delete (stripped as { banner?: unknown }).banner;
    return stripped;
  }
  return next;
}

const LIGHTING_PRESET_NAMES: Readonly<Record<LightingPresetName, true>> = {
  dawn: true, overcast: true, dusk: true, storm: true, night: true,
};
