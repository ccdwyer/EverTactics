/**
 * EverTactics — Charge Time (CT) turn system.
 *
 * This is FFT's clock. Every tick, each unit that is able to accumulate CT gains an
 * amount equal to its *effective* Speed (base Speed filtered through Haste / Slow /
 * Stop). A unit takes its turn once CT reaches {@link CT_THRESHOLD} (100). When the
 * turn ends, the unit *spends* CT according to what it actually did — and whatever is
 * left over carries into the next turn, which is exactly why fast units in FFT
 * sometimes double up.
 *
 * Cost table (the classic two-action economy):
 *   - acting                 60
 *   - moving                 40
 *   - both (a full turn)    100
 *   - neither (plain Wait)   20
 *
 * This module is pure and deterministic. The *numbers* for status effects on the
 * clock live in `combat/status.ts` (`ctScale`), so Haste/Slow/Stop are defined in one
 * place; `ct.ts` owns the clock itself.
 */

import type { BattleState, StatusId, Unit, UnitId } from './types';
import { findStatus, hasStatus, statusDef } from './combat/status';

export { findStatus, hasStatus };

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** CT required to take a turn. */
export const CT_THRESHOLD = 100;

/** CT spent by performing an action (attack, ability, item, defend). */
export const CT_COST_ACT = 60;

/** CT spent by moving. */
export const CT_COST_MOVE = 40;

/** CT spent by ending the turn having done neither (a bare Wait). */
export const CT_COST_WAIT = 20;

/**
 * Hard ceiling on accumulated CT. Without this, a unit that is skipped for a long
 * time (or a Stop that expires late) could bank an absurd number of turns. FFT
 * effectively caps around here too.
 */
export const CT_MAX = 300;

/** Turns a KO'd unit lingers before crystallising. FFT's death counter. */
export const KO_COUNTDOWN_TURNS = 3;

/**
 * Statuses that suspend the clock because the unit is busy, not because it is
 * disabled. Stop / Petrify / Crystal are handled by their `ctScale` of 0 in
 * `combat/status.ts`; these three have no scale of their own but must not bank CT,
 * or a mid-charge wizard would pile up turns it cannot take.
 */
const CT_SUSPENDED: readonly StatusId[] = ['charging', 'jumping', 'performing'];


// ─────────────────────────────────────────────────────────────────────────────
// Status helpers
// ─────────────────────────────────────────────────────────────────────────────

/** True when the unit is off the board for good (crystallised, treasure, fled). */
export function isGone(unit: Unit): boolean {
  return unit.removed || hasStatus(unit, 'crystal') || hasStatus(unit, 'treasure');
}

/** True when the unit is down but still on the field (KO'd, counting down). */
export function isDowned(unit: Unit): boolean {
  return isGone(unit) || hasStatus(unit, 'ko') || unit.stats.hp <= 0;
}

/**
 * Multiplier on CT accumulation from the unit's statuses.
 *
 * This is `combat/status.ts`'s `ctScale` with one deliberate exception: KO does not
 * stop the clock. FFT's death counter ticks down on the dead unit's own turns, so a
 * corpse has to keep accruing CT until it crystallises.
 */
export function ctScaleForClock(unit: Unit): number {
  let scale = 1;
  for (const active of unit.statuses) {
    if (active.status === 'ko') continue;
    scale *= statusDef(active.status).ctScale;
  }
  return scale;
}

/** True when the unit's CT clock runs at all. */
export function canAccumulateCt(unit: Unit): boolean {
  if (isGone(unit)) return false;
  for (const status of CT_SUSPENDED) {
    if (hasStatus(unit, status)) return false;
  }
  return ctScaleForClock(unit) > 0;
}

/**
 * True when the unit reaches its turn but is not allowed to act on it — Sleep being
 * the usual case. Stop and Petrify are also `disabling`, but their `ctScale` of 0
 * means they never get here in the first place.
 */
export function skipsTurn(unit: Unit): boolean {
  if (isDowned(unit)) return false;
  return unit.statuses.some((s) => statusDef(s.status).disabling);
}

// ─────────────────────────────────────────────────────────────────────────────
// Speed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Effective Speed for CT accumulation.
 *
 * `baseSpeed` is the unit's derived Speed (job multipliers + equipment), supplied by
 * the caller so that `ct.ts` stays free of the job/equipment tables.
 *
 * Haste (x1.5) and Slow (x0.5) come from the status table. They cancel each other on
 * application, so the compounded case should never arise in practice.
 */
export function ctSpeed(unit: Unit, baseSpeed: number): number {
  if (!canAccumulateCt(unit)) return 0;
  const speed = Math.floor(baseSpeed * ctScaleForClock(unit));
  if (baseSpeed > 0 && speed < 1) return 1;
  return Math.max(0, speed);
}

/** Default Speed source: the raw stat. Callers should pass derived Speed instead. */
export function rawSpeedOf(unit: Unit): number {
  return unit.stats.spd;
}

// ─────────────────────────────────────────────────────────────────────────────
// The clock
// ─────────────────────────────────────────────────────────────────────────────

/** Advance one unit's CT by `speed`, clamped to {@link CT_MAX}. Returns the new CT. */
export function tickCt(unit: Unit, speed: number): number {
  if (speed <= 0) return unit.ct;
  unit.ct = Math.min(CT_MAX, unit.ct + speed);
  return unit.ct;
}

/** True when the unit has banked enough CT to take a turn. */
export function isReady(unit: Unit): boolean {
  return !isGone(unit) && unit.ct >= CT_THRESHOLD;
}

/** CT the unit will spend for the turn it is currently taking. */
export function turnCtCost(unit: Unit): number {
  const { moved, acted } = unit.turn;
  if (!moved && !acted) return CT_COST_WAIT;
  return (moved ? CT_COST_MOVE : 0) + (acted ? CT_COST_ACT : 0);
}

/**
 * Spend the turn's CT. Leftover carries over — that is the whole point of the
 * system — but CT never goes negative.
 */
export function spendTurnCt(unit: Unit): number {
  const cost = turnCtCost(unit);
  unit.ct = Math.max(0, unit.ct - cost);
  return cost;
}

/** Consume a full turn without acting (asleep, or a charge in progress). */
export function consumeFullTurn(unit: Unit): void {
  unit.ct = Math.max(0, unit.ct - CT_THRESHOLD);
}

/**
 * FFT's Quick: the unit's CT jumps straight to the threshold, so it acts next.
 *
 * `Quick` is an *effect*, not a status — there is no `quick` StatusId — so abilities
 * that grant it call this directly through the battle reducer.
 */
export function grantQuick(unit: Unit): void {
  if (isGone(unit)) return;
  unit.ct = Math.max(unit.ct, CT_THRESHOLD);
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn order prediction
// ─────────────────────────────────────────────────────────────────────────────

export interface TurnForecast {
  unit: UnitId;
  /** Ticks from now at which this turn begins. 0 = right now. */
  tick: number;
  /** Predicted CT at the instant the turn begins. */
  ct: number;
  /** True when the entry is a KO'd unit burning a crystal-countdown turn. */
  downed: boolean;
}

interface SimUnit {
  id: UnitId;
  ct: number;
  speed: number;
  index: number;
  downed: boolean;
}

/**
 * Genuinely predictive turn order: simulates the clock forward and reports who acts,
 * in order, for the next `lookahead` turns. This is what the turn-order bar renders,
 * so it has to account for CT carry-over — a unit that only Waits (20 CT) comes back
 * far sooner than one that moved and acted (100 CT). We cannot know the future
 * commands, so the forecast assumes every predicted turn is a full 100-CT turn; the
 * *current* holder's real spend is applied by the reducer and the bar refreshes.
 *
 * Deterministic: ties on CT break by the unit's insertion order in `state.units`.
 */
export function forecastTurns(
  state: BattleState,
  lookahead = 12,
  speedOf: (unit: Unit) => number = rawSpeedOf,
): TurnForecast[] {
  const sims: SimUnit[] = [];
  let index = 0;
  for (const unit of state.units.values()) {
    const ownIndex = index++;
    if (isGone(unit)) continue;
    sims.push({
      id: unit.id,
      ct: unit.ct,
      speed: ctSpeed(unit, speedOf(unit)),
      index: ownIndex,
      downed: isDowned(unit),
    });
  }

  const out: TurnForecast[] = [];
  if (sims.length === 0 || lookahead <= 0) return out;

  // Safety valve: if every remaining unit is Stopped/petrified the clock is frozen
  // and there is nothing to predict.
  const MAX_SIM_TICKS = 4000;
  let elapsed = 0;

  while (out.length < lookahead && elapsed <= MAX_SIM_TICKS) {
    const ready = sims.filter((s) => s.ct >= CT_THRESHOLD);
    if (ready.length === 0) {
      if (sims.every((s) => s.speed <= 0)) break;
      for (const sim of sims) {
        if (sim.speed > 0) sim.ct = Math.min(CT_MAX, sim.ct + sim.speed);
      }
      elapsed++;
      continue;
    }

    ready.sort((a, b) => b.ct - a.ct || a.index - b.index);
    // The unit currently holding the turn always leads the bar, even if a tie or a
    // mid-turn Haste would otherwise reshuffle it.
    let next = ready[0]!;
    if (out.length === 0 && state.active !== undefined) {
      const active = ready.find((s) => s.id === state.active);
      if (active) next = active;
    }
    out.push({ unit: next.id, tick: elapsed, ct: next.ct, downed: next.downed });
    next.ct -= CT_THRESHOLD;
  }

  return out;
}

/**
 * The predicted upcoming order, as unit ids — this is what `BattleState.order` holds
 * and what the UI turn bar draws.
 */
export function computeTurnOrder(
  state: BattleState,
  lookahead = 12,
  speedOf: (unit: Unit) => number = rawSpeedOf,
): UnitId[] {
  return forecastTurns(state, lookahead, speedOf).map((entry) => entry.unit);
}

/**
 * How many ticks until `unit` next acts, given the current clock. `Infinity` when the
 * unit is frozen or gone. Used by the AI to value tempo.
 */
export function ticksUntilTurn(
  state: BattleState,
  unit: UnitId,
  speedOf: (u: Unit) => number = rawSpeedOf,
): number {
  for (const entry of forecastTurns(state, 32, speedOf)) {
    if (entry.unit === unit) return entry.tick;
  }
  return Infinity;
}
