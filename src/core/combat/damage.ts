/**
 * EverTactics — damage computation.
 *
 * Every `FormulaId` in the contract resolves here. The module is pure: it reads two
 * units and an ability and returns a structured `DamageResult`. Nothing is mutated —
 * `battle.ts` decides when to commit.
 *
 * Pipeline, in order (order matters; changing it changes the feel of the game):
 *
 *   1. base       — formula-specific, from PA/WP or MA/Q and Faith
 *   2. variance   — the FFT-style randomiser
 *   3. crit       — physical only
 *   4. direction  — the back-attack bonus
 *   5. buffs      — Empowered on the attacker, Vulnerable / Mark on the target
 *   6. element    — weakness / halve / null / absorb, Oil doubling Fire
 *   7. mitigation — Protect (physical), Shell (magical), Defending
 *   8. undead     — healing inverts into damage and back
 *   9. wards      — `shielded` pools soak damage before it reaches HP
 */

import type { Ability, Element, EquipCategory, Item, ItemId, Rng, Unit, UnitId } from '../types';
import { deriveStats, getItem, weaponOf } from '../unit';
import { findStatus, hasStatus, previewWards } from './status';
import type { AttackDirection } from './hit';
import { zodiacMultiplier } from './zodiac';

// ─────────────────────────────────────────────────────────────────────────────
// Elemental affinity
// ─────────────────────────────────────────────────────────────────────────────

export type Affinity = 'weak' | 'normal' | 'halve' | 'null' | 'absorb' | 'strong';

/** Multiplier each affinity applies. `absorb` is handled separately (it heals). */
export const AFFINITY_MULTIPLIER: Readonly<Record<Affinity, number>> = {
  weak: 2,
  normal: 1,
  strong: 1.5,   // element-strengthening gear on the *attacker*
  halve: 0.5,
  null: 0,
  absorb: 0,
};

export type ElementTable = Partial<Record<Element, Affinity>>;

const itemAffinities = new Map<ItemId, ElementTable>();
const itemBoosts = new Map<ItemId, readonly Element[]>();

/** Register the elemental resistances an item grants its wearer. */
export function registerItemAffinity(item: ItemId, table: ElementTable): void {
  itemAffinities.set(item, table);
}

/** Register the elements an item *strengthens* when the wearer attacks with them. */
export function registerItemBoost(item: ItemId, elements: readonly Element[]): void {
  itemBoosts.set(item, elements);
}

export function clearElementRegistry(): void {
  itemAffinities.clear();
  itemBoosts.clear();
}

const AFFINITY_RANK: Readonly<Record<Affinity, number>> = {
  absorb: 5, null: 4, halve: 3, normal: 2, strong: 1, weak: 0,
};

/** How a unit reacts to being hit by `element`. Strongest defensive result wins. */
export function elementAffinity(unit: Unit, element: Element): Affinity {
  if (element === 'none') return 'normal';
  let best: Affinity = 'normal';

  for (const slot of ['rightHand', 'leftHand', 'head', 'body', 'accessory'] as const) {
    const id = unit.equipment[slot];
    if (id === undefined) continue;
    const table = itemAffinities.get(id);
    const a = table?.[element];
    if (a && AFFINITY_RANK[a] > AFFINITY_RANK[best]) best = a;
  }

  // Statuses override gear where FFT says so.
  if (element === 'earth' && hasStatus(unit, 'float')) return 'null';
  if (hasStatus(unit, 'undead')) {
    // Holy tears through the undead whatever they are wearing; dark sustains them.
    if (element === 'holy') return 'weak';
    if (element === 'dark') return 'absorb';
  }
  // Oil is a *vulnerability*, so it beats resistance but not immunity.
  if (element === 'fire' && hasStatus(unit, 'oil') && best !== 'null' && best !== 'absorb') {
    return 'weak';
  }
  return best;
}

/** True when the attacker's gear strengthens the element they are using. */
export function elementBoosted(attacker: Unit, element: Element): boolean {
  if (element === 'none') return false;
  for (const slot of ['rightHand', 'leftHand', 'head', 'body', 'accessory'] as const) {
    const id = attacker.equipment[slot];
    if (id === undefined) continue;
    if (itemBoosts.get(id)?.includes(element)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Randomiser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FFT rolls its damage inside a narrow band rather than a wide one — attacks feel
 * consistent, and criticals are what create the spikes. We use ±12.5% in 1/128 steps,
 * which is the granularity the original works in.
 */
export const VARIANCE_STEPS = 33;   // 0..32
export const VARIANCE_BASE = 112;   // 112/128 = 0.875
export const VARIANCE_DENOM = 128;

export function rollVariance(rng: Rng): number {
  return (VARIANCE_BASE + rng.int(VARIANCE_STEPS)) / VARIANCE_DENOM;
}

/** The exact midpoint of the variance band — used when a roll must be deterministic. */
export const VARIANCE_MID = (VARIANCE_BASE + (VARIANCE_STEPS - 1) / 2) / VARIANCE_DENOM;

export const CRIT_MULTIPLIER = 1.5;

/** Positional damage bonuses. FFT only gives evasion for facing; we also reward the hit. */
export const DIRECTION_DAMAGE: Readonly<Record<AttackDirection, number>> = {
  front: 1,
  side: 1.1,
  back: 1.25,
};

export const PROTECT_MULTIPLIER = 2 / 3;
export const SHELL_MULTIPLIER = 2 / 3;
export const DEFENDING_MULTIPLIER = 2 / 3;
export const VULNERABLE_MULTIPLIER = 1.25;
export const EMPOWERED_MULTIPLIER = 1.5;
export const MARK_MULTIPLIER = 1.2;

// ─────────────────────────────────────────────────────────────────────────────
// Weapon flavour
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FFT's weapon families each use a different attack expression. Keeping these makes a
 * Ninja's knives, a Samurai's katana and a Knight's greatsword feel genuinely different
 * rather than being one number with a different icon.
 */
export function weaponAttackPower(
  unit: Unit,
  weapon: Item | undefined,
  rng: Rng,
): { xa: number; wp: number; note: string } {
  const s = deriveStats(unit);
  const wp = weapon?.wp ?? Math.max(1, s.pa); // bare hands: PA * PA * Brave/100
  const category: EquipCategory | 'consumable' | 'bare' = weapon?.category ?? 'bare';

  switch (category) {
    case 'knife':
    case 'bow':
    case 'crossbow':
    case 'instrument':
      return { xa: Math.floor((s.pa + s.spd) / 2), wp, note: '(PA+SP)/2' };
    case 'staff':
    case 'book':
    case 'cloth':
      return { xa: Math.floor((s.pa + s.ma) / 2), wp, note: '(PA+MA)/2' };
    case 'rod':
      return { xa: s.ma, wp, note: 'MA' };
    case 'knightsword':
    case 'katana':
    case 'bare':
    case 'fist':
      return { xa: Math.floor((s.pa * s.brave) / 100), wp, note: 'PA*Br/100' };
    case 'axe':
    case 'hammer':
    case 'flail':
      // Wild weapons: attack power is a fresh roll each swing.
      return { xa: 1 + rng.int(Math.max(1, s.pa)), wp, note: 'rand(1..PA)' };
    case 'gun':
      return { xa: wp, wp, note: 'WP*WP' };
    default:
      return { xa: s.pa, wp, note: 'PA' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

export type DamageKind = 'damage' | 'heal' | 'absorbed' | 'none';

export interface DamageResult {
  target: UnitId;
  kind: DamageKind;
  /** Magnitude before wards. Always non-negative. */
  amount: number;
  /** Signed HP delta to apply to the target after wards. */
  hpDelta: number;
  /** Signed MP delta to apply to the target. */
  mpDelta: number;
  /** HP the attacker gains (Drain) — signed. */
  attackerHpDelta: number;
  /** MP the attacker gains (Drain-MP) — signed. */
  attackerMpDelta: number;
  /** How much a `shielded` ward soaked. */
  wardAbsorbed: number;
  element: Element;
  crit: boolean;
  direction: AttackDirection;
  affinity: Affinity;
  zodiac: number;
  /** True when the target is reduced to 0 HP by this result. */
  lethal: boolean;
  breakdown: string[];
}

export interface DamageInput {
  attacker: Unit;
  target: Unit;
  ability: Ability;
  rng: Rng;
  direction?: AttackDirection;
  /** Pre-rolled crit, so hit resolution and damage stay consistent. */
  crit?: boolean;
  /** Skip the randomiser — used by tests and by replay verification. */
  deterministic?: boolean;
}

function empty(target: UnitId, element: Element, direction: AttackDirection): DamageResult {
  return {
    target, kind: 'none', amount: 0, hpDelta: 0, mpDelta: 0,
    attackerHpDelta: 0, attackerMpDelta: 0, wardAbsorbed: 0,
    element, crit: false, direction, affinity: 'normal', zodiac: 1,
    lethal: false, breakdown: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formula bases
// ─────────────────────────────────────────────────────────────────────────────

/** Faith scaling both ways: caster's belief and the target's receptiveness. */
export function faithScale(attacker: Unit, target: Unit): number {
  const cf = deriveStats(attacker).faith;
  const tf = deriveStats(target).faith;
  return (cf / 100) * (tf / 100);
}

interface BaseResult {
  base: number;
  /** True when this formula is affected by zodiac compatibility (Faith-driven ones are). */
  zodiacAffected: boolean;
  /** True when this is a heal rather than damage. */
  healing: boolean;
  /** True when the physical mitigation chain applies (Protect / Defending). */
  physical: boolean;
  note: string;
}

function baseAmount(input: DamageInput): BaseResult {
  const { attacker, target, ability, rng } = input;
  const a = deriveStats(attacker);
  const t = deriveStats(target);
  const q = ability.power;

  switch (ability.formula) {
    case 'physical': {
      const weapon = weaponOf(attacker);
      const { xa, wp, note } = weaponAttackPower(attacker, weapon, rng);
      const scale = q > 0 ? q : 1;
      return {
        base: Math.max(0, Math.floor(xa * wp * scale)),
        zodiacAffected: false,
        healing: false,
        physical: true,
        note: `${note} ${xa} * WP ${wp}${scale !== 1 ? ` * ${scale}` : ''}`,
      };
    }

    case 'magical':
    case 'summon': {
      const raw = a.ma * q;
      return {
        base: Math.max(0, Math.floor(raw * faithScale(attacker, target))),
        zodiacAffected: true,
        healing: false,
        physical: false,
        note: `MA ${a.ma} * Q ${q} * faith ${a.faith}/${t.faith}`,
      };
    }

    case 'heal': {
      const raw = a.ma * q;
      return {
        base: Math.max(0, Math.floor(raw * faithScale(attacker, target))),
        zodiacAffected: true,
        healing: true,
        physical: false,
        note: `heal MA ${a.ma} * Q ${q} * faith ${a.faith}/${t.faith}`,
      };
    }

    case 'drain': {
      const raw = a.ma * q;
      return {
        base: Math.max(0, Math.floor(raw * faithScale(attacker, target))),
        zodiacAffected: true,
        healing: false,
        physical: false,
        note: `drain MA ${a.ma} * Q ${q}`,
      };
    }

    case 'fixed':
      return { base: Math.max(0, Math.floor(q)), zodiacAffected: false, healing: false, physical: false, note: `fixed ${q}` };

    case 'percent-hp':
      return {
        base: Math.max(0, Math.floor((t.maxHp * q) / 100)),
        zodiacAffected: false, healing: false, physical: false,
        note: `${q}% of ${t.maxHp} maxHP`,
      };

    case 'raise': {
      // Raising an undead unit destroys it; raising the living restores a share of HP.
      const share = q > 0 ? q : 50;
      return {
        base: Math.max(1, Math.floor((t.maxHp * share) / 100)),
        zodiacAffected: false,
        healing: true,
        physical: false,
        note: `raise ${share}% of ${t.maxHp}`,
      };
    }

    case 'status-only':
    case 'buff':
    case 'move':
    case 'special':
    default:
      return { base: 0, zodiacAffected: false, healing: false, physical: false, note: 'no direct damage' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export function computeDamage(input: DamageInput): DamageResult {
  const { attacker, target, ability, rng } = input;
  const direction = input.direction ?? 'front';
  const element = ability.element;
  const result = empty(target.id, element, direction);
  const log = result.breakdown;

  const { base, zodiacAffected, healing, physical, note } = baseAmount(input);
  if (base <= 0) return result;
  log.push(note);

  let value = base;

  // 1. Zodiac — the Faith-driven formulas only, as in FFT.
  const zodiac = zodiacAffected ? zodiacMultiplier(attacker, target) : 1;
  result.zodiac = zodiac;
  if (zodiac !== 1) {
    value *= zodiac;
    log.push(`zodiac x${zodiac}`);
  }

  // 2. Variance.
  const variance = input.deterministic ? 1 : rollVariance(rng);
  value *= variance;
  if (!input.deterministic) log.push(`variance x${variance.toFixed(3)}`);

  // 3. Crit — physical only, and never on a heal.
  const crit = Boolean(input.crit) && physical && !healing;
  result.crit = crit;
  if (crit) {
    value *= CRIT_MULTIPLIER;
    log.push(`critical x${CRIT_MULTIPLIER}`);
  }

  // 4. Direction.
  if (!healing) {
    const dirMul = DIRECTION_DAMAGE[direction];
    if (dirMul !== 1) {
      value *= dirMul;
      log.push(`${direction} attack x${dirMul}`);
    }
  }

  // 5. Attacker / target modifier statuses.
  if (hasStatus(attacker, 'empowered')) {
    value *= EMPOWERED_MULTIPLIER;
    log.push(`empowered x${EMPOWERED_MULTIPLIER}`);
  }
  if (!healing && hasStatus(target, 'vulnerable')) {
    value *= VULNERABLE_MULTIPLIER;
    log.push(`vulnerable x${VULNERABLE_MULTIPLIER}`);
  }
  if (!healing && findStatus(target, 'mark')?.source === attacker.id) {
    value *= MARK_MULTIPLIER;
    log.push(`marked x${MARK_MULTIPLIER}`);
  }

  // 6. Element.
  let affinity: Affinity = 'normal';
  let absorbed = false;
  if (!healing && element !== 'none') {
    affinity = elementAffinity(target, element);
    result.affinity = affinity;
    if (elementBoosted(attacker, element)) {
      value *= AFFINITY_MULTIPLIER.strong;
      log.push(`${element} strengthened x${AFFINITY_MULTIPLIER.strong}`);
    }
    if (affinity === 'absorb') {
      absorbed = true;
      log.push(`${element} absorbed`);
    } else if (affinity !== 'normal') {
      value *= AFFINITY_MULTIPLIER[affinity];
      log.push(`${element} ${affinity} x${AFFINITY_MULTIPLIER[affinity]}`);
    }
  }

  // 7. Mitigation.
  if (!healing && !absorbed) {
    if (physical) {
      if (hasStatus(target, 'protect')) {
        value *= PROTECT_MULTIPLIER;
        log.push('protect x2/3');
      }
      if (hasStatus(target, 'defending')) {
        value *= DEFENDING_MULTIPLIER;
        log.push('defending x2/3');
      }
    } else if (hasStatus(target, 'shell')) {
      value *= SHELL_MULTIPLIER;
      log.push('shell x2/3');
    }
  }

  const amount = Math.max(0, Math.floor(value));

  // 8. Undead inversion — healing hurts, and Raise destroys.
  let isHeal = healing;
  if (hasStatus(target, 'undead') && healing) {
    isHeal = false;
    log.push('undead: healing inverted into damage');
  }
  if (absorbed) isHeal = true;

  result.amount = amount;
  result.element = element;
  result.direction = direction;

  if (amount === 0) {
    // Nulled elements and rounding-to-zero both land here: the hit connected, nothing happened.
    result.kind = 'none';
    return result;
  }

  if (isHeal) {
    result.kind = absorbed ? 'absorbed' : 'heal';
    const stats = deriveStats(target);
    const room = Math.max(0, stats.maxHp - target.stats.hp);
    result.hpDelta = Math.min(amount, room);
    return result;
  }

  // 9. Wards soak damage before HP.
  const wards = previewWards(target, amount);
  result.wardAbsorbed = wards.absorbed;
  if (wards.absorbed > 0) log.push(`ward absorbed ${wards.absorbed}`);
  const toHp = wards.remaining;

  result.kind = 'damage';
  // HP loss is capped at the HP the unit actually has. `amount` keeps the uncapped
  // magnitude so overkill still reads correctly in the log and for AI scoring.
  const applied = Math.min(toHp, target.stats.hp);
  result.hpDelta = applied === 0 ? 0 : -applied;
  result.lethal = toHp >= target.stats.hp;

  // Drain returns a share of the damage that actually landed on HP.
  if (ability.formula === 'drain') {
    const attackerStats = deriveStats(attacker);
    const room = Math.max(0, attackerStats.maxHp - attacker.stats.hp);
    result.attackerHpDelta = Math.min(toHp, room);
    log.push(`drained ${result.attackerHpDelta}`);
  }

  return result;
}

/**
 * Commit a computed result onto the units. Kept out of `computeDamage` so resolution
 * stays pure; `battle.ts` calls this when it applies a resolution.
 */
export function applyDamage(attacker: Unit, target: Unit, result: DamageResult): void {
  if (result.wardAbsorbed > 0) {
    // Drain the real ward pools now that we are committing.
    let left = result.wardAbsorbed;
    for (const s of target.statuses) {
      if (s.status !== 'shielded') continue;
      const pool = s.amount ?? 0;
      const eaten = Math.min(pool, left);
      s.amount = pool - eaten;
      left -= eaten;
      if (left <= 0) break;
    }
    target.statuses = target.statuses.filter((s) => s.status !== 'shielded' || (s.amount ?? 0) > 0);
  }
  const maxHp = deriveStats(target).maxHp;
  target.stats.hp = Math.max(0, Math.min(maxHp, target.stats.hp + result.hpDelta));
  const maxMp = deriveStats(target).maxMp;
  target.stats.mp = Math.max(0, Math.min(maxMp, target.stats.mp + result.mpDelta));

  if (result.attackerHpDelta !== 0) {
    const aMax = deriveStats(attacker).maxHp;
    attacker.stats.hp = Math.max(0, Math.min(aMax, attacker.stats.hp + result.attackerHpDelta));
  }
  if (result.attackerMpDelta !== 0) {
    const aMax = deriveStats(attacker).maxMp;
    attacker.stats.mp = Math.max(0, Math.min(aMax, attacker.stats.mp + result.attackerMpDelta));
  }
}
