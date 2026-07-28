/**
 * Canonical ability aim legality.
 *
 * Command producers and the reducer must call this predicate rather than
 * reproducing distance, height, shape, line-of-sight, or weapon-range rules.
 */

import { facingBetween, isInRange } from './grid';
import type { Ability, AbilityRange, Battlefield, Facing, Vec3 } from './types';

const RANGE_OPTIONS: Readonly<Record<Facing, { facing: Facing }>> = {
  N: { facing: 'N' },
  E: { facing: 'E' },
  S: { facing: 'S' },
  W: { facing: 'W' },
};

/**
 * Whether an ability lands on a tile or follows a selected unit.
 *
 * Authored data normally carries an explicit value. The fallback keeps older
 * or hand-written ability objects compatible: self skills follow the caster,
 * bursts land on their aimed tile, and radius-zero skills follow a unit.
 */
export function abilityTargetsTiles(
  ability: Pick<Ability, 'targetsTiles' | 'range'>,
): boolean {
  if (ability.targetsTiles !== undefined) return ability.targetsTiles;
  if (ability.range.self) return false;
  return (ability.range.radius ?? 0) > 0;
}

/**
 * Whether an ability may be aimed at `target` from `origin`.
 *
 * `origin` may be a planned movement destination, so it is kept separate from
 * the unit's current position. Callers resolve weapon-derived reach once with
 * `effectiveRange` and pass the result here.
 */
export function isAbilityInRange(
  field: Battlefield,
  currentFacing: Facing,
  range: AbilityRange,
  origin: Vec3,
  target: Vec3,
): boolean {
  if (range.self) return origin.x === target.x && origin.y === target.y;

  const onSelf = origin.x === target.x && origin.y === target.y;
  const directional = range.shape === 'line' || range.shape === 'cone';
  const facing = !onSelf && directional ? facingBetween(origin, target) : currentFacing;
  return isInRange(field, origin, target, range, RANGE_OPTIONS[facing]);
}
