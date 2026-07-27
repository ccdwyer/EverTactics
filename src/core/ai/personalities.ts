/**
 * EverTactics — AI personalities.
 *
 * A personality is a weight vector over the scoring terms produced by
 * `evaluate.ts`, plus a handful of behavioural constants that change *which*
 * candidates are considered at all (flee thresholds, standoff distance).
 *
 * The design rule: every archetype must produce visibly different play on the
 * same board. If two personalities pick the same command in every situation,
 * one of them is not pulling its weight.
 *
 * Pure module: no three.js, no Math.random, no imports outside `../types`.
 */

import type { Unit, JobId, StatusId } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Scoring vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The complete set of scoring terms. `evaluate.ts` produces a raw magnitude for
 * each of these (mostly normalised to roughly 0..1 per unit of "thing"), and the
 * personality supplies the weight. Total score = Σ term * weight.
 *
 * Terms whose raw magnitude is inherently *bad* (friendlyFire, threatExposure)
 * are still reported as positive magnitudes; the weights are negative.
 */
export type ScoreTerm =
  // ── offence ──
  | 'damage'          // expected damage to hostiles, as a fraction of their max HP
  | 'kill'            // expected number of kills (probability weighted)
  | 'mpDrain'         // expected MP removed from hostiles, fraction of their max MP
  | 'statusInflict'   // value of debuffs landed on hostiles
  | 'overkill'        // damage thrown away beyond a target's remaining HP
  // ── support ──
  | 'heal'            // effective healing to allies (capped at missing HP), fraction
  | 'revive'          // allies raised from KO
  | 'statusCure'      // value of debuffs cleansed / buffs granted to allies
  // ── mistakes ──
  | 'friendlyFire'    // expected damage dealt to our own side, fraction
  | 'friendlyStatus'  // value of debuffs landed on our own side
  | 'mpCost'          // MP spent, as a fraction of our max MP
  | 'wasteRisk'       // probability a charged ability whiffs because the target moves
  // ── position ──
  | 'height'          // height advantage over the units we care about
  | 'facingSafety'    // 0..1, how well our final facing covers the real threats
  | 'flankRisk'       // being pinched between hostiles on opposite sides
  | 'threatExposure'  // expected incoming damage at the destination, fraction of
                      //      our HP, scaled by `battleCaution`
  | 'clusterRisk'     // standing packed with allies while hostiles hold AoE
  | 'chokepoint'      // holding a narrow tile that gates the approach
  | 'guardAlly'       // staying between the protected ally and the threats
  | 'closeDistance'   // 0..1, fit to our preferred engagement range; falls off
                      //      smoothly with separation so it always pulls us in
  | 'keepDistance'    // 0..1, distance kept, saturating at the range we can
                      //      still strike from — backing off further buys nothing
  // ── target selection ──
  | 'lowHpTarget'     // 0..1, how wounded the primary target is
  | 'squishyTarget'   // 0..1, how fragile the primary target is
  | 'taunt'           // 1 when we obey a taunt compulsion
  // ── self preservation ──
  | 'terrainHazard'   // destination tile actively hurts us (lava, deep water)
  | 'selfRisk'        // chance we simply die before our next turn at this spot,
                      //      scaled by `battleCaution`
  | 'idle';           // 1 when the candidate lands no ability, moved or not

export const SCORE_TERMS: readonly ScoreTerm[] = [
  'damage', 'kill', 'mpDrain', 'statusInflict', 'overkill',
  'heal', 'revive', 'statusCure',
  'friendlyFire', 'friendlyStatus', 'mpCost', 'wasteRisk',
  'height', 'facingSafety', 'flankRisk', 'threatExposure', 'clusterRisk',
  'chokepoint', 'guardAlly', 'closeDistance', 'keepDistance',
  'lowHpTarget', 'squishyTarget', 'taunt',
  'terrainHazard', 'selfRisk', 'idle',
] as const;

export type ScoreWeights = Readonly<Record<ScoreTerm, number>>;

/** An all-zero weight vector, used as the base for every archetype. */
export function zeroWeights(): Record<ScoreTerm, number> {
  const out = {} as Record<ScoreTerm, number>;
  for (const term of SCORE_TERMS) out[term] = 0;
  return out;
}

/**
 * The shared baseline every archetype starts from. This is a competent,
 * colourless tactician: it wants damage and kills, it does not shoot its
 * friends, it likes height, and it does not end a turn with its back exposed.
 */
const BASE: Record<ScoreTerm, number> = {
  damage: 100,
  kill: 260,
  mpDrain: 12,
  statusInflict: 70,
  overkill: -14,

  heal: 95,
  revive: 240,
  statusCure: 60,

  friendlyFire: -190,
  friendlyStatus: -130,
  mpCost: -12,
  wasteRisk: -55,

  height: 16,
  facingSafety: 22,
  flankRisk: -26,
  threatExposure: -55,
  clusterRisk: -10,
  chokepoint: 10,
  guardAlly: 0,
  // Every archetype needs a real reason to walk toward the fight. This is the
  // only term with a gradient out in the open field, so if it is small the unit
  // has no opinion about the enemy at all and settles wherever the terrain
  // happens to score best — which is how a battle ends up never happening.
  closeDistance: 46,
  keepDistance: 0,

  lowHpTarget: 22,
  squishyTarget: 10,
  taunt: 200,

  terrainHazard: -60,
  selfRisk: -110,
  idle: -30,
};

function weights(overrides: Partial<Record<ScoreTerm, number>>): ScoreWeights {
  const out = { ...BASE };
  for (const key of Object.keys(overrides) as ScoreTerm[]) {
    const v = overrides[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Personalities
// ─────────────────────────────────────────────────────────────────────────────

export type PersonalityId =
  | 'aggressive'
  | 'defensive'
  | 'support'
  | 'assassin'
  | 'coward'
  | 'berserk'
  | 'tactician';

export interface Personality {
  readonly id: PersonalityId;
  readonly name: string;
  /** One line the designer can read to know what this thing does on screen. */
  readonly blurb: string;
  readonly weights: ScoreWeights;

  /**
   * Below this fraction of max HP the unit flips into survival mode:
   * `survivalWeights` are blended in and retreat candidates get considered.
   * 0 disables the mode entirely (berserk).
   */
  readonly fleeHpFraction: number;
  /** Weight deltas applied (added) once survival mode engages. */
  readonly survivalWeights: Partial<Record<ScoreTerm, number>>;

  /**
   * Ideal Manhattan distance to hold from the nearest hostile when the unit has
   * nothing better to do. Melee archetypes want 1; casters want their range.
   */
  readonly standoff: number;

  /**
   * 0..1. High values make the unit accept low-probability, high-payoff plays
   * (it multiplies expected value less harshly by hit chance). Low values make
   * it prefer the sure thing.
   */
  readonly gambler: number;

  /**
   * How eagerly the unit spends MP when the same job could be done for free.
   * 1 = normal, >1 = spendthrift, <1 = hoards MP for emergencies.
   */
  readonly mpFreedom: number;

  /** True when the archetype actively body-blocks for a protected ally. */
  readonly guards: boolean;

  /**
   * True when the archetype is compelled onto the nearest hostile regardless of
   * whether a juicier target exists. This is what makes Berserk read as mindless
   * on screen rather than merely reckless.
   */
  readonly chargesNearest: boolean;
}

export const PERSONALITIES: Readonly<Record<PersonalityId, Personality>> = {
  aggressive: {
    id: 'aggressive',
    name: 'Aggressive',
    blurb: 'Closes distance, trades willingly, will walk into a counter to land a kill.',
    weights: weights({
      damage: 130,
      kill: 320,
      closeDistance: 85,
      threatExposure: -22,
      selfRisk: -55,
      facingSafety: 12,
      height: 12,
      heal: 45,
      chokepoint: 4,
      idle: -70,
    }),
    fleeHpFraction: 0.12,
    survivalWeights: { threatExposure: -40, keepDistance: 30, closeDistance: -20 },
    standoff: 1,
    gambler: 0.6,
    mpFreedom: 1.15,
    guards: false,
    chargesNearest: false,
  },

  defensive: {
    id: 'defensive',
    name: 'Defensive',
    blurb: 'Holds high ground and chokepoints, guards an ally, refuses to over-extend.',
    weights: weights({
      damage: 85,
      kill: 230,
      height: 52,
      chokepoint: 58,
      facingSafety: 46,
      flankRisk: -60,
      threatExposure: -70,
      closeDistance: 58,
      keepDistance: 8,
      guardAlly: 60,
      selfRisk: -130,
      terrainHazard: -90,
      idle: -12,
    }),
    fleeHpFraction: 0.25,
    survivalWeights: { threatExposure: -60, heal: 60, keepDistance: 20 },
    standoff: 2,
    gambler: 0.25,
    mpFreedom: 0.9,
    guards: true,
    chargesNearest: false,
  },

  support: {
    id: 'support',
    name: 'Support',
    blurb: 'Heals, cleanses and buffs; hangs back at the edge of its own range.',
    weights: weights({
      damage: 45,
      kill: 150,
      heal: 210,
      revive: 420,
      statusCure: 175,
      statusInflict: 90,
      friendlyFire: -320,
      friendlyStatus: -240,
      mpCost: -5,
      threatExposure: -120,
      keepDistance: 55,
      closeDistance: 30,
      selfRisk: -190,
      height: 18,
      facingSafety: 18,
      idle: -8,
    }),
    fleeHpFraction: 0.35,
    survivalWeights: { heal: 120, keepDistance: 45, threatExposure: -80 },
    standoff: 4,
    gambler: 0.2,
    mpFreedom: 1.3,
    guards: false,
    chargesNearest: false,
  },

  assassin: {
    id: 'assassin',
    name: 'Assassin',
    blurb: 'Dives the softest, most wounded target and strikes from behind.',
    weights: weights({
      damage: 120,
      kill: 420,
      lowHpTarget: 120,
      squishyTarget: 95,
      closeDistance: 70,
      threatExposure: -34,
      facingSafety: 8,
      height: 20,
      statusInflict: 90,
      selfRisk: -80,
      idle: -50,
    }),
    fleeHpFraction: 0.2,
    survivalWeights: { keepDistance: 40, threatExposure: -55, closeDistance: -25 },
    standoff: 1,
    gambler: 0.7,
    mpFreedom: 1.0,
    guards: false,
    chargesNearest: false,
  },

  coward: {
    id: 'coward',
    name: 'Coward',
    blurb: 'Pot-shots from maximum range and runs the moment it is hurt.',
    weights: weights({
      damage: 70,
      kill: 200,
      threatExposure: -140,
      keepDistance: 70,
      closeDistance: 26,
      selfRisk: -260,
      facingSafety: 30,
      height: 26,
      terrainHazard: -110,
      idle: -4,
    }),
    fleeHpFraction: 0.45,
    survivalWeights: {
      keepDistance: 120,
      closeDistance: -60,
      threatExposure: -320,
      selfRisk: -420,
      damage: -30,
      kill: 40,
      idle: 0,
    },
    standoff: 5,
    gambler: 0.15,
    mpFreedom: 0.8,
    guards: false,
    chargesNearest: false,
  },

  berserk: {
    id: 'berserk',
    name: 'Berserk',
    blurb: 'Runs at whatever is nearest and hits it. Does not care what happens next.',
    weights: weights({
      damage: 150,
      kill: 300,
      closeDistance: 180,
      threatExposure: 0,
      selfRisk: 0,
      flankRisk: 0,
      facingSafety: 0,
      height: 0,
      chokepoint: 0,
      terrainHazard: -20,
      friendlyFire: -60,
      heal: 0,
      revive: 0,
      statusCure: 0,
      mpCost: 0,
      idle: -140,
    }),
    fleeHpFraction: 0,
    survivalWeights: {},
    standoff: 1,
    gambler: 0.95,
    mpFreedom: 1.0,
    guards: false,
    chargesNearest: true,
  },

  tactician: {
    id: 'tactician',
    name: 'Tactician',
    blurb: 'Plays terrain and status control; disables before it damages.',
    weights: weights({
      damage: 90,
      kill: 260,
      statusInflict: 190,
      statusCure: 90,
      height: 46,
      chokepoint: 40,
      facingSafety: 34,
      flankRisk: -44,
      threatExposure: -70,
      clusterRisk: -26,
      terrainHazard: -85,
      closeDistance: 50,
      keepDistance: 30,
      selfRisk: -140,
      wasteRisk: -90,
      idle: -14,
    }),
    fleeHpFraction: 0.3,
    survivalWeights: { keepDistance: 35, threatExposure: -60, statusInflict: 60 },
    standoff: 3,
    gambler: 0.35,
    mpFreedom: 1.2,
    guards: false,
    chargesNearest: false,
  },
};

export const DEFAULT_PERSONALITY: PersonalityId = 'aggressive';

/** Ticks a squad is allowed to be shy before the clock starts pushing it in. */
const PATIENCE_TICKS = 24;
/** Ticks over which caution decays from full to `MIN_CAUTION`. */
const PATIENCE_RAMP = 60;
/** Self-preservation never switches off entirely; it just stops being decisive. */
const MIN_CAUTION = 0.15;

/**
 * How much weight the self-preservation terms still carry at clock `tick`.
 *
 * Two cautious squads across open ground is a stable equilibrium: each one's
 * threat term says "make them come to us", so neither moves. Nothing in the
 * scoring breaks that tie, because for a coward holding position genuinely *is*
 * the highest-scoring play — forever. Real skirmishes do not work that way;
 * somebody always commits. Caution therefore decays with the battle clock, so a
 * stand-off resolves itself instead of running to the turn cap. It bites late
 * enough that a normal engagement is over before it matters, and it never
 * reaches zero: a wounded coward still runs, it just stops being able to run out
 * the clock.
 */
export function battleCaution(tick: number): number {
  const over = tick - PATIENCE_TICKS;
  if (over <= 0) return 1;
  return 1 - (1 - MIN_CAUTION) * clamp01(over / PATIENCE_RAMP);
}

/** Resolve a personality from an id, a full object, or undefined. */
export function resolvePersonality(
  p: PersonalityId | Personality | undefined,
  fallback: Personality,
): Personality {
  if (p === undefined) return fallback;
  if (typeof p === 'string') return PERSONALITIES[p] ?? fallback;
  return p;
}

/**
 * Effective weights for a unit right now: the archetype's vector, plus its
 * survival deltas once it drops under the flee threshold.
 *
 * Returned as a plain mutable record so callers can layer situational tweaks
 * (taunt compulsion, objective pressure) without mutating the shared table.
 */
export function effectiveWeights(
  personality: Personality,
  unit: Unit,
  caution = 1,
): Record<ScoreTerm, number> {
  const out = { ...personality.weights } as Record<ScoreTerm, number>;
  const maxHp = Math.max(1, unit.stats.maxHp);
  const hpFraction = unit.stats.hp / maxHp;
  if (personality.fleeHpFraction > 0 && hpFraction <= personality.fleeHpFraction) {
    // Ramp: the further below the threshold, the harder the survival vector bites.
    // Scaled by `caution` as well, because a battle whose last survivor is a
    // wounded coward with a movement advantage otherwise never ends: it simply
    // outruns the pursuit until the turn cap. Late on, it turns and fights.
    const depth = clamp01((personality.fleeHpFraction - hpFraction) / personality.fleeHpFraction);
    const intensity = (0.5 + 0.5 * depth) * caution;
    for (const key of Object.keys(personality.survivalWeights) as ScoreTerm[]) {
      const delta = personality.survivalWeights[key];
      if (delta !== undefined) out[key] = out[key] + delta * intensity;
    }
  }
  return out;
}

/** True when the unit has dropped into its personality's survival mindset. */
export function inSurvivalMode(personality: Personality, unit: Unit): boolean {
  if (personality.fleeHpFraction <= 0) return false;
  const maxHp = Math.max(1, unit.stats.maxHp);
  return unit.stats.hp / maxHp <= personality.fleeHpFraction;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inference — used when a scenario does not name a personality explicitly
// ─────────────────────────────────────────────────────────────────────────────

/** Job-id substrings mapped to the archetype that job naturally plays as. */
const JOB_HINTS: readonly (readonly [string, PersonalityId])[] = [
  ['squire', 'aggressive'],
  ['knight', 'defensive'],
  ['paladin', 'defensive'],
  ['guardian', 'defensive'],
  ['warrior', 'aggressive'],
  ['berserker', 'berserk'],
  ['monk', 'aggressive'],
  ['brawler', 'aggressive'],
  ['thief', 'assassin'],
  ['rogue', 'assassin'],
  ['ninja', 'assassin'],
  ['assassin', 'assassin'],
  ['archer', 'coward'],
  ['ranger', 'coward'],
  ['hunter', 'coward'],
  ['chemist', 'support'],
  ['priest', 'support'],
  ['cleric', 'support'],
  ['templar', 'support'],
  ['inquisitor', 'support'],
  ['mystic', 'support'],
  ['bard', 'support'],
  ['dancer', 'support'],
  ['shaman', 'support'],
  ['druid', 'support'],
  ['wizard', 'tactician'],
  ['mage', 'tactician'],
  ['warlock', 'tactician'],
  ['necromancer', 'tactician'],
  ['summoner', 'tactician'],
  ['oracle', 'tactician'],
  ['calculator', 'tactician'],
  ['coercer', 'tactician'],
  ['illusionist', 'tactician'],
  ['geomancer', 'tactician'],
  ['samurai', 'aggressive'],
  ['dragoon', 'aggressive'],
  ['lancer', 'aggressive'],
  ['beastmaster', 'tactician'],
];

/**
 * Pick a plausible archetype for a unit that has no explicit assignment.
 * Statuses that force behaviour (berserk) win over job flavour.
 */
export function inferPersonality(unit: Unit): PersonalityId {
  if (hasStatus(unit, 'berserk')) return 'berserk';
  if (hasStatus(unit, 'chicken')) return 'coward';

  const job: JobId = unit.currentJob.toLowerCase();
  for (const hint of JOB_HINTS) {
    if (job.includes(hint[0])) return hint[1];
  }

  // No job hint: fall back to stat shape. High MA relative to PA plays back.
  const { pa, ma, maxHp } = unit.stats;
  if (ma > pa * 1.3) return 'tactician';
  if (maxHp > 0 && pa >= ma && unit.stats.move >= 4) return 'assassin';
  return DEFAULT_PERSONALITY;
}

function hasStatus(unit: Unit, id: StatusId): boolean {
  for (const s of unit.statuses) if (s.status === id) return true;
  return false;
}
