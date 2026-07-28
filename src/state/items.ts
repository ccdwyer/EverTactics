/**
 * EverTactics — the item table.
 *
 * FFT-derived equipment and consumables. Weapon power, evade and stat modifiers
 * follow the PSX tables closely enough that the combat formulas produce familiar
 * numbers; prices are the FFT shop prices.
 *
 * Consumable ids deliberately match the ability ids in `core/abilities` (the Item
 * skillset), because `core/battle.ts` resolves `{kind:'item'}` by looking the item
 * id up in the *ability* registry. Keeping the two ids identical is what makes a
 * Potion usable in battle.
 */

import type { DropTableEntry } from '@core/economy';
import type { Item, ItemId } from '@core/types';

function weapon(over: Partial<Item> & Pick<Item, 'id' | 'name' | 'category' | 'wp'>): Item {
  return {
    description: '',
    price: 100,
    range: 1,
    element: 'none',
    ...over,
  } as Item;
}

// ─────────────────────────────────────────────────────────────────────────────
// Weapons
// ─────────────────────────────────────────────────────────────────────────────

const WEAPONS: readonly Item[] = [
  // Knives — fast, PA+SP damage, favoured by Thieves and mages who must not die.
  weapon({
    id: 'dagger', name: 'Dagger', category: 'knife', wp: 3, price: 200, wEvade: 5,
    description: 'A plain crossguarded blade. Quick in the hand, and it asks nothing of the arm.',
  }),
  weapon({
    id: 'mythril-knife', name: 'Mythril Knife', category: 'knife', wp: 5, price: 800, wEvade: 8,
    description: 'Mythril takes an edge no steel can hold and keeps it through a campaign.',
  }),
  weapon({
    id: 'assassin-dagger', name: 'Assassin Dagger', category: 'knife', wp: 8, price: 6000, wEvade: 10,
    description: 'Blackened so it throws no light. Its owners rarely need a second one.',
  }),

  // Swords — the honest middle of the weapon table.
  weapon({
    id: 'broadsword', name: 'Broadsword', category: 'sword', wp: 6, price: 500, wEvade: 10,
    description: 'Issued to every Knight of Ivalice on the day they take the oath.',
  }),
  weapon({
    id: 'long-sword', name: 'Longsword', category: 'sword', wp: 8, price: 1500, wEvade: 12,
    description: 'A hand and a half of good Lionel steel, balanced a thumb above the guard.',
  }),
  weapon({
    id: 'mythril-sword', name: 'Mythril Sword', category: 'sword', wp: 11, price: 4000, wEvade: 14,
    description: 'Pale as river ice and half the weight of the steel it shames.',
  }),

  // Knightswords — two-handed, scale off Brave.
  weapon({
    id: 'defender', name: 'Defender', category: 'knightsword', wp: 13, price: 20000,
    wEvade: 20, twoHanded: true, mods: { hp: 20 },
    description: 'A greatsword sworn to a house rather than a hand. It guards whoever carries it.',
  }),

  // Spears — reach 2, the Dragoon's tool.
  weapon({
    id: 'javelin', name: 'Javelin', category: 'spear', wp: 8, price: 1200, range: 2, wEvade: 15,
    description: 'Long enough to keep a horse off you, short enough to throw if it comes to that.',
  }),
  weapon({
    id: 'partisan', name: 'Partisan', category: 'spear', wp: 11, price: 4500, range: 2, wEvade: 18,
    description: 'A winged head that catches a blade and turns it aside on the way in.',
  }),

  // Katana — Samurai, PA*Brave/100, and they break when drawn.
  weapon({
    id: 'asura-knife', name: 'Asura', category: 'katana', wp: 11, price: 3000, wEvade: 10,
    description: 'A Wutai blade with six notches in the spine, one for each duel it settled.',
  }),

  // Bows — range 4-5, damage off (PA+SP)/2, and they arc over walls.
  weapon({
    id: 'long-bow', name: 'Longbow', category: 'bow', wp: 7, price: 1200, range: 5, twoHanded: true,
    description: 'Yew, waxed linen, and a draw weight that ruins a shoulder over twenty years.',
  }),
  weapon({
    id: 'silver-bow', name: 'Silver Bow', category: 'bow', wp: 10, price: 3500, range: 5, twoHanded: true,
    description: 'Silvered limbs that sing on release. Archers claim the note steadies the aim.',
  }),

  // Staves and rods — the caster line.
  weapon({
    id: 'oak-staff', name: 'Oak Staff', category: 'staff', wp: 4, price: 200, wEvade: 8,
    mods: { ma: 1 },
    description: 'Cut from a monastery grove and blessed once a year, whether it needs it or not.',
  }),
  weapon({
    id: 'white-staff', name: 'White Staff', category: 'staff', wp: 6, price: 2000, wEvade: 10,
    mods: { ma: 2, mp: 10 },
    description: 'Bleached bone-white by prayer. Faith runs through it more easily than through flesh.',
  }),
  weapon({
    id: 'rod', name: 'Rod', category: 'rod', wp: 3, price: 200, wEvade: 5, mods: { ma: 2 },
    description: 'A focus, not a weapon. Striking someone with it is a confession of failure.',
  }),
  weapon({
    id: 'flame-rod', name: 'Flame Rod', category: 'rod', wp: 5, price: 3000, wEvade: 5,
    element: 'fire', mods: { ma: 3 },
    description: 'The core is a splinter of firestone. It is warm even in the snow.',
  }),

  // Instruments — Bard.
  weapon({
    id: 'ramia-harp', name: 'Ramia Harp', category: 'instrument', wp: 6, price: 3000, range: 3,
    mods: { ma: 2 },
    description: 'Strung with something that is not gut. It carries further than it should.',
  }),
];

// ─────────────────────────────────────────────────────────────────────────────
// Armour, headgear, shields, accessories
// ─────────────────────────────────────────────────────────────────────────────

const ARMOUR: readonly Item[] = [
  { id: 'leather-helm', name: 'Leather Helm', category: 'helm', price: 300, mods: { hp: 16 },
    description: 'Boiled hide over a felt cap. Turns a glancing blow; nothing more is promised.' },
  { id: 'bronze-helm', name: 'Bronze Helm', category: 'helm', price: 800, mods: { hp: 30 },
    description: 'Heavy, hot, and the reason most knights still have their skulls.' },
  { id: 'feather-hat', name: 'Feather Hat', category: 'hat', price: 400, mods: { hp: 12, mp: 8 },
    description: 'A scholar\'s hat with a chocobo quill in the band. Keeps rain off a spellbook.' },
  { id: 'green-beret', name: 'Green Beret', category: 'hat', price: 1500, mods: { hp: 20, spd: 1 },
    description: 'Worn by the rangers of the Zeklaus. Light enough to forget you have it on.' },
  { id: 'headband', name: 'Headband', category: 'hat', price: 1200, mods: { hp: 24, pa: 1 },
    description: 'A monk\'s wrap, sweat-stiffened. The knot is part of the discipline.' },

  { id: 'leather-armor', name: 'Leather Armour', category: 'armor', price: 400, mods: { hp: 24 },
    description: 'Layered and lacquered. Cheap, quiet, and it does not rust in the marshes.' },
  { id: 'chain-mail', name: 'Chain Mail', category: 'armor', price: 1300, mods: { hp: 45 },
    description: 'Riveted rings over a padded gambeson. Forty pounds of very good argument.' },
  { id: 'mythril-armor', name: 'Mythril Armour', category: 'armor', price: 5000, mods: { hp: 70, mp: 8 },
    description: 'Plate that weighs less than the mail beneath it. The reason mythril has a price.' },
  { id: 'linen-robe', name: 'Linen Robe', category: 'robe', price: 500, mods: { hp: 14, mp: 20 },
    description: 'Undyed and unremarkable, which is exactly what a mage in a battle line wants.' },
  { id: 'silk-robe', name: 'Silk Robe', category: 'robe', price: 1800, mods: { hp: 22, mp: 34, ma: 1 },
    description: 'Woven in Lesalia, worn everywhere. The sheen makes the wearer easy to find.' },
  { id: 'leather-outfit', name: 'Leather Outfit', category: 'clothing', price: 600, mods: { hp: 20, spd: 1 },
    description: 'Cut for movement first. Thieves and dancers both swear by it, for different reasons.' },

  { id: 'buckler', name: 'Buckler', category: 'shield', price: 800, pEvade: 13, mEvade: 5,
    description: 'A fist-sized round of banded oak. Meant to deflect, never to absorb.' },
  { id: 'round-shield', name: 'Round Shield', category: 'shield', price: 2000, pEvade: 19, mEvade: 8,
    description: 'Full-arm, iron-rimmed. Behind it a knight can walk into archery and live.' },

  { id: 'battle-boots', name: 'Battle Boots', category: 'shoes', price: 2500, mods: { move: 1 },
    description: 'Nailed soles and a stiffened ankle. A tile of ground is worth more than a tile of steel.' },
  { id: 'spike-shoes', name: 'Spike Shoes', category: 'shoes', price: 3000, mods: { jump: 1 },
    description: 'Cleated for stone and ice. The wearer goes up walls other people go around.' },
  { id: 'reflect-ring', name: 'Reflect Ring', category: 'accessory', price: 8000,
    grantsStatus: ['reflect'],
    description: 'A band of polished obsidian. Magick striking it goes back the way it came.' },
  { id: 'ribbon', name: 'Ribbon', category: 'ribbon', price: 20000, mods: { mp: 10 },
    description: 'A scrap of Ivalician silk older than the Church. Nothing sticks to whoever wears it.' },
  { id: 'bracer', name: 'Bracer', category: 'armlet', price: 3500, mods: { pa: 2 },
    description: 'Weighted at the wrist so the arm finishes the swing it started.' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Consumables — ids mirror the Item skillset ability ids
// ─────────────────────────────────────────────────────────────────────────────

const CONSUMABLES: readonly Item[] = [
  { id: 'use-potion', name: 'Potion', category: 'consumable', price: 50, formula: 'heal',
    description: 'A measure of bitter green tincture. Restores 30 HP.' },
  { id: 'use-hi-potion', name: 'Hi-Potion', category: 'consumable', price: 200, formula: 'heal',
    description: 'Twice-distilled and three times the price. Restores 80 HP.' },
  { id: 'use-x-potion', name: 'X-Potion', category: 'consumable', price: 700, formula: 'heal',
    description: 'Battlefield surgery in a vial. Restores 180 HP.' },
  { id: 'use-ether', name: 'Ether', category: 'consumable', price: 300, formula: 'special',
    description: 'Restores 40 MP. Tastes of copper and old rain.' },
  { id: 'use-hi-ether', name: 'Hi-Ether', category: 'consumable', price: 900, formula: 'special',
    description: 'Restores 100 MP. Reserved for those who intend to cast something enormous.' },
  { id: 'use-elixir', name: 'Elixir', category: 'consumable', price: 5000, formula: 'special',
    description: 'Full HP and MP, every ailment gone. There are never enough of these.' },
  { id: 'use-antidote', name: 'Antidote', category: 'consumable', price: 50, formula: 'status-only',
    description: 'Neutralises venom.' },
  { id: 'use-eye-drops', name: 'Eye Drops', category: 'consumable', price: 50, formula: 'status-only',
    description: 'Washes grit, ash and blinding magick from the eyes.' },
  { id: 'use-echo-herbs', name: 'Echo Herbs', category: 'consumable', price: 50, formula: 'status-only',
    description: 'Loosens a throat sealed by silence. Vile, but quick.' },
  { id: 'use-maiden-kiss', name: 'Maiden\'s Kiss', category: 'consumable', price: 100, formula: 'status-only',
    description: 'Restores a frog to its proper shape, with all the dignity that implies.' },
  { id: 'use-soft', name: 'Soft', category: 'consumable', price: 100, formula: 'status-only',
    description: 'Powdered chalcedony. Returns petrified flesh to flesh before the crack sets in.' },
  { id: 'use-holy-water', name: 'Holy Water', category: 'consumable', price: 200, formula: 'status-only',
    element: 'holy',
    description: 'Consecrated, and it burns going on. Lifts undeath and the grave-curse.' },
  { id: 'use-remedy', name: 'Remedy', category: 'consumable', price: 800, formula: 'status-only',
    description: 'The apothecary\'s catch-all. Clears nearly every common ailment at once.' },
  { id: 'use-phoenix-down', name: 'Phoenix Down', category: 'consumable', price: 300, formula: 'raise',
    description: 'One feather, one breath, one more chance. Never more than that.' },
];

/**
 * The consumables, in shop order.
 *
 * These are the ids the party carries a *stock* of — `core/inventory.ts` owns
 * the counts and the starting pile, and derives membership from the Item
 * skillset rather than from this list, so a consumable added here without a
 * matching ability is inert in battle (as it always was) rather than silently
 * infinite.
 */
export const CONSUMABLE_ITEMS: readonly Item[] = CONSUMABLES;

export const ITEMS: readonly Item[] = [...WEAPONS, ...ARMOUR, ...CONSUMABLES];

export const ITEMS_BY_ID: ReadonlyMap<string, Item> = new Map(ITEMS.map((i) => [i.id, i]));

export function findItem(id: string): Item | undefined {
  return ITEMS_BY_ID.get(id);
}

export interface ShopStockEntry {
  readonly itemId: ItemId;
  /** First campaign chapter in which the item may be purchased. */
  readonly chapter: number;
}

/**
 * Authored campaign shop stock. Later chapters inherit every earlier entry.
 * The item table remains the sole source of names, descriptions, and prices.
 */
export const SHOP_STOCK: readonly ShopStockEntry[] = [
  { itemId: 'dagger', chapter: 1 },
  { itemId: 'broadsword', chapter: 1 },
  { itemId: 'javelin', chapter: 1 },
  { itemId: 'oak-staff', chapter: 1 },
  { itemId: 'rod', chapter: 1 },
  { itemId: 'leather-helm', chapter: 1 },
  { itemId: 'feather-hat', chapter: 1 },
  { itemId: 'leather-armor', chapter: 1 },
  { itemId: 'linen-robe', chapter: 1 },
  { itemId: 'buckler', chapter: 1 },
  { itemId: 'use-potion', chapter: 1 },
  { itemId: 'use-antidote', chapter: 1 },
  { itemId: 'use-phoenix-down', chapter: 1 },
  { itemId: 'mythril-knife', chapter: 2 },
  { itemId: 'long-sword', chapter: 2 },
  { itemId: 'partisan', chapter: 2 },
  { itemId: 'long-bow', chapter: 2 },
  { itemId: 'white-staff', chapter: 2 },
  { itemId: 'flame-rod', chapter: 2 },
  { itemId: 'bronze-helm', chapter: 2 },
  { itemId: 'green-beret', chapter: 2 },
  { itemId: 'headband', chapter: 2 },
  { itemId: 'chain-mail', chapter: 2 },
  { itemId: 'silk-robe', chapter: 2 },
  { itemId: 'leather-outfit', chapter: 2 },
  { itemId: 'round-shield', chapter: 2 },
  { itemId: 'use-hi-potion', chapter: 2 },
  { itemId: 'use-ether', chapter: 2 },
  { itemId: 'use-remedy', chapter: 2 },
];

export function shopStockForChapter(chapter: number): Item[] {
  return SHOP_STOCK
    .filter((entry) => entry.chapter <= chapter)
    .map((entry) => findItem(entry.itemId))
    .filter((item): item is Item => item !== undefined);
}

/** Loot candidates are gated by enemy level inside core/economy. */
export const BATTLE_DROP_TABLE: readonly DropTableEntry[] = [
  { itemId: 'use-potion', minLevel: 1, weight: 8 },
  { itemId: 'use-antidote', minLevel: 1, weight: 3 },
  { itemId: 'use-phoenix-down', minLevel: 4, weight: 2 },
  { itemId: 'dagger', minLevel: 6, weight: 1 },
  { itemId: 'use-hi-potion', minLevel: 10, weight: 5 },
  { itemId: 'use-ether', minLevel: 12, weight: 3 },
  { itemId: 'mythril-knife', minLevel: 16, weight: 1 },
  { itemId: 'long-sword', minLevel: 18, weight: 1 },
  { itemId: 'use-remedy', minLevel: 18, weight: 2 },
];
