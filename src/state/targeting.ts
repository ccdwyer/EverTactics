/**
 * EverTactics — where an ability may be aimed.
 *
 * This is deliberately its own module rather than a method on `Game`, because it
 * is the single rule three different consumers have to agree on:
 *
 *   - the UI, when it paints the range overlay and decides which clicks land;
 *   - `core/battle.ts`, when it validates the `act` command;
 *   - `core/ai`, when it enumerates aim points.
 *
 * Two mismatches between those three showed up during integration and both
 * produced the same symptom — the reducer throwing `IllegalCommandError` on a
 * command the proposer believed was legal:
 *
 *   1. `line` and `cone` shapes are resolved against the caster's facing, and the
 *      reducer *turns the caster toward the aim point first*. Testing them
 *      against the caster's current facing paints the ray in the wrong direction.
 *   2. The generic Attack's reach comes from the equipped weapon
 *      (`Ability.usesWeaponRange`), not from `range.range`.
 *
 * Both are handled here, once.
 */

import { tileKey, tilesInBurst } from '@core/grid';
import { isAbilityInRange } from '@core/targeting';
import { effectiveRange } from '@core/unit';
import type { Ability, BattleState, Unit, Vec3 } from '@core/types';

export interface TargetSet {
  /** Every tile the ability may be aimed at, in row-major order. */
  tiles: Vec3[];
  /** The same tiles as `tileKey` strings, for O(1) hit-testing on a click. */
  keys: Set<string>;
}

/**
 * Every tile `unit` may legally aim `ability` at from where it is standing.
 *
 * Mirrors `core/battle.ts:checkTargetLegality` exactly, minus the
 * "needs a unit on the tile" rule — the caller applies that when it knows
 * whether the click landed on an occupant.
 */
export function legalTargets(state: BattleState, unit: Unit, ability: Ability): TargetSet {
  const range = effectiveRange(unit, ability);
  const tiles: Vec3[] = [];
  const keys = new Set<string>();

  if (range.self) {
    const tile = state.field.tileAt(unit.pos.x, unit.pos.y);
    if (tile) {
      tiles.push({ x: tile.x, y: tile.y, z: tile.height });
      keys.add(tileKey(tile.x, tile.y));
    }
    return { tiles, keys };
  }

  for (const tile of state.field.tiles) {
    if (tile.surface === 'void') continue;
    const point: Vec3 = { x: tile.x, y: tile.y, z: tile.height };
    if (!isAbilityInRange(state.field, unit.facing, range, unit.pos, point)) continue;
    tiles.push(point);
    keys.add(tileKey(tile.x, tile.y));
  }
  return { tiles, keys };
}

/** The tiles an ability actually covers once aimed at `target`. */
export function coveredTiles(
  state: BattleState,
  unit: Unit,
  ability: Ability,
  target: Vec3,
): Vec3[] {
  const range = effectiveRange(unit, ability);
  if (range.self) return [{ x: unit.pos.x, y: unit.pos.y, z: unit.pos.z }];
  return tilesInBurst(state.field, target, range);
}

/** The first living unit inside the ability's footprint, for the target preview. */
export function primaryTargetAt(
  state: BattleState,
  unit: Unit,
  ability: Ability,
  target: Vec3,
): Unit | undefined {
  const covered = coveredTiles(state, unit, ability, target);
  const occupied = new Map<string, Unit>();
  for (const other of state.units.values()) {
    if (other.removed) continue;
    occupied.set(tileKey(other.pos.x, other.pos.y), other);
  }
  // Prefer whatever is standing on the aim tile itself; fall back to the burst.
  const direct = occupied.get(tileKey(target.x, target.y));
  if (direct) return direct;
  for (const tile of covered) {
    const found = occupied.get(tileKey(tile.x, tile.y));
    if (found) return found;
  }
  return undefined;
}

/**
 * Whether an ability aims at a **tile** (lands where you point; hits whoever is
 * there at resolution) or at a **unit** (follows the selected unit).
 *
 * Prefers the authored `Ability.targetsTiles` flag; when absent, treats any
 * non-self ability with a burst radius as tile-aimed (Fire, Cure splash, etc.)
 * and everything else as unit-aimed (Steal, single-target buffs, Holy).
 */
export function abilityTargetsTiles(ability: Ability): boolean {
  if (ability.targetsTiles === true) return true;
  if (ability.targetsTiles === false) return false;
  if (ability.range.self) return false;
  return (ability.range.radius ?? 0) > 0;
}

/**
 * Whether the reducer will accept an `act` aimed here — the last gate before a
 * click becomes a command. Unit-targeting abilities need an occupant; tile-
 * targeting abilities (including multi-tile bursts) do not.
 */
export function canAimAt(
  state: BattleState,
  unit: Unit,
  ability: Ability,
  target: Vec3,
  targets: TargetSet = legalTargets(state, unit, ability),
): boolean {
  if (!targets.keys.has(tileKey(target.x, target.y))) return false;
  if (abilityTargetsTiles(ability)) return true;
  return primaryTargetAt(state, unit, ability, target) !== undefined;
}
