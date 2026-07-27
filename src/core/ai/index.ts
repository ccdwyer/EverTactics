/**
 * EverTactics — enemy decision making.
 *
 * `decideTurn(state, unitId)` returns the ordered `Command[]` an AI unit should
 * issue for its turn. The battle reducer applies them exactly as if a player had
 * pressed the buttons, so the AI is never allowed to cheat: everything it does
 * is expressible through the same command surface the UI uses.
 *
 * Ordering matters. FFT's two-action economy allows move→act *or* act→move, and
 * the second one is how a unit strikes and steps back out of reach. The
 * evaluator prices both and this module just transcribes the winner.
 *
 * Pure: no three.js, no Math.random. Any randomness comes from an injected `Rng`.
 */

import type {
  Ability,
  AbilityId,
  BattleState,
  Command,
  Facing,
  Item,
  ItemId,
  Job,
  JobId,
  Rng,
  Unit,
  UnitId,
} from '../types';
import {
  DEFAULT_PERSONALITY,
  PERSONALITIES,
  battleCaution,
  effectiveWeights,
  inSurvivalMode,
  inferPersonality,
  resolvePersonality,
  type Personality,
  type PersonalityId,
  type ScoreTerm,
} from './personalities';
import {
  BASIC_ATTACK,
  bestDefensiveFacing,
  buildContext,
  createAiWorld,
  enumerateCandidates,
  hasStatus,
  isActive,
  isHostileTo,
  manhattan,
  type AiBudget,
  type AiContext,
  type AiWorld,
  type Candidate,
} from './evaluate';

export * from './personalities';
export * from './evaluate';

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface AiOptions {
  /**
   * Authoritative implementations of pathfinding / combat / ability lookup.
   * When omitted, a self-contained default world is built from the tables below.
   */
  world?: AiWorld;
  abilities?: ReadonlyMap<AbilityId, Ability>;
  items?: ReadonlyMap<ItemId, Item>;
  jobs?: ReadonlyMap<JobId, Job>;

  /** Archetype for this specific unit; wins over `personalities`. */
  personality?: PersonalityId | Personality;
  /** Per-unit archetype assignments, usually supplied by the scenario. */
  personalities?: ReadonlyMap<UnitId, PersonalityId | Personality>;
  /** Units that a guardian archetype is assigned to protect. */
  guardTargets?: ReadonlyMap<UnitId, UnitId>;

  budget?: AiBudget;

  /**
   * Optional seeded RNG. When present the AI adds a small amount of noise to
   * near-equal candidates so repeated battles do not play out identically.
   * Determinism is preserved: same seed, same choices.
   */
  rng?: Rng;
  /** Fraction of the best score used as the jitter band. Default 0.03. */
  jitter?: number;
}

export interface AiPlan {
  unit: UnitId;
  personality: PersonalityId;
  /** The winning candidate, with its full score breakdown. */
  candidate: Candidate;
  commands: Command[];
  /** How many candidates were priced. */
  considered: number;
  /** Ranked runners-up, for debugging the AI in the UI. */
  alternatives: Candidate[];
  terms: Record<ScoreTerm, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

/** The command sequence an AI unit should issue for its turn. */
export function decideTurn(state: BattleState, unitId: UnitId, opts: AiOptions = {}): Command[] {
  const plan = planTurn(state, unitId, opts);
  return plan === undefined ? [] : plan.commands;
}

/** Same as `decideTurn` but returns the reasoning as well. */
export function planTurn(
  state: BattleState,
  unitId: UnitId,
  opts: AiOptions = {},
): AiPlan | undefined {
  const actor = state.units.get(unitId);
  if (actor === undefined) return undefined;

  // A unit that cannot act issues nothing; the reducer ends its turn.
  if (!isActive(actor) || isDisabled(actor)) {
    return {
      unit: unitId,
      personality: DEFAULT_PERSONALITY,
      candidate: standStill(actor),
      commands: [{ kind: 'wait', unit: unitId }],
      considered: 0,
      alternatives: [],
      terms: standStill(actor).terms,
    };
  }

  const world = opts.world ?? createAiWorld({
    ...(opts.abilities !== undefined ? { abilities: opts.abilities } : {}),
    ...(opts.items !== undefined ? { items: opts.items } : {}),
    ...(opts.jobs !== undefined ? { jobs: opts.jobs } : {}),
  });

  const personality = pickPersonality(actor, opts);
  const survival = inSurvivalMode(personality, actor);
  const weights = effectiveWeights(personality, actor, battleCaution(state.tick));

  const guardTarget = resolveGuardTarget(state, actor, personality, opts);

  const ctx = buildContext(state, actor, {
    world,
    personality,
    weights,
    survival,
    ...(guardTarget !== undefined ? { guardTarget } : {}),
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
  });

  const all = enumerateCandidates(ctx);
  const legal = applyCompulsions(ctx, all);
  const chosen = select(legal.length > 0 ? legal : all, opts);
  const best = chosen ?? standStill(actor);

  return {
    unit: unitId,
    personality: personality.id,
    candidate: best,
    commands: toCommands(ctx, best),
    considered: all.length,
    alternatives: (legal.length > 0 ? legal : all).slice(1, 6),
    terms: best.terms,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

function select(candidates: readonly Candidate[], opts: AiOptions): Candidate | undefined {
  const first = candidates[0];
  if (first === undefined) return undefined;
  const rng = opts.rng;
  if (rng === undefined) return first;

  // Jitter only inside a narrow band around the best score, so the AI still
  // always takes an obvious kill; it just stops being metronomic about ties.
  const band = Math.abs(first.score) * (opts.jitter ?? 0.03) + 1;
  let bestCandidate = first;
  let bestValue = -Infinity;
  for (const candidate of candidates) {
    if (first.score - candidate.score > band) break;
    const value = candidate.score + (rng.next() - 0.5) * band;
    if (value > bestValue) {
      bestValue = value;
      bestCandidate = candidate;
    }
  }
  return bestCandidate;
}

/**
 * Status-driven compulsions. Taunt forces us onto the taunter; Berserk forces a
 * plain attack on the nearest body. Both fall back to the unrestricted list when
 * the compulsion cannot be satisfied at all (e.g. the taunter is unreachable),
 * because a unit frozen by an impossible compulsion just looks broken.
 */
function applyCompulsions(ctx: AiContext, candidates: readonly Candidate[]): Candidate[] {
  const actor = ctx.actor;
  let filtered: readonly Candidate[] = candidates;

  if (ctx.taunter !== undefined) {
    const taunter = ctx.taunter;
    const attacks = filtered.filter((c) => c.ability !== undefined && c.targetUnit === taunter.id);
    if (attacks.length > 0) {
      filtered = attacks;
    } else {
      // Cannot reach the taunter: close on it instead of acting elsewhere.
      const approaches = filtered.filter((c) => c.ability === undefined);
      if (approaches.length > 0) {
        filtered = [...approaches].sort(
          (a, b) => manhattan(a.pos, taunter.pos) - manhattan(b.pos, taunter.pos),
        );
      }
    }
  }

  const berserkStatus = hasStatus(actor, 'berserk');
  if (berserkStatus || ctx.personality.chargesNearest) {
    let nearest: Unit | undefined;
    let bestDistance = Infinity;
    for (const hostile of ctx.hostiles) {
      const d = manhattan(actor.pos, hostile.pos);
      if (d < bestDistance) {
        bestDistance = d;
        nearest = hostile;
      }
    }
    if (nearest !== undefined) {
      const target = nearest;
      // The *status* also strips access to everything but the plain attack;
      // the personality merely fixates on the nearest body.
      const attacks = filtered.filter(
        (c) =>
          c.targetUnit === target.id &&
          c.ability !== undefined &&
          (!berserkStatus || c.ability.id === BASIC_ATTACK.id),
      );
      if (attacks.length > 0) {
        filtered = attacks;
      } else {
        const approaches = filtered.filter((c) => c.ability === undefined);
        if (approaches.length > 0) {
          filtered = [...approaches].sort(
            (a, b) => manhattan(a.pos, target.pos) - manhattan(b.pos, target.pos),
          );
        }
      }
    }
  }

  return [...filtered];
}

// ─────────────────────────────────────────────────────────────────────────────
// Command transcription
// ─────────────────────────────────────────────────────────────────────────────

function toCommands(ctx: AiContext, candidate: Candidate): Command[] {
  const unit = ctx.actor.id;
  const commands: Command[] = [];

  const move: Command | undefined =
    candidate.move !== undefined && candidate.move.path.length > 1
      ? { kind: 'move', unit, path: candidate.move.path }
      : undefined;

  const act: Command | undefined =
    candidate.ability !== undefined && candidate.targetTile !== undefined
      ? {
          kind: 'act',
          unit,
          ability: candidate.ability.id,
          target: candidate.targetTile,
          ...(candidate.targetUnit !== undefined ? { targetUnit: candidate.targetUnit } : {}),
        }
      : undefined;

  if (candidate.actFrom !== undefined) {
    // Strike, then step away.
    if (act !== undefined) commands.push(act);
    if (move !== undefined) commands.push(move);
  } else {
    if (move !== undefined) commands.push(move);
    if (act !== undefined) commands.push(act);
  }

  // End of turn facing is a free choice in FFT and it is worth real HP.
  const finalFacing: Facing = bestDefensiveFacing(ctx, candidate.pos);
  if (finalFacing !== ctx.actor.facing || move !== undefined || act !== undefined) {
    commands.push({ kind: 'face', unit, facing: finalFacing });
  }

  if (act === undefined && shouldDefend(ctx)) commands.push({ kind: 'defend', unit });
  commands.push({ kind: 'wait', unit });
  return commands;
}

/** With no action worth taking, a cautious unit braces instead of idling. */
function shouldDefend(ctx: AiContext): boolean {
  const archetype = ctx.personality.id;
  if (archetype !== 'defensive' && archetype !== 'coward' && archetype !== 'support') return false;
  for (const source of ctx.threat.sources) {
    if (source.damage > 0 && manhattan(ctx.actor.pos, source.unit.pos) <= source.reach + 1) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function pickPersonality(actor: Unit, opts: AiOptions): Personality {
  const fallbackId = inferPersonality(actor);
  const fallback = PERSONALITIES[fallbackId];
  const explicit = opts.personality ?? opts.personalities?.get(actor.id);
  return resolvePersonality(explicit, fallback);
}

function resolveGuardTarget(
  state: BattleState,
  actor: Unit,
  personality: Personality,
  opts: AiOptions,
): UnitId | undefined {
  const assigned = opts.guardTargets?.get(actor.id);
  if (assigned !== undefined) return assigned;
  if (!personality.guards) return undefined;

  // No explicit assignment: guard the most fragile living ally in the squad.
  let best: Unit | undefined;
  let bestScore = -Infinity;
  for (const other of state.units.values()) {
    if (other.id === actor.id || !isActive(other) || isHostileTo(actor, other)) continue;
    if (other.team === 'neutral') continue;
    const score = other.stats.ma / Math.max(1, other.stats.maxHp);
    if (score > bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best?.id;
}

function isDisabled(unit: Unit): boolean {
  return (
    hasStatus(unit, 'stop') ||
    hasStatus(unit, 'sleep') ||
    hasStatus(unit, 'petrify') ||
    hasStatus(unit, 'crystal') ||
    hasStatus(unit, 'charging') ||
    hasStatus(unit, 'performing')
  );
}

function standStill(actor: Unit): Candidate {
  const terms = {} as Record<ScoreTerm, number>;
  for (const key of Object.keys(ZERO) as ScoreTerm[]) terms[key] = 0;
  return {
    pos: { ...actor.pos },
    facing: actor.facing,
    actableFromOrigin: false,
    score: 0,
    terms,
    prediction: 1,
  };
}

const ZERO: Record<ScoreTerm, number> = {
  damage: 0, kill: 0, mpDrain: 0, statusInflict: 0, overkill: 0,
  heal: 0, revive: 0, statusCure: 0,
  friendlyFire: 0, friendlyStatus: 0, mpCost: 0, wasteRisk: 0,
  height: 0, facingSafety: 0, flankRisk: 0, threatExposure: 0, clusterRisk: 0,
  chokepoint: 0, guardAlly: 0, closeDistance: 0, keepDistance: 0,
  lowHpTarget: 0, squishyTarget: 0, taunt: 0,
  terrainHazard: 0, selfRisk: 0, idle: 0,
};
