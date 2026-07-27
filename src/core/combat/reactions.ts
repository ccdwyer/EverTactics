/**
 * EverTactics — the reaction engine.
 *
 * Reaction abilities are the half of FFT's tactical layer that happens on someone
 * else's turn. A unit carries one in `Unit.reaction`; when it is attacked, the
 * reaction gets a roll against the unit's Brave, and if it lands it produces a real,
 * committed consequence — a counter-attack, a heal, a nullified blow.
 *
 * Shape of the system
 * -------------------
 * `battle.ts` owns *when* this runs, because only the reducer knows when an ability is
 * actually going off. It calls in twice around every ability that fires:
 *
 *   1. {@link runPreemptiveReactions} — before the attack resolves. Blade Grasp, Hamedo,
 *      Reflexes and Arrow Guard live here; they return the set of targets the attack
 *      never reaches, and the reducer drops those targets from the resolution.
 *   2. {@link runPostHitReactions} — after the resolution is committed. Counter,
 *      Auto-Potion, Damage Split, Absorb MP and the rest read what actually landed and
 *      answer it.
 *
 * Three invariants this module is responsible for
 * -----------------------------------------------
 * - **Termination.** Everything a reaction does is executed at `depth + 1`, and
 *   {@link MAX_REACTION_DEPTH} caps how deep that goes. At the cap no reaction rolls at
 *   all, so a Counter answering a Counter answering a Counter cannot happen.
 * - **The dead do not react.** Checked at the point of the roll, after the incoming
 *   damage has been committed — a unit felled by the blow gets nothing but its `ko`
 *   trigger (Dragon Spirit, Last Word), which is exactly what `ko` means.
 * - **Determinism.** Every roll goes through the seeded `Rng` the reducer hands in.
 *   There is no `Math.random()` in this file and there must never be one.
 */

import type {
  Ability, AbilityId, BattleEvent, BattleState, ItemId, Rng, StatusId, Unit, UnitId,
} from '../types';
import { areHostile, tileDistance } from '../grid';
import { grantQuick } from '../ct';
import { deriveStats, getAbility, isKO, isTargetable, weaponOf } from '../unit';
import {
  applyStatus, canApplyStatus, hasStatus, isDisabled, removeStatus, statusDef,
} from './status';
import { hitCategoryForAbility, rollReaction } from './hit';
import { applyResolution, resolveAbilityDetailed, type TargetOutcome } from './formulas';
import { REACTION_TRIGGERS, type ReactionMeta } from '../abilities/reactions';

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How deeply reactions may nest.
 *
 * `1` means: an ability used on a unit's turn (depth 0) may provoke reactions, and
 * everything those reactions do runs at depth 1, where nothing reacts. That is the
 * hard stop on Counter-answers-Counter. Raising this to 2 would let a counter provoke
 * a counter-counter and is deliberately not the default — FFT does not do it and it
 * turns two adjacent Counter units into a coin-flip duel neither player commanded.
 */
export const MAX_REACTION_DEPTH = 1;

/** Fraction of max HP at or below which `hp-critical` reactions arm. */
export const CRITICAL_HP_FRACTION = 0.25;

/**
 * Auto-Potion draws from a per-unit consumable pouch.
 *
 * The game has no inventory model yet — `Unit` carries equipment and nothing else — so
 * the pouch is widened onto `Unit` additively here, the same way `unit.ts` widens raw
 * stats and `status.ts` widens ward pools. A unit that has Auto-Potion equipped and no
 * explicit pouch is stocked lazily with {@link DEFAULT_AUTO_POTION_COUNT} Potions the
 * first time it is looked at, so the ability works out of the box; once a real inventory
 * exists, fill `unit.pouch` from it and this default never fires.
 */
declare module '../types' {
  interface Unit {
    /** Battle consumables, `itemId -> count`. Auto-Potion draws from this. */
    pouch?: Record<ItemId, number>;
  }
}

export const DEFAULT_AUTO_POTION_COUNT = 5;

/** Healing consumables Auto-Potion will reach for, weakest first (FFT's rule). */
export const AUTO_POTION_ORDER: readonly ItemId[] = ['use-potion', 'use-hi-potion', 'use-x-potion'];

/**
 * Statuses that suppress reactions outright, beyond the `disabling` set (KO, Crystal,
 * Treasure, Petrify, Stop, Sleep) which is already excluded. A confused or charmed unit
 * is acting, but not on its own recognition, so it does not answer blows either.
 */
const REACTION_SUPPRESSING: readonly StatusId[] = ['confuse', 'charm'];

// ─────────────────────────────────────────────────────────────────────────────
// Pouch
// ─────────────────────────────────────────────────────────────────────────────

function pouchOf(unit: Unit): Record<ItemId, number> {
  if (unit.pouch === undefined) {
    unit.pouch = unit.reaction === 'auto-potion'
      ? { 'use-potion': DEFAULT_AUTO_POTION_COUNT }
      : {};
  }
  return unit.pouch;
}

export function pouchCount(unit: Unit, item: ItemId): number {
  return pouchOf(unit)[item] ?? 0;
}

/** Put consumables in a unit's pouch. Scenario/roster code and tests use this. */
export function givePouchItem(unit: Unit, item: ItemId, count = 1): void {
  const pouch = pouchOf(unit);
  pouch[item] = (pouch[item] ?? 0) + count;
}

function takePouchItem(unit: Unit, item: ItemId): boolean {
  const pouch = pouchOf(unit);
  const have = pouch[item] ?? 0;
  if (have <= 0) return false;
  pouch[item] = have - 1;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// The host contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the reaction engine needs from the reducer.
 *
 * Declared structurally so `battle.ts` can import this module without this module
 * importing `battle.ts` back — the same decoupling `formulas.ts` uses for its reducer
 * adapter.
 */
export interface ReactionHost {
  readonly state: BattleState;
  readonly rng: Rng;
  /** Nesting depth. 0 for a commanded action; reactions execute their effects at +1. */
  readonly depth: number;
  /** Stamp KO countdowns / clear revived units. The reducer owns that bookkeeping. */
  sync(events: BattleEvent[]): void;
  /** Append a combat-log line. */
  note(actor: UnitId, text: string): void;
}

/** What happened to one target during the pre-emptive phase. */
export interface PreemptiveResult {
  /** Targets the incoming attack never reaches. */
  readonly negated: ReadonlySet<UnitId>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility
// ─────────────────────────────────────────────────────────────────────────────

/** The reaction a unit will actually use, if any, together with its trigger metadata. */
function reactionOf(unit: Unit): { ability: Ability; meta: ReactionMeta } | undefined {
  const id = unit.reaction;
  if (id === undefined) return undefined;
  const meta = REACTION_TRIGGERS.get(id);
  if (meta === undefined) return undefined;
  const ability = getAbility(id);
  if (ability === undefined) return undefined;
  return { ability, meta };
}

/**
 * Can this unit react at all, right now, to this attacker?
 *
 * Deliberately conservative: everything that would make a reaction absurd is checked
 * here rather than inside each handler, so a new reaction cannot forget one of them.
 */
function canReact(host: ReactionHost, reactor: Unit, attacker: Unit): boolean {
  if (host.depth >= MAX_REACTION_DEPTH) return false;   // the termination guarantee
  if (reactor.id === attacker.id) return false;         // nobody reacts to their own blow
  if (isKO(reactor)) return false;                      // the dead do not react
  if (reactor.removed) return false;
  if (!isTargetable(reactor)) return false;             // mid-Jump, crystallised, gone
  if (isDisabled(reactor)) return false;                // ko/petrify/stop/sleep
  if (REACTION_SUPPRESSING.some((s) => hasStatus(reactor, s))) return false;
  return true;
}

/** Manhattan distance plus the vertical tolerance the reaction's own range declares. */
function withinReactionRange(reactor: Unit, attacker: Unit, ability: Ability): boolean {
  const range = ability.range;
  if (range.self) return true;
  if (tileDistance(reactor.pos, attacker.pos) > range.range) return false;
  const vertical = range.vertical;
  if (Number.isFinite(vertical) && Math.abs(reactor.pos.z - attacker.pos.z) > vertical) return false;
  return true;
}

function isCriticalHp(unit: Unit): boolean {
  const maxHp = Math.max(1, deriveStats(unit).maxHp);
  return unit.stats.hp > 0 && unit.stats.hp <= Math.floor(maxHp * CRITICAL_HP_FRACTION);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared execution helpers
// ─────────────────────────────────────────────────────────────────────────────

function announce(
  host: ReactionHost,
  reactor: Unit,
  ability: Ability,
  source: Unit,
  events: BattleEvent[],
): void {
  events.push({ kind: 'reaction', unit: reactor.id, ability: ability.id, source: source.id });
  host.note(reactor.id, `${reactor.name}'s ${ability.name} triggers.`);
}

/**
 * Run a reaction's own ability against a target list and commit it.
 *
 * This is the generic "strike back" path: it goes through the same
 * `resolveAbilityDetailed` → `applyResolution` pipeline as any commanded action, so a
 * Counter rolls hit, evasion, criticals, elements and status inflictions exactly like a
 * normal Attack, and produces exactly the same event stream. It runs with the host's
 * depth already incremented by the caller, so nothing it does can react again.
 */
function executeReactionAbility(
  host: ReactionHost,
  reactor: Unit,
  ability: Ability,
  targets: readonly Unit[],
  events: BattleEvent[],
): void {
  if (targets.length === 0) return;
  const resolution = resolveAbilityDetailed(host.state, reactor, ability, targets, host.rng);
  if (resolution.refused) return;

  // The formula layer aims its own `cast-fire` at the caster's tile because it is not
  // told which tile was picked. We know: the reaction is aimed at whoever provoked it.
  const aim = targets[0]!.pos;
  events.push({ kind: 'cast-fire', unit: reactor.id, ability: ability.id, target: { ...aim } });
  for (const event of resolution.events) {
    if (event.kind !== 'cast-fire') events.push(event);
  }
  events.push(...applyResolution(host.state, resolution));
  host.sync(events);
}

/** Apply a reaction's authored `inflicts` / `cures` to the reactor itself. */
function applySelfStatuses(
  host: ReactionHost,
  reactor: Unit,
  ability: Ability,
  events: BattleEvent[],
): void {
  for (const s of ability.cures ?? []) {
    if (removeStatus(reactor, s)) {
      events.push({ kind: 'status-remove', unit: reactor.id, status: s });
    }
  }
  for (const inf of ability.inflicts ?? []) {
    if (!canApplyStatus(reactor, inf.status).applied) continue;
    // The reaction already passed its Brave roll; its infliction chances are the
    // authored per-status odds on top of that.
    if (inf.chance < 100 && !host.rng.chance(inf.chance)) continue;
    const rules = statusDef(inf.status);
    applyStatus(reactor, inf.status, {
      duration: inf.duration ?? rules.defaultDuration,
      source: reactor.id,
    });
    events.push({ kind: 'status-add', unit: reactor.id, status: inf.status });
  }
}

/** Direct HP change on a unit outside the ability pipeline, with the right events. */
function nudgeHp(unit: Unit, delta: number, events: BattleEvent[]): number {
  if (delta === 0) return 0;
  const maxHp = Math.max(1, deriveStats(unit).maxHp);
  if (delta > 0) {
    const amount = Math.min(delta, maxHp - unit.stats.hp);
    if (amount <= 0) return 0;
    unit.stats.hp += amount;
    events.push({ kind: 'heal', unit: unit.id, amount });
    return amount;
  }
  const amount = Math.min(-delta, unit.stats.hp);
  if (amount <= 0) return 0;
  unit.stats.hp -= amount;
  events.push({ kind: 'damage', unit: unit.id, amount, element: 'none', crit: false });
  return -amount;
}

function nudgeMp(unit: Unit, delta: number): number {
  const maxMp = Math.max(0, deriveStats(unit).maxMp);
  const before = unit.stats.mp;
  unit.stats.mp = Math.max(0, Math.min(maxMp, before + delta));
  return unit.stats.mp - before;
}

/** Living hostiles adjacent to `unit` — the target set for Last Word. */
function adjacentHostiles(state: BattleState, unit: Unit, radius: number): Unit[] {
  const out: Unit[] = [];
  for (const other of state.units.values()) {
    if (other.id === unit.id || isKO(other) || !isTargetable(other)) continue;
    if (!areHostile(unit.team, other.team)) continue;
    if (tileDistance(unit.pos, other.pos) > radius) continue;
    out.push(other);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-emptive phase
// ─────────────────────────────────────────────────────────────────────────────

/** Whether a `preemptive` reaction's own precondition is met against this attack. */
function preemptivePrecondition(
  reactor: Unit,
  attacker: Unit,
  incoming: Ability,
  reaction: Ability,
): boolean {
  const category = hitCategoryForAbility(incoming);
  const distance = tileDistance(reactor.pos, attacker.pos);

  switch (reaction.id) {
    case 'blade-grasp':
      // FFT: catches weapon attacks only. A spell, a breath, a thrown rock — nothing to catch.
      return category === 'physical' && weaponOf(attacker) !== undefined;
    case 'hamedo':
      // Strikes first, so the attacker has to be inside the reactor's own reach.
      return category === 'physical' && withinReactionRange(reactor, attacker, reaction);
    case 'arrow-guard':
      // Turns aside shots, not sword blows: ranged physical only.
      return category === 'physical' && distance >= 2;
    case 'reflexes':
      return category === 'physical' || category === 'status';
    case 'riposte':
      return category === 'physical' && withinReactionRange(reactor, attacker, reaction);
    default:
      return false;
  }
}

/**
 * Roll the pre-emptive reactions of every unit about to be struck.
 *
 * Returns the ids whose reaction cancelled the incoming attack outright — the reducer
 * drops them from the resolution, so the attack genuinely never lands on them rather
 * than landing and being undone.
 */
export function runPreemptiveReactions(
  host: ReactionHost,
  attacker: Unit,
  incoming: Ability,
  targets: readonly Unit[],
  events: BattleEvent[],
): PreemptiveResult {
  const negated = new Set<UnitId>();
  if (host.depth >= MAX_REACTION_DEPTH) return { negated };

  const inner: ReactionHost = { ...host, depth: host.depth + 1 };

  for (const reactor of targets) {
    if (!canReact(host, reactor, attacker)) continue;
    const found = reactionOf(reactor);
    if (!found) continue;
    const { ability, meta } = found;
    if (meta.preemptive !== true) continue;
    if (meta.trigger !== 'targeted') continue;
    if (!preemptivePrecondition(reactor, attacker, incoming, ability)) continue;
    if (!rollReaction(reactor, host.rng, ability)) continue;

    announce(host, reactor, ability, attacker, events);

    if (ability.id === 'hamedo' || ability.id === 'riposte') {
      // Strike first. The blow lands before the attack that provoked it, which is the
      // whole point of Hamedo — and for Hamedo the original attack then never happens.
      executeReactionAbility(inner, reactor, ability, [attacker], events);
    }

    if (meta.negates === true) {
      negated.add(reactor.id);
      events.push({ kind: 'miss', unit: reactor.id });
    }
  }

  return { negated };
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-hit phase
// ─────────────────────────────────────────────────────────────────────────────

/** What actually landed on one target, read off the committed resolution. */
interface Landed {
  readonly target: Unit;
  readonly hit: boolean;
  /** HP the target lost. 0 when the hit healed or did nothing. */
  readonly hpLost: number;
  /** True when the hit put the target on the floor. */
  readonly fatal: boolean;
  readonly category: ReturnType<typeof hitCategoryForAbility>;
  readonly appliedStatuses: readonly StatusId[];
  /**
   * Statuses this very hit stripped off the target.
   *
   * Needed because the resolution is committed before reactions roll: a sleeping unit
   * has already been woken by the damage by the time we get here, and the blow that
   * woke it must not also be countered.
   */
  readonly clearedStatuses: readonly StatusId[];
}

function readOutcome(state: BattleState, outcome: TargetOutcome, incoming: Ability): Landed | undefined {
  const target = state.units.get(outcome.unit);
  if (!target) return undefined;
  const hpDelta = outcome.damage?.hpDelta ?? 0;
  return {
    target,
    hit: outcome.hit.hit,
    hpLost: hpDelta < 0 ? -hpDelta : 0,
    fatal: outcome.ko || target.stats.hp <= 0,
    category: hitCategoryForAbility(incoming),
    appliedStatuses: outcome.applied.map((a) => a.status),
    clearedStatuses: [...outcome.removed],
  };
}

/** Does this reaction's trigger match what actually landed? */
function triggerMatches(meta: ReactionMeta, landed: Landed): boolean {
  switch (meta.trigger) {
    case 'physical-hit':
      return landed.hit && landed.category === 'physical';
    case 'magical-hit':
      return landed.hit && landed.category === 'magical';
    case 'any-hit':
      return landed.hit;
    case 'damage-taken':
      return landed.hpLost > 0;
    case 'hp-critical':
      return landed.hpLost > 0 && isCriticalHp(landed.target);
    case 'ko':
      return landed.fatal;
    case 'status-applied':
      return landed.appliedStatuses.some((s) => !statusDef(s).beneficial);
    case 'targeted':
    case 'ally-hit':
      return false;   // handled in their own phases
    default:
      return false;
  }
}

/** Preconditions that are specific to one post-hit reaction. */
function postPrecondition(reactor: Unit, attacker: Unit, reaction: Ability): boolean {
  switch (reaction.id) {
    case 'auto-potion':
      return AUTO_POTION_ORDER.some((item) => pouchCount(reactor, item) > 0);
    case 'mp-switch':
      return reactor.stats.mp > 0;
    case 'meatbone-slash':
      return reactor.stats.hp > 0 && withinReactionRange(reactor, attacker, reaction);
    case 'last-word':
      return true;  // fires from the floor; range is resolved against neighbours below
    default:
      // Everything that strikes back needs the attacker inside its declared reach.
      return withinReactionRange(reactor, attacker, reaction);
  }
}

/**
 * Execute one reaction that has already passed its trigger, precondition and Brave roll.
 *
 * `host` here is the *inner* host — depth already incremented — so anything this does
 * cannot itself provoke a reaction.
 */
function executePostReaction(
  host: ReactionHost,
  reactor: Unit,
  attacker: Unit,
  reaction: Ability,
  landed: Landed,
  events: BattleEvent[],
): void {
  switch (reaction.id) {
    // ── Strike back ────────────────────────────────────────────────────────
    case 'counter':
    case 'counter-tackle':
    case 'counter-magick':
    case 'counter-flood':
    case 'retaliation':
    case 'thorned-hide':
      executeReactionAbility(host, reactor, reaction, [attacker], events);
      return;

    case 'meatbone-slash': {
      // Hit back for exactly the life you have left — a flat, unmissable answer.
      nudgeHp(attacker, -reactor.stats.hp, events);
      host.sync(events);
      return;
    }

    case 'last-word': {
      // A parting blow to everything hostile standing next to the corpse.
      const neighbours = adjacentHostiles(host.state, reactor, Math.max(1, reaction.range.radius));
      executeReactionAbility(host, reactor, reaction, neighbours, events);
      return;
    }

    // ── Mitigate / convert ─────────────────────────────────────────────────
    case 'damage-split': {
      // Halve what landed and hand the other half to whoever landed it.
      const share = Math.floor(landed.hpLost / 2);
      if (share <= 0) return;
      nudgeHp(reactor, share, events);
      nudgeHp(attacker, -share, events);
      host.sync(events);
      return;
    }

    case 'absorb-mp': {
      // The damage stands; the aether behind it does not. Catch it as MP.
      const gained = nudgeMp(reactor, landed.hpLost);
      if (gained > 0) host.note(reactor.id, `${reactor.name} absorbs ${gained} MP.`);
      return;
    }

    case 'mp-switch': {
      // Pay the wound out of MP instead of HP, as far as the MP goes.
      const paid = Math.min(reactor.stats.mp, landed.hpLost);
      if (paid <= 0) return;
      nudgeMp(reactor, -paid);
      nudgeHp(reactor, paid, events);
      return;
    }

    case 'auto-potion': {
      const item = AUTO_POTION_ORDER.find((id) => pouchCount(reactor, id) > 0);
      if (item === undefined) return;
      const potion = getAbility(item);
      if (potion === undefined) return;
      if (!takePouchItem(reactor, item)) return;
      executeReactionAbility(host, reactor, potion, [reactor], events);
      return;
    }

    // ── Self-affecting ─────────────────────────────────────────────────────
    case 'dragon-spirit': {
      // The blood of wyrms refuses a first death: stand straight back up.
      if (!isKO(reactor) && reactor.stats.hp > 0) return;
      if (reactor.removed) return;
      if (removeStatus(reactor, 'ko')) {
        events.push({ kind: 'status-remove', unit: reactor.id, status: 'ko' });
      }
      const maxHp = Math.max(1, deriveStats(reactor).maxHp);
      reactor.stats.hp = Math.max(1, Math.floor(maxHp / 2));
      events.push({ kind: 'heal', unit: reactor.id, amount: reactor.stats.hp });
      host.note(reactor.id, `${reactor.name} rises again.`);
      return;
    }

    case 'critical-quick': {
      // Cornered and bleeding — take your turn now.
      grantQuick(reactor);
      events.push({ kind: 'turn-order-changed' });
      return;
    }

    case 'brave-up':
      reactor.stats.brave = Math.min(100, reactor.stats.brave + Math.max(1, reaction.power));
      return;
    case 'pa-save':
      reactor.stats.pa += Math.max(1, reaction.power);
      return;
    case 'ma-save':
      reactor.stats.ma += Math.max(1, reaction.power);
      return;
    case 'speed-save':
      reactor.stats.spd += Math.max(1, reaction.power);
      return;

    case 'regenerator':
    case 'sunken-state':
    case 'caution':
    case 'vengeance':
    case 'face-up':
    case 'shadow-recoil':
      // Authored purely as a self-status. Shadow Recoil's *reposition* is not modelled —
      // moving a unit outside its own turn needs occupancy and pathing work the reducer
      // does not expose here — so it lands its Stealth and nothing else.
      applySelfStatuses(host, reactor, reaction, events);
      return;

    // ── Recognised, deliberately inert ─────────────────────────────────────
    case 'distribute':
      // Needs an overheal figure the resolution pipeline does not currently carry.
      return;

    default:
      return;
  }
}

/**
 * Roll and run every reaction owed by the units an ability just struck.
 *
 * Called by the reducer *after* the resolution is committed, so `outcomes` describes
 * what really happened and the reactors' HP already reflects it.
 */
export function runPostHitReactions(
  host: ReactionHost,
  attacker: Unit,
  incoming: Ability,
  outcomes: readonly TargetOutcome[],
  events: BattleEvent[],
): void {
  if (host.depth >= MAX_REACTION_DEPTH) return;
  const inner: ReactionHost = { ...host, depth: host.depth + 1 };

  for (const outcome of outcomes) {
    const landed = readOutcome(host.state, outcome, incoming);
    if (!landed) continue;

    runOwnReaction(host, inner, attacker, landed, events);
    runGuardianAngels(host, inner, landed, events);
  }
}

function runOwnReaction(
  host: ReactionHost,
  inner: ReactionHost,
  attacker: Unit,
  landed: Landed,
  events: BattleEvent[],
): void {
  const reactor = landed.target;
  const found = reactionOf(reactor);
  if (!found) return;
  const { ability, meta } = found;
  if (meta.preemptive === true) return;   // already had its chance
  if (!triggerMatches(meta, landed)) return;

  // A status the incoming hit itself removed still suppresses: waking a sleeper does
  // not earn you a counter from them.
  if (landed.clearedStatuses.some(
    (s) => statusDef(s).disabling || REACTION_SUPPRESSING.includes(s),
  )) return;

  // The dead react only to their own death. Everything else needs a unit still standing.
  if (meta.trigger === 'ko') {
    if (host.depth >= MAX_REACTION_DEPTH) return;
    if (reactor.removed || reactor.id === attacker.id) return;
  } else if (!canReact(host, reactor, attacker)) {
    return;
  }

  if (!postPrecondition(reactor, attacker, ability)) return;
  // A `ko` trigger fires from the floor, so it must not be gated on still being able
  // to defend yourself — that is precisely the state it exists for.
  const ignoreIncapacity = meta.trigger === 'ko';
  if (!rollReaction(reactor, host.rng, ability, { ignoreIncapacity })) return;

  announce(host, reactor, ability, attacker, events);
  executePostReaction(inner, reactor, attacker, ability, landed, events);
}

/**
 * Guardian Angel: an adjacent ally shoulders half of what the victim just took.
 *
 * FFT-flavoured but resolved after the fact rather than by intercepting the blow —
 * intercepting would mean re-targeting inside the pure resolution layer, which
 * `formulas.ts` deliberately cannot do. The visible result is the same: the victim
 * gets half its HP back, the guardian pays it.
 */
function runGuardianAngels(
  host: ReactionHost,
  inner: ReactionHost,
  landed: Landed,
  events: BattleEvent[],
): void {
  if (landed.hpLost <= 0) return;
  const victim = landed.target;

  for (const guardian of host.state.units.values()) {
    if (guardian.id === victim.id) continue;
    if (guardian.reaction !== 'guardian-angel') continue;
    if (areHostile(guardian.team, victim.team)) continue;
    const ability = getAbility('guardian-angel');
    if (ability === undefined) continue;
    if (!canReact(host, guardian, victim)) continue;
    if (tileDistance(guardian.pos, victim.pos) > ability.range.range) continue;
    if (Math.abs(guardian.pos.z - victim.pos.z) > ability.range.vertical) continue;
    if (!rollReaction(guardian, host.rng, ability)) continue;

    const share = Math.floor(landed.hpLost / 2);
    if (share <= 0) continue;

    announce(host, guardian, ability, victim, events);
    nudgeHp(victim, share, events);
    nudgeHp(guardian, -share, events);
    inner.sync(events);
  }
}

/** Every reaction id this engine will actually act on. Used by tests and tooling. */
export const IMPLEMENTED_REACTIONS: ReadonlySet<AbilityId> = new Set<AbilityId>([
  'counter', 'counter-tackle', 'counter-magick', 'counter-flood', 'retaliation',
  'thorned-hide', 'meatbone-slash', 'last-word',
  'blade-grasp', 'hamedo', 'reflexes', 'arrow-guard', 'riposte',
  'damage-split', 'absorb-mp', 'mp-switch', 'auto-potion',
  'dragon-spirit', 'critical-quick',
  'brave-up', 'pa-save', 'ma-save', 'speed-save',
  'regenerator', 'sunken-state', 'caution', 'vengeance', 'face-up', 'shadow-recoil',
  'guardian-angel',
]);

/** Reactions the table knows about but that have no mechanical effect yet. */
export const INERT_REACTIONS: ReadonlySet<AbilityId> = new Set<AbilityId>(['distribute']);
