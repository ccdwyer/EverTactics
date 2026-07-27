/**
 * EverTactics — core state → UI view models.
 *
 * `src/ui` deliberately never sees a `BattleState`; it takes plain, serialisable
 * view models. This module is the only place the two vocabularies meet, so a
 * change to either side is a change to exactly one file.
 *
 * Nothing here mutates state. Damage previews run the *real* combat code
 * (`resolveHit` / `computeDamage`) against a throwaway RNG, so the number in the
 * target panel is produced by the same functions that will produce the number on
 * the field — not by a second, drifting estimate.
 */

import { actionSetOf, jobActions } from './abilityIndex';
import { ATTACK } from './content';

import { ABILITY_SETS, abilitiesInSet, getAbility as lookupAbility } from '@core/abilities';
import { CT_THRESHOLD, forecastTurns } from '@core/ct';
import { computeDamage, resolveHit } from '@core/combat/formulas';
import { attackDirection, type HitResult } from '@core/combat/hit';
import { statusDef } from '@core/combat/status';
import { getJob } from '@core/jobs';
import { createRng } from '@core/rng';
import { deriveStats, isKO, jobProgress, weaponOf } from '@core/unit';
import type {
  Ability,
  AbilitySetId,
  BattleState,
  Element,
  StatusId,
  Unit,
  Vec3,
} from '@core/types';
import { portraitForId } from '@ui/portraits';
import type {
  AbilityItemVM,
  CommandItemVM,
  StatusVM,
  TargetPreviewVM,
  TurnEntryVM,
  UnitVM,
} from '@ui/types';

// ─────────────────────────────────────────────────────────────────────────────
// Portraits
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A stable face per unit. The portrait atlas carries no job or gender metadata,
 * so a deterministic hash of the unit id is the honest choice: every unit gets a
 * consistent face for the life of the save, and no two units in a squad collide
 * unless the roster is larger than the catalogue.
 */
export function portraitFor(unit: Unit): string {
  return portraitForId(`${unit.id}:${unit.gender}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

const BENEFICIAL: ReadonlySet<StatusId> = new Set<StatusId>([
  'haste', 'regen', 'protect', 'shell', 'reraise', 'faith', 'float', 'reflect',
  'transparent', 'defending', 'performing', 'charging', 'jumping', 'empowered',
  'shielded', 'stealth', 'evade-next',
]);

/** Statuses the HUD should not clutter itself with. */
const HIDDEN: ReadonlySet<StatusId> = new Set<StatusId>(['crystal', 'treasure']);

export function statusVMs(unit: Unit): StatusVM[] {
  const out: StatusVM[] = [];
  for (const active of unit.statuses) {
    if (HIDDEN.has(active.status)) continue;
    let def;
    try {
      def = statusDef(active.status);
    } catch {
      continue;
    }
    out.push({
      id: active.status,
      name: def.name,
      remaining: active.remaining,
      tone: BENEFICIAL.has(active.status) ? 'buff' : def.disabling ? 'debuff' : 'neutral',
      description: def.description,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Units
// ─────────────────────────────────────────────────────────────────────────────

export function unitVM(_state: BattleState, unit: Unit): UnitVM {
  const derived = deriveStats(unit);
  const progress = jobProgress(unit, unit.currentJob);
  return {
    id: unit.id,
    name: unit.name,
    team: unit.team,
    job: getJob(unit.currentJob).name,
    jobId: unit.currentJob,
    level: unit.level,
    hp: Math.max(0, unit.stats.hp),
    maxHp: derived.maxHp,
    mp: Math.max(0, unit.stats.mp),
    maxMp: derived.maxMp,
    brave: derived.brave,
    faith: derived.faith,
    ct: Math.min(CT_THRESHOLD, Math.round(unit.ct)),
    statuses: statusVMs(unit),
    portrait: portraitFor(unit),
    pa: derived.pa,
    ma: derived.ma,
    spd: derived.spd,
    move: derived.move,
    jump: derived.jump,
    exp: unit.exp,
    jp: progress.jp,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn order
// ─────────────────────────────────────────────────────────────────────────────

export function turnOrderVM(state: BattleState, limit = 12): TurnEntryVM[] {
  const forecast = forecastTurns(state, limit);
  const out: TurnEntryVM[] = [];
  for (let i = 0; i < forecast.length; i++) {
    const entry = forecast[i];
    if (!entry) continue;
    const unit = state.units.get(entry.unit);
    if (!unit) continue;
    const charging = unit.statuses.find((s) => s.status === 'charging');
    out.push({
      unitId: unit.id,
      name: unit.name,
      team: unit.team,
      portrait: portraitFor(unit),
      current: i === 0 && state.active === unit.id,
      ticksUntil: entry.tick,
      ...(charging ? { note: 'Charging' } : {}),
      ...(isKO(unit) ? { disabled: true } : {}),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Command menu
// ─────────────────────────────────────────────────────────────────────────────

function setLabel(setId: AbilitySetId): string {
  const meta = ABILITY_SETS.get(setId);
  if (meta?.name) return meta.name;
  return setId
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The command rows for a unit's turn. Ids are the contract with `Game`:
 *
 *   `move` · `attack` · `set:<abilitySetId>` · `item` · `defend` · `wait` · `status`
 */
export function commandItemsFor(state: BattleState, unit: Unit): CommandItemVM[] {
  const job = getJob(unit.currentJob);
  const primary = actionSetOf(job);
  const derived = deriveStats(unit);
  const items: CommandItemVM[] = [];

  items.push({
    id: 'move',
    label: 'Move',
    enabled: !unit.turn.moved,
    detail: String(derived.move),
    hint: unit.turn.moved ? 'Already moved this turn.' : `Walk up to ${derived.move} tiles.`,
    icon: 'move',
  });

  const weapon = weaponOf(unit);
  items.push({
    id: 'attack',
    label: 'Attack',
    enabled: !unit.turn.acted,
    detail: weapon ? weapon.name : 'Bare hands',
    hint: unit.turn.acted ? 'Already acted this turn.' : 'Strike with the equipped weapon.',
    icon: 'sword',
  });

  const sets: AbilitySetId[] = [primary];
  if (unit.secondaryAction && unit.secondaryAction !== primary) sets.push(unit.secondaryAction);

  for (const setId of sets) {
    const usable = abilityItemsFor(state, unit, setId);
    if (usable.length === 0) continue;
    items.push({
      id: `set:${setId}`,
      label: setLabel(setId),
      enabled: !unit.turn.acted,
      opensSubmenu: true,
      detail: String(usable.length),
      hint: unit.turn.acted
        ? 'Already acted this turn.'
        : `${usable.length} abilities from ${setLabel(setId)}.`,
      icon: 'book',
    });
  }

  if (sets.every((s) => s !== 'item')) {
    const items_ = abilityItemsFor(state, unit, 'item');
    if (items_.length > 0) {
      items.push({
        id: 'item',
        label: 'Item',
        enabled: !unit.turn.acted,
        opensSubmenu: true,
        detail: String(items_.length),
        hint: 'Use a consumable.',
        icon: 'potion',
      });
    }
  }

  items.push({
    id: 'defend',
    label: 'Defend',
    enabled: !unit.turn.acted,
    hint: 'Brace. Damage taken is reduced by a third until your next turn.',
    icon: 'shield',
  });

  items.push({
    id: 'wait',
    label: 'Wait',
    enabled: true,
    hint: 'End the turn here. Face the way you expect trouble.',
    icon: 'hourglass',
  });

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ability menu
// ─────────────────────────────────────────────────────────────────────────────

/** Abilities from `setId` the unit has actually learned, in menu order. */
export function abilitiesAvailable(unit: Unit, setId: AbilitySetId): Ability[] {
  const progress = unit.jobs.get(unit.currentJob);
  const learned = progress?.learned;
  const out: Ability[] = [];
  const seen = new Set<string>();

  // Learned entries first, in the order the job teaches them.
  for (const skill of jobActions(getJob(unit.currentJob))) {
    if (skill.ability.set !== setId) continue;
    if (learned && !learned.has(skill.ability.id)) continue;
    if (seen.has(skill.ability.id)) continue;
    seen.add(skill.ability.id);
    out.push(skill.ability);
  }
  // A borrowed skillset is not in the current job's teach list.
  for (const ability of abilitiesInSet(setId)) {
    if (seen.has(ability.id)) continue;
    if (learned && !learned.has(ability.id)) continue;
    seen.add(ability.id);
    out.push(ability);
  }
  return out;
}

function shapeLabel(ability: Ability): string {
  if (ability.range.self) return 'Self';
  const shape = ability.range.shape ?? 'circle';
  if (ability.range.radius === 0) return shape === 'circle' ? 'Single' : shape;
  return `${shape} ${ability.range.radius}`;
}

export function abilityItemsFor(
  state: BattleState,
  unit: Unit,
  setId: AbilitySetId,
): AbilityItemVM[] {
  const derived = deriveStats(unit);
  const silenced = unit.statuses.some((s) => s.status === 'silence');
  const out: AbilityItemVM[] = [];

  for (const ability of abilitiesAvailable(unit, setId)) {
    let reason: string | undefined;
    if (ability.mp > 0 && silenced) reason = 'Silenced';
    else if (ability.mp > derived.mp) reason = `Needs ${ability.mp} MP`;

    out.push({
      id: ability.id,
      name: ability.name,
      description: ability.description,
      mp: ability.mp,
      ct: ability.ct,
      range: ability.range.range,
      radius: ability.range.radius,
      vertical: Number.isFinite(ability.range.vertical) ? ability.range.vertical : undefined,
      element: ability.element,
      enabled: reason === undefined && !unit.turn.acted,
      ...(reason !== undefined ? { reason } : {}),
      stats: [
        { label: 'Power', value: ability.power > 0 ? String(ability.power) : '—' },
        { label: 'Accuracy', value: ability.accuracy > 0 ? `${ability.accuracy}%` : 'Always' },
        { label: 'Area', value: shapeLabel(ability) },
        { label: 'Formula', value: ability.formula },
      ],
    });
  }
  void state;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Target preview
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Predict the outcome of `ability` landing on `target`.
 *
 * The hit chance and the damage band come from the real combat functions with a
 * throwaway RNG: `resolveHit` reports `chance` before it rolls, and
 * `computeDamage` run in `deterministic` mode gives the un-jittered magnitude,
 * which the ±12.5% variance band is then applied to. Nothing is mutated.
 */
export function targetPreviewVM(
  state: BattleState,
  attacker: Unit,
  ability: Ability,
  target: Unit,
  fromTile?: Vec3,
): TargetPreviewVM {
  const rng = createRng(0x1a2b3c4d);
  const origin = fromTile ?? attacker.pos;
  const direction = attackDirection(origin, target.pos, target.facing);
  const hit = resolveHit(attacker, target, ability, rng, { direction });

  const damage = computeDamage({
    attacker,
    target,
    ability,
    rng: createRng(0x1a2b3c4d),
    direction,
    crit: false,
    deterministic: true,
  });

  const derived = deriveStats(target);
  const magnitude = Math.abs(damage.hpDelta);
  const healing = damage.hpDelta > 0;
  const min = magnitude > 0 ? Math.max(1, Math.floor(magnitude * 0.875)) : 0;
  const max = magnitude > 0 ? Math.ceil(magnitude * 1.125) : 0;

  const signedMin = healing ? -max : min;
  const signedMax = healing ? -min : max;

  const resultLow = clamp(target.stats.hp + (healing ? min : -max), 0, derived.maxHp);
  const resultHigh = clamp(target.stats.hp + (healing ? max : -min), 0, derived.maxHp);

  const statusChances: { name: string; chance: number; cures?: boolean }[] =
    (ability.inflicts ?? []).map((i) => ({
      name: safeStatusName(i.status),
      chance: Math.round((i.chance * hit.chance) / 100),
    }));
  for (const cured of ability.cures ?? []) {
    statusChances.push({ name: safeStatusName(cured), chance: 100, cures: true });
  }

  const breakdown: { label: string; value: string }[] = [
    { label: 'Direction', value: direction },
    { label: 'Evasion', value: `${totalEvade(hit)}%` },
  ];
  if (hit.zodiac !== 1) breakdown.push({ label: 'Zodiac', value: `×${hit.zodiac.toFixed(2)}` });
  if (damage.affinity !== 'normal') {
    breakdown.push({ label: 'Element', value: damage.affinity });
  }

  const crit = ability.formula === 'physical' ? critEstimate(attacker, direction) : undefined;

  return {
    attackerName: attacker.name,
    targetName: target.name,
    actionName: ability.name,
    hitChance: Math.round(hit.chance),
    facing: direction,
    relative: direction,
    targetHp: target.stats.hp,
    targetMaxHp: derived.maxHp,
    ...(magnitude > 0 ? { amountMin: signedMin, amountMax: signedMax } : {}),
    element: ability.element,
    ...(crit !== undefined ? { critChance: crit } : {}),
    resultHpMin: Math.min(resultLow, resultHigh),
    resultHpMax: Math.max(resultLow, resultHigh),
    ...(statusChances.length > 0 ? { statusChances } : {}),
    breakdown,
  };
}

function totalEvade(hit: HitResult): number {
  const e = hit.evade;
  return Math.round(
    e.classEvade + e.weaponEvade + e.shieldEvade + e.accessoryEvade + e.magicEvade,
  );
}

function critEstimate(attacker: Unit, direction: 'front' | 'side' | 'back'): number {
  const brave = deriveStats(attacker).brave;
  let c = 5 + Math.floor(brave / 20);
  if (direction === 'back') c += 20;
  else if (direction === 'side') c += 10;
  return Math.min(60, c);
}

function safeStatusName(id: StatusId): string {
  try {
    return statusDef(id).name;
  } catch {
    return id;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Misc lookups the game layer needs
// ─────────────────────────────────────────────────────────────────────────────

export function abilityById(id: string): Ability | undefined {
  return id === ATTACK.id ? ATTACK : lookupAbility(id);
}

export function elementOf(id: string): Element {
  return abilityById(id)?.element ?? 'none';
}
