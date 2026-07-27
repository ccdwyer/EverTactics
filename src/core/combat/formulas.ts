/**
 * EverTactics — ability resolution.
 *
 * `resolveAbility` is the single entry point the reducer and the AI both use. It takes
 * a battle state, a caster, an ability and a target list, and returns exactly what
 * would happen: per-target hit rolls, damage, status changes and the `BattleEvent`
 * stream the renderer will play back.
 *
 * It mutates nothing. `applyResolution` commits a resolution when the reducer is ready.
 */

import type {
  Ability, BattleEvent, BattleState, Element, Rng, Stats, StatusId, Unit, UnitId, Vec3,
} from '../types';
import { deriveStats, isKO, isTargetable } from '../unit';
import {
  applyStatus, breakOnAction, canApplyStatus, hasStatus, removeStatus, statusDef,
} from './status';
import {
  computeDamage, applyDamage, type DamageResult,
} from './damage';
import {
  consumeEvadeCharge, directionBetween, hitCategoryFor, resolveHit, rollCrit,
  type AttackDirection, type HitResult,
} from './hit';
import { zodiacMultiplier } from './zodiac';

// ─────────────────────────────────────────────────────────────────────────────
// Result shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusChange {
  status: StatusId;
  duration: number;
  /** Statuses removed as a consequence (cancels). */
  cancelled: StatusId[];
  /** Absorb pool, for wards. */
  amount?: number;
}

export interface TargetOutcome {
  unit: UnitId;
  hit: HitResult;
  direction: AttackDirection;
  damage?: DamageResult;
  /** Statuses that will be applied when this resolution is committed. */
  applied: StatusChange[];
  /** Statuses that will be cured. */
  removed: StatusId[];
  /** The unit will be reduced to 0 HP. */
  ko: boolean;
  /** The unit will be brought back up (Raise, Reraise). */
  revived: boolean;
  /** Magic bounced off Reflect and struck someone else instead. */
  reflectedTo?: UnitId;
  events: BattleEvent[];
}

export interface AbilityResolution {
  caster: UnitId;
  ability: string;
  /** MP the caster spends. */
  mpCost: number;
  /** Signed HP/MP change on the caster (Drain, self-damage). */
  casterHpDelta: number;
  casterMpDelta: number;
  targets: TargetOutcome[];
  /** Statuses the caster loses by acting (Transparent, Stealth). */
  casterStatusesBroken: StatusId[];
  events: BattleEvent[];
  /** Set when the ability could not be used at all. */
  refused?: 'no-mp' | 'silenced' | 'cannot-act' | 'no-targets';
}

export interface ResolveOptions {
  /** Direction override applied to every target (used when replaying). */
  direction?: AttackDirection;
  /** Skip randomisation entirely — every roll takes its midpoint. */
  deterministic?: boolean;
  /** Ignore evasion for this resolution (Concentrate is read from the caster already). */
  ignoreEvade?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function resolveUnit(state: BattleState, ref: Unit | UnitId): Unit | undefined {
  return typeof ref === 'string' ? state.units.get(ref) : ref;
}

/** True when the ability is single-target magic that Reflect bounces. */
function isReflectable(ability: Ability): boolean {
  if (ability.range.radius > 0) return false;
  const category = hitCategoryFor(ability.formula);
  return category === 'magical' || (category === 'status' && ability.mp > 0);
}

/** Pick the unit a reflected spell lands on: back at the caster. */
function reflectTargetOf(state: BattleState, caster: Unit): Unit | undefined {
  return state.units.get(caster.id);
}

function healEvent(unit: UnitId, amount: number): BattleEvent {
  return { kind: 'heal', unit, amount };
}

function damageEvent(unit: UnitId, amount: number, element: Element, crit: boolean): BattleEvent {
  return { kind: 'damage', unit, amount, element, crit };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Reducer adapter
//
// `battle.ts` calls formulas through a single context object and expects a flat
// per-unit delta list back. That shape is declared structurally here so the two
// modules stay decoupled (importing battle.ts would make the graph circular).
// ─────────────────────────────────────────────────────────────────────────────

export interface ReducerAbilityContext {
  readonly state: BattleState;
  readonly actor: Unit;
  readonly ability: Ability;
  readonly target: Vec3;
  readonly targets: readonly Unit[];
  readonly rng: Rng;
  deriveStats(unit: Unit): Stats;
}

export interface ReducerOutcome {
  unit: UnitId;
  hit: boolean;
  crit?: boolean;
  /** Negative = damage, positive = healing. */
  hpDelta?: number;
  mpDelta?: number;
  element?: Element;
  applyStatuses?: readonly { status: StatusId; duration?: number }[];
  removeStatuses?: readonly StatusId[];
  quick?: boolean;
}

export interface ReducerResolution {
  outcomes: readonly ReducerOutcome[];
  mpCost?: number;
}

function isReducerContext(value: unknown): value is ReducerAbilityContext {
  return typeof value === 'object' && value !== null
    && 'actor' in value && 'ability' in value && 'rng' in value;
}

/** Flatten a full resolution into the reducer's per-unit delta list. */
export function toReducerResolution(res: AbilityResolution): ReducerResolution {
  const outcomes: ReducerOutcome[] = [];
  for (const o of res.targets) {
    const out: ReducerOutcome = { unit: o.unit, hit: o.hit.hit };
    if (o.damage) {
      out.crit = o.damage.crit;
      if (o.damage.hpDelta !== 0) out.hpDelta = o.damage.hpDelta;
      if (o.damage.mpDelta !== 0) out.mpDelta = o.damage.mpDelta;
      out.element = o.damage.element;
    }
    if (o.applied.length > 0) {
      out.applyStatuses = o.applied.map((c) => ({ status: c.status, duration: c.duration }));
    }
    if (o.removed.length > 0) out.removeStatuses = [...o.removed];
    outcomes.push(out);
  }
  // Drain and self-damage land on the caster as an extra outcome.
  if (res.casterHpDelta !== 0) {
    outcomes.push({ unit: res.caster, hit: true, hpDelta: res.casterHpDelta });
  }
  return { outcomes, mpCost: res.mpCost };
}

/**
 * Resolve an ability against a set of targets. Pure — nothing in `state` is touched.
 *
 * Two call shapes are supported: the full positional form, which returns the detailed
 * resolution (hit breakdowns, damage traces, events), and the reducer's single-context
 * form, which returns the flattened delta list `battle.ts` applies.
 */
export function resolveAbility(ctx: ReducerAbilityContext): ReducerResolution;
export function resolveAbility(
  state: BattleState,
  casterRef: Unit | UnitId,
  ability: Ability,
  targetRefs: readonly (Unit | UnitId)[],
  rng: Rng,
  opts?: ResolveOptions,
): AbilityResolution;
export function resolveAbility(
  stateOrCtx: BattleState | ReducerAbilityContext,
  casterRef?: Unit | UnitId,
  abilityArg?: Ability,
  targetRefsArg?: readonly (Unit | UnitId)[],
  rngArg?: Rng,
  optsArg: ResolveOptions = {},
): AbilityResolution | ReducerResolution {
  if (isReducerContext(stateOrCtx)) {
    const ctx = stateOrCtx;
    return toReducerResolution(
      resolveAbilityDetailed(ctx.state, ctx.actor, ctx.ability, ctx.targets, ctx.rng),
    );
  }
  if (casterRef === undefined || abilityArg === undefined || targetRefsArg === undefined || rngArg === undefined) {
    throw new Error('resolveAbility: missing arguments');
  }
  return resolveAbilityDetailed(stateOrCtx, casterRef, abilityArg, targetRefsArg, rngArg, optsArg);
}

/** The full-detail resolution. `resolveAbility` is a thin dispatcher over this. */
export function resolveAbilityDetailed(
  state: BattleState,
  casterRef: Unit | UnitId,
  ability: Ability,
  targetRefs: readonly (Unit | UnitId)[],
  rng: Rng,
  opts: ResolveOptions = {},
): AbilityResolution {
  const caster = resolveUnit(state, casterRef);
  const resolution: AbilityResolution = {
    caster: typeof casterRef === 'string' ? casterRef : casterRef.id,
    ability: ability.id,
    mpCost: 0,
    casterHpDelta: 0,
    casterMpDelta: 0,
    targets: [],
    casterStatusesBroken: [],
    events: [],
  };

  if (!caster) {
    resolution.refused = 'cannot-act';
    return resolution;
  }
  resolution.caster = caster.id;

  if (isKO(caster)) {
    resolution.refused = 'cannot-act';
    return resolution;
  }
  if (ability.mp > 0 && hasStatus(caster, 'silence')) {
    resolution.refused = 'silenced';
    return resolution;
  }
  if (ability.mp > deriveStats(caster).mp) {
    resolution.refused = 'no-mp';
    return resolution;
  }

  resolution.mpCost = ability.mp;
  resolution.casterMpDelta = -ability.mp;
  resolution.casterStatusesBroken = caster.statuses
    .filter((s) => statusDef(s.status).brokenByAction)
    .map((s) => s.status);

  resolution.events.push({ kind: 'cast-fire', unit: caster.id, ability: ability.id, target: caster.pos });

  const targets = targetRefs
    .map((r) => resolveUnit(state, r))
    .filter((u): u is Unit => u !== undefined && isTargetable(u));

  if (targets.length === 0) {
    resolution.refused = 'no-targets';
    return resolution;
  }

  for (const original of targets) {
    let target = original;
    let reflectedTo: UnitId | undefined;

    // Reflect bounces single-target magic straight back at the caster.
    if (hasStatus(target, 'reflect') && isReflectable(ability) && target.id !== caster.id) {
      const bounced = reflectTargetOf(state, caster);
      if (bounced) {
        target = bounced;
        reflectedTo = bounced.id;
      }
    }

    const outcome = resolveOnTarget(caster, target, ability, rng, opts);
    if (reflectedTo !== undefined) outcome.reflectedTo = reflectedTo;
    if (outcome.damage) {
      resolution.casterHpDelta += outcome.damage.attackerHpDelta;
      resolution.casterMpDelta += outcome.damage.attackerMpDelta;
    }
    resolution.targets.push(outcome);
    resolution.events.push(...outcome.events);
  }

  return resolution;
}

function resolveOnTarget(
  caster: Unit,
  target: Unit,
  ability: Ability,
  rng: Rng,
  opts: ResolveOptions,
): TargetOutcome {
  const direction = opts.direction ?? directionBetween(caster, target);
  const hitOpts = opts.ignoreEvade ? { direction, ignoreEvade: true } : { direction };
  const hit = resolveHit(caster, target, ability, rng, hitOpts);

  const outcome: TargetOutcome = {
    unit: target.id,
    hit,
    direction,
    applied: [],
    removed: [],
    ko: false,
    revived: false,
    events: [],
  };

  if (!hit.hit) {
    outcome.events.push({ kind: 'miss', unit: target.id });
    return outcome;
  }

  // Raise on a fallen unit brings them back rather than damaging them.
  const raisingDead = ability.formula === 'raise' && isKO(target) && !hasStatus(target, 'undead');

  const crit = ability.formula === 'physical'
    ? (opts.deterministic ? false : rollCrit(caster, direction, rng))
    : false;

  const damage = computeDamage({
    attacker: caster,
    target,
    ability,
    rng,
    direction,
    crit,
    ...(opts.deterministic ? { deterministic: true } : {}),
  });

  if (damage.kind !== 'none') {
    outcome.damage = damage;
    if (damage.hpDelta < 0) {
      outcome.events.push(damageEvent(target.id, -damage.hpDelta, damage.element, damage.crit));
      if (damage.lethal) {
        outcome.ko = true;
        outcome.events.push({ kind: 'knockdown', unit: target.id });
      }
    } else if (damage.hpDelta > 0) {
      outcome.events.push(healEvent(target.id, damage.hpDelta));
    } else if (damage.wardAbsorbed > 0) {
      outcome.events.push(damageEvent(target.id, 0, damage.element, false));
    }
  }

  if (raisingDead) {
    outcome.revived = true;
    outcome.removed.push('ko');
    outcome.events.push({ kind: 'status-remove', unit: target.id, status: 'ko' });
  }

  // Cures.
  if (ability.cures) {
    for (const s of ability.cures) {
      if (!hasStatus(target, s)) continue;
      if (outcome.removed.includes(s)) continue;
      outcome.removed.push(s);
      outcome.events.push({ kind: 'status-remove', unit: target.id, status: s });
    }
  }

  // Inflictions — zodiac compatibility sways the chance, as it does for magic accuracy.
  if (ability.inflicts) {
    const compat = zodiacMultiplier(caster, target);
    for (const inf of ability.inflicts) {
      const check = canApplyStatus(target, inf.status);
      if (!check.applied) continue;
      const chance = Math.max(0, Math.min(100, Math.floor(inf.chance * compat)));
      const lands = chance >= 100 ? true : rng.chance(chance);
      if (!lands) continue;
      const rules = statusDef(inf.status);
      const change: StatusChange = {
        status: inf.status,
        duration: inf.duration ?? rules.defaultDuration,
        cancelled: check.cancelled,
      };
      if (inf.status === 'shielded') change.amount = Math.max(1, ability.power);
      outcome.applied.push(change);
      outcome.events.push({ kind: 'status-add', unit: target.id, status: inf.status });
      if (inf.status === 'ko') outcome.ko = true;
    }
  }

  // Sleep breaks the moment damage lands.
  if (outcome.damage && outcome.damage.hpDelta < 0 && hasStatus(target, 'sleep')
      && !outcome.removed.includes('sleep')) {
    outcome.removed.push('sleep');
    outcome.events.push({ kind: 'status-remove', unit: target.id, status: 'sleep' });
  }

  return outcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a resolution to the state. This is the only mutating function in the combat
 * package, and `battle.ts` owns when it runs.
 */
export function applyResolution(state: BattleState, res: AbilityResolution): BattleEvent[] {
  const events: BattleEvent[] = [];
  const caster = state.units.get(res.caster);
  if (!caster || res.refused) return events;

  if (res.mpCost > 0) {
    caster.stats.mp = Math.max(0, caster.stats.mp - res.mpCost);
  }
  if (res.casterStatusesBroken.length > 0) {
    for (const s of breakOnAction(caster)) {
      events.push({ kind: 'status-remove', unit: caster.id, status: s });
    }
  }

  for (const outcome of res.targets) {
    const target = state.units.get(outcome.unit);
    if (!target) continue;

    if (outcome.hit.consumedEvadeCharge) consumeEvadeCharge(target);

    if (outcome.damage) applyDamage(caster, target, outcome.damage);

    for (const s of outcome.removed) {
      if (removeStatus(target, s)) {
        events.push({ kind: 'status-remove', unit: target.id, status: s });
      }
    }
    if (outcome.revived) {
      const maxHp = deriveStats(target).maxHp;
      const share = outcome.damage?.amount ?? Math.floor(maxHp / 2);
      target.stats.hp = Math.max(1, Math.min(maxHp, share));
      target.removed = false;
    }
    for (const change of outcome.applied) {
      const opts: Parameters<typeof applyStatus>[2] = {
        duration: change.duration,
        source: caster.id,
      };
      if (change.amount !== undefined) opts.amount = change.amount;
      applyStatus(target, change.status, opts);
      events.push({ kind: 'status-add', unit: target.id, status: change.status });
    }

    // Falling: Reraise stands the unit back up once, otherwise they go down.
    if (target.stats.hp <= 0 && !hasStatus(target, 'ko')) {
      if (hasStatus(target, 'reraise')) {
        removeStatus(target, 'reraise');
        target.stats.hp = Math.max(1, Math.floor(deriveStats(target).maxHp / 2));
        events.push({ kind: 'status-remove', unit: target.id, status: 'reraise' });
        events.push(healEvent(target.id, target.stats.hp));
      } else {
        applyStatus(target, 'ko', { duration: -1, source: caster.id });
        events.push({ kind: 'status-add', unit: target.id, status: 'ko' });
        events.push({ kind: 'knockdown', unit: target.id });
      }
    }
  }

  if (res.casterHpDelta !== 0 || res.casterMpDelta !== 0) {
    const cs = deriveStats(caster);
    // MP was already spent above; only the drain component remains.
    const mpGain = res.casterMpDelta + res.mpCost;
    if (mpGain !== 0) caster.stats.mp = Math.max(0, Math.min(cs.maxMp, caster.stats.mp + mpGain));
    if (res.casterHpDelta !== 0) {
      caster.stats.hp = Math.max(0, Math.min(cs.maxHp, caster.stats.hp + res.casterHpDelta));
      if (res.casterHpDelta > 0) events.push(healEvent(caster.id, res.casterHpDelta));
    }
  }

  return events;
}

/** Total HP a resolution will take off a given target — for AI scoring. */
export function projectedDamage(res: AbilityResolution, unit: UnitId): number {
  let total = 0;
  for (const o of res.targets) {
    if (o.unit !== unit || !o.damage) continue;
    total += -o.damage.hpDelta;
  }
  return total;
}

export { computeDamage, resolveHit, directionBetween };
export type { DamageResult, HitResult, AttackDirection };
