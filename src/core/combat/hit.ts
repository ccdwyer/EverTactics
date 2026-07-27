/**
 * EverTactics — hit resolution.
 *
 * FFT does not roll one accuracy number. It rolls the attack's base accuracy, then
 * asks each of the defender's four evasion sources in turn whether it turned the blow
 * aside — class evade, weapon guard, shield, accessory. Each source is scaled by the
 * *direction* the attack came from:
 *
 *   front → full evade      side → half evade      back → no evade at all
 *
 * That single rule is most of what makes FFT positioning matter, so it lives at the
 * centre of this module rather than as a modifier bolted on at the end.
 *
 * Magical accuracy is a different animal: it runs off MA, the ability's own accuracy
 * term, and *both* parties' Faith, then takes the zodiac compatibility multiplier.
 */

import type { Ability, FormulaId, Item, Rng, Unit, Vec3 } from '../types';
import { deriveStats, getItem, getJob, shieldOf, weaponOf } from '../unit';
import {
  accuracyScale, cannotEvade, findStatus, hasStatus, removeStatus,
} from './status';
import { zodiacMultiplier } from './zodiac';

// ─────────────────────────────────────────────────────────────────────────────
// Facing
// ─────────────────────────────────────────────────────────────────────────────

export type AttackDirection = 'front' | 'side' | 'back';

const FACING_VECTORS = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
} as const;

/** Evade retained per direction: full from the front, half from the side, none from behind. */
export const EVADE_BY_DIRECTION: Readonly<Record<AttackDirection, number>> = {
  front: 1,
  side: 0.5,
  back: 0,
};

/**
 * Which side of `target` an attacker standing at `from` is on.
 * Ties on the diagonal count as a side attack.
 */
export function attackDirection(from: Vec3, targetPos: Vec3, targetFacing: keyof typeof FACING_VECTORS): AttackDirection {
  const f = FACING_VECTORS[targetFacing];
  const dx = from.x - targetPos.x;
  const dy = from.y - targetPos.y;
  if (dx === 0 && dy === 0) return 'front';
  const along = dx * f.x + dy * f.y;      // positive → in front
  const across = dx * f.y - dy * f.x;     // magnitude → how far off-axis
  if (Math.abs(along) > Math.abs(across)) return along > 0 ? 'front' : 'back';
  return 'side';
}

export function directionBetween(attacker: Unit, target: Unit): AttackDirection {
  return attackDirection(attacker.pos, target.pos, target.facing);
}

// ─────────────────────────────────────────────────────────────────────────────
// Evasion sources
// ─────────────────────────────────────────────────────────────────────────────

export interface EvadeBreakdown {
  /** Class evade from the job, doubled while Defending. */
  classEvade: number;
  /** Weapon guard from the weapon held. */
  weaponEvade: number;
  /** Shield block. */
  shieldEvade: number;
  /** Accessory evade (bracers, capes). */
  accessoryEvade: number;
  /** Magic evade, used only against magical attacks. */
  magicEvade: number;
}

const ZERO_EVADE: EvadeBreakdown = {
  classEvade: 0, weaponEvade: 0, shieldEvade: 0, accessoryEvade: 0, magicEvade: 0,
};

function itemInSlot(unit: Unit, slot: 'rightHand' | 'leftHand' | 'head' | 'body' | 'accessory'): Item | undefined {
  return getItem(unit.equipment[slot]);
}

/** The defender's raw evade values, before direction scaling. */
export function evadeSources(unit: Unit): EvadeBreakdown {
  if (cannotEvade(unit)) return { ...ZERO_EVADE };

  const jobEvade = getJob(unit.currentJob).cEvade;
  const weapon = weaponOf(unit);
  const shield = shieldOf(unit);
  const accessory = itemInSlot(unit, 'accessory');

  let classEvade = jobEvade;
  if (hasStatus(unit, 'defending')) classEvade *= 2;
  if (hasStatus(unit, 'vulnerable')) classEvade = Math.floor(classEvade / 2);

  return {
    classEvade,
    weaponEvade: weapon?.wEvade ?? 0,
    shieldEvade: shield?.pEvade ?? 0,
    accessoryEvade: accessory?.pEvade ?? 0,
    magicEvade: (shield?.mEvade ?? 0) + (accessory?.mEvade ?? 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hit resolution
// ─────────────────────────────────────────────────────────────────────────────

export type HitCategory = 'physical' | 'magical' | 'status' | 'auto';

/** Which accuracy model each formula uses. */
export function hitCategoryFor(formula: FormulaId): HitCategory {
  switch (formula) {
    case 'physical':
      return 'physical';
    case 'magical':
    case 'drain':
    case 'summon':
      return 'magical';
    case 'status-only':
      return 'status';
    case 'heal':
    case 'buff':
    case 'fixed':
    case 'percent-hp':
    case 'move':
    case 'raise':
    case 'special':
    default:
      return 'auto';
  }
}

/**
 * Which accuracy model a *specific* ability uses.
 *
 * `status-only` splits: a spell (it costs MP) is Faith-driven like any other magic,
 * while a martial debuff — a Break skill, a taunt, a hamstring — is a physical action
 * that the defender can parry. FFT does the same thing, it just expresses it by giving
 * the Break skills PA-based formulas.
 */
export function hitCategoryForAbility(ability: Ability): HitCategory {
  const base = hitCategoryFor(ability.formula);
  if (base === 'status' && ability.mp <= 0) return 'physical';
  return base;
}

export interface HitOptions {
  /** Override the direction (e.g. resolving from the tile the attacker moved from). */
  direction?: AttackDirection;
  /** Concentrate-style support ability: ignore every evasion source. */
  ignoreEvade?: boolean;
  /** Force the roll result, for replaying a recorded battle. */
  forcedRoll?: number;
}

export interface HitResult {
  hit: boolean;
  /** Final chance, 0–100, after every modifier. */
  chance: number;
  /** The roll that decided it, 0–99. -1 when the result did not need a roll. */
  roll: number;
  category: HitCategory;
  direction: AttackDirection;
  /** Direction-scaled evade actually applied. */
  evade: EvadeBreakdown;
  /** True when evasion was nullified (Concentrate, Transparent, Stealth, back attack). */
  evadeNullified: boolean;
  /** Set when an `evade-next` charge ate the attack. */
  consumedEvadeCharge: boolean;
  /** Zodiac compatibility multiplier that was folded into the chance. */
  zodiac: number;
  /** Human-readable trace for the combat log / debug overlay. */
  breakdown: string[];
}

/** Support-ability id that nullifies the target's evasion, FFT's "Concentrate". */
export const CONCENTRATE_ABILITY = 'concentrate';

function nullifiesEvade(attacker: Unit, opts: HitOptions): boolean {
  if (opts.ignoreEvade) return true;
  if (attacker.support === CONCENTRATE_ABILITY) return true;
  // Unseen attackers are not evaded — the defender never sees the blow coming.
  if (hasStatus(attacker, 'transparent') || hasStatus(attacker, 'stealth')) return true;
  return false;
}

function scaleEvade(e: EvadeBreakdown, factor: number): EvadeBreakdown {
  return {
    classEvade: Math.floor(e.classEvade * factor),
    weaponEvade: Math.floor(e.weaponEvade * factor),
    shieldEvade: Math.floor(e.shieldEvade * factor),
    accessoryEvade: Math.floor(e.accessoryEvade * factor),
    magicEvade: Math.floor(e.magicEvade * factor),
  };
}

/** Chain physical evade sources as independent rolls, exactly as FFT does. */
function applyPhysicalEvade(chance: number, e: EvadeBreakdown): number {
  let c = chance;
  for (const ev of [e.classEvade, e.weaponEvade, e.shieldEvade, e.accessoryEvade]) {
    if (ev <= 0) continue;
    c = (c * (100 - Math.min(100, ev))) / 100;
  }
  return c;
}

/**
 * Resolve whether an ability lands on a target.
 *
 * Physical: base accuracy → attacker's own accuracy scale (Blind halves it) → each of
 * the four evasion sources, scaled by attack direction.
 * Magical:  (MA + accuracy) → caster Faith → target Faith → zodiac → magic evade.
 */
export function resolveHit(
  attacker: Unit,
  target: Unit,
  ability: Ability,
  rng: Rng,
  opts: HitOptions = {},
): HitResult {
  const category = hitCategoryForAbility(ability);
  const direction = opts.direction ?? directionBetween(attacker, target);
  const breakdown: string[] = [];

  // An `evade-next` charge eats the attack outright, whatever the numbers say.
  const charge = findStatus(target, 'evade-next');
  if (charge && category !== 'auto') {
    return {
      hit: false, chance: 0, roll: -1, category, direction,
      evade: { ...ZERO_EVADE }, evadeNullified: false, consumedEvadeCharge: true,
      zodiac: 1, breakdown: ['evade-next consumed: attack turned aside'],
    };
  }

  const nullified = nullifiesEvade(attacker, opts);
  const dirFactor = nullified ? 0 : EVADE_BY_DIRECTION[direction];
  const rawEvade = evadeSources(target);
  const evade = scaleEvade(rawEvade, dirFactor);
  const zodiac = zodiacMultiplier(attacker, target);

  let chance: number;

  if (category === 'auto') {
    chance = ability.accuracy > 0 ? ability.accuracy : 100;
    breakdown.push(`auto-hit ability, base ${chance}`);
  } else if (category === 'physical') {
    const scale = accuracyScale(attacker);
    chance = ability.accuracy * scale;
    breakdown.push(`base ${ability.accuracy}${scale !== 1 ? ` x${scale} (blind)` : ''}`);
    if (hasStatus(target, 'mark') && findStatus(target, 'mark')?.source === attacker.id) {
      chance += 20;
      breakdown.push('+20 marked');
    }
    const before = chance;
    chance = applyPhysicalEvade(chance, evade);
    if (chance !== before) {
      breakdown.push(
        `evade ${direction} (x${dirFactor}) c${evade.classEvade}/w${evade.weaponEvade}/s${evade.shieldEvade}/a${evade.accessoryEvade}`,
      );
    } else if (nullified) {
      breakdown.push('evasion nullified');
    }
  } else {
    // magical + status
    const cs = deriveStats(attacker);
    const ts = deriveStats(target);
    const magicPower = category === 'magical' ? cs.ma : 0;
    chance = ability.accuracy + magicPower;
    breakdown.push(`base ${ability.accuracy}${magicPower ? ` +${magicPower} MA` : ''}`);
    chance = (chance * cs.faith) / 100;
    chance = (chance * ts.faith) / 100;
    breakdown.push(`faith ${cs.faith}/${ts.faith}`);
    chance *= zodiac;
    if (zodiac !== 1) breakdown.push(`zodiac x${zodiac}`);
    if (evade.magicEvade > 0) {
      chance = (chance * (100 - Math.min(100, evade.magicEvade))) / 100;
      breakdown.push(`magic evade ${evade.magicEvade}`);
    }
  }

  chance = Math.max(0, Math.min(100, Math.floor(chance)));
  const roll = opts.forcedRoll ?? rng.int(100);
  const hit = roll < chance;
  breakdown.push(`${chance}% vs roll ${roll} → ${hit ? 'hit' : 'miss'}`);

  return {
    hit, chance, roll, category, direction, evade,
    evadeNullified: nullified || dirFactor === 0,
    consumedEvadeCharge: false,
    zodiac,
    breakdown,
  };
}

/**
 * Spend the `evade-next` charge on a target. Kept separate so `resolveHit` stays pure;
 * the reducer calls this when it commits a resolution.
 */
export function consumeEvadeCharge(target: Unit): boolean {
  return removeStatus(target, 'evade-next');
}

// ─────────────────────────────────────────────────────────────────────────────
// Criticals and reactions
// ─────────────────────────────────────────────────────────────────────────────

export const BASE_CRIT_CHANCE = 4;
export const BACK_ATTACK_CRIT_BONUS = 5;
export const MAX_CRIT_CHANCE = 40;

/** Critical chance, percent. Bravery sharpens it; striking from behind more so. */
export function critChance(attacker: Unit, direction: AttackDirection): number {
  if (hasStatus(attacker, 'stealth')) return 100; // an opening strike from stealth always lands true
  const brave = deriveStats(attacker).brave;
  let c = BASE_CRIT_CHANCE + Math.floor(brave / 20);
  if (direction === 'back') c += BACK_ATTACK_CRIT_BONUS;
  else if (direction === 'side') c += Math.floor(BACK_ATTACK_CRIT_BONUS / 2);
  return Math.max(0, Math.min(MAX_CRIT_CHANCE, c));
}

export function rollCrit(attacker: Unit, direction: AttackDirection, rng: Rng): boolean {
  return rng.chance(critChance(attacker, direction));
}

/**
 * Reaction abilities trigger on Brave, as in FFT. Units that cannot act cannot react.
 *
 * The reaction's own `accuracy` is its *base* trigger chance, scaled by Brave:
 * `trigger% = accuracy * Brave / 100`. A reaction with accuracy 100 therefore fires at
 * exactly Brave%, which is the FFT number; a rarer one like Meatbone Slash (50) fires at
 * half that. Passing no ability reads as accuracy 100.
 */
export interface ReactionRollOptions {
  /**
   * Skip the "can this unit still defend itself" gate.
   *
   * Only `ko`-triggered reactions set this — Dragon Spirit and Last Word fire *because*
   * their owner just went down, so refusing them for being incapacitated would make
   * them unreachable by construction.
   */
  ignoreIncapacity?: boolean;
}

export function reactionChance(unit: Unit, ability?: Ability, opts: ReactionRollOptions = {}): number {
  if (opts.ignoreIncapacity !== true && cannotEvade(unit)) return 0;
  const brave = deriveStats(unit).brave;
  const base = ability === undefined ? 100 : ability.accuracy;
  return Math.max(0, Math.min(100, Math.floor((base * brave) / 100)));
}

export function rollReaction(
  unit: Unit,
  rng: Rng,
  ability?: Ability,
  opts: ReactionRollOptions = {},
): boolean {
  return rng.chance(reactionChance(unit, ability, opts));
}
