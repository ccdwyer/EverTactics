/**
 * EverTactics — action ability sets.
 *
 * Every job's primary command menu lives here. Sets are keyed by `AbilitySetId`;
 * `jobs/` is expected to reference these ids from `Job.actionSet`. Because the jobs
 * table is authored independently, `SET_ALIASES` maps the plausible alternative
 * spellings (white-magic / white-magick, iaido / draw-out, chakra / punch-art …)
 * onto the canonical id, and `resolveSetId()` should be used by any consumer that
 * takes a set id from outside this module.
 *
 * Pure data: no three.js, no Math.random, no side effects.
 */

import type {
  Ability,
  AbilityId,
  AbilityRange,
  AbilitySetId,
  AbilitySlot,
  AnimName,
  Element,
  FormulaId,
  JobId,
  StatusId,
  StatusInfliction,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Authoring helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A terse authoring shape; `defineAbilities` fills in the boring defaults. */
export interface AbilitySpec {
  id: AbilityId;
  name: string;
  description: string;
  mp?: number;
  ct?: number;
  element?: Element;
  range?: AbilityRange;
  formula?: FormulaId;
  power?: number;
  accuracy?: number;
  inflicts?: readonly StatusInfliction[];
  cures?: readonly StatusId[];
  targetsTiles?: boolean;
  vfx: string;
  sfx?: string;
  castAnim?: AnimName;
}

/** Range constructor. Vertical tolerance defaults to 3 half-tiles, LOS on. */
export function R(range: number, radius = 0, opts: Partial<AbilityRange> = {}): AbilityRange {
  return { range, radius, vertical: 3, los: true, ...opts };
}

/** Adjacent tile, the default for weapon-flavoured skills. */
export const MELEE: AbilityRange = R(1, 0, { vertical: 2 });
/** Caster's own tile. */
export const SELF: AbilityRange = { range: 0, radius: 0, vertical: 0, los: false, self: true };
/** Self-centred burst — auras, songs, war cries. */
export function AURA(radius: number, vertical = 4): AbilityRange {
  return { range: 0, radius, vertical, los: false, self: true };
}
/** Whole-field effect (songs, dances, math skill). */
export const FIELD: AbilityRange = { range: 99, radius: 99, vertical: Infinity, los: false };

/** Status infliction shorthand. `duration` is in CT ticks; omit for permanent. */
export function inf(status: StatusId, chance: number, duration?: number): StatusInfliction {
  return duration === undefined ? { status, chance } : { status, chance, duration };
}

/** Standard status duration bands, in CT ticks. */
export const SHORT = 24;
export const MEDIUM = 36;
export const LONG = 48;
export const VERY_LONG = 64;

export function defineAbilities(
  set: AbilitySetId,
  slot: AbilitySlot,
  specs: readonly AbilitySpec[],
): Ability[] {
  return specs.map((s) => ({
    id: s.id,
    name: s.name,
    set,
    slot,
    description: s.description,
    mp: s.mp ?? 0,
    ct: s.ct ?? 0,
    element: s.element ?? 'none',
    range: s.range ?? MELEE,
    formula: s.formula ?? 'physical',
    power: s.power ?? 1,
    accuracy: s.accuracy ?? 100,
    inflicts: s.inflicts,
    cures: s.cures,
    targetsTiles: s.targetsTiles,
    vfx: s.vfx,
    sfx: s.sfx,
    castAnim: s.castAnim,
  }));
}

/** Convenience: an action set. */
function actions(set: AbilitySetId, specs: readonly AbilitySpec[]): Ability[] {
  return defineAbilities(set, 'action', specs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Set metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface AbilitySetMeta {
  readonly id: AbilitySetId;
  readonly name: string;
  /** Icon key for the command menu. */
  readonly icon: string;
  /** Sort position in the command menu / secondary-action picker. */
  readonly order: number;
  readonly origin: 'fft' | 'eq2' | 'wow' | 'original';
  readonly description: string;
  /** The job that teaches this set, by convention. Informational only. */
  readonly job?: JobId;
  /** Set cannot be taken as a secondary command (Mimicry, Math Skill …). */
  readonly primaryOnly?: boolean;
}

const SET_LIST: readonly AbilitySetMeta[] = [
  { id: 'basic-skill', name: 'Basic Skill', icon: 'cmd/basic', order: 10, origin: 'fft', job: 'squire',
    description: 'The soldier\'s trade: shout, shove, and make do with a stone and a steady hand.' },
  { id: 'item', name: 'Item', icon: 'cmd/item', order: 20, origin: 'fft', job: 'chemist',
    description: 'Field alchemy. Potions, tinctures and the phoenix down that keeps a company alive.' },
  { id: 'battle-skill', name: 'Battle Skill', icon: 'cmd/break', order: 30, origin: 'fft', job: 'knight',
    description: 'Precision strikes that ruin gear and stats rather than merely spending life.' },
  { id: 'charge', name: 'Charge', icon: 'cmd/charge', order: 40, origin: 'fft', job: 'archer',
    description: 'Hold the draw. The longer the string sings, the harder the arrow lands.' },
  { id: 'punch-art', name: 'Punch Art', icon: 'cmd/fist', order: 50, origin: 'fft', job: 'monk',
    description: 'Chakra-driven martial forms — strike at range, mend by touch, wake the fallen.' },
  { id: 'white-magick', name: 'White Magick', icon: 'cmd/white', order: 60, origin: 'fft', job: 'white-mage',
    description: 'The restorative art. Faith made into mended bone and turned-aside harm.' },
  { id: 'black-magick', name: 'Black Magick', icon: 'cmd/black', order: 70, origin: 'fft', job: 'black-mage',
    description: 'Elemental ruin drawn straight out of the aether and dropped on a chosen tile.' },
  { id: 'time-magick', name: 'Time Magick', icon: 'cmd/time', order: 80, origin: 'fft', job: 'time-mage',
    description: 'Bend the order of the clock — hasten allies, mire foes, borrow gravity itself.' },
  { id: 'summon-magick', name: 'Summon Magick', icon: 'cmd/summon', order: 90, origin: 'fft', job: 'summoner',
    description: 'Call the Espers. Vast, slow, and indifferent to who stands where.' },
  { id: 'steal', name: 'Steal', icon: 'cmd/steal', order: 100, origin: 'fft', job: 'thief',
    description: 'Quick fingers. Take the coin, the blade, or the will to fight.' },
  { id: 'snatch', name: 'Snatch', icon: 'cmd/snatch', order: 110, origin: 'fft', job: 'rogue',
    description: 'Thievery that also wounds — the refined trade of a working cutpurse.' },
  { id: 'talk-skill', name: 'Talk Skill', icon: 'cmd/talk', order: 120, origin: 'fft', job: 'orator',
    description: 'Words as weapons: recruit, cow, flatter and sentence without drawing steel.' },
  { id: 'yin-yang-magick', name: 'Yin-Yang Magick', icon: 'cmd/yinyang', order: 130, origin: 'fft', job: 'oracle',
    description: 'Old hedge-sorcery. Curses, blindings and the quiet theft of faith.' },
  { id: 'geomancy', name: 'Geomancy', icon: 'cmd/geo', order: 140, origin: 'fft', job: 'geomancer',
    description: 'Strike with the ground you stand on; every surface answers differently.' },
  { id: 'jump', name: 'Jump', icon: 'cmd/jump', order: 150, origin: 'fft', job: 'dragoon',
    description: 'Leave the field entirely, then arrive point-first from out of the sky.' },
  { id: 'draw-out', name: 'Draw Out', icon: 'cmd/iaido', order: 160, origin: 'fft', job: 'samurai',
    description: 'Unsheathe a katana and spend its spirit in a single stroke. The blade may break.' },
  { id: 'throw', name: 'Throw', icon: 'cmd/throw', order: 170, origin: 'fft', job: 'ninja',
    description: 'Anything can be thrown, and everything hits harder than it has any right to.' },
  { id: 'math-skill', name: 'Math Skill', icon: 'cmd/math', order: 180, origin: 'fft', job: 'arithmetician',
    primaryOnly: true,
    description: 'Cast without cost or delay upon every unit whose numbers satisfy the equation.' },
  { id: 'sing', name: 'Sing', icon: 'cmd/sing', order: 190, origin: 'fft', job: 'bard',
    description: 'Hold a note across the battlefield; it accrues on every ally who can hear it.' },
  { id: 'dance', name: 'Dance', icon: 'cmd/dance', order: 200, origin: 'fft', job: 'dancer',
    description: 'A slow figure that drains the enemy line a little more with every step.' },
  { id: 'dark-sword', name: 'Dark Sword', icon: 'cmd/dark', order: 210, origin: 'fft', job: 'dark-knight',
    description: 'Spend your own blood to cut with the grave. Cheap only if you win quickly.' },
  { id: 'holy-sword', name: 'Holy Sword', icon: 'cmd/holy', order: 220, origin: 'fft', job: 'holy-knight',
    description: 'Sword-auras loosed in a line — light that neither armour nor distance turns.' },
  { id: 'mighty-sword', name: 'Mighty Sword', icon: 'cmd/mighty', order: 230, origin: 'fft', job: 'divine-knight',
    description: 'Ranged sword-waves that shatter equipment outright rather than merely damaging it.' },
  { id: 'mimicry', name: 'Mimicry', icon: 'cmd/mime', order: 240, origin: 'fft', job: 'mime',
    primaryOnly: true,
    description: 'Repeat what your allies do, without gear, without cost, without hesitation.' },
  // ── EQ2 / WoW lineage ──────────────────────────────────────────────────────
  { id: 'threat-arts', name: 'Threat Arts', icon: 'cmd/threat', order: 300, origin: 'eq2', job: 'guardian',
    description: 'Make yourself the only target worth swinging at, then survive being right.' },
  { id: 'ward-craft', name: 'Ward Craft', icon: 'cmd/ward', order: 310, origin: 'eq2', job: 'mystic',
    description: 'Ancestral shielding that absorbs harm before it lands — prevention, not repair.' },
  { id: 'enthrall', name: 'Enthrall', icon: 'cmd/charm', order: 320, origin: 'eq2', job: 'coercer',
    description: 'Take an enemy\'s mind off the battle, or take it over entirely.' },
  { id: 'beast-command', name: 'Beast Command', icon: 'cmd/beast', order: 330, origin: 'eq2', job: 'beastlord',
    description: 'Orders for a bonded warder — and the strikes you two only land together.' },
  { id: 'affliction', name: 'Affliction', icon: 'cmd/dot', order: 340, origin: 'wow', job: 'warlock',
    description: 'Damage that lives inside the enemy and keeps working after your turn ends.' },
  { id: 'subterfuge', name: 'Subterfuge', icon: 'cmd/combo', order: 350, origin: 'wow', job: 'assassin',
    description: 'Build the opening with fast strikes, then spend it all in one finisher.' },
  { id: 'stances', name: 'Stances', icon: 'cmd/stance', order: 360, origin: 'wow', job: 'berserker',
    description: 'Postures that trade one virtue for another. Only one may be held at a time.' },
  { id: 'totemcraft', name: 'Totemcraft', icon: 'cmd/totem', order: 370, origin: 'wow', job: 'shaman',
    description: 'Plant a spirit-totem on a tile; it works on its own until something breaks it.' },
  { id: 'auras', name: 'Auras', icon: 'cmd/aura', order: 380, origin: 'wow', job: 'paladin',
    description: 'A standing field of consecration centred on you. One aura, always burning.' },
  { id: 'runic-strike', name: 'Runic Strike', icon: 'cmd/rune', order: 390, origin: 'wow', job: 'death-knight',
    description: 'Blood, frost and unholy runes spent through the weapon and out the other side.' },
];

export const ABILITY_SETS: ReadonlyMap<AbilitySetId, AbilitySetMeta> = new Map(
  SET_LIST.map((s) => [s.id, s]),
);

/** Sets in menu order. */
export const ABILITY_SET_ORDER: readonly AbilitySetId[] = SET_LIST.slice()
  .sort((a, b) => a.order - b.order)
  .map((s) => s.id);

/**
 * Alternative spellings a job table might plausibly use, mapped to the canonical id.
 * Consumers should call `resolveSetId` rather than indexing `ABILITY_SETS` directly.
 */
export const SET_ALIASES: Readonly<Record<string, AbilitySetId>> = {
  'basic-skills': 'basic-skill',
  'squire-skill': 'basic-skill',
  'items': 'item',
  'chemistry': 'item',
  'battle-skills': 'battle-skill',
  'break': 'battle-skill',
  'arts-of-war': 'battle-skill',
  'aim': 'charge',
  'charge-shot': 'charge',
  'chakra': 'punch-art',
  'punch-arts': 'punch-art',
  'martial-arts-command': 'punch-art',
  'white-magic': 'white-magick',
  'white-magicks': 'white-magick',
  'black-magic': 'black-magick',
  'black-magicks': 'black-magick',
  'time-magic': 'time-magick',
  'time-magicks': 'time-magick',
  'summon-magic': 'summon-magick',
  'summon': 'summon-magick',
  'summoning': 'summon-magick',
  'steal-skill': 'steal',
  'thievery': 'steal',
  'talk': 'talk-skill',
  'speechcraft': 'talk-skill',
  'yin-yang-magic': 'yin-yang-magick',
  'yin-yang': 'yin-yang-magick',
  'mystic-arts': 'yin-yang-magick',
  'geomancy-skill': 'geomancy',
  'elemental': 'geomancy',
  'jump-skill': 'jump',
  'lancet': 'jump',
  'iaido': 'draw-out',
  'draw-out-skill': 'draw-out',
  'throw-skill': 'throw',
  'ninjutsu': 'throw',
  'math': 'math-skill',
  'arithmeticks': 'math-skill',
  'song': 'sing',
  'bardsong': 'sing',
  'dance-skill': 'dance',
  'darkness': 'dark-sword',
  'dark-arts': 'dark-sword',
  'holy-swordplay': 'holy-sword',
  'sword-spirit': 'holy-sword',
  'mighty-swordplay': 'mighty-sword',
  'mimic': 'mimicry',
  'threat': 'threat-arts',
  'taunt-arts': 'threat-arts',
  'defiance': 'threat-arts',
  'wards': 'ward-craft',
  'warding': 'ward-craft',
  'charm-arts': 'enthrall',
  'mesmerism': 'enthrall',
  'pet-command': 'beast-command',
  'beastcraft': 'beast-command',
  'afflictions': 'affliction',
  'curses': 'affliction',
  'combo-arts': 'subterfuge',
  'shadow-arts': 'subterfuge',
  'stance': 'stances',
  'totems': 'totemcraft',
  'aura': 'auras',
  'runic-strikes': 'runic-strike',
  'runeblade': 'runic-strike',
};

/** Normalises an externally-supplied set id (case, spacing, known aliases). */
export function resolveSetId(raw: string): AbilitySetId | undefined {
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (ABILITY_SETS.has(key)) return key;
  const alias = SET_ALIASES[key];
  if (alias !== undefined) return alias;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Squire — Basic Skill
// ─────────────────────────────────────────────────────────────────────────────

const BASIC_SKILL = actions('basic-skill', [
  { id: 'accumulate', name: 'Focus', description: 'Gather your strength in silence. Raises Attack permanently for this battle.',
    range: SELF, formula: 'buff', power: 1, vfx: 'buff/focus', castAnim: 'charge',
    inflicts: [inf('empowered', 100, VERY_LONG)] },
  { id: 'dash', name: 'Dash', description: 'Shoulder-charge an adjacent foe, knocking them back a tile and off their feet.',
    formula: 'physical', power: 2, accuracy: 75, vfx: 'phys/shove', castAnim: 'attack' },
  { id: 'throw-stone', name: 'Throw Stone', description: 'A rock, thrown well. Cheap, long-ranged, and occasionally enough to end someone.',
    range: R(4), formula: 'fixed', power: 12, accuracy: 80, element: 'earth', vfx: 'phys/stone', castAnim: 'throw' },
  { id: 'heal-wounds', name: 'Tend', description: 'Bind an ally\'s wounds by hand. Clears bleeding, poison and blindness.',
    formula: 'status-only', power: 0, accuracy: 100, vfx: 'heal/tend', castAnim: 'item',
    cures: ['poison', 'blind', 'bleeding', 'sleep'] },
  { id: 'yell', name: 'Yell', description: 'A bellowed order. The target\'s next turn arrives noticeably sooner.',
    range: R(3), formula: 'buff', power: 20, vfx: 'buff/yell', castAnim: 'cast',
    inflicts: [inf('haste', 100, SHORT)] },
  { id: 'cheer-up', name: 'Steel', description: 'Steady an ally\'s nerve. Raises Bravery, and with it the odds their reaction triggers.',
    range: R(3), formula: 'buff', power: 10, vfx: 'buff/cheer', castAnim: 'cast' },
  { id: 'wish', name: 'Wish', description: 'Give up a quarter of your own life to restore far more of an ally\'s.',
    range: R(2), formula: 'special', power: 200, vfx: 'heal/wish', castAnim: 'cast' },
  { id: 'rally', name: 'Rally', description: 'A war cry that pulls every nearby ally another step out of exhaustion.',
    range: AURA(2), mp: 8, ct: 3, formula: 'heal', power: 8, vfx: 'buff/rally', castAnim: 'cast',
    cures: ['sleep', 'confuse'] },
  { id: 'shield-bash', name: 'Shield Bash', description: 'Drive the boss of your shield into a face. Crude, loud, and it stops a spell mid-word.',
    formula: 'physical', power: 2, accuracy: 70, vfx: 'phys/bash', castAnim: 'attack',
    inflicts: [inf('silence', 40, SHORT)] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Chemist — Item
// ─────────────────────────────────────────────────────────────────────────────

const ITEM = actions('item', [
  { id: 'use-potion', name: 'Potion', description: 'A measure of bitter green tincture. Restores 30 HP to one unit.',
    range: R(3, 0, { vertical: 3, los: false }), formula: 'heal', power: 30, vfx: 'item/potion', castAnim: 'item' },
  { id: 'use-hi-potion', name: 'Hi-Potion', description: 'Twice-distilled and three times the price. Restores 80 HP.',
    range: R(3, 0, { los: false }), formula: 'heal', power: 80, vfx: 'item/potion-hi', castAnim: 'item' },
  { id: 'use-x-potion', name: 'X-Potion', description: 'Battlefield surgery in a vial. Restores 180 HP to one unit.',
    range: R(3, 0, { los: false }), formula: 'heal', power: 180, vfx: 'item/potion-x', castAnim: 'item' },
  { id: 'use-ether', name: 'Ether', description: 'Restores 40 MP. Tastes of copper and old rain.',
    range: R(3, 0, { los: false }), formula: 'special', power: 40, vfx: 'item/ether', castAnim: 'item' },
  { id: 'use-hi-ether', name: 'Hi-Ether', description: 'Restores 100 MP. Reserved for those who intend to cast something enormous.',
    range: R(3, 0, { los: false }), formula: 'special', power: 100, vfx: 'item/ether-hi', castAnim: 'item' },
  { id: 'use-elixir', name: 'Elixir', description: 'Full HP and MP, every ailment gone. There are never enough of these.',
    range: R(3, 0, { los: false }), formula: 'special', power: 999, vfx: 'item/elixir', castAnim: 'item',
    cures: ['poison', 'blind', 'silence', 'frog', 'chicken', 'confuse', 'sleep', 'petrify', 'stop', 'slow', 'bleeding', 'burning', 'undead', 'berserk', 'charm'] },
  { id: 'use-antidote', name: 'Antidote', description: 'Neutralises venom. Also settles the stomach, which matters more than you would think.',
    range: R(3, 0, { los: false }), formula: 'status-only', vfx: 'item/antidote', castAnim: 'item',
    cures: ['poison'] },
  { id: 'use-eye-drops', name: 'Eye Drops', description: 'Washes grit, ash and blinding magick from the eyes.',
    range: R(3, 0, { los: false }), formula: 'status-only', vfx: 'item/drops', castAnim: 'item',
    cures: ['blind'] },
  { id: 'use-echo-herbs', name: 'Echo Herbs', description: 'Loosens a throat sealed by silence. Vile, but quick.',
    range: R(3, 0, { los: false }), formula: 'status-only', vfx: 'item/echo', castAnim: 'item',
    cures: ['silence'] },
  { id: 'use-maiden-kiss', name: 'Maiden\'s Kiss', description: 'Restores a frog to its proper shape, with all the dignity that implies.',
    range: R(3, 0, { los: false }), formula: 'status-only', vfx: 'item/kiss', castAnim: 'item',
    cures: ['frog', 'chicken'] },
  { id: 'use-soft', name: 'Soft', description: 'Powdered chalcedony. Returns petrified flesh to flesh before the crack sets in.',
    range: R(3, 0, { los: false }), formula: 'status-only', vfx: 'item/soft', castAnim: 'item',
    cures: ['petrify'] },
  { id: 'use-holy-water', name: 'Holy Water', description: 'Consecrated, and it burns going on. Lifts undeath and the grave-curse.',
    range: R(3, 0, { los: false }), formula: 'status-only', element: 'holy', vfx: 'item/holy-water', castAnim: 'item',
    cures: ['undead', 'death-sentence'] },
  { id: 'use-remedy', name: 'Remedy', description: 'The apothecary\'s catch-all. Clears nearly every common ailment at once.',
    range: R(3, 0, { los: false }), formula: 'status-only', vfx: 'item/remedy', castAnim: 'item',
    cures: ['poison', 'blind', 'silence', 'frog', 'chicken', 'confuse', 'sleep', 'petrify', 'bleeding'] },
  { id: 'use-phoenix-down', name: 'Phoenix Down', description: 'A single scarlet feather. Wakes the freshly fallen — and burns the undead where they stand.',
    range: R(3, 0, { los: false }), formula: 'raise', power: 25, accuracy: 100, element: 'holy',
    vfx: 'item/phoenix', castAnim: 'item', cures: ['ko'] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Knight — Battle Skill (breaks)
// ─────────────────────────────────────────────────────────────────────────────

const BATTLE_SKILL = actions('battle-skill', [
  { id: 'head-break', name: 'Head Break', description: 'Sheer the helm from a foe\'s skull. Destroys headgear and rattles the wearer.',
    formula: 'special', power: 0, accuracy: 65, vfx: 'break/head', castAnim: 'attack',
    inflicts: [inf('vulnerable', 50, SHORT)] },
  { id: 'armor-break', name: 'Armor Break', description: 'Split the breastplate at the seam. What is left will not stop the next blow.',
    formula: 'special', power: 0, accuracy: 60, vfx: 'break/armor', castAnim: 'attack',
    inflicts: [inf('vulnerable', 60, MEDIUM)] },
  { id: 'shield-break', name: 'Shield Break', description: 'Shatter the shield arm\'s guard, and every evasion that came with it.',
    formula: 'special', power: 0, accuracy: 70, vfx: 'break/shield', castAnim: 'attack' },
  { id: 'weapon-break', name: 'Weapon Break', description: 'Strike the blade, not the body. A disarmed knight is a very quiet knight.',
    formula: 'special', power: 0, accuracy: 55, vfx: 'break/weapon', castAnim: 'attack' },
  { id: 'magick-break', name: 'Magick Break', description: 'A blow to the diaphragm that drives the aether out. Empties the target\'s MP.',
    formula: 'special', power: 0, accuracy: 60, vfx: 'break/magick', castAnim: 'attack',
    inflicts: [inf('silence', 25, SHORT)] },
  { id: 'speed-break', name: 'Speed Break', description: 'Hamstring the leading leg. Permanently reduces the target\'s Speed.',
    formula: 'special', power: 0, accuracy: 65, vfx: 'break/speed', castAnim: 'attack',
    inflicts: [inf('slow', 45, LONG)] },
  { id: 'power-break', name: 'Power Break', description: 'Ruin the shoulder that carries the swing. Permanently reduces Attack.',
    formula: 'special', power: 0, accuracy: 65, vfx: 'break/power', castAnim: 'attack' },
  { id: 'mind-break', name: 'Mind Break', description: 'A flat-of-the-blade concussion. Permanently reduces Magick.',
    formula: 'special', power: 0, accuracy: 65, vfx: 'break/mind', castAnim: 'attack' },
  { id: 'stasis-sword', name: 'Stasis Sword', description: 'A ranged sword-wave that locks the target where they stand.',
    mp: 12, range: R(3, 0, { shape: 'line', vertical: 2 }), formula: 'physical', power: 3, accuracy: 75,
    vfx: 'sword/stasis', castAnim: 'attack', inflicts: [inf('stop', 30, SHORT)] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Archer — Charge
// ─────────────────────────────────────────────────────────────────────────────

function charge(n: number, ct: number, power: number, mp: number): AbilitySpec {
  return {
    id: `charge-${n}`,
    name: `Charge +${n}`,
    description: `Hold the draw for ${ct} ticks. The shot lands at +${n} weapon power — and everyone can see you doing it.`,
    mp,
    ct,
    range: R(0, 0, { self: true, los: false, vertical: 0 }),
    formula: 'physical',
    power,
    accuracy: 100,
    vfx: `charge/level-${n}`,
    castAnim: 'aim',
  };
}

const CHARGE = actions('charge', [
  charge(1, 2, 1, 0),
  charge(2, 3, 2, 0),
  charge(3, 4, 3, 2),
  charge(4, 5, 4, 4),
  charge(5, 6, 5, 6),
  charge(7, 8, 7, 10),
  charge(10, 11, 10, 16),
  charge(20, 20, 20, 30),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Monk — Punch Art
// ─────────────────────────────────────────────────────────────────────────────

const PUNCH_ART = actions('punch-art', [
  { id: 'spin-fist', name: 'Spin Fist', description: 'A turning strike that catches every adjacent tile at once, allies included.',
    range: AURA(1, 2), formula: 'physical', power: 2, accuracy: 100, vfx: 'fist/spin', castAnim: 'punch' },
  { id: 'repeating-fist', name: 'Repeating Fist', description: 'Strike again and again until your rhythm finally breaks. Bravery decides how long that takes.',
    formula: 'special', power: 2, accuracy: 100, vfx: 'fist/repeat', castAnim: 'punch' },
  { id: 'wave-fist', name: 'Wave Fist', description: 'Chi thrown from the knuckle in a compressed wave. Reaches three tiles.',
    range: R(3, 0, { shape: 'line' }), formula: 'physical', power: 3, accuracy: 100, vfx: 'fist/wave', castAnim: 'punch' },
  { id: 'earth-slash', name: 'Earth Slash', description: 'Crack the ground with an open palm; the fissure runs the length of the field.',
    range: R(8, 0, { shape: 'line', vertical: 6 }), element: 'earth', formula: 'physical', power: 3,
    accuracy: 75, vfx: 'fist/earth-slash', castAnim: 'punch' },
  { id: 'secret-fist', name: 'Secret Fist', description: 'A touch on a meridian point. The victim dies in thirty ticks and knows it.',
    formula: 'status-only', accuracy: 55, vfx: 'fist/secret', castAnim: 'punch',
    inflicts: [inf('death-sentence', 100, MEDIUM)] },
  { id: 'stigma-magick', name: 'Purification', description: 'Burn ailments out of an ally with raw chakra. Painful, thorough.',
    range: R(1, 1, { vertical: 3 }), formula: 'status-only', vfx: 'fist/purify', castAnim: 'cast',
    cures: ['poison', 'blind', 'silence', 'frog', 'chicken', 'confuse', 'petrify', 'undead', 'bleeding'] },
  { id: 'chakra', name: 'Chakra', description: 'Open your own centre and pour it outward, restoring HP and MP to everyone adjacent.',
    range: AURA(1, 3), formula: 'heal', power: 40, vfx: 'fist/chakra', castAnim: 'cast' },
  { id: 'revive', name: 'Revive', description: 'A precise blow to a stopped heart. It works far more often than it has any right to.',
    formula: 'raise', power: 50, accuracy: 70, vfx: 'fist/revive', castAnim: 'punch', cures: ['ko'] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// White Mage — White Magick
// ─────────────────────────────────────────────────────────────────────────────

const WHITE_MAGICK = actions('white-magick', [
  { id: 'cure', name: 'Cure', description: 'The first prayer any acolyte learns. Closes a wound with a word.',
    mp: 5, ct: 3, range: R(4, 1), formula: 'heal', power: 20, vfx: 'white/cure-1', castAnim: 'cast' },
  { id: 'cura', name: 'Cura', description: 'A fuller invocation. Knits bone as readily as skin.',
    mp: 12, ct: 4, range: R(4, 1), formula: 'heal', power: 32, vfx: 'white/cure-2', castAnim: 'cast' },
  { id: 'curaga', name: 'Curaga', description: 'Light falls in a column and everyone inside it stands up straighter.',
    mp: 22, ct: 6, range: R(4, 2), formula: 'heal', power: 46, vfx: 'white/cure-3', castAnim: 'cast' },
  { id: 'curaja', name: 'Curaja', description: 'The highest restorative rite. Turns a rout back into a battle line.',
    mp: 40, ct: 8, range: R(4, 2), formula: 'heal', power: 62, vfx: 'white/cure-4', castAnim: 'cast' },
  { id: 'raise', name: 'Raise', description: 'Call a soul back before the crystal takes it. Half the time it comes.',
    mp: 14, ct: 6, range: R(4), formula: 'raise', power: 30, accuracy: 60, element: 'holy',
    vfx: 'white/raise', castAnim: 'cast', cures: ['ko'] },
  { id: 'arise', name: 'Arise', description: 'The full rite of return: the fallen rise whole, not merely breathing.',
    mp: 30, ct: 9, range: R(4), formula: 'raise', power: 100, accuracy: 85, element: 'holy',
    vfx: 'white/arise', castAnim: 'cast', cures: ['ko'] },
  { id: 'reraise', name: 'Reraise', description: 'Set a soul to catch itself. If the target falls, they get up once, unaided.',
    mp: 20, ct: 6, range: R(3), formula: 'buff', element: 'holy', vfx: 'white/reraise', castAnim: 'cast',
    inflicts: [inf('reraise', 100)] },
  { id: 'regen', name: 'Regen', description: 'A slow green thread of life that keeps mending long after the caster has moved on.',
    mp: 10, ct: 4, range: R(4, 1), formula: 'buff', power: 10, vfx: 'white/regen', castAnim: 'cast',
    inflicts: [inf('regen', 100, LONG)] },
  { id: 'protect', name: 'Protect', description: 'A hardened aura across the skin. Physical blows land at two-thirds weight.',
    mp: 6, ct: 3, range: R(3, 1), formula: 'buff', vfx: 'white/protect', castAnim: 'cast',
    inflicts: [inf('protect', 100, LONG)] },
  { id: 'protectga', name: 'Protectga', description: 'The same ward, thrown wide enough to cover the whole front rank.',
    mp: 16, ct: 5, range: R(4, 2), formula: 'buff', vfx: 'white/protect-2', castAnim: 'cast',
    inflicts: [inf('protect', 100, LONG)] },
  { id: 'shell', name: 'Shell', description: 'A lattice of resistance against magick. Spells arrive muted.',
    mp: 6, ct: 3, range: R(3, 1), formula: 'buff', vfx: 'white/shell', castAnim: 'cast',
    inflicts: [inf('shell', 100, LONG)] },
  { id: 'shellga', name: 'Shellga', description: 'Shell laid over a formation, for when the enemy line is all mages.',
    mp: 16, ct: 5, range: R(4, 2), formula: 'buff', vfx: 'white/shell-2', castAnim: 'cast',
    inflicts: [inf('shell', 100, LONG)] },
  { id: 'wall', name: 'Wall', description: 'Protect, Shell and Haste at once. Expensive, slow, and worth it on the right unit.',
    mp: 36, ct: 9, range: R(3), formula: 'buff', vfx: 'white/wall', castAnim: 'cast',
    inflicts: [inf('protect', 100, LONG), inf('shell', 100, LONG), inf('haste', 100, MEDIUM)] },
  { id: 'esuna', name: 'Esuna', description: 'Unpick a curse strand by strand. Clears most ailments from a small area.',
    mp: 18, ct: 4, range: R(3, 1), formula: 'status-only', element: 'holy', vfx: 'white/esuna', castAnim: 'cast',
    cures: ['poison', 'blind', 'silence', 'frog', 'chicken', 'confuse', 'sleep', 'petrify', 'slow', 'stop', 'berserk', 'charm', 'death-sentence', 'undead', 'bleeding', 'burning'] },
  { id: 'holy', name: 'Holy', description: 'A pillar of judgement. The single most reliable killing spell in the White canon.',
    mp: 56, ct: 10, range: R(5), formula: 'magical', power: 44, accuracy: 100, element: 'holy',
    vfx: 'white/holy', castAnim: 'cast' },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Black Mage — Black Magick
// ─────────────────────────────────────────────────────────────────────────────

/** Tiered elemental nuke family — the balance spine every other set is priced against. */
function nuke(
  id: string, name: string, tier: 1 | 2 | 3 | 4, element: Element, vfx: string, description: string,
): AbilitySpec {
  const mp = [6, 16, 30, 48][tier - 1] ?? 6;
  const ct = [4, 6, 8, 11][tier - 1] ?? 4;
  const power = [14, 22, 32, 44][tier - 1] ?? 14;
  const radius = tier >= 3 ? 2 : 1;
  return {
    id, name, description, mp, ct, element,
    range: R(5, radius, { vertical: 4 }),
    formula: 'magical', power, accuracy: 100, vfx, castAnim: 'cast',
  };
}

const BLACK_MAGICK = actions('black-magick', [
  nuke('fire', 'Fire', 1, 'fire', 'black/fire-1', 'A fistful of flame dropped on a tile. Cheap enough to open with.'),
  nuke('fira', 'Fira', 2, 'fire', 'black/fire-2', 'The flame arrives with a pressure wave that knocks dust off the walls.'),
  nuke('firaga', 'Firaga', 3, 'fire', 'black/fire-3', 'A standing column of fire wide enough to take a squad.'),
  nuke('firaja', 'Firaja', 4, 'fire', 'black/fire-4', 'The sky opens and the ground burns. Do not stand near your own allies.'),
  nuke('blizzard', 'Blizzard', 1, 'ice', 'black/ice-1', 'A lance of ice, thrown fast and flat.'),
  nuke('blizzara', 'Blizzara', 2, 'ice', 'black/ice-2', 'Frost blooms out of the air; the ground rimes over where it lands.'),
  nuke('blizzaga', 'Blizzaga', 3, 'ice', 'black/ice-3', 'Spears of black ice erupt from below in a wide ring.'),
  nuke('blizzaja', 'Blizzaja', 4, 'ice', 'black/ice-4', 'Absolute cold, held for a heartbeat. Nothing organic likes it.'),
  nuke('thunder', 'Thunder', 1, 'lightning', 'black/bolt-1', 'A short, spiteful arc of lightning.'),
  nuke('thundara', 'Thundara', 2, 'lightning', 'black/bolt-2', 'The bolt forks on impact and finds anyone nearby.'),
  nuke('thundaga', 'Thundaga', 3, 'lightning', 'black/bolt-3', 'A white column that leaves the air smelling scorched.'),
  nuke('thundaja', 'Thundaja', 4, 'lightning', 'black/bolt-4', 'Every hair on the field stands up, and then the sky answers.'),
  { id: 'poison', name: 'Poison', description: 'Curdle the blood. Damage accrues every turn until the venom is drawn.',
    mp: 8, ct: 4, range: R(5, 1), formula: 'magical', power: 8, accuracy: 85, element: 'dark',
    vfx: 'black/poison', castAnim: 'cast', inflicts: [inf('poison', 80, LONG)] },
  { id: 'toad', name: 'Toad', description: 'Reduce a soldier to something wet and harmless. Cast again to undo it.',
    mp: 14, ct: 5, range: R(4), formula: 'status-only', accuracy: 70, vfx: 'black/toad', castAnim: 'cast',
    inflicts: [inf('frog', 100, VERY_LONG)] },
  { id: 'death', name: 'Death', description: 'Skip the intervening steps. Either it works completely or not at all.',
    mp: 40, ct: 10, range: R(4), formula: 'status-only', accuracy: 45, element: 'dark',
    vfx: 'black/death', castAnim: 'cast', inflicts: [inf('ko', 100)] },
  { id: 'flare', name: 'Flare', description: 'Unaspected annihilation on a single point. No element to resist, no area to dodge.',
    mp: 60, ct: 12, range: R(4), formula: 'magical', power: 58, accuracy: 100, vfx: 'black/flare', castAnim: 'cast' },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Time Mage — Time Magick
// ─────────────────────────────────────────────────────────────────────────────

const TIME_MAGICK = actions('time-magick', [
  { id: 'haste', name: 'Haste', description: 'Half again the Speed, which in practice means half again the turns.',
    mp: 8, ct: 4, range: R(4, 1), formula: 'buff', vfx: 'time/haste', castAnim: 'cast',
    inflicts: [inf('haste', 100, LONG)] },
  { id: 'hastega', name: 'Hastega', description: 'Accelerate an entire formation. The single strongest opening in the game.',
    mp: 22, ct: 7, range: R(4, 2), formula: 'buff', vfx: 'time/haste-2', castAnim: 'cast',
    inflicts: [inf('haste', 100, LONG)] },
  { id: 'slow', name: 'Slow', description: 'Mire a foe in treacle-thick time. Their turns arrive at two-thirds pace.',
    mp: 8, ct: 4, range: R(4, 1), formula: 'status-only', accuracy: 75, vfx: 'time/slow', castAnim: 'cast',
    inflicts: [inf('slow', 100, LONG)] },
  { id: 'slowga', name: 'Slowga', description: 'Drag a whole advance to a crawl before it reaches your line.',
    mp: 22, ct: 7, range: R(4, 2), formula: 'status-only', accuracy: 65, vfx: 'time/slow-2', castAnim: 'cast',
    inflicts: [inf('slow', 100, MEDIUM)] },
  { id: 'stop', name: 'Stop', description: 'Take a unit out of the clock entirely. They will not move, act, or age.',
    mp: 20, ct: 7, range: R(4), formula: 'status-only', accuracy: 55, vfx: 'time/stop', castAnim: 'cast',
    inflicts: [inf('stop', 100, SHORT)] },
  { id: 'immobilize', name: 'Immobilize', description: 'Fix the feet in place. They may still swing, but they will not close the gap.',
    mp: 12, ct: 4, range: R(4), formula: 'status-only', accuracy: 70, vfx: 'time/immobilize', castAnim: 'cast',
    inflicts: [inf('rooted', 100, LONG)] },
  { id: 'reflect', name: 'Reflect', description: 'A mirrored skin. Single-target spells bounce back at whoever cast them.',
    mp: 16, ct: 5, range: R(3), formula: 'buff', vfx: 'time/reflect', castAnim: 'cast',
    inflicts: [inf('reflect', 100, LONG)] },
  { id: 'quick', name: 'Quick', description: 'Hand a unit their next turn immediately. Ruinous in the right hands.',
    mp: 26, ct: 6, range: R(4), formula: 'special', power: 100, vfx: 'time/quick', castAnim: 'cast' },
  { id: 'demi', name: 'Demi', description: 'Gravity, applied selectively. Removes a quarter of current HP regardless of defence.',
    mp: 16, ct: 6, range: R(4, 1), formula: 'percent-hp', power: 25, accuracy: 70, vfx: 'time/demi', castAnim: 'cast' },
  { id: 'demiga', name: 'Demiga', description: 'A heavier well. Takes half of what the target has left; never quite finishes them.',
    mp: 30, ct: 9, range: R(4, 1), formula: 'percent-hp', power: 50, accuracy: 60, vfx: 'time/demi-2', castAnim: 'cast' },
  { id: 'float', name: 'Float', description: 'Lift an ally a hand\'s breadth off the ground — out of reach of earth and traps.',
    mp: 10, ct: 3, range: R(3, 1), formula: 'buff', vfx: 'time/float', castAnim: 'cast',
    inflicts: [inf('float', 100, VERY_LONG)] },
  { id: 'meteor', name: 'Meteor', description: 'Four falling stones, aimed roughly. The most damage any Time Mage will ever do.',
    mp: 70, ct: 14, range: R(5, 2, { vertical: 6 }), formula: 'magical', power: 60, accuracy: 90,
    element: 'earth', vfx: 'time/meteor', castAnim: 'cast' },
  { id: 'stabilize', name: 'Stabilize', description: 'Pin a unit\'s local time steady, ending haste, slow, stop and death sentence alike.',
    mp: 14, ct: 4, range: R(4, 1), formula: 'status-only', vfx: 'time/stabilize', castAnim: 'cast',
    cures: ['haste', 'slow', 'stop', 'death-sentence'] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Summoner — Summon Magick
// ─────────────────────────────────────────────────────────────────────────────

interface EsperSpec {
  id: string; name: string; mp: number; ct: number; power: number; element: Element;
  formula: FormulaId; radius: number; description: string;
  inflicts?: readonly StatusInfliction[]; cures?: readonly StatusId[]; accuracy?: number;
}

function esper(e: EsperSpec): AbilitySpec {
  return {
    id: e.id, name: e.name, description: e.description,
    mp: e.mp, ct: e.ct, element: e.element,
    range: R(5, e.radius, { vertical: 5 }),
    formula: e.formula, power: e.power, accuracy: e.accuracy ?? 100,
    inflicts: e.inflicts, cures: e.cures,
    vfx: `summon/${e.id}`, sfx: `summon/${e.id}`, castAnim: 'cast',
  };
}

const SUMMON_MAGICK = actions('summon-magick', [
  esper({ id: 'moogle', name: 'Moogle', mp: 8, ct: 4, power: 18, element: 'none', formula: 'heal', radius: 2,
    description: 'A small, indignant creature arrives, mends everyone nearby, and leaves. Kupo.' }),
  esper({ id: 'shiva', name: 'Shiva', mp: 20, ct: 6, power: 24, element: 'ice', formula: 'magical', radius: 2,
    description: 'The Ice Queen exhales once across the field. Everything she touches stops steaming.' }),
  esper({ id: 'ramuh', name: 'Ramuh', mp: 20, ct: 6, power: 24, element: 'lightning', formula: 'magical', radius: 2,
    description: 'The old man with the staff. He does not hurry, and he does not miss.' }),
  esper({ id: 'ifrit', name: 'Ifrit', mp: 20, ct: 6, power: 24, element: 'fire', formula: 'magical', radius: 2,
    description: 'Hellfire given horns. The ground he lands on stays black for a season.' }),
  esper({ id: 'titan', name: 'Titan', mp: 28, ct: 7, power: 30, element: 'earth', formula: 'magical', radius: 2,
    description: 'The earth itself stands up and turns over. Floating units are untouched.' }),
  esper({ id: 'golem', name: 'Golem', mp: 24, ct: 6, power: 60, element: 'earth', formula: 'buff', radius: 3,
    description: 'A stone guardian interposes itself, soaking physical damage for the whole party until it crumbles.',
    inflicts: [inf('shielded', 100, LONG)] }),
  esper({ id: 'carbuncle', name: 'Carbuncle', mp: 24, ct: 6, power: 0, element: 'none', formula: 'buff', radius: 2,
    description: 'The ruby on its brow throws every incoming spell back the way it came.',
    inflicts: [inf('reflect', 100, LONG)] }),
  esper({ id: 'bahamut', name: 'Bahamut', mp: 60, ct: 12, power: 52, element: 'none', formula: 'magical', radius: 3,
    description: 'Megaflare. The King of Dragons does not distinguish between combatants and bystanders.' }),
  esper({ id: 'odin', name: 'Odin', mp: 48, ct: 10, power: 46, element: 'dark', formula: 'magical', radius: 2,
    description: 'Zantetsuken falls in a single grey line. Some things it touches simply stop existing.',
    inflicts: [inf('ko', 15)] }),
  esper({ id: 'leviathan', name: 'Leviathan', mp: 40, ct: 9, power: 40, element: 'water', formula: 'magical', radius: 3,
    description: 'A tidal wall crosses the map at chest height and takes the battle line with it.' }),
  esper({ id: 'salamander', name: 'Salamander', mp: 40, ct: 9, power: 40, element: 'fire', formula: 'magical', radius: 2,
    description: 'A serpent of living flame coils through the target zone and out again.',
    inflicts: [inf('burning', 50, MEDIUM)] }),
  esper({ id: 'sylph', name: 'Sylph', mp: 24, ct: 6, power: 22, element: 'wind', formula: 'drain', radius: 2,
    description: 'Wind spirits siphon MP from the enemy and hand it to the summoner. Bright, cruel, quick.' }),
  esper({ id: 'fairy', name: 'Fairy', mp: 26, ct: 6, power: 34, element: 'none', formula: 'heal', radius: 2,
    description: 'A drift of light that closes wounds and lifts the small cruelties of the battlefield.',
    cures: ['poison', 'blind', 'silence', 'sleep', 'bleeding'] }),
  esper({ id: 'lich', name: 'Lich', mp: 44, ct: 10, power: 40, element: 'dark', formula: 'percent-hp', radius: 2,
    accuracy: 75, description: 'The Hand of Death takes a fixed share of what is left. Armour is no answer to it.' }),
  esper({ id: 'cyclops', name: 'Cyclops', mp: 52, ct: 11, power: 48, element: 'none', formula: 'magical', radius: 2,
    description: 'One enormous fist, brought down once. It is not subtle and does not need to be.' }),
  esper({ id: 'zodiark', name: 'Zodiark', mp: 80, ct: 16, power: 70, element: 'dark', formula: 'magical', radius: 3,
    description: 'The Keeper of Precepts. Summoning it is a decision about the whole battle, not the turn.' }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Thief — Steal
// ─────────────────────────────────────────────────────────────────────────────

const STEAL = actions('steal', [
  { id: 'steal-gil', name: 'Steal Gil', description: 'Cut a purse strap mid-melee. Nobody notices until the battle is over.',
    formula: 'special', power: 0, accuracy: 80, vfx: 'steal/gil', castAnim: 'attack' },
  { id: 'steal-weapon', name: 'Steal Weapon', description: 'Take the blade out of a hand that is still swinging it. The hardest lift on the field.',
    formula: 'special', power: 0, accuracy: 40, vfx: 'steal/weapon', castAnim: 'attack' },
  { id: 'steal-shield', name: 'Steal Shield', description: 'Slip the straps and walk away with the guard.',
    formula: 'special', power: 0, accuracy: 50, vfx: 'steal/shield', castAnim: 'attack' },
  { id: 'steal-helmet', name: 'Steal Helm', description: 'Lift a helm cleanly. Embarrassing for them, lucrative for you.',
    formula: 'special', power: 0, accuracy: 55, vfx: 'steal/helm', castAnim: 'attack' },
  { id: 'steal-armor', name: 'Steal Armor', description: 'Unbuckle a cuirass in a single pass. Requires nerve and very fast hands.',
    formula: 'special', power: 0, accuracy: 45, vfx: 'steal/armor', castAnim: 'attack' },
  { id: 'steal-accessory', name: 'Steal Accessory', description: 'Rings, ribbons, charms — the small things that are worth the most.',
    formula: 'special', power: 0, accuracy: 50, vfx: 'steal/accessory', castAnim: 'attack' },
  { id: 'steal-heart', name: 'Steal Heart', description: 'Charm rather than theft, though the thief would argue the difference is small.',
    formula: 'status-only', accuracy: 55, vfx: 'steal/heart', castAnim: 'cast',
    inflicts: [inf('charm', 100, MEDIUM)] },
  { id: 'steal-exp', name: 'Steal EXP', description: 'Take the lesson as well as the loot. The victim forgets what they just learned.',
    formula: 'special', power: 0, accuracy: 60, vfx: 'steal/exp', castAnim: 'attack' },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Rogue — Snatch (theft that also hurts)
// ─────────────────────────────────────────────────────────────────────────────

const SNATCH = actions('snatch', [
  { id: 'snatch-purse', name: 'Snatch Purse', description: 'Gut the coin pouch and the man carrying it, in that order of priority.',
    formula: 'physical', power: 2, accuracy: 80, vfx: 'snatch/purse', castAnim: 'attack' },
  { id: 'snatch-weapon', name: 'Snatch Weapon', description: 'Disarm on the parry, then bury the stolen point in its owner.',
    formula: 'physical', power: 2, accuracy: 55, vfx: 'snatch/weapon', castAnim: 'attack' },
  { id: 'snatch-charm', name: 'Snatch Charm', description: 'Tear off a warding trinket, and let whatever it was holding back come through.',
    formula: 'physical', power: 2, accuracy: 60, vfx: 'snatch/charm', castAnim: 'attack',
    inflicts: [inf('vulnerable', 60, MEDIUM)] },
  { id: 'snatch-breath', name: 'Snatch Breath', description: 'A knife across the windpipe: they will not be finishing that incantation.',
    formula: 'physical', power: 2, accuracy: 65, vfx: 'snatch/breath', castAnim: 'attack',
    inflicts: [inf('silence', 75, MEDIUM), inf('bleeding', 50, SHORT)] },
  { id: 'snatch-mana', name: 'Snatch Mana', description: 'Draw the aether out of a spellcaster and keep it. Their loss is precisely your gain.',
    mp: 0, formula: 'drain', power: 14, accuracy: 70, element: 'dark', vfx: 'snatch/mana', castAnim: 'attack' },
  { id: 'snatch-footing', name: 'Snatch Footing', description: 'Hook an ankle and put them in the dirt. Nobody acts quickly from down there.',
    formula: 'physical', power: 1, accuracy: 75, vfx: 'snatch/trip', castAnim: 'attack',
    inflicts: [inf('slow', 70, MEDIUM), inf('rooted', 40, SHORT)] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Orator — Talk Skill
// ─────────────────────────────────────────────────────────────────────────────

/** Talk Skill reaches further than a blade and never provokes a reaction. */
const TALK_RANGE = R(4, 0, { vertical: 4, los: true });

const TALK_SKILL = actions('talk-skill', [
  { id: 'invitation', name: 'Invitation', description: 'Offer better terms than their captain did. Some soldiers change sides on the spot.',
    range: TALK_RANGE, formula: 'status-only', accuracy: 40, vfx: 'talk/invite', castAnim: 'cast',
    inflicts: [inf('charm', 100)] },
  { id: 'persuade', name: 'Persuade', description: 'Talk a man out of his own momentum. He will stand there, thinking it over.',
    range: TALK_RANGE, formula: 'status-only', accuracy: 65, vfx: 'talk/persuade', castAnim: 'cast',
    inflicts: [inf('stop', 100, SHORT)] },
  { id: 'praise', name: 'Praise', description: 'Public commendation. The ally stands taller and their Bravery rises for good.',
    range: TALK_RANGE, formula: 'buff', power: 10, vfx: 'talk/praise', castAnim: 'cast' },
  { id: 'threaten', name: 'Threaten', description: 'Describe, in detail, what happens next. Their Bravery leaves them.',
    range: TALK_RANGE, formula: 'special', power: -12, accuracy: 70, vfx: 'talk/threaten', castAnim: 'cast' },
  { id: 'preach', name: 'Preach', description: 'A sermon that finds its mark. Faith rises, and with it their vulnerability to magick.',
    range: TALK_RANGE, formula: 'buff', power: 10, accuracy: 70, vfx: 'talk/preach', castAnim: 'cast',
    inflicts: [inf('faith', 100, LONG)] },
  { id: 'solution', name: 'Solution', description: 'A cold argument against belief itself. Faith falls; so does their magick.',
    range: TALK_RANGE, formula: 'special', power: -10, accuracy: 70, vfx: 'talk/solution', castAnim: 'cast',
    inflicts: [inf('innocent', 100, LONG)] },
  { id: 'condemn', name: 'Condemn', description: 'Pronounce sentence. In thirty ticks it is carried out, by nothing anyone can see.',
    range: TALK_RANGE, formula: 'status-only', accuracy: 55, element: 'dark', vfx: 'talk/condemn', castAnim: 'cast',
    inflicts: [inf('death-sentence', 100, MEDIUM)] },
  { id: 'insult', name: 'Insult', description: 'Something unforgivable about their mother. They stop thinking and start swinging.',
    range: TALK_RANGE, formula: 'status-only', accuracy: 70, vfx: 'talk/insult', castAnim: 'cast',
    inflicts: [inf('berserk', 100, LONG)] },
  { id: 'mimic-daravon', name: 'Mimic Daravon', description: 'A flawless impression of the dullest lecturer in Ivalice. The target falls asleep.',
    range: TALK_RANGE, formula: 'status-only', accuracy: 70, vfx: 'talk/daravon', castAnim: 'cast',
    inflicts: [inf('sleep', 100, LONG)] },
  { id: 'refute', name: 'Refute', description: 'Dismantle their reasoning so thoroughly that they lose track of who they are fighting.',
    range: TALK_RANGE, formula: 'status-only', accuracy: 60, vfx: 'talk/refute', castAnim: 'cast',
    inflicts: [inf('confuse', 100, MEDIUM)] },
  { id: 'rehabilitate', name: 'Rehabilitate', description: 'Reason a charmed, berserk or confused ally back to themselves.',
    range: TALK_RANGE, formula: 'status-only', vfx: 'talk/rehab', castAnim: 'cast',
    cures: ['charm', 'confuse', 'berserk', 'sleep', 'taunted'] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Oracle — Yin-Yang Magick
// ─────────────────────────────────────────────────────────────────────────────

const YIN_YANG = actions('yin-yang-magick', [
  { id: 'blind', name: 'Blind', description: 'Darkness across the eyes. Their weapon finds air more often than flesh.',
    mp: 6, ct: 3, range: R(4, 1), formula: 'status-only', accuracy: 70, element: 'dark',
    vfx: 'yin/blind', castAnim: 'cast', inflicts: [inf('blind', 100, LONG)] },
  { id: 'spell-absorb', name: 'Spell Absorb', description: 'Siphon aether from a caster into your own reserve.',
    mp: 4, ct: 3, range: R(4), formula: 'drain', power: 18, accuracy: 65, element: 'dark',
    vfx: 'yin/absorb', castAnim: 'cast' },
  { id: 'life-drain', name: 'Life Drain', description: 'Take life directly and keep it. The oldest and least polite spell in the book.',
    mp: 10, ct: 5, range: R(4), formula: 'drain', power: 22, accuracy: 65, element: 'dark',
    vfx: 'yin/drain', castAnim: 'cast' },
  { id: 'pray-faith', name: 'Pray Faith', description: 'Raise a unit\'s Faith. Their spells hit harder — and so do spells aimed at them.',
    mp: 8, ct: 4, range: R(4), formula: 'buff', accuracy: 70, vfx: 'yin/faith', castAnim: 'cast',
    inflicts: [inf('faith', 100, LONG)] },
  { id: 'doubt-faith', name: 'Doubt Faith', description: 'Sow doubt. The target becomes nearly immune to magick, and nearly useless at it.',
    mp: 8, ct: 4, range: R(4), formula: 'status-only', accuracy: 70, vfx: 'yin/doubt', castAnim: 'cast',
    inflicts: [inf('innocent', 100, LONG)] },
  { id: 'zombie', name: 'Zombie', description: 'Turn a living body undead. Healing now burns it; phoenix down is lethal.',
    mp: 16, ct: 5, range: R(4), formula: 'status-only', accuracy: 55, element: 'dark',
    vfx: 'yin/zombie', castAnim: 'cast', inflicts: [inf('undead', 100)] },
  { id: 'silence-song', name: 'Silence Song', description: 'A hummed note that closes throats across a small area.',
    mp: 12, ct: 4, range: R(4, 1), formula: 'status-only', accuracy: 65, vfx: 'yin/silence', castAnim: 'sing',
    inflicts: [inf('silence', 100, LONG)] },
  { id: 'blind-rage', name: 'Blind Rage', description: 'Fill a soldier with fury and take away their judgement along with it.',
    mp: 12, ct: 4, range: R(4), formula: 'status-only', accuracy: 60, vfx: 'yin/rage', castAnim: 'cast',
    inflicts: [inf('berserk', 100, LONG)] },
  { id: 'foxbird', name: 'Foxbird', description: 'A phantom bird shrieks past. Whoever hears it loses their nerve.',
    mp: 10, ct: 4, range: R(4, 1), formula: 'special', power: -10, accuracy: 65, element: 'wind',
    vfx: 'yin/foxbird', castAnim: 'cast' },
  { id: 'confusion-song', name: 'Confusion Song', description: 'A melody with no key. The listener stops being sure which banner is theirs.',
    mp: 14, ct: 5, range: R(4, 1), formula: 'status-only', accuracy: 60, vfx: 'yin/confuse', castAnim: 'sing',
    inflicts: [inf('confuse', 100, MEDIUM)] },
  { id: 'dispel-magick', name: 'Dispel', description: 'Strip every enchantment from a unit, good and ill alike.',
    mp: 18, ct: 5, range: R(4), formula: 'status-only', accuracy: 75, vfx: 'yin/dispel', castAnim: 'cast',
    cures: ['haste', 'protect', 'shell', 'regen', 'reraise', 'faith', 'innocent', 'float', 'reflect', 'transparent', 'empowered', 'shielded', 'stealth', 'evade-next'] },
  { id: 'paralyze', name: 'Paralyze', description: 'Lock the nerves. The body remains upright and entirely uncooperative.',
    mp: 16, ct: 5, range: R(4), formula: 'status-only', accuracy: 60, element: 'lightning',
    vfx: 'yin/paralyze', castAnim: 'cast', inflicts: [inf('stop', 100, SHORT)] },
  { id: 'sleep', name: 'Sleep', description: 'A weight behind the eyes that no soldier can argue with.',
    mp: 12, ct: 5, range: R(4, 1), formula: 'status-only', accuracy: 60, vfx: 'yin/sleep', castAnim: 'cast',
    inflicts: [inf('sleep', 100, LONG)] },
  { id: 'petrify', name: 'Break', description: 'Grey creeps up from the feet. If it reaches the heart, they are statuary.',
    mp: 24, ct: 8, range: R(4), formula: 'status-only', accuracy: 45, element: 'earth',
    vfx: 'yin/petrify', castAnim: 'cast', inflicts: [inf('petrify', 100)] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Geomancer — Geomancy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Geomancy is free, instant, and keyed to the surface the caster is standing on.
 * `combat/` is expected to pick the matching ability by `SurfaceKind`; the mapping
 * is exported as `GEOMANCY_BY_SURFACE`.
 */
function geo(
  id: string, name: string, element: Element, power: number, description: string,
  inflicts?: readonly StatusInfliction[],
): AbilitySpec {
  return {
    id, name, description, mp: 0, ct: 0, element,
    range: R(3, 1, { vertical: 3 }),
    formula: 'magical', power, accuracy: 75, inflicts,
    vfx: `geo/${id}`, castAnim: 'cast', targetsTiles: true,
  };
}

const GEOMANCY = actions('geomancy', [
  geo('pitfall', 'Pitfall', 'earth', 18, 'The dirt gives way beneath them and closes again badly.',
    [inf('rooted', 30, SHORT)]),
  geo('water-ball', 'Water Ball', 'water', 18, 'A fist of river water, delivered at speed.'),
  geo('hell-ivy', 'Hell Ivy', 'earth', 18, 'Grass turns to grasping vine and holds whatever it catches.',
    [inf('rooted', 45, MEDIUM)]),
  geo('carve-model', 'Carve Model', 'earth', 20, 'Stone flows up and around a foe, taking their likeness with it.',
    [inf('petrify', 12)]),
  geo('local-quake', 'Local Quake', 'earth', 22, 'A short, contained tremor. Everything unbraced goes over.'),
  geo('kamaitachi', 'Kamaitachi', 'wind', 18, 'Sand-borne wind sharp enough to open cloth and skin alike.',
    [inf('bleeding', 35, SHORT)]),
  geo('demon-fire', 'Demon Fire', 'fire', 22, 'Lava spits upward on command and clings where it lands.',
    [inf('burning', 45, SHORT)]),
  geo('quicksand', 'Quicksand', 'earth', 20, 'The swamp opens a mouth. Anything heavy goes down first.',
    [inf('rooted', 40, SHORT)]),
  geo('sand-storm', 'Sandstorm', 'wind', 18, 'A wall of grit that scours the eyes before anything else.',
    [inf('blind', 45, MEDIUM)]),
  geo('blizzard-geo', 'Blizzard', 'ice', 20, 'Snow lifts off the ground and comes back edged with ice.',
    [inf('slow', 30, SHORT)]),
  geo('gusty-wind', 'Gusty Wind', 'wind', 18, 'Wind funnelled between the boards and out the far side.',
    [inf('silence', 30, SHORT)]),
  geo('lava-ball', 'Lava Ball', 'fire', 24, 'A dripping sphere of molten rock, thrown underhand.',
    [inf('burning', 55, MEDIUM)]),
  geo('static-shock', 'Static Shock', 'lightning', 20, 'Charge earthed through a metal roof and into whoever is standing on it.'),
  geo('will-o-wisp', 'Will-o\'-the-Wisp', 'dark', 20, 'Bog-lights drift up from the water and settle on the nearest living thing.',
    [inf('confuse', 25, SHORT)]),
]);

/** Surface → geomancy ability. `combat/` resolves the caster's tile through this. */
export const GEOMANCY_BY_SURFACE: Readonly<Record<string, AbilityId>> = {
  dirt: 'pitfall',
  water: 'water-ball',
  deepwater: 'will-o-wisp',
  grass: 'hell-ivy',
  stone: 'carve-model',
  bridge: 'local-quake',
  sand: 'kamaitachi',
  lava: 'demon-fire',
  swamp: 'quicksand',
  snow: 'blizzard-geo',
  wood: 'gusty-wind',
  roof: 'static-shock',
  void: 'gusty-wind',
};

// ─────────────────────────────────────────────────────────────────────────────
// Dragoon — Jump
// ─────────────────────────────────────────────────────────────────────────────

const JUMP = actions('jump', [
  { id: 'jump', name: 'Jump', description: 'Leave the field. Return point-first two turns later for doubled weapon damage.',
    range: R(3, 0, { vertical: Infinity, los: false }), formula: 'physical', power: 2, accuracy: 100,
    vfx: 'jump/basic', castAnim: 'jump', targetsTiles: true, inflicts: [inf('jumping', 100)] },
  { id: 'level-jump-3', name: 'Level Jump 3', description: 'A flatter arc that covers three tiles of ground before the spear comes down.',
    range: R(4, 0, { vertical: Infinity, los: false }), formula: 'physical', power: 2, accuracy: 100,
    vfx: 'jump/level-3', castAnim: 'jump', targetsTiles: true, inflicts: [inf('jumping', 100)] },
  { id: 'level-jump-5', name: 'Level Jump 5', description: 'Cross most of a battlefield in the air. Nothing intercepts you on the way.',
    range: R(6, 0, { vertical: Infinity, los: false }), formula: 'physical', power: 2, accuracy: 100,
    vfx: 'jump/level-5', castAnim: 'jump', targetsTiles: true, inflicts: [inf('jumping', 100)] },
  { id: 'vertical-jump-4', name: 'Vertical Jump 4', description: 'Straight up, four levels of clearance, then straight down through a roof if need be.',
    range: R(3, 0, { vertical: Infinity, los: false }), formula: 'physical', power: 3, accuracy: 100,
    vfx: 'jump/vertical-4', castAnim: 'jump', targetsTiles: true, inflicts: [inf('jumping', 100)] },
  { id: 'high-jump', name: 'High Jump', description: 'A longer hang time for a heavier landing. Triple weapon power on descent.',
    mp: 10, range: R(4, 0, { vertical: Infinity, los: false }), formula: 'physical', power: 3, accuracy: 100,
    vfx: 'jump/high', castAnim: 'jump', targetsTiles: true, inflicts: [inf('jumping', 100)] },
  { id: 'dragon-dive', name: 'Dragon Dive', description: 'Come down in the centre of a formation and put the spear through all of it.',
    mp: 20, range: R(4, 1, { vertical: Infinity, los: false }), formula: 'physical', power: 3, accuracy: 90,
    element: 'wind', vfx: 'jump/dive', castAnim: 'jump', targetsTiles: true,
    inflicts: [inf('jumping', 100)] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Samurai — Draw Out (Iaido)
// ─────────────────────────────────────────────────────────────────────────────

const DRAW_OUT = actions('draw-out', [
  { id: 'asura', name: 'Asura', description: 'The cheapest blade in the rack. A flat wave of force, and often a broken katana.',
    range: R(0, 2, { self: true, los: false, vertical: 3 }), formula: 'magical', power: 14,
    accuracy: 100, vfx: 'iaido/asura', castAnim: 'attack' },
  { id: 'koutetsu', name: 'Koutetsu', description: 'Old steel, honestly forged. Cuts everything in front of it without ceremony.',
    range: R(0, 2, { self: true, los: false, vertical: 3 }), formula: 'magical', power: 20,
    accuracy: 100, vfx: 'iaido/koutetsu', castAnim: 'attack' },
  { id: 'bizen-boat', name: 'Bizen Boat', description: 'Draws the aether out of everyone it touches and leaves them unable to cast.',
    range: R(0, 2, { self: true, los: false, vertical: 3 }), formula: 'drain', power: 16,
    accuracy: 90, vfx: 'iaido/bizen', castAnim: 'attack', inflicts: [inf('silence', 40, SHORT)] },
  { id: 'murasame', name: 'Murasame', description: 'The rain-blade. Wounds close on every ally standing in its arc.',
    range: R(0, 2, { self: true, los: false, vertical: 3 }), formula: 'heal', power: 30,
    accuracy: 100, vfx: 'iaido/murasame', castAnim: 'attack' },
  { id: 'heavens-cloud', name: "Heaven's Cloud", description: 'A cold white line across the field that leaves time itself dragging.',
    range: R(0, 2, { self: true, los: false, vertical: 3 }), formula: 'magical', power: 24,
    element: 'ice', accuracy: 95, vfx: 'iaido/heavens-cloud', castAnim: 'attack',
    inflicts: [inf('slow', 60, MEDIUM)] },
  { id: 'kiyomori', name: 'Kiyomori', description: 'The guardian blade. Protect and Shell settle over every ally in range.',
    range: R(0, 2, { self: true, los: false, vertical: 3 }), formula: 'buff', power: 0,
    accuracy: 100, vfx: 'iaido/kiyomori', castAnim: 'attack',
    inflicts: [inf('protect', 100, LONG), inf('shell', 100, LONG)] },
  { id: 'muramasa', name: 'Muramasa', description: 'A cursed edge. It wounds, and it leaves something behind in the wound.',
    range: R(0, 2, { self: true, los: false, vertical: 3 }), formula: 'magical', power: 26,
    element: 'dark', accuracy: 90, vfx: 'iaido/muramasa', castAnim: 'attack',
    inflicts: [inf('confuse', 40, SHORT), inf('death-sentence', 20, MEDIUM)] },
  { id: 'kikuichimonji', name: 'Kikuichimonji', description: 'Sixteen petals of the chrysanthemum, all of them edged.',
    range: R(0, 3, { self: true, los: false, vertical: 4 }), formula: 'magical', power: 32,
    accuracy: 100, vfx: 'iaido/kiku', castAnim: 'attack' },
  { id: 'masamune', name: 'Masamune', description: 'The great blade. Hastens and mends every ally within reach of the draw.',
    range: R(0, 2, { self: true, los: false, vertical: 3 }), formula: 'buff', power: 0,
    accuracy: 100, vfx: 'iaido/masamune', castAnim: 'attack',
    inflicts: [inf('haste', 100, LONG), inf('regen', 100, MEDIUM)] },
  { id: 'chirijiraden', name: 'Chirijiraden', description: 'The last blade in the rack, and the last stroke of most battles.',
    range: R(0, 3, { self: true, los: false, vertical: 4 }), formula: 'magical', power: 44,
    accuracy: 100, vfx: 'iaido/chirijiraden', castAnim: 'attack' },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Ninja — Throw
// ─────────────────────────────────────────────────────────────────────────────

const THROW = actions('throw', [
  { id: 'throw-shuriken', name: 'Shuriken', description: 'Four points of folded steel, thrown flat and fast. Range is not a factor.',
    range: R(6, 0, { vertical: 4 }), formula: 'fixed', power: 30, accuracy: 100,
    vfx: 'throw/shuriken', castAnim: 'throw' },
  { id: 'throw-fuma-shuriken', name: 'Fuma Shuriken', description: 'A shuriken the size of a dinner plate. It arrives spinning and does not stop.',
    range: R(6, 0, { vertical: 4 }), formula: 'fixed', power: 55, accuracy: 100,
    vfx: 'throw/fuma', castAnim: 'throw' },
  { id: 'throw-knife', name: 'Knife', description: 'A thrown blade carries its own weapon power the whole way.',
    range: R(5, 0, { vertical: 4 }), formula: 'physical', power: 2, accuracy: 95,
    vfx: 'throw/knife', castAnim: 'throw' },
  { id: 'throw-sword', name: 'Sword', description: 'Throwing a sword is a waste of a sword. It is also extremely effective.',
    range: R(5, 0, { vertical: 4 }), formula: 'physical', power: 3, accuracy: 90,
    vfx: 'throw/sword', castAnim: 'throw' },
  { id: 'throw-katana', name: 'Katana', description: 'A katana thrown by a ninja lands better than one swung by most samurai.',
    range: R(5, 0, { vertical: 4 }), formula: 'physical', power: 3, accuracy: 95,
    vfx: 'throw/katana', castAnim: 'throw' },
  { id: 'throw-axe', name: 'Axe', description: 'Heavy, tumbling, and unkind to helmets.',
    range: R(4, 0, { vertical: 5 }), formula: 'physical', power: 4, accuracy: 80,
    vfx: 'throw/axe', castAnim: 'throw' },
  { id: 'throw-bomb', name: 'Bomb', description: 'A clay sphere of black powder. It takes the tile and its neighbours.',
    range: R(5, 1, { vertical: 4 }), formula: 'fixed', power: 40, accuracy: 90, element: 'fire',
    vfx: 'throw/bomb', castAnim: 'throw', inflicts: [inf('burning', 40, SHORT)] },
  { id: 'throw-caltrops', name: 'Caltrops', description: 'Scattered iron on the ground ahead. Whoever walks it bleeds and slows.',
    range: R(4, 1, { vertical: 3 }), formula: 'fixed', power: 16, accuracy: 90, targetsTiles: true,
    vfx: 'throw/caltrops', castAnim: 'throw',
    inflicts: [inf('bleeding', 70, MEDIUM), inf('slow', 40, SHORT)] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Arithmetician — Math Skill
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Math Skill selects every unit on the field whose chosen attribute divides evenly
 * by the chosen number, then casts a known spell on all of them for free, instantly.
 * `power` encodes the divisor; `vfx` and `description` carry the attribute.
 * `combat/` reads `MATH_TERMS` to evaluate the predicate.
 */
export interface MathTerm {
  readonly ability: AbilityId;
  readonly attribute: 'ct' | 'level' | 'exp' | 'height';
  readonly divisor: number | 'prime';
}

const MATH_TERM_LIST: readonly MathTerm[] = [
  { ability: 'math-ct-prime', attribute: 'ct', divisor: 'prime' },
  { ability: 'math-ct-5', attribute: 'ct', divisor: 5 },
  { ability: 'math-level-prime', attribute: 'level', divisor: 'prime' },
  { ability: 'math-level-3', attribute: 'level', divisor: 3 },
  { ability: 'math-exp-4', attribute: 'exp', divisor: 4 },
  { ability: 'math-exp-5', attribute: 'exp', divisor: 5 },
  { ability: 'math-height-3', attribute: 'height', divisor: 3 },
  { ability: 'math-height-4', attribute: 'height', divisor: 4 },
];

export const MATH_TERMS: ReadonlyMap<AbilityId, MathTerm> = new Map(
  MATH_TERM_LIST.map((t) => [t.ability, t]),
);

const ATTRIBUTE_LABEL: Readonly<Record<MathTerm['attribute'], string>> = {
  ct: 'Charge Time',
  level: 'Level',
  exp: 'Experience',
  height: 'Height',
};

const MATH_SKILL = actions(
  'math-skill',
  MATH_TERM_LIST.map<AbilitySpec>((t) => {
    const label = ATTRIBUTE_LABEL[t.attribute];
    const div = t.divisor === 'prime' ? 'a prime number' : `${t.divisor}`;
    return {
      id: t.ability,
      name: t.divisor === 'prime' ? `${label} · Prime` : `${label} · ${t.divisor}`,
      description:
        `Choose a spell you know. Every unit on the field whose ${label} is ${div === 'a prime number' ? div : `divisible by ${div}`} is struck by it — no MP, no charge time, no line of sight, and no regard whatsoever for whose side they are on.`,
      mp: 0,
      ct: 0,
      range: FIELD,
      formula: 'special',
      power: t.divisor === 'prime' ? 0 : t.divisor,
      accuracy: 100,
      vfx: `math/${t.attribute}`,
      castAnim: 'cast',
    };
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Bard — Sing
// ─────────────────────────────────────────────────────────────────────────────

/** Songs are sustained: they re-apply every tick until the bard acts again. */
function song(
  id: string, name: string, description: string, vfx: string,
  extra: Partial<AbilitySpec> = {},
): AbilitySpec {
  return {
    id, name, description,
    mp: 0, ct: 0, element: 'none',
    range: FIELD, formula: 'buff', power: 1, accuracy: 100,
    vfx, castAnim: 'sing',
    inflicts: [inf('performing', 100)],
    ...extra,
  };
}

const SING = actions('sing', [
  song('angel-song', 'Angel Song', 'A rising line that returns a little MP to every ally, every tick, forever.', 'song/angel'),
  song('life-song', 'Life Song', 'A slow hymn that closes wounds across the whole party while it is held.', 'song/life',
    { formula: 'heal', power: 6 }),
  song('cheer-song', 'Cheer Song', 'A marching cadence. Allies gain Speed for as long as you keep singing.', 'song/cheer'),
  song('battle-song', 'Battle Song', 'A war-chant that puts weight behind every friendly swing.', 'song/battle'),
  song('magick-song', 'Magick Song', 'A resonant drone that sharpens every spell your side casts.', 'song/magick'),
  song('nameless-song', 'Nameless Song', 'A song with no words and no author. It grants a random blessing to all allies.', 'song/nameless',
    { inflicts: [inf('performing', 100), inf('protect', 25, MEDIUM), inf('shell', 25, MEDIUM), inf('haste', 25, MEDIUM), inf('regen', 25, MEDIUM), inf('reraise', 10, MEDIUM)] }),
  song('last-song', 'Last Song', 'One verse, sung once, that hands every ally their turn immediately. Then you are spent.', 'song/last',
    { mp: 60, ct: 8, formula: 'special', power: 100, inflicts: undefined }),
  song('sky-demon', 'Sky Demon', 'A dissonant note that eats away at every enemy on the field while it holds.', 'song/sky-demon',
    { formula: 'magical', power: 6, element: 'wind', accuracy: 80 }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Dancer — Dance
// ─────────────────────────────────────────────────────────────────────────────

function dance(
  id: string, name: string, description: string, vfx: string,
  extra: Partial<AbilitySpec> = {},
): AbilitySpec {
  return {
    id, name, description,
    mp: 0, ct: 0, element: 'none',
    range: FIELD, formula: 'magical', power: 6, accuracy: 80,
    vfx, castAnim: 'dance',
    inflicts: [inf('performing', 100)],
    ...extra,
  };
}

const DANCE = actions('dance', [
  dance('witch-hunt', 'Witch Hunt', 'A stamping figure that drains MP from every enemy each tick.', 'dance/witch-hunt',
    { formula: 'drain', power: 6 }),
  dance('wiznaibus', 'Wiznaibus', 'A whirling step that opens shallow wounds across the entire enemy line.', 'dance/wiznaibus',
    { formula: 'magical', power: 8 }),
  dance('slow-dance', 'Slow Dance', 'A dragging tempo that pulls at every foe\'s Speed while it continues.', 'dance/slow',
    { inflicts: [inf('performing', 100), inf('slow', 20, SHORT)] }),
  dance('polka-polka', 'Polka Polka', 'Absurd, relentless, and it steadily weakens every arm on the far side.', 'dance/polka',
    { formula: 'status-only', power: 0 }),
  dance('disillusion', 'Disillusion', 'A figure that leeches Faith from the enemy line and leaves them dull to magick.', 'dance/disillusion',
    { formula: 'status-only', power: 0, inflicts: [inf('performing', 100), inf('innocent', 20, SHORT)] }),
  dance('nameless-dance', 'Nameless Dance', 'The steps are wrong on purpose. Every enemy risks a different affliction each tick.', 'dance/nameless',
    { formula: 'status-only', power: 0, accuracy: 60,
      inflicts: [inf('performing', 100), inf('sleep', 12, SHORT), inf('confuse', 12, SHORT), inf('blind', 12, SHORT), inf('silence', 12, SHORT), inf('rooted', 12, SHORT), inf('frog', 5, SHORT)] }),
  dance('last-dance', 'Last Waltz', 'One perfect turn that empties the enemy\'s Charge Time across the whole field.', 'dance/last',
    { mp: 60, ct: 8, formula: 'special', power: 100, accuracy: 100, inflicts: undefined }),
  dance('obsidian-blade', 'Obsidian Blade', 'A knife-edged figure that strips MP away from every foe until they can cast nothing.', 'dance/obsidian',
    { formula: 'drain', power: 10, element: 'dark' }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Dark Knight — Dark Sword
// ─────────────────────────────────────────────────────────────────────────────

const DARK_SWORD = actions('dark-sword', [
  { id: 'sanguine-sword', name: 'Sanguine Sword', description: 'Pay in your own blood to drain theirs. Costs HP, returns MP.',
    range: R(3, 0, { shape: 'line', vertical: 3 }), formula: 'drain', power: 20, accuracy: 90,
    element: 'dark', vfx: 'dark/sanguine', castAnim: 'attack' },
  { id: 'night-sword', name: 'Night Sword', description: 'A black arc that takes life out of the target and puts it into you.',
    range: R(3, 0, { shape: 'line', vertical: 3 }), formula: 'drain', power: 28, accuracy: 90,
    element: 'dark', vfx: 'dark/night', castAnim: 'attack' },
  { id: 'shadowblade', name: 'Shadowblade', description: 'Cuts the target\'s aether reserve and hands the whole of it to you.',
    range: R(3, 0, { shape: 'line', vertical: 3 }), formula: 'drain', power: 24, accuracy: 85,
    element: 'dark', vfx: 'dark/shadowblade', castAnim: 'attack', inflicts: [inf('silence', 35, SHORT)] },
  { id: 'crushing-blow', name: 'Crushing Blow', description: 'A downward stroke that shatters armour and leaves it useless.',
    range: R(2, 0, { shape: 'line', vertical: 3 }), formula: 'physical', power: 4, accuracy: 70,
    element: 'dark', vfx: 'dark/crushing', castAnim: 'attack', inflicts: [inf('vulnerable', 70, MEDIUM)] },
  { id: 'infernal-strike', name: 'Infernal Strike', description: 'A vertical line of black fire that opens the ground beneath it.',
    range: R(4, 1, { shape: 'line', vertical: 3 }), formula: 'magical', power: 30, accuracy: 85,
    element: 'dark', vfx: 'dark/infernal', castAnim: 'attack', inflicts: [inf('burning', 40, SHORT)] },
  { id: 'abyssal-blade', name: 'Abyssal Blade', description: 'Cut deep enough and something on the other side reaches through.',
    range: R(3, 1, { shape: 'line', vertical: 3 }), formula: 'magical', power: 36, accuracy: 80,
    element: 'dark', vfx: 'dark/abyssal', castAnim: 'attack', inflicts: [inf('death-sentence', 20, MEDIUM)] },
  { id: 'duskblade', name: 'Duskblade', description: 'Spends a quarter of your own life to strike for a great deal more than that.',
    range: R(3, 0, { shape: 'line', vertical: 3 }), formula: 'special', power: 250, accuracy: 90,
    element: 'dark', vfx: 'dark/duskblade', castAnim: 'attack' },
  { id: 'unyielding-blade', name: 'Unyielding Blade', description: 'The knight refuses to fall while the stroke is still descending. Lands even at zero HP.',
    range: R(3, 0, { shape: 'line', vertical: 3 }), formula: 'physical', power: 5, accuracy: 100,
    element: 'dark', vfx: 'dark/unyielding', castAnim: 'attack' },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Holy Knight — Holy Sword
// ─────────────────────────────────────────────────────────────────────────────

const HOLY_SWORD = actions('holy-sword', [
  { id: 'judgment-blade', name: 'Judgment Blade', description: 'A line of light three tiles long that leaves those it touches stopped mid-step.',
    mp: 14, range: R(3, 0, { shape: 'line', vertical: 3 }), formula: 'physical', power: 3, accuracy: 85,
    element: 'holy', vfx: 'holy/judgment', castAnim: 'attack', inflicts: [inf('stop', 40, SHORT)] },
  { id: 'cleansing-strike', name: 'Cleansing Strike', description: 'A wide stroke of white fire that burns undeath and curses out of everything in its path.',
    mp: 16, range: R(3, 1, { shape: 'line', vertical: 3 }), formula: 'physical', power: 3, accuracy: 90,
    element: 'holy', vfx: 'holy/cleansing', castAnim: 'attack', inflicts: [inf('confuse', 30, SHORT)] },
  { id: 'northswain-strike', name: "Northswain's Strike", description: 'A pillar of starlight dropped on one tile from directly above.',
    mp: 20, range: R(4, 0, { vertical: 5 }), formula: 'physical', power: 4, accuracy: 90,
    element: 'holy', vfx: 'holy/northswain', castAnim: 'attack', inflicts: [inf('blind', 35, MEDIUM)] },
  { id: 'hallowed-bolt', name: 'Hallowed Bolt', description: 'Lightning called down through consecrated steel. It does not care about armour.',
    mp: 22, range: R(4, 1, { vertical: 5 }), formula: 'physical', power: 4, accuracy: 85,
    element: 'lightning', vfx: 'holy/hallowed', castAnim: 'attack', inflicts: [inf('silence', 40, SHORT)] },
  { id: 'divine-ruination', name: 'Divine Ruination', description: 'The full sword-aura, loosed in a line the length of the field. The knight\'s last argument.',
    mp: 34, range: R(6, 1, { shape: 'line', vertical: 5 }), formula: 'physical', power: 5, accuracy: 85,
    element: 'holy', vfx: 'holy/ruination', castAnim: 'attack' },
  { id: 'sanctify', name: 'Sanctify', description: 'Turn the blade flat and let the light fall on your own line instead.',
    mp: 18, range: R(0, 2, { self: true, los: false, vertical: 3 }), formula: 'heal', power: 34,
    accuracy: 100, element: 'holy', vfx: 'holy/sanctify', castAnim: 'cast',
    cures: ['undead', 'death-sentence', 'poison', 'blind'] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Divine Knight — Mighty Sword (ranged breaks)
// ─────────────────────────────────────────────────────────────────────────────

const MIGHTY_SWORD = actions('mighty-sword', [
  { id: 'shellburst-stab', name: 'Shellburst Stab', description: 'A thrust that ruptures the aether reserve at four tiles\' distance.',
    mp: 12, range: R(4, 0, { shape: 'line', vertical: 3 }), formula: 'special', power: 0, accuracy: 70,
    vfx: 'mighty/shellburst', castAnim: 'attack', inflicts: [inf('silence', 45, MEDIUM)] },
  { id: 'blastar-punch', name: 'Blastar Punch', description: 'Armour, at range, ceases to be armour.',
    mp: 12, range: R(4, 0, { shape: 'line', vertical: 3 }), formula: 'special', power: 0, accuracy: 70,
    vfx: 'mighty/blastar', castAnim: 'attack', inflicts: [inf('vulnerable', 70, MEDIUM)] },
  { id: 'hellcry-punch', name: 'Hellcry Punch', description: 'A shockwave that snaps a weapon at the tang from across the field.',
    mp: 12, range: R(4, 0, { shape: 'line', vertical: 3 }), formula: 'special', power: 0, accuracy: 65,
    vfx: 'mighty/hellcry', castAnim: 'attack' },
  { id: 'icewolf-bite', name: 'Icewolf Bite', description: 'Cold closes over the target\'s shield until it splits along the grain.',
    mp: 12, range: R(4, 0, { shape: 'line', vertical: 3 }), formula: 'special', power: 0, accuracy: 70,
    element: 'ice', vfx: 'mighty/icewolf', castAnim: 'attack', inflicts: [inf('slow', 35, SHORT)] },
  { id: 'crush-punch', name: 'Crush Punch', description: 'Not a break at all. Simply an attempt to end them outright.',
    mp: 24, range: R(3, 0, { shape: 'line', vertical: 3 }), formula: 'status-only', accuracy: 40,
    element: 'dark', vfx: 'mighty/crush', castAnim: 'attack', inflicts: [inf('ko', 100)] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Mime — Mimicry
// ─────────────────────────────────────────────────────────────────────────────

const MIMICRY = actions('mimicry', [
  { id: 'mimic', name: 'Mimic', description: 'Repeat the last action any ally took, from where you stand, at no cost. The Mime carries no gear and needs none.',
    range: SELF, formula: 'special', power: 100, accuracy: 100, vfx: 'mime/mimic', castAnim: 'cast' },
  { id: 'echo-form', name: 'Echo Form', description: 'Hold the shape of the last ally you copied, keeping their stance and their reach until you copy another.',
    range: SELF, formula: 'buff', power: 0, accuracy: 100, vfx: 'mime/echo', castAnim: 'cast',
    inflicts: [inf('empowered', 100, LONG)] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Guardian — Threat Arts
// ─────────────────────────────────────────────────────────────────────────────

const THREAT_ARTS = actions('threat-arts', [
  { id: 'taunt', name: 'Taunt', description: 'Say the one thing that guarantees they come for you instead of the mage behind you.',
    range: R(4, 0, { vertical: 4 }), formula: 'status-only', accuracy: 90, vfx: 'threat/taunt', castAnim: 'cast',
    inflicts: [inf('taunted', 100, MEDIUM)] },
  { id: 'sentinel-roar', name: 'Sentinel Roar', description: 'A bellow that drags every enemy within two tiles onto your shield.',
    mp: 12, range: AURA(2, 4), formula: 'status-only', accuracy: 75, vfx: 'threat/roar', castAnim: 'cast',
    inflicts: [inf('taunted', 100, SHORT)] },
  { id: 'rescue', name: 'Rescue', description: 'Step between an ally and what is about to happen to them. You take the next blow instead.',
    range: R(3, 0, { vertical: 3 }), formula: 'buff', vfx: 'threat/rescue', castAnim: 'defend',
    inflicts: [inf('shielded', 100, SHORT), inf('evade-next', 100, SHORT)] },
  { id: 'shield-slam', name: 'Shield Slam', description: 'Everything you have behind the boss of the shield. Loud enough to hold their attention.',
    formula: 'physical', power: 3, accuracy: 85, vfx: 'threat/slam', castAnim: 'attack',
    inflicts: [inf('taunted', 80, SHORT), inf('silence', 30, SHORT)] },
  { id: 'provoking-wound', name: 'Provoking Wound', description: 'A shallow, insulting cut that keeps bleeding and keeps them furious.',
    formula: 'physical', power: 2, accuracy: 90, vfx: 'threat/provoke', castAnim: 'attack',
    inflicts: [inf('bleeding', 90, LONG), inf('taunted', 60, MEDIUM)] },
  { id: 'bulwark', name: 'Bulwark', description: 'Set your feet and lock the shield. Physical damage arrives at a fraction of its weight.',
    mp: 10, range: SELF, formula: 'buff', vfx: 'threat/bulwark', castAnim: 'defend',
    inflicts: [inf('protect', 100, LONG), inf('shielded', 100, MEDIUM), inf('rooted', 100, SHORT)] },
  { id: 'intercept', name: 'Intercept', description: 'Close the distance in one stride and put yourself in the way of whatever comes next.',
    range: R(4, 0, { vertical: 3, los: true }), formula: 'move', power: 4, vfx: 'threat/intercept',
    castAnim: 'run', targetsTiles: true },
  { id: 'last-stand', name: 'Last Stand', description: 'Refuse to fall for a while. You cannot be reduced below one HP until it lapses.',
    mp: 30, range: SELF, formula: 'buff', vfx: 'threat/last-stand', castAnim: 'defend',
    inflicts: [inf('shielded', 100, MEDIUM), inf('empowered', 100, MEDIUM)] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Mystic — Ward Craft
// ─────────────────────────────────────────────────────────────────────────────

const WARD_CRAFT = actions('ward-craft', [
  { id: 'ancestral-ward', name: 'Ancestral Ward', description: 'A shell of borrowed ancestry that absorbs damage outright until it is spent.',
    mp: 12, ct: 3, range: R(4), formula: 'buff', power: 60, vfx: 'ward/ancestral', castAnim: 'cast',
    inflicts: [inf('shielded', 100, LONG)] },
  { id: 'umbral-barrier', name: 'Umbral Barrier', description: 'A heavier ward, laid over the entire front rank. Costly, and worth every point.',
    mp: 28, ct: 6, range: R(4, 2), formula: 'buff', power: 90, vfx: 'ward/umbral', castAnim: 'cast',
    inflicts: [inf('shielded', 100, MEDIUM)] },
  { id: 'torpor', name: 'Torpor', description: 'Thicken an enemy\'s blood until every movement costs them twice what it should.',
    mp: 16, ct: 4, range: R(4), formula: 'status-only', accuracy: 70, element: 'ice',
    vfx: 'ward/torpor', castAnim: 'cast', inflicts: [inf('slow', 100, LONG), inf('vulnerable', 50, MEDIUM)] },
  { id: 'spirit-tap', name: 'Spirit Tap', description: 'Draw on the dead crowding the field and turn what you take into a ward.',
    mp: 8, ct: 3, range: R(4), formula: 'drain', power: 20, accuracy: 80, element: 'dark',
    vfx: 'ward/spirit-tap', castAnim: 'cast' },
  { id: 'bolster', name: 'Bolster', description: 'Push an ally past their own limits: more strength, more spirit, and no time to enjoy it.',
    mp: 20, ct: 4, range: R(3), formula: 'buff', vfx: 'ward/bolster', castAnim: 'cast',
    inflicts: [inf('empowered', 100, MEDIUM), inf('haste', 100, SHORT)] },
  { id: 'transcendence', name: 'Transcendence', description: 'The great ward. Absorbs a punishing amount of damage on a single chosen ally.',
    mp: 44, ct: 8, range: R(4), formula: 'buff', power: 200, vfx: 'ward/transcendence', castAnim: 'cast',
    inflicts: [inf('shielded', 100, VERY_LONG), inf('reraise', 100)] },
  { id: 'ancestral-channel', name: 'Ancestral Channel', description: 'Open the way for the ancestors and let them mend what the ward could not stop.',
    mp: 18, ct: 5, range: R(4, 1), formula: 'heal', power: 40, element: 'holy',
    vfx: 'ward/channel', castAnim: 'cast', cures: ['bleeding', 'burning', 'poison'] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Coercer — Enthrall
// ─────────────────────────────────────────────────────────────────────────────

const ENTHRALL = actions('enthrall', [
  { id: 'mesmerize', name: 'Mesmerize', description: 'Hold a mind still. It breaks the moment anything strikes them, so choose your target.',
    mp: 14, ct: 3, range: R(5), formula: 'status-only', accuracy: 80, vfx: 'mind/mez', castAnim: 'cast',
    inflicts: [inf('sleep', 100, LONG)] },
  { id: 'mass-mesmerize', name: 'Mass Mesmerize', description: 'The same trick, spread across a formation. Slower, and far more dangerous to interrupt.',
    mp: 32, ct: 7, range: R(4, 2), formula: 'status-only', accuracy: 65, vfx: 'mind/mez-mass', castAnim: 'cast',
    inflicts: [inf('sleep', 100, MEDIUM)] },
  { id: 'dominate', name: 'Dominate', description: 'Take an enemy\'s mind outright. They fight for you until the hold slips.',
    mp: 40, ct: 8, range: R(4), formula: 'status-only', accuracy: 50, vfx: 'mind/dominate', castAnim: 'cast',
    inflicts: [inf('charm', 100, MEDIUM)] },
  { id: 'spellbind', name: 'Spellbind', description: 'Tangle the words in their throat and the feet in the dirt at the same time.',
    mp: 18, ct: 4, range: R(5), formula: 'status-only', accuracy: 75, vfx: 'mind/spellbind', castAnim: 'cast',
    inflicts: [inf('silence', 100, LONG), inf('rooted', 70, MEDIUM)] },
  { id: 'mind-blank', name: 'Mind Blank', description: 'Erase the last thirty ticks. They forget who they were about to kill.',
    mp: 16, ct: 4, range: R(5), formula: 'status-only', accuracy: 70, vfx: 'mind/blank', castAnim: 'cast',
    inflicts: [inf('confuse', 100, MEDIUM)], cures: ['taunted', 'berserk'] },
  { id: 'mana-flow', name: 'Mana Flow', description: 'Reach into another caster\'s reserve and redirect the current into your own hands.',
    mp: 0, ct: 4, range: R(4), formula: 'drain', power: 26, accuracy: 75, element: 'dark',
    vfx: 'mind/mana-flow', castAnim: 'cast' },
  { id: 'terrorize', name: 'Terrorize', description: 'Show them precisely how this ends. They run, and they do not choose the direction.',
    mp: 22, ct: 5, range: R(4, 1), formula: 'status-only', accuracy: 65, element: 'dark',
    vfx: 'mind/terror', castAnim: 'cast', inflicts: [inf('confuse', 100, SHORT), inf('slow', 60, SHORT)] },
  { id: 'breeze', name: 'Breeze', description: 'A clean, cold clarity handed to an ally. Their thoughts — and their turns — come faster.',
    mp: 14, ct: 3, range: R(4, 1), formula: 'buff', vfx: 'mind/breeze', castAnim: 'cast',
    inflicts: [inf('haste', 100, MEDIUM)], cures: ['confuse', 'sleep', 'charm'] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Beastlord — Beast Command
// ─────────────────────────────────────────────────────────────────────────────

const BEAST_COMMAND = actions('beast-command', [
  { id: 'summon-warder', name: 'Summon Warder', description: 'Call your bonded beast onto an empty tile. It fights on its own initiative until it falls.',
    mp: 24, ct: 4, range: R(3, 0, { vertical: 2, los: true }), formula: 'summon', power: 100,
    vfx: 'beast/summon', castAnim: 'cast', targetsTiles: true },
  { id: 'savage-mauling', name: 'Savage Mauling', description: 'Send the warder in with everything. It opens wounds that will not close on their own.',
    mp: 8, range: R(5, 0, { vertical: 4 }), formula: 'physical', power: 3, accuracy: 85,
    vfx: 'beast/maul', castAnim: 'cast', inflicts: [inf('bleeding', 80, LONG)] },
  { id: 'pack-tactics', name: 'Pack Tactics', description: 'You and the warder strike the same target in the same breath. Neither of you misses.',
    mp: 14, range: MELEE, formula: 'physical', power: 4, accuracy: 100, vfx: 'beast/pack', castAnim: 'attack' },
  { id: 'call-back', name: 'Call Back', description: 'A short whistle. The warder disengages and returns to your side immediately.',
    range: SELF, formula: 'move', power: 8, vfx: 'beast/recall', castAnim: 'cast' },
  { id: 'mend-companion', name: 'Mend Companion', description: 'Field surgery on something with four times your body weight and no patience.',
    mp: 12, range: R(4), formula: 'heal', power: 50, vfx: 'beast/mend', castAnim: 'item',
    cures: ['bleeding', 'poison'] },
  { id: 'enrage-warder', name: 'Enrage Warder', description: 'Let the leash out. The beast hits far harder and stops listening for a while.',
    mp: 16, range: R(4), formula: 'buff', vfx: 'beast/enrage', castAnim: 'cast',
    inflicts: [inf('empowered', 100, LONG), inf('berserk', 100, MEDIUM)] },
  { id: 'beastly-bond', name: 'Beastly Bond', description: 'Share your vitality with the warder — and its ferocity with yourself.',
    mp: 18, range: SELF, formula: 'buff', vfx: 'beast/bond', castAnim: 'cast',
    inflicts: [inf('empowered', 100, LONG), inf('regen', 100, MEDIUM)] },
  { id: 'harrying-strike', name: 'Harrying Strike', description: 'The warder circles and snaps at the heels, pinning a foe where you want them.',
    mp: 10, range: R(5, 0, { vertical: 4 }), formula: 'physical', power: 2, accuracy: 85,
    vfx: 'beast/harry', castAnim: 'cast', inflicts: [inf('rooted', 70, MEDIUM)] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Warlock — Affliction (damage over time)
// ─────────────────────────────────────────────────────────────────────────────

const AFFLICTION = actions('affliction', [
  { id: 'corruption', name: 'Corruption', description: 'Rot set into the target\'s aether. Cheap, instant, and it never stops working.',
    mp: 8, ct: 0, range: R(5), formula: 'magical', power: 6, accuracy: 90, element: 'dark',
    vfx: 'dot/corruption', castAnim: 'cast', inflicts: [inf('poison', 100, LONG)] },
  { id: 'agony', name: 'Agony', description: 'A curse that grows heavier the longer it is left alone.',
    mp: 14, ct: 3, range: R(5), formula: 'magical', power: 10, accuracy: 85, element: 'dark',
    vfx: 'dot/agony', castAnim: 'cast', inflicts: [inf('poison', 100, VERY_LONG), inf('vulnerable', 60, LONG)] },
  { id: 'immolation', name: 'Immolation', description: 'Set them alight from the inside. The burning outlasts the casting by some margin.',
    mp: 16, ct: 4, range: R(5, 1), formula: 'magical', power: 16, accuracy: 90, element: 'fire',
    vfx: 'dot/immolate', castAnim: 'cast', inflicts: [inf('burning', 100, LONG)] },
  { id: 'unstable-affliction', name: 'Unstable Affliction', description: 'A curse rigged to detonate. Dispelling it silences whoever tried.',
    mp: 22, ct: 5, range: R(5), formula: 'magical', power: 14, accuracy: 85, element: 'dark',
    vfx: 'dot/unstable', castAnim: 'cast',
    inflicts: [inf('poison', 100, LONG), inf('silence', 40, MEDIUM)] },
  { id: 'curse-of-doom', name: 'Curse of Doom', description: 'Nothing happens for a long time. Then a great deal happens at once.',
    mp: 30, ct: 6, range: R(5), formula: 'magical', power: 48, accuracy: 75, element: 'dark',
    vfx: 'dot/doom', castAnim: 'cast', inflicts: [inf('death-sentence', 70, LONG)] },
  { id: 'drain-life', name: 'Drain Life', description: 'A steady thread of stolen vitality, running the wrong way down the battlefield.',
    mp: 18, ct: 4, range: R(4), formula: 'drain', power: 26, accuracy: 90, element: 'dark',
    vfx: 'dot/drain-life', castAnim: 'cast' },
  { id: 'shadow-plague', name: 'Shadow Plague', description: 'It spreads. Everyone standing near the first victim gets a share of it.',
    mp: 34, ct: 7, range: R(5, 2), formula: 'magical', power: 18, accuracy: 80, element: 'dark',
    vfx: 'dot/plague', castAnim: 'cast',
    inflicts: [inf('poison', 90, LONG), inf('blind', 45, MEDIUM)] },
  { id: 'harvest', name: 'Harvest', description: 'Rip every curse you have laid out of the target at once, all at their full remaining value.',
    mp: 26, ct: 3, range: R(5), formula: 'special', power: 150, accuracy: 100, element: 'dark',
    vfx: 'dot/harvest', castAnim: 'cast',
    cures: ['poison', 'burning', 'bleeding'] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Assassin — Subterfuge (combo points)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builders add a `mark` stack to the target; finishers consume every stack.
 * `combat/` reads `COMBO_BUILDERS` / `COMBO_FINISHERS` to apply the scaling.
 */
const SUBTERFUGE = actions('subterfuge', [
  { id: 'sinister-strike', name: 'Sinister Strike', description: 'A fast, unremarkable stab whose only purpose is to set up the next one. Builder.',
    formula: 'physical', power: 2, accuracy: 95, vfx: 'combo/sinister', castAnim: 'attack',
    inflicts: [inf('mark', 100, LONG)] },
  { id: 'hemorrhage', name: 'Hemorrhage', description: 'Open a vein and leave it open. Builder, and it bleeds them meanwhile.',
    mp: 4, formula: 'physical', power: 2, accuracy: 90, vfx: 'combo/hemorrhage', castAnim: 'attack',
    inflicts: [inf('mark', 100, LONG), inf('bleeding', 80, MEDIUM)] },
  { id: 'garrote', name: 'Garrote', description: 'Wire from behind. Builder, and they will not be casting anything for a while.',
    mp: 6, formula: 'physical', power: 2, accuracy: 85, vfx: 'combo/garrote', castAnim: 'attack',
    inflicts: [inf('mark', 100, LONG), inf('silence', 70, MEDIUM)] },
  { id: 'cheap-shot', name: 'Cheap Shot', description: 'Pommel to the temple from stealth. Builder, and it takes their next turn away.',
    mp: 8, formula: 'physical', power: 1, accuracy: 90, vfx: 'combo/cheap-shot', castAnim: 'attack',
    inflicts: [inf('mark', 100, LONG), inf('stop', 60, SHORT)] },
  { id: 'shadowstep', name: 'Shadowstep', description: 'Cross to the far side of a target in one movement and arrive unseen. Builder.',
    mp: 10, range: R(4, 0, { vertical: 3 }), formula: 'move', power: 4, vfx: 'combo/shadowstep',
    castAnim: 'run', targetsTiles: true, inflicts: [inf('stealth', 100, SHORT)] },
  { id: 'eviscerate', name: 'Eviscerate', description: 'Spend every opening you have made in one upward cut. Finisher.',
    formula: 'physical', power: 3, accuracy: 95, vfx: 'combo/eviscerate', castAnim: 'attack',
    cures: ['mark'] },
  { id: 'kidney-strike', name: 'Kidney Strike', description: 'Finisher. The longer you set it up, the longer they spend on the ground.',
    mp: 8, formula: 'physical', power: 2, accuracy: 90, vfx: 'combo/kidney', castAnim: 'attack',
    inflicts: [inf('stop', 100, MEDIUM)], cures: ['mark'] },
  { id: 'rupture', name: 'Rupture', description: 'Finisher. Converts every opening into a bleed that runs for the rest of the fight.',
    mp: 10, formula: 'physical', power: 2, accuracy: 90, vfx: 'combo/rupture', castAnim: 'attack',
    inflicts: [inf('bleeding', 100, VERY_LONG)], cures: ['mark'] },
  { id: 'deadly-crescendo', name: 'Deadly Crescendo', description: 'Finisher. At full marks it is simply lethal; below that it is merely brutal.',
    mp: 20, formula: 'special', power: 400, accuracy: 85, element: 'dark',
    vfx: 'combo/crescendo', castAnim: 'attack', cures: ['mark'] },
]);

export const COMBO_BUILDERS: readonly AbilityId[] = [
  'sinister-strike', 'hemorrhage', 'garrote', 'cheap-shot', 'shadowstep',
];
export const COMBO_FINISHERS: readonly AbilityId[] = [
  'eviscerate', 'kidney-strike', 'rupture', 'deadly-crescendo',
];
/** Maximum `mark` stacks a target can carry. */
export const MAX_COMBO_POINTS = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Berserker — Stances
// ─────────────────────────────────────────────────────────────────────────────

/** Only one stance may be held at a time; applying one cancels the others. */
function stance(id: string, name: string, description: string, extra: Partial<AbilitySpec> = {}): AbilitySpec {
  return {
    id, name, description,
    mp: 0, ct: 0, element: 'none', range: SELF,
    formula: 'buff', power: 1, accuracy: 100,
    vfx: `stance/${id}`, castAnim: 'defend',
    ...extra,
  };
}

const STANCES = actions('stances', [
  stance('berserker-stance', 'Berserker Stance',
    'All weight forward. Half again the damage dealt, and half again the damage taken.',
    { inflicts: [inf('empowered', 100, VERY_LONG), inf('vulnerable', 100, VERY_LONG)] }),
  stance('defensive-stance', 'Defensive Stance',
    'Weight back, guard high. Damage taken falls sharply; so does everything you deal.',
    { inflicts: [inf('protect', 100, VERY_LONG), inf('shell', 100, VERY_LONG)] }),
  stance('reckless-stance', 'Reckless Stance',
    'Stop defending entirely. You never evade again, but nothing you swing at is safe.',
    { inflicts: [inf('empowered', 100, VERY_LONG), inf('berserk', 100, VERY_LONG)] }),
  stance('tactical-stance', 'Tactical Stance',
    'Measured footwork. Accuracy and Speed rise; raw damage does not.',
    { inflicts: [inf('haste', 100, VERY_LONG), inf('evade-next', 100, MEDIUM)] }),
  stance('warlord-cry', 'Warlord\'s Cry',
    'Break stance and roar. Every ally within three tiles takes the stance\'s benefit for a while.',
    { mp: 20, range: AURA(3), inflicts: [inf('empowered', 100, MEDIUM), inf('haste', 100, SHORT)] }),
  stance('unbreakable', 'Unbreakable',
    'Refuse the concept of a killing blow. Damage cannot reduce you below one HP while it holds.',
    { mp: 28, inflicts: [inf('shielded', 100, MEDIUM), inf('protect', 100, MEDIUM)] }),
]);

export const STANCE_ABILITIES: readonly AbilityId[] = [
  'berserker-stance', 'defensive-stance', 'reckless-stance', 'tactical-stance',
];

// ─────────────────────────────────────────────────────────────────────────────
// Shaman — Totemcraft
// ─────────────────────────────────────────────────────────────────────────────

/** Totems occupy a tile, act on their own, and can be destroyed. */
function totem(
  id: string, name: string, description: string, mp: number, element: Element,
  extra: Partial<AbilitySpec> = {},
): AbilitySpec {
  return {
    id, name, description, mp, ct: 2, element,
    range: R(3, 0, { vertical: 2, los: true }),
    formula: 'summon', power: 40, accuracy: 100,
    vfx: `totem/${id}`, castAnim: 'cast', targetsTiles: true,
    ...extra,
  };
}

const TOTEMCRAFT = actions('totemcraft', [
  totem('searing-totem', 'Searing Totem',
    'A carved post that spits fire at the nearest enemy every tick until something knocks it over.',
    12, 'fire', { power: 12 }),
  totem('stoneskin-totem', 'Stoneskin Totem',
    'Grants Protect to every ally within two tiles for as long as it stands.',
    16, 'earth', { formula: 'summon', power: 0, inflicts: [inf('protect', 100, LONG)] }),
  totem('cleansing-totem', 'Cleansing Totem',
    'Pulls one affliction off each nearby ally every few ticks. Quietly indispensable.',
    18, 'water', { power: 0, cures: ['poison', 'blind', 'silence', 'bleeding', 'burning'] }),
  totem('windfury-totem', 'Windfury Totem',
    'The air around it moves wrong. Nearby allies strike faster and more often.',
    22, 'wind', { power: 0, inflicts: [inf('haste', 100, LONG), inf('empowered', 100, MEDIUM)] }),
  totem('mana-tide-totem', 'Mana Tide Totem',
    'A slow spring of aether. Restores MP to every ally who stays near it.',
    20, 'water', { power: 8 }),
  totem('earthbind-totem', 'Earthbind Totem',
    'Roots grasp at every enemy within two tiles. Nothing walks past it comfortably.',
    14, 'earth', { power: 0, accuracy: 75, inflicts: [inf('rooted', 80, MEDIUM), inf('slow', 60, MEDIUM)] }),
  totem('totemic-recall', 'Totemic Recall',
    'Shatter your own totems and take the unspent spirit back into yourself.',
    0, 'none', { range: SELF, formula: 'special', power: 60, ct: 0, targetsTiles: false }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Paladin — Auras
// ─────────────────────────────────────────────────────────────────────────────

/** One aura at a time; each is a persistent self-centred field. */
function auraSpec(
  id: string, name: string, description: string, mp: number, element: Element,
  extra: Partial<AbilitySpec> = {},
): AbilitySpec {
  return {
    id, name, description, mp, ct: 0, element,
    range: AURA(2),
    formula: 'buff', power: 1, accuracy: 100,
    vfx: `aura/${id}`, castAnim: 'cast',
    ...extra,
  };
}

const AURAS = actions('auras', [
  auraSpec('devotion-aura', 'Devotion Aura',
    'A standing field of protection. Every ally in it takes physical damage at reduced weight.',
    12, 'holy', { inflicts: [inf('protect', 100, VERY_LONG)] }),
  auraSpec('retribution-aura', 'Retribution Aura',
    'Holy fire answers on your allies\' behalf. Anyone who strikes them is burned for it.',
    14, 'holy', { inflicts: [inf('empowered', 100, VERY_LONG)] }),
  auraSpec('concentration-aura', 'Concentration Aura',
    'Steadies every mind in range. Spells are not interrupted and silence does not take hold.',
    14, 'holy', { cures: ['silence', 'confuse', 'sleep'], inflicts: [inf('shell', 100, VERY_LONG)] }),
  auraSpec('sanctity-aura', 'Sanctity Aura',
    'Consecrated ground. Undead within it burn steadily and cannot bear to remain.',
    16, 'holy', { formula: 'magical', power: 12, accuracy: 90, inflicts: [inf('burning', 40, SHORT)] }),
  auraSpec('crusader-aura', 'Crusader Aura',
    'A marching field. Every ally in range moves a tile further and arrives sooner.',
    12, 'holy', { inflicts: [inf('haste', 100, VERY_LONG)] }),
  auraSpec('aura-mastery', 'Aura Mastery',
    'Blaze the current aura at double strength across four tiles for a short, glorious while.',
    30, 'holy', { range: AURA(4), inflicts: [inf('empowered', 100, MEDIUM), inf('shielded', 100, MEDIUM)] }),
]);

export const AURA_ABILITIES: readonly AbilityId[] = [
  'devotion-aura', 'retribution-aura', 'concentration-aura', 'sanctity-aura', 'crusader-aura',
];

// ─────────────────────────────────────────────────────────────────────────────
// Death Knight — Runic Strike
// ─────────────────────────────────────────────────────────────────────────────

const RUNIC_STRIKE = actions('runic-strike', [
  { id: 'blood-strike', name: 'Blood Strike', description: 'A blood rune spent through the edge. What it takes out of them goes into you.',
    mp: 6, formula: 'drain', power: 18, accuracy: 95, element: 'dark',
    vfx: 'rune/blood', castAnim: 'attack' },
  { id: 'frost-strike', name: 'Frost Strike', description: 'A frost rune, discharged on contact. The cold gets into the joints and stays.',
    mp: 10, formula: 'physical', power: 3, accuracy: 90, element: 'ice',
    vfx: 'rune/frost', castAnim: 'attack', inflicts: [inf('slow', 70, MEDIUM)] },
  { id: 'unholy-blight', name: 'Unholy Blight', description: 'A cloud of grave-rot around the blade that spreads to everything adjacent.',
    mp: 16, range: AURA(1, 2), formula: 'magical', power: 18, accuracy: 85, element: 'dark',
    vfx: 'rune/blight', castAnim: 'attack', inflicts: [inf('poison', 80, LONG)] },
  { id: 'death-coil', name: 'Death Coil', description: 'A whip of dark energy at range. It wounds the living and mends the undead.',
    mp: 18, ct: 2, range: R(4, 0, { vertical: 4 }), formula: 'magical', power: 26, accuracy: 90,
    element: 'dark', vfx: 'rune/coil', castAnim: 'cast' },
  { id: 'rune-tap', name: 'Rune Tap', description: 'Break one of your own runes and turn it straight into closed wounds.',
    mp: 0, range: SELF, formula: 'heal', power: 45, vfx: 'rune/tap', castAnim: 'cast' },
  { id: 'howling-blast', name: 'Howling Blast', description: 'The frost rune, released all at once, across a wide circle of ground.',
    mp: 30, ct: 5, range: R(4, 2, { vertical: 4 }), formula: 'magical', power: 30, accuracy: 85,
    element: 'ice', vfx: 'rune/howling', castAnim: 'cast', inflicts: [inf('rooted', 50, SHORT)] },
  { id: 'marked-for-death', name: 'Marked for Death', description: 'Carve a rune into a foe. Every blow that lands on them afterward lands harder.',
    mp: 12, range: R(4), formula: 'status-only', accuracy: 85, element: 'dark',
    vfx: 'rune/mark', castAnim: 'cast', inflicts: [inf('vulnerable', 100, LONG), inf('mark', 100, LONG)] },
  { id: 'raise-thrall', name: 'Raise Thrall', description: 'Stand a corpse back up on the tile where it fell and set it against its own side.',
    mp: 36, ct: 6, range: R(3, 0, { vertical: 2 }), formula: 'summon', power: 80, accuracy: 100,
    element: 'dark', vfx: 'rune/thrall', castAnim: 'cast', targetsTiles: true },
]);

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate
// ─────────────────────────────────────────────────────────────────────────────

/** Every action ability, in set order. */
export const ACTION_ABILITIES: readonly Ability[] = [
  ...BASIC_SKILL,
  ...ITEM,
  ...BATTLE_SKILL,
  ...CHARGE,
  ...PUNCH_ART,
  ...WHITE_MAGICK,
  ...BLACK_MAGICK,
  ...TIME_MAGICK,
  ...SUMMON_MAGICK,
  ...STEAL,
  ...SNATCH,
  ...TALK_SKILL,
  ...YIN_YANG,
  ...GEOMANCY,
  ...JUMP,
  ...DRAW_OUT,
  ...THROW,
  ...MATH_SKILL,
  ...SING,
  ...DANCE,
  ...DARK_SWORD,
  ...HOLY_SWORD,
  ...MIGHTY_SWORD,
  ...MIMICRY,
  ...THREAT_ARTS,
  ...WARD_CRAFT,
  ...ENTHRALL,
  ...BEAST_COMMAND,
  ...AFFLICTION,
  ...SUBTERFUGE,
  ...STANCES,
  ...TOTEMCRAFT,
  ...AURAS,
  ...RUNIC_STRIKE,
];

/**
 * Best-guess job → action set mapping, offered so `jobs/` and the UI agree even
 * though the job table is authored separately. Consumers should treat
 * `Job.actionSet` as authoritative and fall back to this only when it is missing.
 */
export const JOB_ACTION_SETS: Readonly<Record<JobId, AbilitySetId>> = {
  // FFT line
  squire: 'basic-skill',
  chemist: 'item',
  knight: 'battle-skill',
  archer: 'charge',
  monk: 'punch-art',
  'white-mage': 'white-magick',
  'black-mage': 'black-magick',
  'time-mage': 'time-magick',
  summoner: 'summon-magick',
  thief: 'steal',
  rogue: 'snatch',
  orator: 'talk-skill',
  mediator: 'talk-skill',
  oracle: 'yin-yang-magick',
  mystic: 'yin-yang-magick',
  geomancer: 'geomancy',
  dragoon: 'jump',
  lancer: 'jump',
  samurai: 'draw-out',
  ninja: 'throw',
  arithmetician: 'math-skill',
  calculator: 'math-skill',
  bard: 'sing',
  dancer: 'dance',
  'dark-knight': 'dark-sword',
  'holy-knight': 'holy-sword',
  'divine-knight': 'mighty-sword',
  mime: 'mimicry',
  // EQ2 / WoW line
  guardian: 'threat-arts',
  warrior: 'threat-arts',
  paladin: 'auras',
  templar: 'auras',
  shaman: 'totemcraft',
  defiler: 'ward-craft',
  coercer: 'enthrall',
  illusionist: 'enthrall',
  beastlord: 'beast-command',
  hunter: 'beast-command',
  warlock: 'affliction',
  necromancer: 'affliction',
  assassin: 'subterfuge',
  brigand: 'subterfuge',
  swashbuckler: 'subterfuge',
  berserker: 'stances',
  'death-knight': 'runic-strike',
  shadowknight: 'runic-strike',
};

/** Set id for a job, using the job table's own value when one is supplied. */
export function actionSetForJob(job: JobId, declared?: AbilitySetId): AbilitySetId | undefined {
  if (declared !== undefined) {
    const resolved = resolveSetId(declared);
    if (resolved !== undefined) return resolved;
  }
  const guess = JOB_ACTION_SETS[job];
  if (guess !== undefined) return guess;
  return resolveSetId(job);
}
