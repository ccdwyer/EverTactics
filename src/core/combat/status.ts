/**
 * EverTactics — status effect engine.
 *
 * Owns the full `StatusId` table, application rules (immunity / blockedBy / cancels),
 * per-tick decay, per-tick effects (poison, regen, bleed, burn, death sentence) and
 * the CT-accumulation scaling that Haste / Slow / Stop feed into.
 *
 * Pure logic. No three.js, no Math.random — every roll goes through `Rng`.
 */

import type { ActiveStatus, ItemId, Rng, StatusDef, StatusId, Unit, UnitId } from '../types';

// The `ActiveStatus` contract in types.ts only carries `remaining`. Ward-style statuses
// need an absorb pool and stacking DoTs need a stack count, so we widen it additively
// via declaration merging rather than editing the shared contract file.
declare module '../types' {
  interface ActiveStatus {
    /** Remaining absorb pool, in HP, for ward-style statuses (`shielded`). */
    amount?: number;
    /** Stack count for stacking effects (`bleeding`, `burning`, `mark`). */
    stacks?: number;
    /** Potency scalar for statuses whose strength varies by caster (`empowered`, `regen`). */
    potency?: number;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status table
// ─────────────────────────────────────────────────────────────────────────────

/** How a status behaves when the clock advances. */
export type StatusTickKind =
  | 'none'
  | 'poison'
  | 'regen'
  | 'bleed'
  | 'burn'
  | 'doom'; // death sentence

/**
 * Everything the engine needs to know about a status. Extends the frozen `StatusDef`
 * contract with mechanical fields so `StatusDef` consumers (UI, renderer) still work.
 */
export interface StatusRules extends StatusDef {
  /** Default duration in CT ticks when an ability does not specify one. -1 = permanent. */
  readonly defaultDuration: number;
  /** Unit cannot move (but may still act). */
  readonly preventsMove: boolean;
  /** Unit cannot use evasion at all while this is active. */
  readonly preventsEvade: boolean;
  /** Unit's own attacks are less accurate (Blind). Multiplier on physical accuracy. */
  readonly accuracyScale: number;
  /** Multiplier applied to CT accumulation while active (Haste 1.5, Slow 0.5, Stop 0). */
  readonly ctScale: number;
  /** Per-clock-tick effect. */
  readonly tick: StatusTickKind;
  /** Positive statuses are not resisted by immunity gear and are not "debuffs" for AI. */
  readonly beneficial: boolean;
  /** Re-applying refreshes duration (false) or adds a stack (true). */
  readonly stacks: boolean;
  /** Status is removed the moment the unit acts offensively. */
  readonly brokenByAction: boolean;
}

/** Statuses that mean "this unit is off the board" for most rules. */
export const INCAPACITATED: readonly StatusId[] = ['ko', 'crystal', 'treasure', 'petrify'] as const;

/** Every status that a Ribbon-class accessory turns off. */
export const RIBBON_IMMUNITIES: readonly StatusId[] = [
  'petrify', 'stop', 'sleep', 'charm', 'confuse', 'berserk', 'blind', 'silence',
  'oil', 'poison', 'frog', 'slow', 'chicken', 'death-sentence', 'bleeding', 'burning',
] as const;

interface StatusSeed extends Partial<StatusRules> {
  id: StatusId;
  name: string;
  description: string;
  icon: string;
}

function def(seed: StatusSeed): StatusRules {
  return {
    id: seed.id,
    name: seed.name,
    description: seed.description,
    icon: seed.icon,
    cancels: seed.cancels ?? [],
    blockedBy: seed.blockedBy ?? DEFAULT_BLOCKERS,
    disabling: seed.disabling ?? false,
    ...(seed.tint !== undefined ? { tint: seed.tint } : {}),
    defaultDuration: seed.defaultDuration ?? -1,
    preventsMove: seed.preventsMove ?? false,
    preventsEvade: seed.preventsEvade ?? false,
    accuracyScale: seed.accuracyScale ?? 1,
    ctScale: seed.ctScale ?? 1,
    tick: seed.tick ?? 'none',
    beneficial: seed.beneficial ?? false,
    stacks: seed.stacks ?? false,
    brokenByAction: seed.brokenByAction ?? false,
  };
}

/** Nothing lands on a unit that is dead, crystallised, looted or stone. */
const DEFAULT_BLOCKERS: readonly StatusId[] = ['ko', 'crystal', 'treasure', 'petrify'] as const;
const NO_BLOCKERS: readonly StatusId[] = [] as const;

/** Death cancels essentially every transient condition. */
const CANCELLED_BY_DEATH: readonly StatusId[] = [
  'petrify', 'stop', 'sleep', 'charm', 'confuse', 'berserk', 'blind', 'silence', 'oil',
  'poison', 'frog', 'slow', 'haste', 'regen', 'protect', 'shell', 'faith', 'innocent',
  'float', 'reflect', 'transparent', 'chicken', 'death-sentence', 'defending',
  'performing', 'charging', 'jumping', 'taunted', 'rooted', 'vulnerable', 'empowered',
  'shielded', 'bleeding', 'burning', 'mark', 'stealth', 'evade-next',
] as const;

const TABLE: readonly StatusRules[] = [
  // ── Terminal states ────────────────────────────────────────────────────────
  def({
    id: 'ko', name: 'K.O.', icon: 'status/ko',
    description: 'The unit has fallen. It crystallises after three turns unless raised.',
    cancels: CANCELLED_BY_DEATH, blockedBy: NO_BLOCKERS,
    disabling: true, preventsMove: true, preventsEvade: true, ctScale: 0,
    tint: [0.35, 0.35, 0.45],
  }),
  def({
    id: 'crystal', name: 'Crystal', icon: 'status/crystal',
    description: 'The body has become a crystal. The unit is gone for good.',
    cancels: ['ko', 'reraise'], blockedBy: NO_BLOCKERS,
    disabling: true, preventsMove: true, preventsEvade: true, ctScale: 0,
  }),
  def({
    id: 'treasure', name: 'Treasure', icon: 'status/treasure',
    description: 'The body left behind a treasure chest. The unit is gone for good.',
    cancels: ['ko', 'reraise'], blockedBy: NO_BLOCKERS,
    disabling: true, preventsMove: true, preventsEvade: true, ctScale: 0,
  }),
  def({
    id: 'petrify', name: 'Petrify', icon: 'status/petrify',
    description: 'Turned to stone. Cannot act, cannot evade, takes no turns.',
    cancels: ['charging', 'performing', 'jumping', 'defending', 'transparent', 'stealth', 'haste', 'slow', 'regen'],
    blockedBy: ['ko', 'crystal', 'treasure'],
    disabling: true, preventsMove: true, preventsEvade: true, ctScale: 0,
    tint: [0.6, 0.6, 0.55],
  }),

  // ── Hard control ───────────────────────────────────────────────────────────
  def({
    id: 'stop', name: 'Stop', icon: 'status/stop',
    description: 'Time is frozen around the unit. It gains no CT and cannot evade.',
    cancels: ['charging', 'performing', 'jumping', 'defending'],
    disabling: true, preventsMove: true, preventsEvade: true, ctScale: 0,
    defaultDuration: 24, tint: [0.55, 0.7, 1.0],
  }),
  def({
    id: 'sleep', name: 'Sleep', icon: 'status/sleep',
    description: 'Asleep. Cannot act or evade; damage wakes the unit.',
    cancels: ['charging', 'performing', 'jumping', 'defending'],
    disabling: true, preventsMove: true, preventsEvade: true,
    defaultDuration: 60, tint: [0.7, 0.7, 1.0],
  }),
  def({
    id: 'charm', name: 'Charm', icon: 'status/charm',
    description: 'Fighting for the other side until the charm wears off.',
    cancels: ['berserk', 'confuse', 'taunted'],
    defaultDuration: 32, tint: [1.0, 0.7, 0.85],
  }),
  def({
    id: 'confuse', name: 'Confusion', icon: 'status/confuse',
    description: 'Attacks at random. Cannot evade.',
    cancels: ['charm', 'berserk', 'sleep'],
    preventsEvade: true, defaultDuration: 32, tint: [0.9, 0.75, 1.0],
  }),
  def({
    id: 'berserk', name: 'Berserk', icon: 'status/berserk',
    description: 'Attacks the nearest target with raised physical power and no control.',
    cancels: ['charm', 'confuse', 'sleep'],
    defaultDuration: -1, tint: [1.0, 0.55, 0.5],
  }),
  def({
    id: 'chicken', name: 'Chicken', icon: 'status/chicken',
    description: 'Brave has collapsed. The unit flees and cannot be commanded.',
    cancels: ['berserk'], preventsEvade: true, defaultDuration: -1,
  }),
  def({
    id: 'frog', name: 'Frog', icon: 'status/frog',
    description: 'A frog. Physical and magical power are halved and only Attack remains.',
    cancels: ['charging', 'performing', 'jumping'], defaultDuration: -1,
    tint: [0.6, 1.0, 0.6],
  }),

  // ── Debuffs ────────────────────────────────────────────────────────────────
  def({
    id: 'blind', name: 'Darkness', icon: 'status/blind',
    description: 'Blinded. Physical accuracy is halved.',
    accuracyScale: 0.5, defaultDuration: 36, tint: [0.4, 0.4, 0.45],
  }),
  def({
    id: 'silence', name: 'Silence', icon: 'status/silence',
    description: 'Cannot cast spells.', defaultDuration: 36,
  }),
  def({
    id: 'oil', name: 'Oil', icon: 'status/oil',
    description: 'Soaked in oil. Fire damage is doubled.',
    defaultDuration: -1, tint: [0.45, 0.4, 0.35],
  }),
  def({
    id: 'poison', name: 'Poison', icon: 'status/poison',
    description: 'Loses HP every clock tick.',
    tick: 'poison', defaultDuration: 36, tint: [0.7, 0.5, 0.95],
  }),
  def({
    id: 'undead', name: 'Undead', icon: 'status/undead',
    description: 'Healing harms and harm heals. Rises again after falling.',
    defaultDuration: -1, tint: [0.5, 0.65, 0.5],
  }),
  def({
    id: 'slow', name: 'Slow', icon: 'status/slow',
    description: 'Charge Time accumulates at half speed.',
    cancels: ['haste'], ctScale: 0.5, defaultDuration: 32, tint: [0.6, 0.6, 0.75],
  }),
  def({
    id: 'innocent', name: 'Innocent', icon: 'status/innocent',
    description: 'Faith is reduced to nothing — magic barely touches the unit, in either direction.',
    cancels: ['faith'], defaultDuration: 32,
  }),
  def({
    id: 'death-sentence', name: 'Death Sentence', icon: 'status/doom',
    description: 'Falls when the count reaches zero.',
    tick: 'doom', defaultDuration: 30, tint: [0.35, 0.3, 0.4],
  }),
  def({
    id: 'vulnerable', name: 'Vulnerable', icon: 'status/vulnerable',
    description: 'Armour has been broken open — all damage taken is increased by a quarter.',
    defaultDuration: 24, tint: [1.0, 0.6, 0.4],
  }),
  def({
    id: 'rooted', name: 'Rooted', icon: 'status/rooted',
    description: 'Held in place. The unit may act but cannot move.',
    preventsMove: true, defaultDuration: 24, tint: [0.55, 0.45, 0.3],
  }),
  def({
    id: 'taunted', name: 'Taunted', icon: 'status/taunt',
    description: 'Forced to answer the taunter — other targets are ignored.',
    cancels: ['charm'], defaultDuration: 24, tint: [1.0, 0.45, 0.35],
  }),
  def({
    id: 'bleeding', name: 'Bleeding', icon: 'status/bleed',
    description: 'An open wound. Loses HP every clock tick, and it stacks.',
    tick: 'bleed', stacks: true, defaultDuration: 30, tint: [0.9, 0.3, 0.3],
  }),
  def({
    id: 'burning', name: 'Burning', icon: 'status/burn',
    description: 'Alight. Loses HP every clock tick; oil makes it far worse.',
    tick: 'burn', stacks: true, defaultDuration: 24, tint: [1.0, 0.6, 0.25],
  }),
  def({
    id: 'mark', name: 'Marked', icon: 'status/mark',
    description: "Singled out. The marker's attacks land more often and hit harder.",
    defaultDuration: 30, tint: [1.0, 0.85, 0.4],
  }),

  // ── Buffs ──────────────────────────────────────────────────────────────────
  def({
    id: 'haste', name: 'Haste', icon: 'status/haste',
    description: 'Charge Time accumulates half again as fast.',
    cancels: ['slow'], ctScale: 1.5, defaultDuration: 32, beneficial: true,
    tint: [1.0, 0.95, 0.6],
  }),
  def({
    id: 'regen', name: 'Regen', icon: 'status/regen',
    description: 'Recovers HP every clock tick.',
    tick: 'regen', defaultDuration: 36, beneficial: true, tint: [0.6, 1.0, 0.7],
  }),
  def({
    id: 'protect', name: 'Protect', icon: 'status/protect',
    description: 'Physical damage taken is reduced by a third.',
    defaultDuration: 32, beneficial: true, tint: [0.75, 0.85, 1.0],
  }),
  def({
    id: 'shell', name: 'Shell', icon: 'status/shell',
    description: 'Magical damage taken is reduced by a third.',
    defaultDuration: 32, beneficial: true, tint: [0.85, 0.75, 1.0],
  }),
  def({
    id: 'reraise', name: 'Reraise', icon: 'status/reraise',
    description: 'The unit stands back up once after falling.',
    defaultDuration: -1, beneficial: true, tint: [1.0, 1.0, 0.8],
  }),
  def({
    id: 'faith', name: 'Faith', icon: 'status/faith',
    description: 'Faith is at its peak — magic flows through the unit, for good and ill.',
    cancels: ['innocent'], defaultDuration: 32, beneficial: true,
  }),
  def({
    id: 'float', name: 'Float', icon: 'status/float',
    description: 'Hovering above the ground. Earth damage passes harmlessly beneath.',
    defaultDuration: 32, beneficial: true,
  }),
  def({
    id: 'reflect', name: 'Reflect', icon: 'status/reflect',
    description: 'Single-target magic bounces back at its caster.',
    defaultDuration: 32, beneficial: true, tint: [0.8, 0.9, 1.0],
  }),
  def({
    id: 'transparent', name: 'Transparent', icon: 'status/transparent',
    description: 'Unseen. The unit ignores its target\'s evasion, and the effect breaks when it acts.',
    defaultDuration: -1, beneficial: true, brokenByAction: true, tint: [0.8, 0.9, 1.0],
  }),
  def({
    id: 'stealth', name: 'Stealth', icon: 'status/stealth',
    description: 'Moving unseen. The next strike ignores evasion and always finds the weak point.',
    defaultDuration: -1, beneficial: true, brokenByAction: true, tint: [0.55, 0.6, 0.75],
  }),
  def({
    id: 'empowered', name: 'Empowered', icon: 'status/empowered',
    description: 'Damage dealt is increased by half.',
    defaultDuration: 20, beneficial: true, tint: [1.0, 0.8, 0.4],
  }),
  def({
    id: 'shielded', name: 'Ward', icon: 'status/ward',
    description: 'A ward absorbs incoming damage before it reaches HP.',
    defaultDuration: 32, beneficial: true, tint: [0.7, 0.95, 1.0],
  }),
  def({
    id: 'evade-next', name: 'Evasion', icon: 'status/evade-next',
    description: 'The very next attack against the unit is turned aside.',
    defaultDuration: 20, beneficial: true,
  }),

  // ── Action-economy markers ─────────────────────────────────────────────────
  def({
    id: 'defending', name: 'Defending', icon: 'status/defend',
    description: 'Guarding. Evasion is doubled and physical damage is reduced.',
    defaultDuration: 100, beneficial: true,
  }),
  def({
    id: 'performing', name: 'Performing', icon: 'status/perform',
    description: 'Mid-song or mid-dance. Cannot evade until the performance ends.',
    preventsEvade: true, defaultDuration: -1,
  }),
  def({
    id: 'charging', name: 'Charging', icon: 'status/charge',
    description: 'Channelling a spell. Cannot evade while the charge runs.',
    preventsEvade: true, defaultDuration: -1,
  }),
  def({
    id: 'jumping', name: 'Jumping', icon: 'status/jump',
    description: 'Airborne. Untargetable until the lance comes down.',
    preventsEvade: true, defaultDuration: -1,
  }),
];

/** Every status in the union, keyed by id. */
export const STATUSES: ReadonlyMap<StatusId, StatusRules> = new Map(TABLE.map((s) => [s.id, s]));

export function statusDef(id: StatusId): StatusRules {
  const d = STATUSES.get(id);
  if (!d) throw new Error(`unknown status: ${id}`);
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Immunity registry — populated by the item table at boot.
// ─────────────────────────────────────────────────────────────────────────────

const itemImmunities = new Map<ItemId, ReadonlySet<StatusId>>();

/** Register the statuses an equipment item makes the wearer immune to. */
export function registerItemImmunity(item: ItemId, statuses: readonly StatusId[]): void {
  itemImmunities.set(item, new Set(statuses));
}

export function clearItemImmunities(): void {
  itemImmunities.clear();
}

/** All statuses this unit cannot be afflicted with, from gear plus innate rules. */
export function immunities(unit: Unit): Set<StatusId> {
  const out = new Set<StatusId>();
  for (const id of Object.values(unit.equipment)) {
    if (typeof id !== 'string') continue;
    const set = itemImmunities.get(id);
    if (set) for (const s of set) out.add(s);
  }
  // Undead are already dead: poison, death sentence and instant death do nothing.
  if (hasStatus(unit, 'undead')) {
    out.add('poison');
    out.add('death-sentence');
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

export function hasStatus(unit: Unit, id: StatusId): boolean {
  return unit.statuses.some((s) => s.status === id);
}

export function findStatus(unit: Unit, id: StatusId): ActiveStatus | undefined {
  return unit.statuses.find((s) => s.status === id);
}

export function statusStacks(unit: Unit, id: StatusId): number {
  const s = findStatus(unit, id);
  if (!s) return 0;
  return s.stacks ?? 1;
}

/** True when any of the listed statuses is present. */
export function hasAnyStatus(unit: Unit, ids: readonly StatusId[]): boolean {
  return ids.some((id) => hasStatus(unit, id));
}

export function isIncapacitated(unit: Unit): boolean {
  return hasAnyStatus(unit, INCAPACITATED);
}

/** Statuses that stop a unit from taking its turn at all. */
export function isDisabled(unit: Unit): boolean {
  return unit.statuses.some((s) => statusDef(s.status).disabling);
}

export function isImmobile(unit: Unit): boolean {
  return unit.statuses.some((s) => statusDef(s.status).preventsMove);
}

/** True when the unit is not permitted to use any evasion this attack. */
export function cannotEvade(unit: Unit): boolean {
  return unit.statuses.some((s) => statusDef(s.status).preventsEvade);
}

/** Multiplier on CT accumulation. Haste 1.5, Slow 0.5, Stop/KO/Petrify 0. */
export function ctScale(unit: Unit): number {
  let scale = 1;
  for (const s of unit.statuses) scale *= statusDef(s.status).ctScale;
  return scale;
}

/** Multiplier on this unit's own physical accuracy (Blind halves it). */
export function accuracyScale(unit: Unit): number {
  let scale = 1;
  for (const s of unit.statuses) scale *= statusDef(s.status).accuracyScale;
  return scale;
}

// ─────────────────────────────────────────────────────────────────────────────
// Application
// ─────────────────────────────────────────────────────────────────────────────

export type StatusRefusal = 'immune' | 'blocked' | 'already-present' | 'unknown';

export interface StatusApplication {
  status: StatusId;
  applied: boolean;
  /** Why it failed, when it did. */
  refused?: StatusRefusal;
  /** The status that blocked it, when `refused === 'blocked'`. */
  blocker?: StatusId;
  /** Statuses removed as a consequence of this one landing. */
  cancelled: StatusId[];
  /** True when the status was already present and only its duration was refreshed. */
  refreshed: boolean;
}

export interface ApplyOptions {
  /** Duration override in CT ticks; -1 for permanent. Defaults to the status' own. */
  duration?: number;
  source?: UnitId;
  /** Absorb pool for `shielded`. */
  amount?: number;
  /** Potency scalar for statuses whose strength varies by caster. */
  potency?: number;
}

/** Non-mutating check: would this status land? */
export function canApplyStatus(unit: Unit, id: StatusId): StatusApplication {
  const rules = STATUSES.get(id);
  if (!rules) return { status: id, applied: false, refused: 'unknown', cancelled: [], refreshed: false };

  if (!rules.beneficial && immunities(unit).has(id)) {
    return { status: id, applied: false, refused: 'immune', cancelled: [], refreshed: false };
  }
  for (const blocker of rules.blockedBy) {
    if (hasStatus(unit, blocker)) {
      return { status: id, applied: false, refused: 'blocked', blocker, cancelled: [], refreshed: false };
    }
  }
  const cancelled = rules.cancels.filter((c) => hasStatus(unit, c));
  return {
    status: id,
    applied: true,
    cancelled,
    refreshed: hasStatus(unit, id),
  };
}

/**
 * Apply a status to a unit, mutating its status array. Returns what actually happened.
 * Callers that must stay pure should use `canApplyStatus` and apply later.
 */
export function applyStatus(unit: Unit, id: StatusId, opts: ApplyOptions = {}): StatusApplication {
  const result = canApplyStatus(unit, id);
  if (!result.applied) return result;
  const rules = statusDef(id);

  for (const c of result.cancelled) removeStatus(unit, c);

  const duration = opts.duration ?? rules.defaultDuration;
  const existing = findStatus(unit, id);

  if (existing) {
    // Refresh, or stack when the status is a stacking DoT.
    existing.remaining = duration < 0 || existing.remaining < 0
      ? (duration < 0 ? -1 : Math.max(existing.remaining, duration))
      : Math.max(existing.remaining, duration);
    if (rules.stacks) existing.stacks = (existing.stacks ?? 1) + 1;
    if (opts.amount !== undefined) existing.amount = (existing.amount ?? 0) + opts.amount;
    if (opts.potency !== undefined) existing.potency = opts.potency;
    if (opts.source !== undefined) existing.source = opts.source;
    return result;
  }

  const active: ActiveStatus = { status: id, remaining: duration };
  if (opts.source !== undefined) active.source = opts.source;
  if (rules.stacks) active.stacks = 1;
  if (opts.amount !== undefined) active.amount = opts.amount;
  if (opts.potency !== undefined) active.potency = opts.potency;
  unit.statuses.push(active);
  return result;
}

export function removeStatus(unit: Unit, id: StatusId): boolean {
  const i = unit.statuses.findIndex((s) => s.status === id);
  if (i < 0) return false;
  unit.statuses.splice(i, 1);
  return true;
}

/** Remove every status the unit has that is not in `keep`. */
export function clearStatuses(unit: Unit, keep: readonly StatusId[] = []): StatusId[] {
  const removed: StatusId[] = [];
  unit.statuses = unit.statuses.filter((s) => {
    if (keep.includes(s.status)) return true;
    removed.push(s.status);
    return false;
  });
  return removed;
}

/** Drop statuses that break when the unit takes an offensive action (Transparent, Stealth). */
export function breakOnAction(unit: Unit): StatusId[] {
  const broken = unit.statuses.filter((s) => statusDef(s.status).brokenByAction).map((s) => s.status);
  for (const id of broken) removeStatus(unit, id);
  return broken;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wards
// ─────────────────────────────────────────────────────────────────────────────

export interface WardAbsorption {
  /** Damage soaked by wards. */
  absorbed: number;
  /** Damage that still reaches HP. */
  remaining: number;
  /** Wards whose pool was emptied by this hit. */
  broken: StatusId[];
}

/** How much of `amount` a unit's wards would eat, without mutating anything. */
export function previewWards(unit: Unit, amount: number): WardAbsorption {
  let left = Math.max(0, amount);
  let absorbed = 0;
  const broken: StatusId[] = [];
  for (const s of unit.statuses) {
    if (s.status !== 'shielded') continue;
    const pool = s.amount ?? 0;
    if (pool <= 0) continue;
    const eaten = Math.min(pool, left);
    absorbed += eaten;
    left -= eaten;
    if (eaten >= pool) broken.push(s.status);
    if (left <= 0) break;
  }
  return { absorbed, remaining: left, broken };
}

/** Same as `previewWards`, but actually drains the pools and drops empty wards. */
export function consumeWards(unit: Unit, amount: number): WardAbsorption {
  let left = Math.max(0, amount);
  let absorbed = 0;
  const broken: StatusId[] = [];
  for (const s of unit.statuses) {
    if (s.status !== 'shielded') continue;
    const pool = s.amount ?? 0;
    if (pool <= 0) continue;
    const eaten = Math.min(pool, left);
    s.amount = pool - eaten;
    absorbed += eaten;
    left -= eaten;
    if (s.amount <= 0) broken.push(s.status);
    if (left <= 0) break;
  }
  unit.statuses = unit.statuses.filter((s) => s.status !== 'shielded' || (s.amount ?? 0) > 0);
  return { absorbed, remaining: left, broken };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ticking
// ─────────────────────────────────────────────────────────────────────────────

/** Fraction of max HP each damage-over-time status moves per clock tick. */
export const TICK_FRACTIONS = {
  /** Poison: an eighth of max HP, FFT-style. */
  poison: 8,
  regen: 8,
  /** Bleeds are smaller but stack. */
  bleed: 16,
  burn: 12,
} as const;

export interface StatusTickEffect {
  status: StatusId;
  /** Signed HP change this status caused (negative = damage). */
  hp: number;
  /** Set when the status ran its course this tick. */
  expired: boolean;
  /** Set when this status killed the unit outright (Death Sentence). */
  kills: boolean;
}

export interface StatusTickResult {
  /** Net signed HP change to apply. */
  hpDelta: number;
  /** Statuses whose duration ran out and were removed. */
  expired: StatusId[];
  effects: StatusTickEffect[];
  /** True when the tick reduced the unit to zero HP or Death Sentence fired. */
  ko: boolean;
}

export interface TickContext {
  maxHp: number;
  hp: number;
  /** Ticks of clock to advance. Defaults to 1. */
  ticks?: number;
}

function fraction(maxHp: number, denom: number): number {
  return Math.max(1, Math.floor(maxHp / denom));
}

/**
 * Advance a unit's statuses by `ticks` clock ticks: run damage-over-time and regen,
 * count durations down, and remove anything that expired. Mutates the status array
 * (durations, stacks) but never touches HP — the caller applies `hpDelta`.
 */
export function tickStatuses(unit: Unit, ctx: TickContext): StatusTickResult {
  const ticks = ctx.ticks ?? 1;
  const effects: StatusTickEffect[] = [];
  const expired: StatusId[] = [];
  let hpDelta = 0;
  let ko = false;

  const oiled = hasStatus(unit, 'oil');
  const undead = hasStatus(unit, 'undead');

  for (const s of [...unit.statuses]) {
    const rules = statusDef(s.status);
    let hp = 0;
    let kills = false;

    switch (rules.tick) {
      case 'poison': {
        hp = -fraction(ctx.maxHp, TICK_FRACTIONS.poison) * ticks;
        break;
      }
      case 'regen': {
        const heal = fraction(ctx.maxHp, TICK_FRACTIONS.regen) * ticks;
        // Undead invert healing, exactly like a Cure spell.
        hp = undead ? -heal : heal;
        break;
      }
      case 'bleed': {
        hp = -fraction(ctx.maxHp, TICK_FRACTIONS.bleed) * (s.stacks ?? 1) * ticks;
        break;
      }
      case 'burn': {
        const base = fraction(ctx.maxHp, TICK_FRACTIONS.burn) * (s.stacks ?? 1) * ticks;
        hp = -(oiled ? base * 2 : base);
        break;
      }
      case 'doom': {
        if (s.remaining >= 0 && s.remaining - ticks <= 0) {
          kills = true;
          ko = true;
        }
        break;
      }
      case 'none':
      default:
        break;
    }

    hpDelta += hp;

    let didExpire = false;
    if (s.remaining >= 0) {
      s.remaining -= ticks;
      if (s.remaining <= 0) {
        didExpire = true;
        expired.push(s.status);
        removeStatus(unit, s.status);
      }
    }
    if (hp !== 0 || kills || didExpire) {
      effects.push({ status: s.status, hp, expired: didExpire, kills });
    }
  }

  if (ctx.hp + hpDelta <= 0) ko = true;
  return { hpDelta, expired, effects, ko };
}
