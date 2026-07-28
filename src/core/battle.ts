/**
 * EverTactics — the battle reducer.
 *
 * This is the single mutation point of the game. Nothing outside this module is
 * allowed to write to a `BattleState`.
 *
 *   applyCommand(state, cmd) -> BattleEvent[]   the UI or the AI issues a command
 *   advance(state)           -> BattleEvent[]   the clock runs until someone is up
 *
 * Both return the event stream `render/` animates. Every random number comes from
 * `state.rngState` through the `Rng` contract, so `(seed, command list)` replays a
 * battle bit-for-bit.
 *
 * Division of labour with the rest of `core/`:
 *   ct.ts               the clock: accumulation, the 60/40/20 turn economy, forecast
 *   grid.ts             reachability, path cost, range shapes, line of sight
 *   combat/formulas.ts  what an ability does (`resolveAbility` / `applyResolution`)
 *   combat/status.ts    the status table: durations, CT scaling, DoT fractions
 *   unit.ts             derived stats, JP, EXP, level-ups
 *
 * What lives *here*: validating commands, the turn lifecycle, the status clock, the
 * KO -> crystal countdown, charged spells in flight, and the objective.
 */

import type {
  Ability,
  BattleEvent,
  BattleLogEntry,
  BattleState,
  Command,
  Facing,
  ItemId,
  Rng,
  StatusId,
  Unit,
  UnitId,
  Vec3,
} from './types';

import {
  CT_THRESHOLD,
  KO_COUNTDOWN_TURNS,
  canAccumulateCt,
  computeTurnOrder,
  consumeFullTurn,
  ctSpeed,
  isDowned,
  isGone,
  isReady,
  skipsTurn,
  spendTurnCt,
  tickCt,
} from './ct';

import { inventoryOf, isConsumable } from './inventory';
import { restoreRng } from './rng';
import { deriveStats, effectiveRange, gainExp, gainJp, getAbility, getItem } from './unit';
import { isAbilityInRange } from './targeting';

import {
  areHostile,
  buildOccupancy,
  canEndOn,
  facingBetween,
  isInRange,
  moveCostInto,
  tileDistance,
  tilesInBurst,
  type Mover,
} from './grid';

import {
  TICK_FRACTIONS,
  applyStatus,
  findStatus,
  hasStatus,
  isImmobile,
  removeStatus,
  statusDef,
} from './combat/status';

import { applyResolution, resolveAbility } from './combat/formulas';

import {
  MAX_REACTION_DEPTH,
  runPostHitReactions,
  runPreemptiveReactions,
  type ReactionHost,
} from './combat/reactions';

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

/** JP for an action that connected with an enemy, before the random bonus. */
export const JP_ACTION_BASE = 8;
/** JP for a supportive or utility action. */
export const JP_SUPPORT_BASE = 6;
/** Random JP bonus range, `[0, JP_JITTER)`. */
const JP_JITTER = 3;

/** One "round" for a survive-N-turns objective, measured in CT ticks. */
export const TICKS_PER_ROUND = CT_THRESHOLD;

/** Statuses whose `remaining` counts *turns*, not CT ticks. */
const TURN_COUNTED: readonly StatusId[] = ['ko', 'crystal', 'treasure'];

/** Runaway guard for the tick loop. */
const MAX_ADVANCE_TICKS = 20000;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class IllegalCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalCommandError';
  }
}

function fail(message: string): never {
  throw new IllegalCommandError(message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Charged actions (FFT charge time)
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingCharge {
  unit: UnitId;
  ability: string;
  /** Aim tile stored at cast time — used as-is for tile-targeted abilities. */
  target: Vec3;
  /**
   * When set, the charge is **unit-targeted** and resolves at this unit's live
   * position (FFT Steal / single-target buffs). Tile-targeted charges leave this
   * undefined and hit `target` even if the original victim has walked away.
   */
  targetUnit?: UnitId;
  /** CT ticks left before the spell goes off. */
  remaining: number;
}

/**
 * `BattleState` has no field for spells in flight and `types.ts` is not this module's
 * to extend, so charges live in a side table keyed by the state object. Replaying
 * `(seed, commands)` reconstructs them naturally; a save file should round-trip them
 * through {@link getPendingCharges} / {@link setPendingCharges}.
 */
const CHARGE_TABLE = new WeakMap<BattleState, PendingCharge[]>();

export function getPendingCharges(state: BattleState): readonly PendingCharge[] {
  return CHARGE_TABLE.get(state) ?? [];
}

export function setPendingCharges(state: BattleState, charges: readonly PendingCharge[]): void {
  CHARGE_TABLE.set(
    state,
    charges.map((c) => ({
      ...c,
      target: { ...c.target },
      ...(c.targetUnit !== undefined ? { targetUnit: c.targetUnit } : {}),
    })),
  );
}

function pushCharge(state: BattleState, charge: PendingCharge): void {
  const list = CHARGE_TABLE.get(state);
  if (list) list.push(charge);
  else CHARGE_TABLE.set(state, [charge]);
}

function dropCharges(state: BattleState, unit: UnitId): void {
  const list = CHARGE_TABLE.get(state);
  if (!list || list.length === 0) return;
  CHARGE_TABLE.set(
    state,
    list.filter((c) => c.unit !== unit),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function requireUnit(state: BattleState, id: UnitId): Unit {
  const unit = state.units.get(id);
  if (!unit) fail(`no such unit: ${id}`);
  return unit;
}

function sameTile(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}

function log(state: BattleState, entry: Omit<BattleLogEntry, 'tick'>): void {
  state.log.push({ tick: state.tick, ...entry });
}

function moverOf(unit: Unit): Mover {
  const derived = deriveStats(unit);
  return {
    pos: unit.pos,
    team: unit.team,
    stats: { move: Math.max(0, derived.move), jump: Math.max(0, derived.jump) },
  };
}

/** Occupancy as the grid sees it, optionally ignoring the unit that is moving. */
function occupancyFor(state: BattleState, except?: UnitId) {
  const others: Unit[] = [];
  for (const unit of state.units.values()) {
    if (unit.id === except) continue;
    if (isGone(unit)) continue;
    others.push(unit);
  }
  return buildOccupancy(others);
}

function livingUnitAt(state: BattleState, x: number, y: number): Unit | undefined {
  for (const unit of state.units.values()) {
    if (isGone(unit)) continue;
    if (unit.pos.x === x && unit.pos.y === y) return unit;
  }
  return undefined;
}

/** Units standing on any of `tiles`, in `state.units` insertion order. */
function unitsOnTiles(state: BattleState, tiles: readonly Vec3[]): Unit[] {
  const keys = new Set(tiles.map((t) => `${t.x},${t.y}`));
  const out: Unit[] = [];
  for (const unit of state.units.values()) {
    if (isGone(unit)) continue;
    if (hasStatus(unit, 'jumping')) continue; // airborne, cannot be caught by a burst
    if (keys.has(`${unit.pos.x},${unit.pos.y}`)) out.push(unit);
  }
  return out;
}

/** The tiles an ability aimed at `target` actually covers. */
export function affectedTiles(state: BattleState, actor: Unit, ability: Ability, target: Vec3): Vec3[] {
  if (ability.range.self) {
    return [{ x: actor.pos.x, y: actor.pos.y, z: actor.pos.z }];
  }
  return tilesInBurst(state.field, target, ability.range);
}

// ─────────────────────────────────────────────────────────────────────────────
// HP, KO and the crystal countdown
// ─────────────────────────────────────────────────────────────────────────────

function fraction(maxHp: number, denom: number): number {
  return Math.max(1, Math.floor(maxHp / denom));
}

/**
 * Apply an HP change from a source that is not an ability (poison, regen, a death
 * sentence coming due) and handle falling over.
 */
function changeHp(state: BattleState, unit: Unit, delta: number, events: BattleEvent[]): void {
  if (delta === 0 || isGone(unit)) return;
  const maxHp = Math.max(1, deriveStats(unit).maxHp);
  unit.stats.maxHp = maxHp;

  if (delta < 0) {
    const amount = Math.min(-delta, unit.stats.hp);
    if (amount <= 0) return;
    unit.stats.hp -= amount;
    events.push({ kind: 'damage', unit: unit.id, amount, element: 'none', crit: false });
    log(state, { actor: unit.id, kind: 'damage', text: `${unit.name} takes ${amount} damage.` });
    if (unit.stats.hp <= 0) knockOut(state, unit, events);
  } else {
    if (hasStatus(unit, 'ko')) return; // healing does not revive; Raise does.
    const amount = Math.min(delta, maxHp - unit.stats.hp);
    if (amount <= 0) return;
    unit.stats.hp += amount;
    events.push({ kind: 'heal', unit: unit.id, amount });
  }
}

function knockOut(state: BattleState, unit: Unit, events: BattleEvent[]): void {
  if (hasStatus(unit, 'ko')) return;
  unit.stats.hp = 0;
  dropCharges(state, unit.id);

  if (hasStatus(unit, 'reraise')) {
    removeStatus(unit, 'reraise');
    events.push({ kind: 'status-remove', unit: unit.id, status: 'reraise' });
    unit.stats.hp = Math.max(1, Math.floor(deriveStats(unit).maxHp / 2));
    events.push({ kind: 'heal', unit: unit.id, amount: unit.stats.hp });
    log(state, { actor: unit.id, kind: 'heal', text: `${unit.name} is brought back by Reraise.` });
    return;
  }

  for (const status of ['charging', 'jumping', 'performing', 'defending', 'sleep'] as const) {
    if (removeStatus(unit, status)) {
      events.push({ kind: 'status-remove', unit: unit.id, status });
    }
  }
  applyStatus(unit, 'ko', { duration: KO_COUNTDOWN_TURNS });
  events.push({ kind: 'status-add', unit: unit.id, status: 'ko' });
  events.push({ kind: 'knockdown', unit: unit.id });
  log(state, { actor: unit.id, kind: 'ko', text: `${unit.name} falls.` });
}

/**
 * `combat/formulas.applyResolution` lays units out with a permanent KO because it has
 * no opinion about the death counter. The counter is the turn engine's business, so
 * we stamp it on here — and clear it from anyone who got back up.
 */
function syncDeathCounters(state: BattleState, events: BattleEvent[]): void {
  for (const unit of state.units.values()) {
    if (unit.removed) continue;
    const ko = findStatus(unit, 'ko');
    if (ko) {
      if (unit.stats.hp > 0) {
        // Revived by the same resolution that felled them.
        removeStatus(unit, 'ko');
        events.push({ kind: 'status-remove', unit: unit.id, status: 'ko' });
        continue;
      }
      if (ko.remaining < 0) ko.remaining = KO_COUNTDOWN_TURNS;
      dropCharges(state, unit.id);
    } else if (unit.stats.hp <= 0) {
      knockOut(state, unit, events);
    }
  }
}

/** A KO'd unit's turn: burn one of its three countdown turns. */
function crystalTurn(state: BattleState, unit: Unit, rng: Rng, events: BattleEvent[]): void {
  consumeFullTurn(unit);
  const ko = findStatus(unit, 'ko');
  if (!ko) {
    applyStatus(unit, 'ko', { duration: KO_COUNTDOWN_TURNS });
    events.push({ kind: 'status-add', unit: unit.id, status: 'ko' });
    return;
  }
  ko.remaining -= 1;
  if (ko.remaining > 0) return;

  removeStatus(unit, 'ko');
  events.push({ kind: 'status-remove', unit: unit.id, status: 'ko' });

  const becomesTreasure = rng.chance(50);
  const result: StatusId = becomesTreasure ? 'treasure' : 'crystal';
  applyStatus(unit, result, { duration: -1 });
  unit.removed = true;
  events.push({ kind: 'status-add', unit: unit.id, status: result });
  events.push({ kind: 'crystal', unit: unit.id });
  log(state, {
    actor: unit.id,
    kind: 'crystal',
    text: becomesTreasure
      ? `${unit.name} leaves behind a treasure.`
      : `${unit.name} shatters into a crystal.`,
    data: { result },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The status clock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count status durations down by `ticks` of the CT clock.
 *
 * Durations in `combat/status.ts` are authored in CT ticks, so they belong on the
 * clock. Damage-over-time does *not*: `TICK_FRACTIONS` are turn-sized fractions
 * (Poison is an eighth of max HP, FFT's per-turn number), so they are applied once
 * at the victim's turn start by {@link applyTurnEffects} instead. That is why this
 * function drives durations by hand rather than going through
 * `unit.tickUnitStatuses`, which fuses the two.
 */
function advanceStatusClock(state: BattleState, unit: Unit, ticks: number, events: BattleEvent[]): void {
  for (const active of [...unit.statuses]) {
    if (active.remaining < 0) continue;
    if (TURN_COUNTED.includes(active.status)) continue;
    active.remaining -= ticks;
    if (active.remaining > 0) continue;

    const kind = statusDef(active.status).tick;
    removeStatus(unit, active.status);
    events.push({ kind: 'status-remove', unit: unit.id, status: active.status });
    if (kind === 'doom') {
      log(state, { actor: unit.id, kind: 'ko', text: `${unit.name}'s Death Sentence comes due.` });
      knockOut(state, unit, events);
    }
  }
}

/** Poison, Regen and the EQ2/WoW damage-over-time statuses, once per turn. */
function applyTurnEffects(state: BattleState, unit: Unit, events: BattleEvent[]): void {
  const maxHp = Math.max(1, deriveStats(unit).maxHp);
  const oiled = hasStatus(unit, 'oil');
  const undead = hasStatus(unit, 'undead');
  let delta = 0;

  for (const active of unit.statuses) {
    const stacks = active.stacks ?? 1;
    switch (statusDef(active.status).tick) {
      case 'poison':
        delta -= fraction(maxHp, TICK_FRACTIONS.poison);
        break;
      case 'regen': {
        const heal = fraction(maxHp, TICK_FRACTIONS.regen);
        delta += undead ? -heal : heal;
        break;
      }
      case 'bleed':
        delta -= fraction(maxHp, TICK_FRACTIONS.bleed) * stacks;
        break;
      case 'burn':
        delta -= fraction(maxHp, TICK_FRACTIONS.burn) * stacks * (oiled ? 2 : 1);
        break;
      default:
        break;
    }
  }

  if (delta !== 0) changeHp(state, unit, delta, events);
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn start. Returns false when the unit did not actually get its turn (it died to
 * its own poison), so the clock should keep running.
 */
function beginTurn(state: BattleState, unit: Unit, events: BattleEvent[]): boolean {
  if (removeStatus(unit, 'defending')) {
    events.push({ kind: 'status-remove', unit: unit.id, status: 'defending' });
  }

  applyTurnEffects(state, unit, events);
  if (isDowned(unit)) {
    consumeFullTurn(unit);
    return false;
  }

  unit.turn = {
    moved: false,
    acted: false,
    origin: { ...unit.pos },
    originFacing: unit.facing,
  };
  state.active = unit.id;
  state.phase = 'awaiting-command';
  return true;
}

/** End the active unit's turn: spend CT by what it did, lock in facing. */
function endTurn(state: BattleState, unit: Unit, events: BattleEvent[]): void {
  spendTurnCt(unit);
  state.active = undefined;
  // Facing is locked in at the end of the turn, FFT-style: whatever the unit was
  // looking at when it finished is what its back is exposed from until next time.
  events.push({ kind: 'faced', unit: unit.id, facing: unit.facing });
  state.phase = 'tick';
}

function maybeEndTurn(state: BattleState, unit: Unit, events: BattleEvent[]): void {
  // A unit can now be felled *during its own turn* — a Counter or a Hamedo answering the
  // blow it just threw. It cannot be left holding a turn it can no longer end, so the
  // turn closes here rather than the reducer refusing every subsequent command.
  if (isDowned(unit)) {
    endTurn(state, unit, events);
    return;
  }
  if (unit.turn.moved && unit.turn.acted) endTurn(state, unit, events);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ability execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The reaction engine's view of the reducer.
 *
 * `combat/reactions.ts` needs to commit KO bookkeeping and write the combat log, both
 * of which live here. Handing it a small host object keeps the dependency one-way.
 */
function reactionHost(state: BattleState, rng: Rng, depth: number): ReactionHost {
  return {
    state,
    rng,
    depth,
    sync: (out: BattleEvent[]) => syncDeathCounters(state, out),
    note: (actor: UnitId, text: string) => log(state, { actor, kind: 'act', text }),
  };
}

/**
 * Run an ability that is going off *now* — either instant, or a charge coming due —
 * and commit the result. Returns the units it actually connected with.
 *
 * This is the reaction trigger point, and it is the only one: every path by which an
 * ability actually strikes somebody — a commanded action, an item, a charged spell
 * coming due, a counter-attack — funnels through here, so wiring reactions in at this
 * single seam catches all of them and cannot be bypassed. The two phases straddle the
 * resolution because they have to: pre-emptive reactions (Blade Grasp, Hamedo) must
 * remove their owner from the target list *before* damage is computed, while everything
 * else needs to read what actually landed.
 *
 * `depth` is the reaction-nesting counter. Commanded actions come in at 0; anything a
 * reaction itself causes runs at {@link MAX_REACTION_DEPTH}, where no further reactions
 * roll. That is what makes counter-chains terminate.
 */
function fireAbility(
  state: BattleState,
  actor: Unit,
  ability: Ability,
  target: Vec3,
  rng: Rng,
  events: BattleEvent[],
  depth = 0,
): Unit[] {
  const tiles = affectedTiles(state, actor, ability, target);
  const inRange = unitsOnTiles(state, tiles);

  // Phase 1 — pre-emptive reactions. Whoever turns the attack aside is dropped from
  // the target list entirely, so the blow never lands rather than landing and being undone.
  const host = reactionHost(state, rng, depth);
  const preemptive = runPreemptiveReactions(host, actor, ability, inRange, events);
  const targets = inRange.filter((u) => !preemptive.negated.has(u.id));

  if (inRange.length > 0 && targets.length === 0) {
    // Everyone in the blast turned it aside. The cast still happened; nothing landed.
    events.push({ kind: 'cast-fire', unit: actor.id, ability: ability.id, target: { ...target } });
    log(state, {
      actor: actor.id,
      kind: 'act',
      text: `${actor.name}'s ${ability.name} is turned aside.`,
      data: { ability: ability.id },
    });
    return [];
  }

  const resolution = resolveAbility(state, actor, ability, targets, rng);

  // The formula layer emits its own `cast-fire` aimed at the caster's tile, because
  // it is not told which tile was picked. We know, so ours replaces it.
  events.push({ kind: 'cast-fire', unit: actor.id, ability: ability.id, target: { ...target } });
  if (resolution.refused) {
    log(state, {
      actor: actor.id,
      kind: 'act',
      text: `${actor.name} cannot use ${ability.name} (${resolution.refused}).`,
      data: { ability: ability.id, refused: resolution.refused },
    });
    return [];
  }

  for (const event of resolution.events) {
    if (event.kind !== 'cast-fire') events.push(event);
  }
  events.push(...applyResolution(state, resolution));
  syncDeathCounters(state, events);

  // Phase 2 — everyone who was actually struck answers back.
  runPostHitReactions(host, actor, ability, resolution.targets, events);

  const connected: Unit[] = [];
  for (const outcome of resolution.targets) {
    if (!outcome.hit.hit) continue;
    const unit = state.units.get(outcome.unit);
    if (unit) connected.push(unit);
  }

  log(state, {
    actor: actor.id,
    kind: 'act',
    text: `${actor.name} uses ${ability.name}.`,
    data: { ability: ability.id, targets: targets.map((t) => t.id) },
  });

  awardForAction(state, actor, connected, rng, events);
  return connected;
}

/** Advance spells in flight; fire the ones that come due. */
function tickCharges(state: BattleState, rng: Rng, events: BattleEvent[]): void {
  const charges = CHARGE_TABLE.get(state);
  if (!charges || charges.length === 0) return;

  const due: PendingCharge[] = [];
  for (const charge of charges) {
    charge.remaining -= 1;
    if (charge.remaining <= 0) due.push(charge);
  }
  if (due.length === 0) return;

  CHARGE_TABLE.set(
    state,
    charges.filter((c) => !due.includes(c)),
  );

  for (const charge of due) {
    const actor = state.units.get(charge.unit);
    if (!actor || isDowned(actor)) continue;
    const ability = getAbility(charge.ability);
    if (!ability) continue;
    if (removeStatus(actor, 'charging')) {
      events.push({ kind: 'status-remove', unit: actor.id, status: 'charging' });
    }

    // Unit-targeted charges track the victim; tile-targeted ones land on the
    // stored panel even if the original occupant has moved or died.
    let resolveAt = charge.target;
    if (charge.targetUnit !== undefined) {
      const tracked = state.units.get(charge.targetUnit);
      // KO'd units stay trackable (Raise, etc.); only crystal/removed is a miss.
      if (!tracked || isGone(tracked)) {
        log(state, {
          actor: actor.id,
          kind: 'act',
          text: `${actor.name}'s ${ability.name} loses its target.`,
          data: { ability: ability.id, fizzled: true },
        });
        events.push({
          kind: 'cast-fire',
          unit: actor.id,
          ability: ability.id,
          target: { ...charge.target },
        });
        continue;
      }
      const tile = state.field.tileAt(tracked.pos.x, tracked.pos.y);
      resolveAt = {
        x: tracked.pos.x,
        y: tracked.pos.y,
        z: tile?.height ?? tracked.pos.z,
      };
    }
    fireAbility(state, actor, ability, resolveAt, rng, events);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JP and EXP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FFT pays the *actor* in both currencies when an action resolves. EXP scales with
 * the level gap, so punching above your weight is worth far more.
 */
function awardForAction(
  state: BattleState,
  actor: Unit,
  connected: readonly Unit[],
  rng: Rng,
  events: BattleEvent[],
): void {
  if (isDowned(actor)) return;

  const offensive = connected.some((u) => areHostile(actor.team, u.team));
  const jp = (offensive ? JP_ACTION_BASE : JP_SUPPORT_BASE) + rng.int(JP_JITTER);
  const gain = gainJp(actor, jp);
  events.push({ kind: 'jp', unit: actor.id, amount: gain.amount });

  if (connected.length === 0) return;

  const reference = connected.reduce((best, u) => (u.level > best.level ? u : best), connected[0]!);
  const exp = Math.max(1, Math.min(99, Math.floor((reference.level - actor.level + 50) / 2)));
  const expGain = gainExp(actor, exp);
  events.push({ kind: 'exp', unit: actor.id, amount: expGain.amount });
  for (const level of expGain.levels) {
    events.push({ kind: 'levelup', unit: actor.id, level: level.level });
    log(state, {
      actor: actor.id,
      kind: 'levelup',
      text: `${actor.name} reaches level ${level.level}.`,
      data: { hpGained: level.hpGained },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Objective
// ─────────────────────────────────────────────────────────────────────────────

function teamStanding(state: BattleState, team: Unit['team']): boolean {
  for (const unit of state.units.values()) {
    if (unit.team === team && !isDowned(unit)) return true;
  }
  return false;
}

/**
 * Evaluate the objective, moving `phase` to `victory` or `defeat` when it is decided.
 * Returns true once the battle is over.
 */
export function evaluateObjective(state: BattleState): boolean {
  if (state.phase === 'victory' || state.phase === 'defeat') return true;
  const objective = state.objective;

  for (const id of objective.loseIfDead ?? []) {
    const unit = state.units.get(id);
    if (!unit || isDowned(unit)) {
      state.phase = 'defeat';
      return true;
    }
  }

  if (!teamStanding(state, 'player')) {
    state.phase = 'defeat';
    return true;
  }

  switch (objective.kind) {
    case 'defeat-all':
    case 'protect': {
      if (!teamStanding(state, 'enemy')) {
        state.phase = 'victory';
        return true;
      }
      break;
    }
    case 'defeat-target': {
      const id = objective.targetUnit;
      if (id !== undefined) {
        const target = state.units.get(id);
        if (!target || isDowned(target)) {
          state.phase = 'victory';
          return true;
        }
      }
      break;
    }
    case 'survive': {
      const turns = objective.turns ?? 0;
      if (turns > 0 && state.tick >= turns * TICKS_PER_ROUND) {
        state.phase = 'victory';
        return true;
      }
      break;
    }
    case 'reach-tile': {
      const tile = objective.targetTile;
      if (tile) {
        const occupant = livingUnitAt(state, tile.x, tile.y);
        if (occupant && occupant.team === 'player' && !isDowned(occupant)) {
          state.phase = 'victory';
          return true;
        }
      }
      break;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// advance()
// ─────────────────────────────────────────────────────────────────────────────

/** Everyone at or over the CT threshold, most-ready first, ties by insertion order. */
function readyUnits(state: BattleState): Unit[] {
  const rows: { unit: Unit; index: number }[] = [];
  let index = 0;
  for (const unit of state.units.values()) {
    const own = index++;
    if (isReady(unit)) rows.push({ unit, index: own });
  }
  rows.sort((a, b) => b.unit.ct - a.unit.ct || a.index - b.index);
  return rows.map((row) => row.unit);
}

function refreshOrder(state: BattleState): void {
  state.order = computeTurnOrder(state, 16, (unit) => deriveStats(unit).spd);
}

/** One tick of the world clock: statuses count down, charges advance, CT accrues. */
function tickOnce(state: BattleState, rng: Rng, events: BattleEvent[]): void {
  state.tick += 1;

  for (const unit of state.units.values()) {
    if (isGone(unit)) continue;
    advanceStatusClock(state, unit, 1, events);
  }

  tickCharges(state, rng, events);

  for (const unit of state.units.values()) {
    if (!canAccumulateCt(unit)) continue;
    tickCt(unit, ctSpeed(unit, deriveStats(unit).spd));
  }
}

/**
 * Run the clock until a unit is ready to be commanded, or the battle ends.
 *
 * Returns everything that happened along the way — expiring statuses, poison ticks,
 * charged spells going off, crystal countdowns, KOs — so the renderer can play the
 * whole stretch back before handing control to the player.
 */
export function advance(state: BattleState): BattleEvent[] {
  const events: BattleEvent[] = [];
  if (state.phase === 'victory' || state.phase === 'defeat') return events;
  if (state.phase === 'awaiting-command') return events;
  if (state.phase === 'deploy') state.phase = 'tick';

  const rng = restoreRng(state.rngState);

  let guard = 0;
  while (guard++ < MAX_ADVANCE_TICKS) {
    if (evaluateObjective(state)) break;

    const next = readyUnits(state)[0];
    if (!next) {
      const anyMoving = [...state.units.values()].some(
        (u) => canAccumulateCt(u) && ctSpeed(u, deriveStats(u).spd) > 0,
      );
      if (!anyMoving) break; // whole field Stopped — nothing left to simulate
      tickOnce(state, rng, events);
      continue;
    }

    if (isDowned(next)) {
      crystalTurn(state, next, rng, events);
      continue;
    }
    if (skipsTurn(next)) {
      consumeFullTurn(next);
      continue;
    }

    state.phase = 'turn-start';
    if (beginTurn(state, next, events)) break;
    state.phase = 'tick';
  }

  if (state.phase === 'turn-start') state.phase = 'tick';
  state.rngState = rng.state();
  refreshOrder(state);
  events.push({ kind: 'turn-order-changed' });
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// Movement validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a path the UI built with `grid.pathTo` and return the canonical walked
 * route, always starting on the unit's current tile.
 *
 * The reducer trusts nothing: every step must be orthogonally adjacent, land on a
 * passable tile, stay inside the unit's Jump, and the whole route must fit inside
 * Move. Only the destination has to be free — FFT lets you walk through allies.
 */
export function validatePath(state: BattleState, unit: Unit, path: readonly Vec3[]): Vec3[] {
  if (isImmobile(unit)) fail(`move: ${unit.name} cannot move right now`);

  const mover = moverOf(unit);
  const { move, jump } = mover.stats;
  const field = state.field;
  const occupied = occupancyFor(state, unit.id);

  const steps = path.length > 0 && sameTile(path[0]!, unit.pos) ? path.slice(1) : path.slice();
  if (steps.length === 0) fail('move: empty path');

  const walked: Vec3[] = [{ x: unit.pos.x, y: unit.pos.y, z: unit.pos.z }];
  let cursor = walked[0]!;
  let cost = 0;

  for (const raw of steps) {
    const tile = field.tileAt(raw.x, raw.y);
    if (!tile) fail(`move: tile (${raw.x},${raw.y}) is off the map`);
    if (!tile.passable) fail(`move: tile (${raw.x},${raw.y}) is impassable`);
    if (tileDistance(cursor, raw) !== 1) {
      fail(`move: (${raw.x},${raw.y}) is not adjacent to (${cursor.x},${cursor.y})`);
    }
    if (Math.abs(tile.height - cursor.z) > jump) {
      fail(`move: the step to (${raw.x},${raw.y}) exceeds Jump ${jump}`);
    }
    const stepCost = moveCostInto(tile);
    if (!Number.isFinite(stepCost)) fail(`move: tile (${raw.x},${raw.y}) cannot be crossed`);
    cost += stepCost;
    if (cost > move) fail(`move: path costs ${cost} but Move is ${move}`);

    const next: Vec3 = { x: raw.x, y: raw.y, z: tile.height };
    walked.push(next);
    cursor = next;
  }

  const end = walked[walked.length - 1]!;
  if (!canEndOn(field, mover, occupied, end.x, end.y)) {
    fail(`move: (${end.x},${end.y}) is not somewhere ${unit.name} can stop`);
  }
  return walked;
}

// ─────────────────────────────────────────────────────────────────────────────
// applyCommand()
// ─────────────────────────────────────────────────────────────────────────────

function requireActive(state: BattleState, id: UnitId): Unit {
  if (state.phase !== 'awaiting-command') {
    fail(`cannot issue commands while the battle is in phase "${state.phase}"`);
  }
  if (state.active === undefined) fail('no unit currently holds the turn');
  if (state.active !== id) fail(`it is ${state.active}'s turn, not ${id}'s`);
  const unit = requireUnit(state, id);
  if (isDowned(unit)) fail(`${unit.name} cannot act while down`);
  return unit;
}

function checkTargetLegality(state: BattleState, actor: Unit, ability: Ability, target: Vec3): Vec3 {
  const tile = state.field.tileAt(target.x, target.y);
  if (!tile) fail(`act: target tile (${target.x},${target.y}) is off the map`);
  const resolved: Vec3 = { x: target.x, y: target.y, z: tile.height };
  const range = effectiveRange(actor, ability);

  if (range.self) {
    if (!sameTile(resolved, actor.pos)) fail(`act: ${ability.name} can only be aimed at the caster`);
    return resolved;
  }

  if (!isAbilityInRange(state.field, actor.facing, range, actor.pos, resolved)) {
    fail(`act: (${target.x},${target.y}) is out of range for ${ability.name}`);
  }

  if (!abilityTargetsTiles(ability) && !livingUnitAt(state, resolved.x, resolved.y)) {
    fail(`act: ${ability.name} needs a unit on the target tile`);
  }
  return resolved;
}

/** Mirrors `state/targeting.ts:abilityTargetsTiles` without importing UI state. */
function abilityTargetsTiles(ability: Ability): boolean {
  if (ability.targetsTiles === true) return true;
  if (ability.targetsTiles === false) return false;
  if (ability.range.self) return false;
  return (ability.range.radius ?? 0) > 0;
}

function performAction(
  state: BattleState,
  actor: Unit,
  ability: Ability,
  target: Vec3,
  rng: Rng,
  events: BattleEvent[],
  targetUnit?: UnitId,
): void {
  const resolved = checkTargetLegality(state, actor, ability, target);

  if (ability.mp > 0 && hasStatus(actor, 'silence')) fail(`act: ${actor.name} is silenced`);
  if (ability.mp > 0 && actor.stats.mp < ability.mp) {
    fail(`act: ${actor.name} needs ${ability.mp} MP for ${ability.name} but has ${actor.stats.mp}`);
  }

  // Turn to face what we are aiming at, the way FFT does automatically.
  if (!sameTile(resolved, actor.pos)) {
    const facing = facingBetween(actor.pos, resolved);
    if (facing !== actor.facing) {
      actor.facing = facing;
      events.push({ kind: 'faced', unit: actor.id, facing });
    }
  }

  actor.turn.acted = true;

  if (ability.ct > 0) {
    // A charged spell ends the turn now and lands later.
    events.push({ kind: 'cast-start', unit: actor.id, ability: ability.id, target: resolved });
    applyStatus(actor, 'charging', { duration: -1, source: actor.id });
    events.push({ kind: 'status-add', unit: actor.id, status: 'charging' });

    // Tile-targeted: store the panel. Unit-targeted: lock onto the victim so the
    // resolve follows them if they walk between cast and fire.
    const tileAimed = abilityTargetsTiles(ability);
    const locked =
      !tileAimed
        ? (targetUnit ?? livingUnitAt(state, resolved.x, resolved.y)?.id)
        : undefined;
    pushCharge(state, {
      unit: actor.id,
      ability: ability.id,
      target: resolved,
      ...(locked !== undefined ? { targetUnit: locked } : {}),
      remaining: ability.ct,
    });
    log(state, {
      actor: actor.id,
      kind: 'act',
      text: `${actor.name} begins casting ${ability.name}.`,
      data: { ability: ability.id, ct: ability.ct },
    });
    endTurn(state, actor, events);
    return;
  }

  fireAbility(state, actor, ability, resolved, rng, events);
  maybeEndTurn(state, actor, events);
}

/**
 * The only way to mutate a battle.
 *
 * Validates the command, applies it, and returns the events the renderer plays back.
 * Anything illegal throws {@link IllegalCommandError} saying exactly what was wrong —
 * the UI is expected to only offer legal commands, so a throw is a bug, not a prompt.
 */
export function applyCommand(state: BattleState, cmd: Command): BattleEvent[] {
  const events: BattleEvent[] = [];
  const unit = requireActive(state, cmd.unit);
  const rng = restoreRng(state.rngState);

  switch (cmd.kind) {
    case 'move': {
      if (unit.turn.moved) fail(`${unit.name} has already moved this turn`);
      const path = validatePath(state, unit, cmd.path);
      const destination = path[path.length - 1]!;
      const previous = path.length >= 2 ? path[path.length - 2]! : destination;
      unit.pos = { ...destination };
      unit.turn.moved = true;
      if (!sameTile(previous, destination)) {
        unit.facing = facingBetween(previous, destination);
      }
      events.push({ kind: 'moved', unit: unit.id, path });
      events.push({ kind: 'faced', unit: unit.id, facing: unit.facing });
      log(state, {
        actor: unit.id,
        kind: 'move',
        text: `${unit.name} moves to (${destination.x},${destination.y}).`,
        data: { to: destination },
      });
      maybeEndTurn(state, unit, events);
      break;
    }

    case 'act': {
      if (unit.turn.acted) fail(`${unit.name} has already acted this turn`);
      const ability = getAbility(cmd.ability);
      if (!ability) fail(`act: unknown ability "${cmd.ability}"`);
      if (ability.slot !== 'action') fail(`act: ${ability.name} is not an action ability`);
      // The Item skillset is issued as an ordinary `act`, so the stock check has
      // to live here as well as under `item` below.
      requireStock(state, unit, ability);
      performAction(state, unit, ability, cmd.target, rng, events, cmd.targetUnit);
      spendStock(state, unit, ability);
      break;
    }

    case 'item': {
      if (unit.turn.acted) fail(`${unit.name} has already acted this turn`);
      const ability = itemAbility(cmd.item);
      requireStock(state, unit, ability);
      performAction(state, unit, ability, cmd.target, rng, events);
      spendStock(state, unit, ability);
      break;
    }

    case 'face': {
      if (unit.facing !== cmd.facing) {
        unit.facing = cmd.facing;
        events.push({ kind: 'faced', unit: unit.id, facing: cmd.facing });
      }
      break;
    }

    case 'defend': {
      if (unit.turn.acted) fail(`${unit.name} has already acted this turn`);
      unit.turn.acted = true;
      applyStatus(unit, 'defending', { duration: -1, source: unit.id });
      events.push({ kind: 'status-add', unit: unit.id, status: 'defending' });
      log(state, { actor: unit.id, kind: 'act', text: `${unit.name} takes a defensive stance.` });
      endTurn(state, unit, events);
      break;
    }

    case 'wait': {
      endTurn(state, unit, events);
      break;
    }
  }

  state.rngState = rng.state();
  evaluateObjective(state);
  refreshOrder(state);
  events.push({ kind: 'turn-order-changed' });
  return events;
}

/**
 * Consumables resolve through the same pipeline as abilities. An item is usable in
 * battle when the ability table carries an entry under its id — which is how FFT
 * models the Item skillset — so Potion, Phoenix Down and the rest share the formula
 * and targeting code with everything else.
 */
/**
 * A consumable the party has run out of is an illegal command, exactly like
 * moving twice: the menu is not supposed to offer it, so reaching here is a bug
 * and says so. Checked before the action resolves, spent only after it has —
 * a Potion refused by targeting is not a Potion drunk.
 */
function requireStock(state: BattleState, unit: Unit, ability: Ability): void {
  if (!isConsumable(ability.id)) return;
  if (!inventoryOf(state, unit).has(ability.id)) {
    fail(`${unit.name} has no ${ability.name} left`);
  }
}

function spendStock(state: BattleState, unit: Unit, ability: Ability): void {
  if (!isConsumable(ability.id)) return;
  inventoryOf(state, unit).consume(ability.id);
}

function itemAbility(item: ItemId): Ability {
  const ability = getAbility(item);
  if (ability) return ability;
  const known = getItem(item);
  fail(known ? `item: ${known.name} cannot be used in battle` : `item: unknown item "${item}"`);
}

/** Facing a unit at `from` should adopt to look at `to`. Re-exported for the UI. */
export function facingToward(from: Vec3, to: Vec3): Facing {
  if (sameTile(from, to)) return 'S';
  return facingBetween(from, to);
}
