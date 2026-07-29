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
import {
  ENCOUNTERS as AUTHORED_ENCOUNTERS,
  getEncounter as findEncounter,
  type Encounter,
  type UnitPlacement,
} from '../content/encounters';
import {
  ARCHER_KIT,
  BLACK_MAGE_KIT,
  KNIGHT_KIT,
  MONK_KIT,
  THIEF_KIT,
  WHITE_MAGE_KIT,
} from '../content/encounters/loadouts';

import {
  createCampaign,
  setCurrentWorldNode,
  unitFromPersisted,
  unitToPersisted,
  type CampaignState,
} from '@core/campaign';
import type { WorldNodeId } from '@core/ids';
import { getMapDef, generateMap, positionOn, tileKey } from '@core/grid';
import { getJob } from '@core/jobs';
import { createRng } from '@core/rng';
import { createUnit, deriveStats } from '@core/unit';
import type {
  AbilityId,
  BattleState,
  Battlefield,
  Facing,
  ItemId,
  JobId,
  Objective,
  Unit,
  UnitId,
  Vec3,
} from '@core/types';
import type { PersonalityId } from '@core/ai';
import type { LightingPreset, LightingPresetName } from '@render/lighting';

/** Scenario ids that keep the hardcoded `buildScenario` cast for render tooling. */
const DIAGNOSTIC_SCENARIO_IDS: ReadonlySet<string> = new Set([
  'terrain-only',
  'sprites-only',
  'ui-only',
]);

/** True for screenshot/diagnostic scenes that must not go through the campaign. */
export function isDiagnosticScenario(scenarioId: string): boolean {
  return DIAGNOSTIC_SCENARIO_IDS.has(scenarioId);
}

/**
 * Starter company stock for a brand-new game.
 * Three Potions — not the battle-default eight from {@link STARTING_STOCK}.
 */
export const STARTER_CAMPAIGN_INVENTORY: Readonly<Record<string, number>> = {
  'long-sword': 1,
  rod: 1,
  buckler: 1,
  'use-potion': 3,
};

/** Canonical scenario whose player cast seeds a brand-new campaign company. */
export const CAMPAIGN_START_SCENARIO_ID = 'first-lesson';

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
  /**
   * Honour the contain-fit even when it puts characters below the camera's
   * composition floor, so the whole diorama is in shot. For overview scenarios.
   */
  fitWholeField?: boolean;
}

export type { Encounter, UnitPlacement } from '../content/encounters';

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
  /**
   * Per-scenario patch on top of the preset AND on top of the map's own authored
   * lighting. Use it for the things only the composition knows — a walled
   * courtyard needs a higher sun than the open plains or the whole interior sits
   * in the shadow of its own wall.
   */
  readonly lightingTune?: Partial<LightingPreset>;
  readonly grade: string;
  readonly layers: ScenarioLayers;
  readonly camera: ScenarioCamera;
  readonly post?: ScenarioPost;
  /** Campaign battles resolve their opposition and rewards through this record. */
  readonly encounterId?: string;
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

/**
 * Campaign path result: a playable battle plus the selected durable company.
 * Battle launch provenance travels on BattleState, so write-back does not rely
 * on mutating campaign navigation or on the caller retaining a wrapper object.
 */
export interface CampaignBuiltScenario extends BuiltScenario {
  campaign: CampaignState;
}

export interface CampaignBattleOptions {
  /** World-map node that explicitly launched this battle, if any. */
  worldNodeId?: WorldNodeId;
  /**
   * Place the campaign roster at the scenario's authored player positions.
   * Screenshot mode uses this so routing through the campaign does not move
   * the cast the visual baselines were composed around.
   */
  preserveScenarioPlayerPlacements?: boolean;
}

export interface CampaignLaunchOptions extends CampaignBattleOptions {
  /** Loaded company, or null/undefined for a brand-new game. */
  campaign?: CampaignState | null;
  timestamp: number;
}

export interface CampaignLaunch {
  campaign: CampaignState;
  built: CampaignBuiltScenario;
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

/** Build a unit from a scenario placement (hardcoded demo path). */
function unitFromPlacement(
  placement: UnitPlacement,
  pos: Vec3,
): Unit {
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

  return unit;
}

function primeDerived(units: Iterable<Unit>): void {
  for (const unit of units) {
    const derived = deriveStats(unit);
    unit.stats.maxHp = derived.maxHp;
    unit.stats.maxMp = derived.maxMp;
    unit.stats.hp = derived.maxHp;
    unit.stats.mp = derived.maxMp;
  }
}

export function buildScenario(scenario: Scenario): BuiltScenario {
  bootstrapContent();

  const field = generateMap(scenario.mapId);
  const rng = createRng(scenario.seed);
  const units = new Map<UnitId, Unit>();
  const personalities = new Map<UnitId, PersonalityId>();
  const taken = new Set<string>();

  for (const placement of scenario.units) {
    const pos = resolvePlacement(field, placement.at, taken);
    const unit = unitFromPlacement(placement, pos);
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

  primeDerived(units.values());

  return { scenario, state, personalities };
}

/**
 * A brand-new company seeded from the scenario's player cast.
 *
 * Production boot uses this (or a loaded save), then {@link campaignToBattle}.
 * Does not launch a battle — inventory is the campaign starter stock (three
 * Potions), not the eight-potion battle default from inventoryFor.
 */
export function newGameCampaign(scenario: Scenario, timestamp: number): CampaignState {
  bootstrapContent();
  const campaign = createCampaign(scenario.seed, timestamp);
  for (const placement of scenario.units) {
    if (placement.team !== 'player') continue;
    // Placement tile is only used for unit construction; campaignToBattle
    // repositions onto map playerStarts from the formation slate.
    const unit = unitFromPlacement(placement, {
      x: placement.at.x,
      y: placement.at.y,
      z: 0,
    });
    campaign.roster.push(unitToPersisted(unit));
  }
  campaign.formation = campaign.roster.map((u, i) => ({
    unitId: u.id,
    startIndex: i,
  }));
  campaign.inventory = { ...STARTER_CAMPAIGN_INVENTORY };
  return campaign;
}

/**
 * Select the company for a real battle, then launch it through one boundary.
 *
 * Game uses this for loaded saves, new games, and non-diagnostic screenshot
 * scenes. Keeping selection and launch together prevents a fresh-game caller
 * from accidentally falling back to buildScenario.
 */
export function launchCampaignBattle(
  scenario: Scenario,
  opts: CampaignLaunchOptions,
): CampaignLaunch {
  const loaded = opts.campaign;
  const selected =
    loaded === null || loaded === undefined || loaded.roster.length === 0
      ? newGameCampaign(scenario, opts.timestamp)
      : loaded;
  const campaign =
    opts.worldNodeId === undefined
      ? selected
      : setCurrentWorldNode(selected, opts.worldNodeId, opts.timestamp);
  const built = campaignToBattle(campaign, scenario, {
    preserveScenarioPlayerPlacements: opts.preserveScenarioPlayerPlacements ?? false,
    ...(opts.worldNodeId === undefined ? {} : { worldNodeId: opts.worldNodeId }),
  });
  return { campaign, built };
}

/**
 * Open a battle whose player units come from the campaign roster instead of the
 * scenario's hardcoded list. Enemies (and any non-player placements) still come
 * from the scenario. Placement tiles and CT offsets are the scenario's.
 *
 * Battle RNG is seeded from `campaign.seed` (not `scenario.seed`) so a campaign
 * save/load boundary preserves determinism and changing the campaign seed
 * changes the fight. Map geometry and enemy placements still come from the
 * scenario definition.
 *
 * World-node provenance is copied onto BattleState only when the world map
 * supplied it. Direct scenario and diagnostic entry paths leave it absent, so
 * they cannot complete a stale navigation node.
 *
 * Does not replace {@link buildScenario}: diagnostic scenes and the screenshot
 * harness keep using the hardcoded path.
 */
export function campaignToBattle(
  campaign: CampaignState,
  scenario: Scenario,
  opts: CampaignBattleOptions = {},
): CampaignBuiltScenario {
  bootstrapContent();

  const rosterIds = new Set<UnitId>();
  for (const unit of campaign.roster) {
    if (rosterIds.has(unit.id)) {
      throw new Error(`campaignToBattle: duplicate roster id "${unit.id}"`);
    }
    rosterIds.add(unit.id);
  }

  const field = generateMap(scenario.mapId);
  // Campaign seed drives CT stagger and battle RNG — scenario.seed is unused
  // on this path (it remains the seed for the diagnostic buildScenario path).
  const battleSeed = campaign.seed;
  const rng = createRng(battleSeed);
  const units = new Map<UnitId, Unit>();
  const personalities = new Map<UnitId, PersonalityId>();
  const taken = new Set<string>();

  // Legal deploy tiles come from the map's playerStarts, not the scenario's
  // hardcoded cast positions (those exist for the diagnostic buildScenario path).
  const mapDef = getMapDef(scenario.mapId);
  const startTiles = mapDef?.playerStarts ?? [];
  const encounter = getEncounter(scenario.encounterId);
  if (scenario.encounterId !== undefined && encounter === undefined) {
    throw new Error(`scenario: unknown encounter "${scenario.encounterId}"`);
  }
  const authoredOpposition = scenario.units.filter((u) => u.team !== 'player');
  // Tests and one-off tools may deliberately derive a peaceful scenario by
  // removing every authored enemy. Preserve that explicit empty override.
  const activeEncounter = authoredOpposition.length > 0 ? encounter : undefined;
  const nonPlayerPlacements = activeEncounter?.enemies ?? authoredOpposition;
  // Facing / CT hints from the scenario's player slots when counts match.
  const playerHints = scenario.units.filter((u) => u.team === 'player');

  const rosterById = new Map(campaign.roster.map((u) => [u.id, u]));
  const formation = campaign.formation ?? [];
  if (formation.length > 0) {
    for (const entry of formation) {
      const persisted = rosterById.get(entry.unitId);
      const hint = playerHints[entry.startIndex];
      const start = opts.preserveScenarioPlayerPlacements ? hint?.at : startTiles[entry.startIndex];
      if (!start || !persisted) continue;
      const pos = resolvePlacement(field, { x: start.x, y: start.y }, taken);
      const unit = unitFromPersisted(persisted, {
        team: 'player',
        pos,
        facing: hint?.facing ?? 'N',
      });
      unit.ct = hint?.ct ?? rng.int(40);
      units.set(unit.id, unit);
    }
  } else {
    const availableStarts = opts.preserveScenarioPlayerPlacements ? playerHints : startTiles;
    const deployCount = Math.min(campaign.roster.length, availableStarts.length);
    for (let i = 0; i < deployCount; i++) {
      const persisted = campaign.roster[i]!;
      const hint = playerHints[i];
      const start = opts.preserveScenarioPlayerPlacements ? hint?.at : startTiles[i];
      if (!start) continue;
      const pos = resolvePlacement(field, { x: start.x, y: start.y }, taken);
      const unit = unitFromPersisted(persisted, {
        team: 'player',
        pos,
        facing: hint?.facing ?? 'N',
      });
      unit.ct = hint?.ct ?? rng.int(40);
      units.set(unit.id, unit);
    }
  }

  for (const placement of nonPlayerPlacements) {
    const pos = resolvePlacement(field, placement.at, taken);
    const unit = unitFromPlacement(placement, pos);
    unit.ct = placement.ct ?? rng.int(40);
    units.set(unit.id, unit);
    if (placement.personality) personalities.set(unit.id, placement.personality);
  }

  const playerStock = new Map<ItemId, number>();
  for (const [id, n] of Object.entries(campaign.inventory)) {
    if (n > 0) playerStock.set(id, n);
  }

  const state: BattleState = {
    field,
    units,
    order: [],
    active: undefined,
    phase: 'deploy',
    tick: 0,
    rngState: createRng(battleSeed ^ 0x5f3759df).state(),
    log: [],
    objective: activeEncounter?.objective ?? scenario.objective,
    inventories: new Map([['player', playerStock]]),
    ...(opts.worldNodeId === undefined ? {} : { campaignNodeId: opts.worldNodeId }),
  };

  primeDerived(units.values());

  return { scenario, state, personalities, campaign };
}

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
const BATTLE_OPEN_PLAYER_UNITS: readonly UnitPlacement[] = [
  // ── Player: the south steps and the west walk ────────────────────────────
  {
    id: 'p-aldric', name: 'Aldric', job: 'knight', gender: 'male', team: 'player',
    level: 14, zodiac: 'leo', brave: 72, faith: 58,
    at: { x: 7, y: 9 }, facing: 'N', equipment: KNIGHT_KIT,
    secondary: 'squire', reaction: 'counter', support: 'defense-up', movement: 'move-plus-1',
    ct: 82,
  },
  {
    id: 'p-seryn', name: 'Seryn', job: 'white-mage', gender: 'female', team: 'player',
    level: 13, zodiac: 'virgo', brave: 55, faith: 78,
    at: { x: 7, y: 11 }, facing: 'N', equipment: WHITE_MAGE_KIT,
    secondary: 'chemist', reaction: 'regenerator', support: 'half-mp', movement: 'move-hp-up',
    ct: 34,
  },
  {
    id: 'p-belric', name: 'Belric', job: 'archer', gender: 'male', team: 'player',
    level: 13, zodiac: 'sagittarius', brave: 68, faith: 52,
    at: { x: 2, y: 9 }, facing: 'N', equipment: ARCHER_KIT,
    secondary: 'squire', reaction: 'arrow-guard', support: 'concentrate', movement: 'jump-plus-2',
    ct: 61,
  },
  {
    id: 'p-ivane', name: 'Ivane', job: 'black-mage', gender: 'female', team: 'player',
    level: 13, zodiac: 'scorpio', brave: 48, faith: 82,
    at: { x: 9, y: 11 }, facing: 'N', equipment: BLACK_MAGE_KIT,
    secondary: 'time-mage', reaction: 'absorb-mp', support: 'magick-attack-up',
    movement: 'move-mp-up',
    ct: 47,
  },
  {
    id: 'p-torvald', name: 'Torvald', job: 'monk', gender: 'male', team: 'player',
    level: 14, zodiac: 'aries', brave: 80, faith: 45,
    at: { x: 8, y: 9 }, facing: 'N', equipment: MONK_KIT,
    secondary: 'knight', reaction: 'brave-up', support: 'martial-arts', movement: 'move-plus-2',
    ct: 25,
  },
  {
    id: 'p-nessa', name: 'Nessa', job: 'thief', gender: 'female', team: 'player',
    level: 12, zodiac: 'gemini', brave: 66, faith: 60,
    at: { x: 3, y: 11 }, facing: 'N', equipment: THIEF_KIT,
    secondary: 'archer', reaction: 'sunken-state', support: 'gained-jp-up', movement: 'move-plus-2',
    ct: 55,
  },
];

/**
 * The playable campaign starts below the screenshot cast's veteran levels.
 *
 * Keep this derivation separate from BATTLE_OPEN_PLAYER_UNITS: battle-open is a
 * protected visual reference scene, while these levels shape campaign combat.
 */
const CAMPAIGN_START_LEVELS: Readonly<Record<UnitId, number>> = {
  'p-aldric': 9,
  'p-seryn': 8,
  'p-belric': 8,
  'p-ivane': 8,
  'p-torvald': 9,
  'p-nessa': 7,
};

const CAMPAIGN_PLAYER_UNITS: readonly UnitPlacement[] = BATTLE_OPEN_PLAYER_UNITS.map(
  (unit) => ({
    ...unit,
    level: CAMPAIGN_START_LEVELS[unit.id] ?? unit.level,
  }),
);

export const ENCOUNTERS: Readonly<Record<string, Encounter>> = AUTHORED_ENCOUNTERS;

export function getEncounter(id: string | null | undefined): Encounter | undefined {
  return findEncounter(id);
}

const BATTLE_OPEN_ENCOUNTER = ENCOUNTERS['orbonne-vanguard']!;
const BATTLE_OPEN_UNITS: readonly UnitPlacement[] = [
  ...BATTLE_OPEN_PLAYER_UNITS,
  ...BATTLE_OPEN_ENCOUNTER.enemies,
];

const BATTLE_OPEN: Scenario = {
  id: 'battle-open',
  name: 'Orbonne Monastery — Cloister Garden',
  blurb: 'Six against six across the sunken garden. Height, cover and a reflecting pool.',
  mapId: 'orbonne-courtyard',
  seed: 20260727,
  lighting: 'dawn',
  // Orbonne's cloister is a box: its own walls rise 4-5 world units above the
  // sunken garden, so the preset's 24-degree dawn sun leaves the entire playable
  // interior in shadow. Lift the key over the wall and warm the fill.
  lightingTune: {
    keyElevation: 54,
    keyAzimuth: 138,
    keyIntensity: 3.1,
    // ART-DIRECTION PASS — the shadow floor was the reason the board read as a
    // black cut-out pasted onto a lighter card.
    //
    // At 1.25/0.42 the board's unlit faces bottomed out under luma 15 while the
    // ground plate immediately outside them sat near 110, so the diorama's
    // silhouette was a 5x value step across one antialiased edge, and several
    // rounds of work on the PLATE could not fix it because the plate was not the
    // side that was wrong. No reference frame does this: the shadow side of the
    // stone in 'official_003_steam.jpg' holds 40-60, and it is the value
    // continuity across that boundary — not any amount of dressing laid over it —
    // that makes a shipped frame read as one solid object rather than two layers.
    //
    // Lifting the fill rather than the key also puts the light where the grade
    // wants it: 'publishTerrainBounce' premultiplies the rig's own graded sky and
    // ground colours, and 'groundColor' here is a warm ochre, so the extra fill
    // arrives warm and reinforces the warm-positive shadow the grade now asks for
    // instead of fighting it.
    hemiIntensity: 1.62,
    ambientIntensity: 0.62,
    // Cooled 0.5 of a step and desaturated. This is the sky lobe of the terrain
    // bounce; at 0xa8c4e8 it was the source of the saturated cyan speckle visible
    // at 6x in the board's shadow. Same luminance, a third of the chroma.
    skyColor: 0xb6c6da,
    groundColor: 0x7a6248,
    rimIntensity: 0.7,
    shadowRadius: 2.4,
  },
  grade: 'ivalice-noon',
  layers: { terrain: true, sprites: true, ui: true, post: true, highlights: true },
  // Composition, round 2.
  //
  // `fitWholeField` is GONE. It forced the zoom floor down to `zoomLevels[0]`, which put the
  // whole cloister on screen as a small diamond with roughly half the frame left as flat
  // background — the single defect the critics scored hardest. Neither reference game shows
  // the whole playfield: `refs/curated/triangle/official_005_steam.jpg` runs its board off
  // all four edges. Dropping the flag lets `frameField`'s cover bias take over and the map
  // bleeds past the frame.
  //
  // 30° rather than 40°. A walled cloister does need to be looked *into*, but 40 flattens
  // the elevation bands this map exists to express — at 40 the vertical wall faces are half
  // the screen height they get at 32, and height is both the art and the mechanic here.
  // VISUAL_TARGET.md measures the references at "roughly 30° pitch".
  //
  // `focusTile` is authored rather than left to the acting unit. Aldric holds the south
  // steps, so focusing him puts the frame centre three tiles south of the garden and the
  // near chapel wall — a single flat masonry face — owns the bottom-right third of the
  // picture. Centring the fountain plinth instead keeps the sunken garden, both colonnades
  // and three elevation bands in shot, and the camera's composition offset then takes it
  // off dead centre.
  camera: { yawIndex: 0, frameField: true, pitchDegrees: 30, focusTile: { x: 6, y: 6, z: 2 } },
  // Post is authored in `post.ts` against the measured reference rubric; the scenario no
  // longer dials it down. `dof: 0.35` was fighting a floor that clamped it straight back up,
  // so the number was a lie, and `vignette: 0.8` was compounding an already-dark frame.
  // Both now sit at 1.0 and the shape lives in `REFERENCE_FLOOR`.
  // Exposure measured, not guessed: `tools/shoot.mjs` reports mean frame luma, the reference
  // frames sit at 66-80/255, and at 1.05 this scene came back at 39.
  // Round 4 re-measured after the grade stopped lifting blacks into navy and the vignette
  // stopped painting a code-28 violet floor over the corners: both changes are correct and
  // both cost mean luma, which fell from 56.5 to 46.8 against the references' 66-80. The
  // right answer to a frame that is too dark because its SHADOWS are finally black is more
  // exposure, not a lighter black point.
  // Round 5 re-measured again on a 3x3 luma grid rather than a single mean, because the mean
  // hid the real defect. Ours: 62 mean with the centre cell at 1.0x the frame average.
  // `official_005_steam.jpg`: 87 mean with the centre cell at 1.8x. Both numbers move the
  // same way — more light through the middle — and the vignette in `post.ts` takes the rim
  // back down, so the frame gets steeper rather than merely brighter.
  //
  // ROUND 6: 2.65 -> 3.9, and it is a consequence rather than a decision. `post.ts` gained a
  // focal-hierarchy pass — a graduated subordination of the defocused far field plus a broad
  // dodge on the composed subject — because the round-6 measurement was that our brightest
  // 3x3 cell was the TOP-CENTRE backdrop, not the action. Subordinating the surround costs
  // mean luma (it fell to 53 at the old exposure, against the references' 66-88), so the
  // exposure goes up to put that light back where the shot is composed instead of spread
  // evenly over the whole picture. Measured on the resulting frame: mean 66.5, centre/corner
  // luma 2.07 against 1.49 before and 1.38-3.84 across four Triangle frames.
  // Exposure is now single-owned (see Game.applyPostProfile): a scenario's value
  // is FINAL and is no longer multiplied by the lighting preset's factor, because
  // two owners on one dial spent a round cancelling each other.
  //
  // 2.1 is measured, not taste. The curated Triangle corpus spans meanLuma 36.5
  // to 142.6 — a 4x range — because it contains both night interiors and daylight
  // snowfields. Two agents each quoted one end of that as "the reference" and drew
  // opposite conclusions. Orbonne at night belongs to the dark subset (36-50), and
  // this lands the frame at meanLuma 45.8 and darkShare 0.42 - inside the night
  // band on both - instead of ~69 with clipped highlights.
  post: { exposure: 1.94, dof: 1.0, vignette: 1.0 },
  encounterId: BATTLE_OPEN_ENCOUNTER.id,
  objective: BATTLE_OPEN_ENCOUNTER.objective,
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
  camera: { yawIndex: 0, frameField: false, pixelScale: 3, focusTile: { x: 7, y: 6, z: 2 }, pitchDegrees: 30 },
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

function scenarioPlayers(mapId: string): readonly UnitPlacement[] {
  if (mapId === 'orbonne-courtyard') return CAMPAIGN_PLAYER_UNITS;
  const starts = getMapDef(mapId)?.playerStarts ?? [];
  return CAMPAIGN_PLAYER_UNITS.map((unit, index) => ({
    ...unit,
    at: starts[index] ?? unit.at,
    facing: 'N' as Facing,
  }));
}

function scenarioFromEncounter(encounter: Encounter): Scenario {
  return {
    id: encounter.id,
    name: encounter.name,
    blurb: encounter.blurb,
    mapId: encounter.mapId,
    seed: encounter.seed,
    lighting: encounter.lighting,
    ...(encounter.lightingTune ? { lightingTune: encounter.lightingTune } : {}),
    grade: encounter.grade,
    layers: { terrain: true, sprites: true, ui: true, post: true, highlights: true },
    camera: encounter.camera ?? { yawIndex: 0, frameField: true },
    ...(encounter.post ? { post: encounter.post } : {}),
    encounterId: encounter.id,
    objective: encounter.objective,
    units: [...scenarioPlayers(encounter.mapId), ...encounter.enemies],
    openCommandMenu: true,
    banner: encounter.banner,
  };
}

const CAMPAIGN_SCENARIOS: Readonly<Record<string, Scenario>> = Object.fromEntries(
  Object.values(ENCOUNTERS)
    .filter((encounter) => encounter.id !== BATTLE_OPEN_ENCOUNTER.id)
    .map((encounter) => [encounter.id, scenarioFromEncounter(encounter)]),
);

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export const SCENARIOS: Readonly<Record<ScenarioId, Scenario>> = {
  'battle-open': BATTLE_OPEN,
  'terrain-only': TERRAIN_ONLY,
  'sprites-only': SPRITES_ONLY,
  'ui-only': UI_ONLY,
  'mandalia-ford': MANDALIA,
  ...CAMPAIGN_SCENARIOS,
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
