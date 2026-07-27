/**
 * EverTactics — support and movement abilities.
 *
 * These are passives: they never appear in the action menu, they sit in
 * `Unit.support` / `Unit.movement` and are read by `combat/`, `grid.ts` and
 * `unit.ts` when deriving stats, evaluating equipment or building move ranges.
 *
 * `power` is the passive's magnitude in whatever unit the effect uses (percent,
 * tiles, half-tiles), and `SUPPORT_EFFECTS` / `MOVEMENT_EFFECTS` give a machine-
 * readable description so consumers do not have to switch on ability ids.
 */

import type { Ability, AbilityId, EquipCategory } from '../types';
import { defineAbilities, inf, R, SELF, type AbilitySpec } from './sets';

// ─────────────────────────────────────────────────────────────────────────────
// Machine-readable effect descriptors
// ─────────────────────────────────────────────────────────────────────────────

export type SupportEffectKind =
  | 'dual-wield'          // attack with both hands
  | 'two-hand'            // one-hand weapon held in two, damage x1.5
  | 'martial-arts'        // bare-hand damage scales with PA
  | 'stat-percent'        // percent modifier to a derived stat
  | 'equip-category'      // may equip an otherwise-forbidden category
  | 'equip-any'           // may equip anything
  | 'throw-item'          // items gain range
  | 'half-mp'             // MP costs halved
  | 'no-charge'           // charge times removed
  | 'jp-boost'            // JP gain increased
  | 'gil-boost'           // gil/loot gain increased
  | 'defend-bonus'        // defensive passive
  | 'threat-modifier'     // generates more or less threat
  | 'combo-retention'     // keeps combo points between targets
  | 'pet-boost'           // summoned companions gain stats
  | 'dot-boost'           // damage-over-time effects last longer / hit harder
  | 'aura-radius'         // auras and songs reach further
  | 'ward-boost';         // absorb shields are larger

export interface SupportEffect {
  readonly ability: AbilityId;
  readonly kind: SupportEffectKind;
  /** Magnitude — percent for `stat-percent`, tiles for radius effects, etc. */
  readonly value: number;
  /** Which stat a `stat-percent` effect touches. */
  readonly stat?: 'pa' | 'ma' | 'hp' | 'mp' | 'spd' | 'defense' | 'mdefense' | 'accuracy' | 'evade';
  /** Which categories an `equip-category` effect unlocks. */
  readonly categories?: readonly EquipCategory[];
}

export type MovementEffectKind =
  | 'move-bonus'
  | 'jump-bonus'
  | 'ignore-height'
  | 'ignore-terrain'
  | 'teleport'
  | 'walk-on-water'
  | 'walk-on-lava'
  | 'fly'
  | 'move-hp-up'
  | 'move-mp-up'
  | 'move-find-item'
  | 'move-gain-jp'
  | 'no-reaction'          // movement provokes nothing, cannot be blocked
  | 'move-through-units';

export interface MovementEffect {
  readonly ability: AbilityId;
  readonly kind: MovementEffectKind;
  readonly value: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Support abilities
// ─────────────────────────────────────────────────────────────────────────────

function passive(
  id: string, name: string, description: string, vfx: string,
  extra: Partial<AbilitySpec> = {},
): AbilitySpec {
  return {
    id, name, description,
    mp: 0, ct: 0, element: 'none', range: SELF,
    formula: 'buff', power: 0, accuracy: 100,
    vfx, ...extra,
  };
}

const SUPPORT_SPECS: readonly AbilitySpec[] = [
  passive('two-swords', 'Dual Wield',
    'Carry a weapon in each hand and swing both. The single most powerful passive in the book, and priced accordingly.',
    'support/dual-wield', { power: 2 }),
  passive('two-hands', 'Two Hands',
    'Grip a one-handed weapon in both fists. No shield, but the blow lands at half again its weight.',
    'support/two-hands', { power: 150 }),
  passive('martial-arts', 'Martial Arts',
    'Bare hands stop being a handicap. Unarmed damage scales fully with Attack.',
    'support/martial-arts', { power: 150 }),
  passive('attack-up', 'Attack Up',
    'Endless drill on the training yard. Physical damage rises by a fifth.',
    'support/attack-up', { power: 120, castAnim: 'attack' }),
  passive('magick-attack-up', 'Magick Attack Up',
    'Sharper focus, cleaner incantation. Spell damage rises by a fifth.',
    'support/magick-up', { power: 120, castAnim: 'cast' }),
  passive('defense-up', 'Defense Up',
    'You have learned where blows land. Physical damage taken falls by a fifth.',
    'support/defense-up', { power: 80 }),
  passive('magick-defense-up', 'Magick Defense Up',
    'Resistance drilled into the marrow. Spell damage taken falls by a fifth.',
    'support/mdefense-up', { power: 80 }),
  passive('hp-boost', 'HP Boost',
    'Hard living and harder training. Maximum HP rises by a quarter.',
    'support/hp-boost', { power: 125 }),
  passive('mp-boost', 'MP Boost',
    'A deeper reservoir of aether. Maximum MP rises by a third.',
    'support/mp-boost', { power: 133 }),
  passive('half-mp', 'Half MP',
    'Perfect economy of casting. Every spell costs half what it should.',
    'support/half-mp', { power: 50 }),
  passive('short-charge', 'Short Charge',
    'Compress the incantation. Charge times fall to a third — the mage\'s single best purchase.',
    'support/short-charge', { power: 33 }),
  passive('no-charge', 'Swiftcast',
    'No charge time at all, at a steep cost to the spell\'s force.',
    'support/swiftcast', { power: 0 }),
  passive('concentrate', 'Concentration',
    'Ignore evasion entirely. If it can be hit, you hit it.',
    'support/concentrate', { power: 100 }),
  passive('throw-item', 'Throw Item',
    'Items are thrown rather than handed over. Range becomes irrelevant.',
    'support/throw-item', { power: 4 }),
  passive('safeguard', 'Safeguard',
    'Your gear cannot be stolen or broken. Knights hate you.',
    'support/safeguard', { power: 100 }),
  passive('equip-sword', 'Equip Sword',
    'Train with the arming sword until it stops caring what your job title is.',
    'support/equip-sword'),
  passive('equip-axe', 'Equip Axe',
    'Axes, flails, hammers — anything with momentum and a bad attitude.',
    'support/equip-axe'),
  passive('equip-spear', 'Equip Spear',
    'Reach, leverage, and the discipline to keep the point up.',
    'support/equip-spear'),
  passive('equip-bow', 'Equip Bow',
    'The draw, the hold, the loose. Bows and crossbows both.',
    'support/equip-bow'),
  passive('equip-gun', 'Equip Gun',
    'Machinist\'s licence. Range that ignores height and armour alike.',
    'support/equip-gun'),
  passive('equip-katana', 'Equip Katana',
    'Katana, and the etiquette that comes attached to carrying one.',
    'support/equip-katana'),
  passive('equip-armor', 'Equip Heavy Armor',
    'Plate and mail on a frame that was never meant for it. Worth the weight.',
    'support/equip-armor'),
  passive('equip-robe', 'Equip Robe',
    'Mage\'s robes and their attendant resistances, on anyone.',
    'support/equip-robe'),
  passive('equip-shield', 'Equip Shield',
    'A shield in the off hand, whatever the job manual says about it.',
    'support/equip-shield'),
  passive('equip-change', 'Equip Change',
    'Swap gear as a free action and still take your turn.',
    'support/equip-change'),
  passive('maintenance', 'Maintenance',
    'Straps checked, buckles doubled. Nothing you wear comes off in a fight.',
    'support/maintenance'),
  passive('gained-jp-up', 'JP Boost',
    'You learn from every exchange. Job Points earned rise by half.',
    'support/jp-up', { power: 150 }),
  passive('gained-exp-up', 'EXP Boost',
    'Experience gained rises by half. Levels arrive noticeably faster.',
    'support/exp-up', { power: 150 }),
  passive('treasure-hunter', 'Treasure Hunter',
    'You find things. Gil and loot from every battle increase substantially.',
    'support/treasure', { power: 150 }),
  passive('defense-boost', 'Sentinel',
    'Defending is not a wasted turn for you. Guarding halves all damage instead of reducing it.',
    'support/sentinel', { power: 50, castAnim: 'defend' }),
  // ── EQ2 / WoW lineage ────────────────────────────────────────────────────
  passive('vehement-threat', 'Vehement Threat',
    'Everything you do reads as an insult. Threat generated is doubled — indispensable, and dangerous.',
    'support/threat-up', { power: 200 }),
  passive('subtlety', 'Subtlety',
    'Kill quietly. Threat generated is halved, and nobody looks at the assassin.',
    'support/threat-down', { power: 50, inflicts: [inf('stealth', 100)] }),
  passive('relentless-combo', 'Relentless Combo',
    'Combo points survive a target\'s death and carry to the next one.',
    'support/combo-retention', { power: 100 }),
  passive('virulence', 'Virulence',
    'Every damage-over-time you apply runs half again as long and half again as hard.',
    'support/virulence', { power: 150 }),
  passive('warder-bond', 'Warder\'s Bond',
    'Your summoned companion inherits half your stats instead of a third, and dies far less often.',
    'support/warder-bond', { power: 150 }),
  passive('resonant-aura', 'Resonant Aura',
    'Auras, songs and dances reach two tiles further than they have any right to.',
    'support/resonant', { power: 2 }),
  passive('greater-wards', 'Greater Wards',
    'Every absorb shield you cast is half again as large.',
    'support/greater-wards', { power: 150 }),
  passive('runic-focus', 'Runic Focus',
    'Runes recharge as you strike. Rune-powered abilities cost a third less.',
    'support/runic-focus', { power: 66 }),
  passive('totemic-mastery', 'Totemic Mastery',
    'Two totems may stand at once, and both are considerably harder to knock down.',
    'support/totemic-mastery', { power: 2 }),
  passive('unyielding-will', 'Unyielding Will',
    'Ailments that would disable you land at half duration. Stubbornness as a discipline.',
    'support/unyielding', { power: 50 }),
  passive('darkness-toll', 'Darkness Toll',
    'Every Dark Sword stroke is paid for in your own blood — and the less of it you have left, the harder the next one lands.',
    'support/darkness-toll', { power: 150 }),
  passive('covenant-of-dread', 'Covenant of Dread',
    'The oath pays in the currency it is owed: every wound taken becomes Dread, and Dread becomes somebody else\'s blood.',
    'support/covenant', { power: 25 }),
  passive('domination', 'Domination',
    'The upkeep pool every charm drains from. A larger reservoir, and minds held a good deal longer before they slip.',
    'support/domination', { power: 150 }),
  passive('soul-harvest', 'Soul Harvest',
    'Anything that dies still carrying your curses leaves a shard behind. You will always have one when it matters.',
    'support/soul-harvest', { power: 100 }),
  passive('funeral-rites', 'Funeral Rites',
    'You keep the roll of the dead, and reading a name off it aloud makes every mark you have placed bite deeper.',
    'support/funeral-rites', { power: 125 }),
  passive('onion-mastery', 'Onion Mastery',
    'Every job taken to mastery adds a percent to all five multipliers, permanently and cumulatively. Worthless early, terrifying late.',
    'support/onion-mastery', { power: 100 }),
  passive('shapeshift', 'Shapeshift',
    'Changing form costs neither your move nor your action, once each turn. Nothing else in the roster gets a free action.',
    'support/shapeshift', { power: 1 }),
  // ── The Mime's two rules, expressed as passives rather than engine flags ──
  passive('bare-mimicry', 'Bare Mimicry',
    'You carry nothing and are paid for it: with no equipment at all, every stat multiplier you have is the highest in the game.',
    'support/bare-mimicry', { power: 140 }),
  passive('sole-command', 'Sole Command',
    'No secondary command, no reaction, no support but this one. Everything you do, you do by copying somebody who could.',
    'support/sole-command', { power: 100 }),
];

export const SUPPORT_ABILITIES: readonly Ability[] = defineAbilities('support', 'support', SUPPORT_SPECS);

const SUPPORT_EFFECT_LIST: readonly SupportEffect[] = [
  { ability: 'two-swords', kind: 'dual-wield', value: 2 },
  { ability: 'two-hands', kind: 'two-hand', value: 150 },
  { ability: 'martial-arts', kind: 'martial-arts', value: 150 },
  { ability: 'attack-up', kind: 'stat-percent', value: 120, stat: 'pa' },
  { ability: 'magick-attack-up', kind: 'stat-percent', value: 120, stat: 'ma' },
  { ability: 'defense-up', kind: 'stat-percent', value: 80, stat: 'defense' },
  { ability: 'magick-defense-up', kind: 'stat-percent', value: 80, stat: 'mdefense' },
  { ability: 'hp-boost', kind: 'stat-percent', value: 125, stat: 'hp' },
  { ability: 'mp-boost', kind: 'stat-percent', value: 133, stat: 'mp' },
  { ability: 'half-mp', kind: 'half-mp', value: 50 },
  { ability: 'short-charge', kind: 'no-charge', value: 33 },
  { ability: 'no-charge', kind: 'no-charge', value: 0 },
  { ability: 'concentrate', kind: 'stat-percent', value: 100, stat: 'accuracy' },
  { ability: 'throw-item', kind: 'throw-item', value: 4 },
  { ability: 'safeguard', kind: 'defend-bonus', value: 100 },
  { ability: 'equip-sword', kind: 'equip-category', value: 1, categories: ['sword', 'knightsword'] },
  { ability: 'equip-axe', kind: 'equip-category', value: 1, categories: ['axe', 'hammer', 'flail'] },
  { ability: 'equip-spear', kind: 'equip-category', value: 1, categories: ['spear'] },
  { ability: 'equip-bow', kind: 'equip-category', value: 1, categories: ['bow', 'crossbow'] },
  { ability: 'equip-gun', kind: 'equip-category', value: 1, categories: ['gun'] },
  { ability: 'equip-katana', kind: 'equip-category', value: 1, categories: ['katana'] },
  { ability: 'equip-armor', kind: 'equip-category', value: 1, categories: ['armor', 'helm'] },
  { ability: 'equip-robe', kind: 'equip-category', value: 1, categories: ['robe', 'hat'] },
  { ability: 'equip-shield', kind: 'equip-category', value: 1, categories: ['shield'] },
  { ability: 'equip-change', kind: 'equip-any', value: 1 },
  { ability: 'maintenance', kind: 'defend-bonus', value: 100 },
  { ability: 'gained-jp-up', kind: 'jp-boost', value: 150 },
  { ability: 'gained-exp-up', kind: 'jp-boost', value: 150 },
  { ability: 'treasure-hunter', kind: 'gil-boost', value: 150 },
  { ability: 'defense-boost', kind: 'defend-bonus', value: 50 },
  { ability: 'vehement-threat', kind: 'threat-modifier', value: 200 },
  { ability: 'subtlety', kind: 'threat-modifier', value: 50 },
  { ability: 'relentless-combo', kind: 'combo-retention', value: 100 },
  { ability: 'virulence', kind: 'dot-boost', value: 150 },
  { ability: 'warder-bond', kind: 'pet-boost', value: 150 },
  { ability: 'resonant-aura', kind: 'aura-radius', value: 2 },
  { ability: 'greater-wards', kind: 'ward-boost', value: 150 },
  { ability: 'runic-focus', kind: 'half-mp', value: 66 },
  { ability: 'totemic-mastery', kind: 'pet-boost', value: 200 },
  { ability: 'unyielding-will', kind: 'defend-bonus', value: 50 },
  { ability: 'darkness-toll', kind: 'stat-percent', value: 150, stat: 'pa' },
  { ability: 'covenant-of-dread', kind: 'threat-modifier', value: 125 },
  { ability: 'domination', kind: 'aura-radius', value: 150 },
  { ability: 'soul-harvest', kind: 'dot-boost', value: 100 },
  { ability: 'funeral-rites', kind: 'dot-boost', value: 125 },
  { ability: 'onion-mastery', kind: 'stat-percent', value: 100, stat: 'pa' },
  { ability: 'shapeshift', kind: 'combo-retention', value: 1 },
  { ability: 'bare-mimicry', kind: 'stat-percent', value: 140, stat: 'hp' },
  { ability: 'sole-command', kind: 'defend-bonus', value: 100 },
];

export const SUPPORT_EFFECTS: ReadonlyMap<AbilityId, SupportEffect> = new Map(
  SUPPORT_EFFECT_LIST.map((e) => [e.ability, e]),
);

// ─────────────────────────────────────────────────────────────────────────────
// Movement abilities
// ─────────────────────────────────────────────────────────────────────────────

const MOVEMENT_SPECS: readonly AbilitySpec[] = [
  passive('move-plus-1', 'Move +1', 'One more tile of ground per turn. Never a wasted slot.',
    'move/plus-1', { formula: 'move', power: 1 }),
  passive('move-plus-2', 'Move +2', 'Two extra tiles. The difference between arriving and watching.',
    'move/plus-2', { formula: 'move', power: 2 }),
  passive('move-plus-3', 'Move +3', 'Three extra tiles. Reserved for those who intend to be everywhere.',
    'move/plus-3', { formula: 'move', power: 3 }),
  passive('jump-plus-1', 'Jump +1', 'One more half-tile of vertical clearance on every step.',
    'move/jump-1', { formula: 'move', power: 1 }),
  passive('jump-plus-2', 'Jump +2', 'Ledges that stopped you last battle no longer do.',
    'move/jump-2', { formula: 'move', power: 2 }),
  passive('jump-plus-3', 'Jump +3', 'Vault most walls in Ivalice from a standing start.',
    'move/jump-3', { formula: 'move', power: 3 }),
  passive('ignore-height', 'Ignore Height', 'Vertical distance stops mattering. Cliffs are simply floor at an angle.',
    'move/ignore-height', { formula: 'move', power: 99 }),
  passive('any-ground', 'Any Ground', 'Swamp, sand, snow and rubble all cost a single point of movement.',
    'move/any-ground', { formula: 'move', power: 1 }),
  passive('teleport', 'Teleport', 'Step out of the world and back into it anywhere in sight. It does not always work.',
    'move/teleport', { formula: 'move', power: 3, accuracy: 75, range: R(8, 0, { vertical: Infinity, los: false }), targetsTiles: true }),
  passive('teleport-2', 'Teleport 2', 'The refined version: the distance no longer affects whether you arrive.',
    'move/teleport-2', { formula: 'move', power: 8, accuracy: 100, range: R(12, 0, { vertical: Infinity, los: false }), targetsTiles: true }),
  passive('walk-on-water', 'Walk on Water', 'Cross rivers and shallows at full pace and without going under.',
    'move/water-walk', { formula: 'move', power: 1 }),
  passive('walk-on-lava', 'Walk on Lava', 'Molten stone will not hold your weight, but it will not burn you either.',
    'move/lava-walk', { formula: 'move', power: 1 }),
  passive('fly', 'Fly', 'Leave the ground entirely. Terrain, height and traps all become somebody else\'s problem.',
    'move/fly', { formula: 'move', power: 99, inflicts: [inf('float', 100)] }),
  passive('levitate', 'Levitate', 'A hand\'s breadth of clearance. Enough for water, traps and the worst of the mud.',
    'move/levitate', { formula: 'move', power: 1, inflicts: [inf('float', 100)] }),
  passive('move-hp-up', 'Move-HP Up', 'Every tile walked closes a wound a little further.',
    'move/hp-up', { formula: 'heal', power: 10 }),
  passive('move-mp-up', 'Move-MP Up', 'Movement gathers aether. Walk the long way round on purpose.',
    'move/mp-up', { formula: 'heal', power: 10 }),
  passive('move-find-item', 'Move-Find Item', 'You notice things underfoot that nobody else does. Sometimes valuable things.',
    'move/find-item', { formula: 'move', power: 1 }),
  passive('move-gain-jp', 'Move-Gain JP', 'You think while you walk. Every tile crossed earns a little Job Point.',
    'move/gain-jp', { formula: 'move', power: 2 }),
  passive('unblockable-stride', 'Unblockable Stride', 'Walk straight through the enemy line. No unit, ally or foe, blocks your path.',
    'move/stride', { formula: 'move', power: 1 }),
  passive('shadow-walk', 'Shadow Walk', 'Move unseen. You remain hidden until you attack or an enemy stands adjacent.',
    'move/shadow-walk', { formula: 'move', power: 1, inflicts: [inf('stealth', 100)] }),
];

export const MOVEMENT_ABILITIES: readonly Ability[] = defineAbilities('movement', 'movement', MOVEMENT_SPECS);

const MOVEMENT_EFFECT_LIST: readonly MovementEffect[] = [
  { ability: 'move-plus-1', kind: 'move-bonus', value: 1 },
  { ability: 'move-plus-2', kind: 'move-bonus', value: 2 },
  { ability: 'move-plus-3', kind: 'move-bonus', value: 3 },
  { ability: 'jump-plus-1', kind: 'jump-bonus', value: 1 },
  { ability: 'jump-plus-2', kind: 'jump-bonus', value: 2 },
  { ability: 'jump-plus-3', kind: 'jump-bonus', value: 3 },
  { ability: 'ignore-height', kind: 'ignore-height', value: 99 },
  { ability: 'any-ground', kind: 'ignore-terrain', value: 1 },
  { ability: 'teleport', kind: 'teleport', value: 3 },
  { ability: 'teleport-2', kind: 'teleport', value: 12 },
  { ability: 'walk-on-water', kind: 'walk-on-water', value: 1 },
  { ability: 'walk-on-lava', kind: 'walk-on-lava', value: 1 },
  { ability: 'fly', kind: 'fly', value: 99 },
  { ability: 'levitate', kind: 'fly', value: 1 },
  { ability: 'move-hp-up', kind: 'move-hp-up', value: 10 },
  { ability: 'move-mp-up', kind: 'move-mp-up', value: 10 },
  { ability: 'move-find-item', kind: 'move-find-item', value: 1 },
  { ability: 'move-gain-jp', kind: 'move-gain-jp', value: 2 },
  { ability: 'unblockable-stride', kind: 'move-through-units', value: 1 },
  { ability: 'shadow-walk', kind: 'no-reaction', value: 1 },
];

export const MOVEMENT_EFFECTS: ReadonlyMap<AbilityId, MovementEffect> = new Map(
  MOVEMENT_EFFECT_LIST.map((e) => [e.ability, e]),
);
