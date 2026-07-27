/**
 * EverTactics — reconciling the job table with the ability table.
 *
 * The jobs author and the abilities author worked in parallel and picked
 * different slugs for the same content: `Job.learnable` names `potion`,
 * `magic-break` and `charge-plus-3`, while `core/abilities` defines `use-potion`,
 * `magick-break` and `charge-3`. 218 of the 390 learnable entries did not resolve.
 * Beyond that, the twelve EQ2/WoW jobs name per-job abilities (`harm-touch`,
 * `seal-of-righteousness`) that the abilities author instead grouped into shared
 * thematic sets (`threat-arts`, `auras`).
 *
 * Neither table is wrong; they are two independent inventions of the same design.
 * Rather than rewrite 218 entries inside files another agent owns, this module is
 * the single reconciliation point:
 *
 *  - `ALIASES` maps every job-table slug that has a genuine 1:1 counterpart.
 *  - `ACTION_SET_OVERRIDES` fixes the ten jobs whose `actionSet` resolves to an
 *    empty set (`dread-arts`, `sacraments`, `anthems`, …).
 *  - `jobSkillset(job)` returns the job's real, complete learnable list: aliased
 *    entries first, then every remaining ability in the job's action set and its
 *    passive slots, priced from the ability's own cost profile.
 *
 * Result: every job has a non-empty, fully resolvable skillset and no menu row
 * ever points at a missing ability.
 */

import {
  MOVEMENT_SET,
  REACTION_SET,
  SUPPORT_SET,
  abilitiesInSet,
  getAbility,
} from '@core/abilities';
import type { Ability, AbilityId, AbilitySetId, Job, JobId } from '@core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Slug aliases — job-table id → ability-table id
// ─────────────────────────────────────────────────────────────────────────────

export const ALIASES: Readonly<Record<string, AbilityId>> = {
  // Squire
  heal: 'heal-wounds',

  // Chemist — the Item skillset is named after the verb, not the object.
  potion: 'use-potion',
  'hi-potion': 'use-hi-potion',
  'x-potion': 'use-x-potion',
  ether: 'use-ether',
  'hi-ether': 'use-hi-ether',
  elixir: 'use-elixir',
  antidote: 'use-antidote',
  'eye-drop': 'use-eye-drops',
  'echo-herbs': 'use-echo-herbs',
  'maidens-kiss': 'use-maiden-kiss',
  soft: 'use-soft',
  'holy-water': 'use-holy-water',
  remedy: 'use-remedy',
  'phoenix-down': 'use-phoenix-down',

  // Knight
  'magic-break': 'magick-break',
  parry: 'riposte',

  // Archer — Charge tiers.
  'charge-plus-1': 'charge-1',
  'charge-plus-2': 'charge-2',
  'charge-plus-3': 'charge-3',
  'charge-plus-4': 'charge-4',
  'charge-plus-5': 'charge-5',
  'charge-plus-7': 'charge-7',
  'charge-plus-10': 'charge-10',
  'charge-plus-20': 'charge-20',
  'equip-crossbow': 'equip-bow',

  // Monk
  'stigma-magic': 'stigma-magick',

  // Thief
  'steal-helm': 'steal-helmet',
  'sticky-fingers': 'treasure-hunter',

  // White Mage
  'magic-defend-up': 'magick-defense-up',
  protectja: 'wall',

  // Black Mage
  frog: 'toad',
  'magic-attack-up': 'magick-attack-up',

  // Time Mage
  disable: 'immobilize',
  'demi-2': 'demiga',
  'half-of-mp': 'half-mp',

  // Summoner
  'half-of-mp-summon': 'half-mp',

  // Mystic
  'dispel-magic': 'dispel-magick',
  'absorb-used-mp': 'absorb-mp',

  // Geomancer
  'blizzard-terrain': 'blizzard-geo',
  'counter-flood': 'counter-magick',
  'move-on-lava': 'walk-on-lava',

  // Dragoon
  'level-jump-2': 'level-jump-3',
  'level-jump-4': 'level-jump-5',
  'vertical-jump-2': 'vertical-jump-4',
  'vertical-jump-5': 'high-jump',
  'vertical-jump-8': 'dragon-dive',

  // Orator
  'monster-talk': 'invitation',
  train: 'persuade',

  // Samurai
  'weapon-guard': 'reflexes',
  doublehand: 'two-hands',

  // Ninja
  'dual-wield': 'two-swords',
  vanish: 'sunken-state',
  'throw-ball': 'throw-bomb',
  'throw-stick': 'throw-knife',
  'throw-spear': 'throw-sword',
  'throw-ninja-blade': 'throw-katana',
  'throw-hammer': 'throw-axe',

  // Arithmetician
  'multiple-of-3': 'math-level-3',
  'multiple-of-4': 'math-exp-4',
  'multiple-of-5': 'math-ct-5',
  'prime-number': 'math-ct-prime',
  'calculate-ct': 'math-ct-prime',
  'calculate-level': 'math-level-prime',
  'calculate-exp': 'math-exp-5',
  'calculate-height': 'math-height-3',

  // Bard
  'magic-song': 'magick-song',

  // Dark Knight
  'unholy-darkness': 'abyssal-blade',
  'unholy-sacrifice': 'duskblade',
  'crush-helm': 'hellcry-punch',
  'crush-armor': 'shellburst-stab',
  'crush-weapon': 'blastar-punch',
  'crush-accessory': 'crush-punch',

  // ── EQ2 / WoW lineage ────────────────────────────────────────────────────
  'harm-touch': 'death-coil',
  'siphon-strike': 'sanguine-sword',
  'grasp-of-night': 'shadowstep',
  'shroud-of-armor': 'bulwark',
  'death-march': 'sentinel-roar',
  reaver: 'provoking-wound',
  'sanguine-covenant': 'night-sword',

  'ward-of-salvation': 'ancestral-ward',
  sanctuary: 'umbral-barrier',
  'shield-of-faith': 'bolster',
  'resurrection-rite': 'transcendence',
  'divine-arbitration': 'spirit-tap',

  mesmerise: 'mesmerize',
  charm: 'dominate',
  'shatter-will': 'terrorize',
  'peaceful-link': 'breeze',
  'mind-blight': 'mind-blank',
  'cannibalise-thoughts': 'mana-flow',
  'simple-minds': 'mass-mesmerize',
  puppetmaster: 'spellbind',

  'warder-rush': 'summon-warder',
  'feral-bite': 'savage-mauling',
  'sic-warder': 'harrying-strike',
  'bond-of-blood': 'beastly-bond',
  'rending-maul': 'pack-tactics',
  'feralic-rage': 'enrage-warder',
  'warders-guard': 'mend-companion',
  'call-of-the-wild': 'call-back',

  'icy-touch': 'frost-strike',
  'plague-strike': 'unholy-blight',
  'chains-of-ice': 'howling-blast',
  'raise-ghoul': 'raise-thrall',
  'death-and-decay': 'marked-for-death',
  obliterate: 'blood-strike',
  'anti-magic-shell': 'rune-tap',

  immolate: 'immolation',
  'curse-of-agony': 'agony',
  'drain-soul': 'drain-life',
  'shadow-bolt': 'corruption',
  'curse-of-tongues': 'shadow-plague',
  shadowburn: 'unstable-affliction',
  'howl-of-terror': 'curse-of-doom',

  'dire-bear-form': 'defensive-stance',
  'feral-cat-form': 'berserker-stance',
  mangle: 'reckless-stance',
  swipe: 'warlord-cry',
  shred: 'unbreakable',
  'natures-swiftness': 'tactical-stance',

  'seal-of-righteousness': 'devotion-aura',
  'seal-of-justice': 'retribution-aura',
  judgement: 'crusader-aura',
  'holy-strike': 'sanctity-aura',
  'lay-on-hands': 'aura-mastery',
  consecration: 'concentration-aura',

  stealth: 'shadowstep',
  ambush: 'cheap-shot',
  backstab: 'sinister-strike',
  'kidney-shot': 'kidney-strike',
  'vanish-rogue': 'garrote',
  'expose-armour': 'hemorrhage',
  'slice-and-dice': 'rupture',

  'healing-stream-totem': 'mana-tide-totem',
  'tremor-totem': 'earthbind-totem',
  'ancestral-spirit': 'cleansing-totem',
  bloodlust: 'windfury-totem',
};

/**
 * Jobs whose declared `actionSet` resolves to no abilities at all. The names in
 * the job table (`dread-arts`, `sacraments`, `anthems`, `wild-shape`, …) have no
 * counterpart in the ability table; these are the closest real sets, chosen so no
 * two jobs in the same lineage share one where it can be avoided.
 */
export const ACTION_SET_OVERRIDES: Readonly<Record<JobId, AbilitySetId>> = {
  'onion-knight': 'basic-skill',
  shadowknight: 'threat-arts',
  templar: 'ward-craft',
  coercer: 'enthrall',
  beastlord: 'beast-command',
  troubador: 'sing',
  dirge: 'dance',
  druid: 'stances',
  paladin: 'auras',
  rogue: 'snatch',
};

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Look an ability up by its job-table id, following the alias table. */
export function resolveAbility(id: AbilityId): Ability | undefined {
  const direct = getAbility(id);
  if (direct) return direct;
  const alias = ALIASES[id];
  return alias === undefined ? undefined : getAbility(alias);
}

/** Canonical ability id for a job-table slug, or `undefined` if it has none. */
export function canonicalAbilityId(id: AbilityId): AbilityId | undefined {
  return resolveAbility(id)?.id;
}

/** The action set a job's command menu should show. */
export function actionSetOf(job: Job): AbilitySetId {
  const override = ACTION_SET_OVERRIDES[job.id];
  if (override !== undefined) return override;
  return abilitiesInSet(job.actionSet).length > 0 ? job.actionSet : 'basic-skill';
}

export interface JobSkill {
  ability: Ability;
  jp: number;
}

/**
 * Price an ability that the job table never listed. Anchored on the black-magick
 * spine the abilities author balanced everything against: Fire (6 MP, 4 CT,
 * power 14) lands near 200 JP, Firaja (48 MP, 11 CT, power 44) near 900.
 */
function priceOf(ability: Ability): number {
  const raw = 90 + ability.mp * 6 + ability.power * 3 + ability.ct * 14 + ability.range.radius * 40;
  return Math.min(900, Math.max(100, Math.round(raw / 50) * 50));
}

const skillsetCache = new Map<JobId, readonly JobSkill[]>();

/**
 * The job's complete learnable list, with every entry guaranteed to resolve.
 *
 * Order is: the job table's own entries (aliased where needed), then anything in
 * the job's action set it missed, then the passive slots it declares. Duplicates
 * are collapsed on the *canonical* id, so `half-of-mp` and `half-mp` are one row.
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
    const ability = resolveAbility(entry.ability);
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
