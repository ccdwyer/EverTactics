/**
 * EverTactics — job ⇄ ability reconciliation.
 *
 * The job table and the ability table were authored in parallel and drifted:
 * `Job.learnable` named `potion`, `magic-break` and `charge-plus-3` while
 * `core/abilities` defined `use-potion`, `magick-break` and `charge-3`, and ten
 * jobs pointed `actionSet` at a set name the ability table had never heard of.
 * This module used to hold a 200-entry alias table and a set-override map to
 * bridge that gap at runtime.
 *
 * Both tables are now reconciled at the source (see docs/JOBS.md § Canonical set
 * names), so the bridge is gone: `Job.actionSet` and every `Job.learnable` entry
 * resolve directly. What is left is the small amount of genuine derivation the UI
 * needs — the menu a job shows, and the priced skill list behind it.
 */

import {
  MOVEMENT_SET,
  REACTION_SET,
  SUPPORT_SET,
  abilitiesInSet,
  getAbility,
} from '@core/abilities';
import type { Ability, AbilityId, AbilitySetId, Job, JobId } from '@core/types';

/** Look an ability up by the id a job table uses. */
export function resolveAbility(id: AbilityId): Ability | undefined {
  return getAbility(id);
}

/** Canonical ability id, or `undefined` when nothing answers to it. */
export function canonicalAbilityId(id: AbilityId): AbilityId | undefined {
  return getAbility(id)?.id;
}

/**
 * The action set a job's command menu should show.
 *
 * `Job.actionSet` is authoritative and every job's now resolves; the fallback to
 * Basic Skill exists so a hand-authored scenario unit with a typo still renders a
 * usable menu instead of an empty one.
 */
export function actionSetOf(job: Job): AbilitySetId {
  return abilitiesInSet(job.actionSet).length > 0 ? job.actionSet : 'basic-skill';
}

export interface JobSkill {
  ability: Ability;
  jp: number;
}

/**
 * Price an ability the job table did not itself list. Anchored on the black-magick
 * spine the ability table is balanced against: Fire (6 MP, 4 CT, power 14) lands
 * near 200 JP, Firaja (48 MP, 11 CT, power 44) near 900.
 */
function priceOf(ability: Ability): number {
  const raw = 90 + ability.mp * 6 + ability.power * 3 + ability.ct * 14 + ability.range.radius * 40;
  return Math.min(900, Math.max(100, Math.round(raw / 50) * 50));
}

const skillsetCache = new Map<JobId, readonly JobSkill[]>();

/**
 * The job's complete learnable list.
 *
 * Order is the job table's own entries at their authored JP cost, then anything
 * else in the job's action set — a job always has access to its whole command,
 * even where the designer priced only part of it.
 */
export function jobSkillset(job: Job): readonly JobSkill[] {
  const cached = skillsetCache.get(job.id);
  if (cached) return cached;

  const out: JobSkill[] = [];
  const seen = new Set<AbilityId>();

  const push = (ability: Ability, jp: number): void => {
    if (seen.has(ability.id)) return;
    seen.add(ability.id);
    out.push({ ability, jp });
  };

  for (const entry of job.learnable) {
    const ability = getAbility(entry.ability);
    if (ability) push(ability, entry.jp);
  }
  for (const ability of abilitiesInSet(actionSetOf(job))) {
    push(ability, priceOf(ability));
  }

  skillsetCache.set(job.id, out);
  return out;
}

/** Action abilities only — what the command submenu lists. */
export function jobActions(job: Job): readonly JobSkill[] {
  return jobSkillset(job).filter((s) => s.ability.slot === 'action');
}

/** Every passive the game offers for a slot, for the job screen's slot pickers. */
export function passivesForSlot(slot: 'reaction' | 'support' | 'movement'): readonly Ability[] {
  const setId = slot === 'reaction' ? REACTION_SET : slot === 'support' ? SUPPORT_SET : MOVEMENT_SET;
  return abilitiesInSet(setId);
}
