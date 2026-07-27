/**
 * EverTactics — the canonical Final Fantasy Tactics job roster.
 *
 * Numbers follow FFT's own conventions:
 *   - `growth` constants are *divisors*: lower is better. Raw stat gain per level is
 *     `raw += raw / (growth + level)` in the original engine, so HP growth sits in the
 *     6–14 band while PA/MA/SPD growth sits in the 35–100 band.
 *   - `mult` are percent multipliers applied to the raw stat when the job is worn
 *     (100 = neutral). A Knight's 120 HPM is why Knight-set units are tanky even with
 *     Chemist-grown raw HP.
 *   - `move` / `jump` / `cEvade` are the class's own values before equipment or supports.
 *
 * Ability id convention (see docs/JOBS.md): globally-unique kebab-case slug of the
 * ability's canonical name — `head-break`, `equip-armor`, `move-plus-1`, `fira`.
 * Ability *set* ids are the kebab-case command name — `battle-skill`, `white-magick` —
 * and are the canonical spelling registered in `core/abilities/sets.ts`, not one of
 * the aliases `SET_ALIASES` tolerates.
 */

import type { Job, LearnableAbility } from '../types';

/** Terse learnable-ability constructor; keeps the tables readable. */
const a = (ability: string, jp: number): LearnableAbility => ({ ability, jp });

export const FFT_JOBS: readonly Job[] = [
  // ───────────────────────────────────────────────────────────── base ──
  {
    id: 'squire',
    name: 'Squire',
    origin: 'fft',
    blurb: 'Everything starts here. Cheap, flexible, quietly excellent.',
    description:
      'The rank every levy soldier of Ivalice holds before they are anything else. A Squire ' +
      'has no specialty and therefore no weakness: they move further than most, throw a stone ' +
      'as readily as they bind a wound, and learn faster than any specialist. Veterans who ' +
      'never leave the job are not failures — they are the ones who kept the Move +1 and the ' +
      'JP Boost that every later job stands on.',
    sprite: { male: '924_Squire_Male_hd', female: '994_Squire_Female_hd' },
    move: 4,
    jump: 3,
    cEvade: 5,
    growth: { hp: 11, mp: 15, pa: 60, ma: 50, spd: 100 },
    mult: { hp: 100, mp: 100, pa: 100, ma: 100, spd: 100 },
    requires: [],
    actionSet: 'basic-skill',
    learnable: [
      a('throw-stone', 100),
      a('heal-wounds', 100),
      a('dash', 180),
      a('accumulate', 200),
      a('yell', 220),
      a('wish', 400),
      a('counter-tackle', 300),
      a('gained-jp-up', 400),
      a('move-plus-1', 200),
    ],
    equip: ['knife', 'sword', 'axe', 'shield', 'helm', 'hat', 'armor', 'clothing', 'accessory'],
    innate: [],
  },
  {
    id: 'chemist',
    name: 'Chemist',
    origin: 'fft',
    blurb: 'Items work on anything. Undead, silenced, out of MP — the Chemist does not care.',
    description:
      'Apothecaries of the Order, trained to keep a company alive on the road where no cleric ' +
      'walks. Their craft ignores Faith, ignores Silence, and ignores the target being a ' +
      'walking corpse — a Phoenix Down works because chemistry works. Weak in the arm and ' +
      'slow on the field; the reason to bring one is that nothing can turn their kit off.',
    sprite: { male: '996_Chemist_Male_hd', female: '998_Chemist_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 5,
    growth: { hp: 12, mp: 16, pa: 75, ma: 50, spd: 100 },
    mult: { hp: 90, mp: 80, pa: 90, ma: 80, spd: 100 },
    requires: [],
    actionSet: 'item',
    learnable: [
      a('use-potion', 50),
      a('use-antidote', 50),
      a('use-eye-drops', 50),
      a('use-echo-herbs', 50),
      a('use-maiden-kiss', 100),
      a('use-soft', 100),
      a('use-hi-potion', 200),
      a('use-phoenix-down', 200),
      a('use-holy-water', 200),
      a('use-ether', 300),
      a('use-x-potion', 400),
      a('use-remedy', 400),
      a('use-hi-ether', 500),
      a('use-elixir', 900),
      a('auto-potion', 500),
      a('throw-item', 180),
      a('move-find-item', 900),
    ],
    equip: ['knife', 'gun', 'hat', 'clothing', 'accessory'],
    innate: [],
  },

  // ─────────────────────────────────────────────────────── squire line ──
  {
    id: 'knight',
    name: 'Knight',
    origin: 'fft',
    blurb: 'Heavy armour, knightswords, and eight ways to break a soldier apart from their kit.',
    description:
      'The professional line infantry of the Fifty Years War. A Knight is the only common job ' +
      'that wears plate and carries a knightsword, and Battle Skill is not damage — it is ' +
      'attrition: shatter the helm, the mail, the blade, the will. An enemy stripped of ' +
      'equipment by turn three is an enemy the rest of the company can ignore.',
    sprite: { male: '1000_Knight_Male_hd', female: '1002_Knight_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 10,
    growth: { hp: 10, mp: 15, pa: 40, ma: 50, spd: 100 },
    mult: { hp: 120, mp: 80, pa: 120, ma: 80, spd: 100 },
    requires: [{ job: 'squire', level: 2 }],
    actionSet: 'battle-skill',
    learnable: [
      a('head-break', 150),
      a('armor-break', 200),
      a('shield-break', 180),
      a('speed-break', 180),
      a('power-break', 180),
      a('mind-break', 180),
      a('magick-break', 180),
      a('weapon-break', 250),
      a('riposte', 400),
      a('equip-armor', 400),
      a('equip-shield', 250),
    ],
    equip: ['knife', 'sword', 'knightsword', 'shield', 'helm', 'armor', 'accessory'],
    innate: [],
  },
  {
    id: 'archer',
    name: 'Archer',
    origin: 'fft',
    blurb: 'Hold the draw. The longer the bow is charged, the harder the arrow lands.',
    description:
      'Bowmen shoot over intervening units and over terrain, which makes elevation the ' +
      'Archer\'s real weapon — a rooftop is worth more than any bow in the shop. Charge ' +
      'commits the unit for a number of ticks and pays it back as raw damage, so an Archer ' +
      'played well is a sniper who never fires the shot the enemy expected.',
    sprite: { male: '1004_Archer_Male_hd', female: '1006_Archer_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 10,
    growth: { hp: 11, mp: 16, pa: 45, ma: 50, spd: 100 },
    mult: { hp: 100, mp: 65, pa: 110, ma: 80, spd: 100 },
    requires: [{ job: 'squire', level: 2 }],
    actionSet: 'charge',
    learnable: [
      a('charge-plus-1', 40),
      a('charge-plus-2', 80),
      a('charge-plus-3', 150),
      a('charge-plus-4', 250),
      a('charge-plus-5', 400),
      a('charge-plus-7', 600),
      a('charge-plus-10', 800),
      a('charge-plus-20', 1200),
      a('arrow-guard', 300),
      a('equip-bow', 250),
    ],
    equip: ['bow', 'crossbow', 'knife', 'shield', 'hat', 'clothing', 'accessory'],
    innate: [],
  },
  {
    id: 'monk',
    name: 'Monk',
    origin: 'fft',
    blurb: 'No weapon, no armour, and the best raw damage in the low tree.',
    description:
      'Ascetics out of the mountain temples who fight with the body and the breath. Monks ' +
      'hit at range with Wave Fist, heal without magic through Chakra, and stand up allies ' +
      'that a cleric could not reach in time. Martial Arts makes bare hands scale with Brave, ' +
      'so the correct Monk equipment is nothing at all.',
    sprite: { male: '1008_Monk_Male_hd', female: '1010_Monk_Female_hd' },
    move: 3,
    jump: 4,
    cEvade: 20,
    growth: { hp: 9, mp: 16, pa: 48, ma: 50, spd: 100 },
    mult: { hp: 135, mp: 80, pa: 129, ma: 80, spd: 100 },
    requires: [{ job: 'knight', level: 2 }],
    actionSet: 'punch-art',
    learnable: [
      a('spin-fist', 200),
      a('repeating-fist', 300),
      a('secret-fist', 300),
      a('earth-slash', 300),
      a('wave-fist', 400),
      a('stigma-magick', 400),
      a('chakra', 400),
      a('revive', 500),
      a('counter', 500),
      a('martial-arts', 400),
    ],
    equip: ['fist', 'hat', 'clothing', 'accessory'],
    innate: [],
  },
  {
    id: 'thief',
    name: 'Thief',
    origin: 'fft',
    blurb: 'Fastest legs on the field, and it takes the enemy\'s gear home with it.',
    description:
      'Move 4, Jump 4, 25% class evasion and the ability to walk off with a boss\'s sword ' +
      'before the boss has taken a turn. Steal rolls against Speed, so a Thief that outpaces ' +
      'the target strips them reliably; against a slow, richly-equipped commander it is the ' +
      'single most profitable job in the game.',
    sprite: { male: '1028_Thief_Male_hd', female: '1030_Thief_Female_hd' },
    move: 4,
    jump: 4,
    cEvade: 25,
    growth: { hp: 11, mp: 17, pa: 50, ma: 50, spd: 90 },
    mult: { hp: 90, mp: 60, pa: 100, ma: 60, spd: 110 },
    requires: [{ job: 'archer', level: 2 }],
    actionSet: 'steal',
    learnable: [
      a('steal-heart', 180),
      a('steal-helmet', 200),
      a('steal-gil', 250),
      a('steal-shield', 250),
      a('steal-armor', 300),
      a('steal-accessory', 350),
      a('steal-weapon', 400),
      a('move-plus-2', 400),
      a('treasure-hunter', 300),
    ],
    equip: ['knife', 'hat', 'clothing', 'accessory'],
    innate: [],
  },

  // ────────────────────────────────────────────────────── chemist line ──
  {
    id: 'white-mage',
    name: 'White Mage',
    origin: 'fft',
    blurb: 'Cure, raise, ward. Faith cuts both ways.',
    description:
      'The Church\'s battlefield clergy. White Magic is the only reliable multi-target healing ' +
      'in Ivalice, but every point of it is scaled by the Faith of both caster and target — a ' +
      'faithless veteran is nearly unhealable, and an Innocent enemy is nearly unkillable by ' +
      'magic. Raise and Esuna are what actually win long fights.',
    sprite: { male: '1012_White_Mage_Male_hd', female: '1014_White_Mage_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 5,
    growth: { hp: 12, mp: 10, pa: 70, ma: 45, spd: 100 },
    mult: { hp: 80, mp: 120, pa: 90, ma: 110, spd: 100 },
    requires: [{ job: 'chemist', level: 2 }],
    actionSet: 'white-magick',
    learnable: [
      a('cure', 50),
      a('cura', 180),
      a('protect', 200),
      a('shell', 200),
      a('raise', 300),
      a('regen', 300),
      a('curaga', 400),
      a('protectja', 400),
      a('shellja', 400),
      a('esuna', 400),
      a('curaja', 700),
      a('holy', 800),
      a('arise', 800),
      a('magick-defense-up', 400),
    ],
    equip: ['staff', 'hat', 'robe', 'clothing', 'accessory'],
    innate: [],
  },
  {
    id: 'black-mage',
    name: 'Black Mage',
    origin: 'fft',
    blurb: 'Elemental artillery. Slow to land, ruinous when it does.',
    description:
      'Academy-trained evokers who trade a body for a spellbook. Every offensive spell has a ' +
      'charge time, so Black Magic is played by predicting where the enemy will be, not where ' +
      'they are. Area spells do not distinguish friend from foe: the mage who kills their own ' +
      'front line is a mage who mis-read the turn order.',
    sprite: { male: '1016_Black_Mage_Male_hd', female: '1018_Black_Mage_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 5,
    growth: { hp: 12, mp: 10, pa: 75, ma: 45, spd: 100 },
    mult: { hp: 75, mp: 120, pa: 80, ma: 120, spd: 100 },
    requires: [{ job: 'chemist', level: 2 }],
    actionSet: 'black-magick',
    learnable: [
      a('fire', 100),
      a('blizzard', 100),
      a('thunder', 100),
      a('fira', 200),
      a('blizzara', 200),
      a('thundara', 200),
      a('poison', 200),
      a('firaga', 400),
      a('blizzaga', 400),
      a('thundaga', 400),
      a('toad', 400),
      a('death', 600),
      a('flare', 900),
      a('magick-attack-up', 500),
    ],
    equip: ['rod', 'hat', 'robe', 'clothing', 'accessory'],
    innate: [],
  },
  {
    id: 'time-mage',
    name: 'Time Mage',
    origin: 'fft',
    blurb: 'Owns the clock. Haste, Slow, Stop, and the turn order is yours.',
    description:
      'Chronomancers do almost no damage and decide almost every battle. Haste on two units ' +
      'and Slow on two enemies swings the Charge Time queue further than any spell in the ' +
      'Black Mage\'s book. Short Charge and Teleport are the two most valuable passives in ' +
      'the game and both live here.',
    sprite: { male: '1020_Time_Mage_Male_hd', female: '1022_Time_Mage_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 5,
    growth: { hp: 12, mp: 10, pa: 70, ma: 50, spd: 100 },
    mult: { hp: 75, mp: 115, pa: 80, ma: 110, spd: 100 },
    requires: [{ job: 'black-mage', level: 2 }],
    actionSet: 'time-magick',
    learnable: [
      a('haste', 200),
      a('slow', 200),
      a('float', 200),
      a('immobilize', 300),
      a('disable', 300),
      a('hastega', 400),
      a('slowga', 400),
      a('reflect', 400),
      a('demi', 400),
      a('stop', 500),
      a('demiga', 600),
      a('quick', 800),
      a('meteor', 1200),
      a('short-charge', 900),
      a('half-mp', 1200),
      a('teleport', 600),
    ],
    equip: ['staff', 'hat', 'robe', 'clothing', 'accessory'],
    innate: [],
  },
  {
    id: 'summoner',
    name: 'Summoner',
    origin: 'fft',
    blurb: 'One cast, the whole field. Summons never hit allies.',
    description:
      'Callers who bind the Lucavi-adjacent espers of older ages into a single, enormous, ' +
      'expensive cast. The defining property is friendly-fire immunity: a Summoner can drop ' +
      'Bahamut on a melee scrum with their own knights inside it. The cost is MP and charge ' +
      'time, which is exactly what a Time Mage secondary fixes.',
    sprite: { male: '1024_Summoner_Male_hd', female: '1026_Summoner_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 5,
    growth: { hp: 13, mp: 10, pa: 70, ma: 40, spd: 100 },
    mult: { hp: 70, mp: 125, pa: 80, ma: 120, spd: 100 },
    requires: [{ job: 'time-mage', level: 3 }],
    actionSet: 'summon-magick',
    learnable: [
      a('moogle', 200),
      a('shiva', 300),
      a('ramuh', 300),
      a('ifrit', 300),
      a('titan', 400),
      a('golem', 500),
      a('carbuncle', 500),
      a('sylph', 500),
      a('fairy', 500),
      a('salamander', 600),
      a('leviathan', 700),
      a('odin', 700),
      a('bahamut', 800),
      a('lich', 900),
      a('cyclops', 900),
      a('zodiark', 1500),
      a('half-mp', 900),
    ],
    equip: ['rod', 'staff', 'hat', 'robe', 'clothing', 'accessory'],
    innate: [],
  },
  {
    id: 'mystic',
    name: 'Mystic',
    origin: 'fft',
    blurb: 'Status warfare. It does not kill; it makes everything else lethal.',
    description:
      'Oracles read the humours and inflict them. Mystic Arts land Sleep, Confuse, Silence, ' +
      'Petrify and Doubt Faith at Faith-scaled odds — the best Mystic play is Doubt Faith on ' +
      'an enemy mage, or Faith on an ally healer, before anyone has swung. Low damage, ' +
      'decisive control.',
    sprite: { male: '1036_Mystic_Male_hd', female: '1038_Mystic_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 10,
    growth: { hp: 12, mp: 12, pa: 60, ma: 50, spd: 100 },
    mult: { hp: 75, mp: 110, pa: 80, ma: 110, spd: 100 },
    requires: [{ job: 'white-mage', level: 2 }],
    actionSet: 'yin-yang-magick',
    learnable: [
      a('blind', 180),
      a('spell-absorb', 200),
      a('silence-song', 200),
      a('life-drain', 250),
      a('pray-faith', 250),
      a('doubt-faith', 250),
      a('zombie', 300),
      a('blind-rage', 300),
      a('foxbird', 300),
      a('confusion-song', 300),
      a('sleep', 300),
      a('paralyze', 350),
      a('petrify', 400),
      a('dispel-magick', 500),
      a('absorb-mp', 400),
    ],
    equip: ['rod', 'staff', 'hat', 'robe', 'clothing', 'accessory'],
    innate: [],
  },

  // ───────────────────────────────────────────────────── second tier ──
  {
    id: 'geomancer',
    name: 'Geomancer',
    origin: 'fft',
    blurb: 'The ground is the spellbook. Free, instant, and it changes with every tile.',
    description:
      'Elementalists who draw from whatever they are standing next to — Local Quake on stone, ' +
      'Water Ball on a river, Hell Ivy in grass. Geomancy costs no MP, has no charge time, ' +
      'and reaches a full line, which makes the Geomancer the most reliable damage job in ' +
      'the middle tree. It also wears a shield and swings a sword.',
    sprite: { male: '1040_Geomancer_Male_hd', female: '1042_Geomancer_Female_hd' },
    move: 4,
    jump: 3,
    cEvade: 10,
    growth: { hp: 11, mp: 13, pa: 50, ma: 50, spd: 100 },
    mult: { hp: 110, mp: 95, pa: 110, ma: 105, spd: 100 },
    requires: [{ job: 'monk', level: 3 }],
    actionSet: 'geomancy',
    learnable: [
      a('pitfall', 300),
      a('water-ball', 300),
      a('hell-ivy', 300),
      a('carve-model', 300),
      a('local-quake', 300),
      a('kamaitachi', 300),
      a('demon-fire', 300),
      a('quicksand', 300),
      a('sand-storm', 300),
      a('blizzard-geo', 300),
      a('gusty-wind', 300),
      a('lava-ball', 300),
      a('counter-flood', 500),
      a('attack-up', 800),
      a('walk-on-lava', 480),
    ],
    equip: ['sword', 'axe', 'shield', 'hat', 'clothing', 'accessory'],
    innate: [],
  },
  {
    id: 'dragoon',
    name: 'Dragoon',
    origin: 'fft',
    blurb: 'Leaves the field entirely, then lands on a head from above.',
    description:
      'Lancers of the Northern Sky, trained on the wyvern-hunting spears. Jump removes the ' +
      'unit from the battlefield for a number of ticks and returns it as an unmissable, ' +
      'double-damage spear strike on a chosen tile. Untargetable while airborne, which makes ' +
      'a Dragoon the safest way to be standing in the middle of the enemy line.',
    sprite: { male: '1044_Dragoon_Male_hd', female: '1046_Dragoon_Female_hd' },
    move: 3,
    jump: 4,
    cEvade: 15,
    growth: { hp: 11, mp: 15, pa: 40, ma: 50, spd: 100 },
    mult: { hp: 120, mp: 70, pa: 120, ma: 80, spd: 100 },
    requires: [{ job: 'thief', level: 3 }],
    actionSet: 'jump',
    learnable: [
      a('level-jump-2', 200),
      a('vertical-jump-2', 200),
      a('level-jump-3', 300),
      a('vertical-jump-3', 300),
      a('level-jump-4', 400),
      a('vertical-jump-4', 400),
      a('level-jump-5', 500),
      a('vertical-jump-5', 500),
      a('level-jump-8', 700),
      a('vertical-jump-8', 700),
      a('high-jump', 600),
      a('dragon-dive', 900),
      a('equip-spear', 200),
      a('ignore-height', 400),
    ],
    equip: ['spear', 'shield', 'helm', 'armor', 'accessory'],
    innate: [],
  },
  {
    id: 'orator',
    name: 'Orator',
    origin: 'fft',
    blurb: 'Talks enemies onto your side, out of their morale, or into an early grave.',
    description:
      'Mediators of the great houses, who understand that a battle is a negotiation with ' +
      'casualties. Speechcraft rolls against Brave and Faith rather than defence: Invitation ' +
      'permanently recruits, Praise and Threaten reshape a unit\'s Brave for the whole ' +
      'campaign, and Condemn kills on a timer nothing can heal.',
    sprite: { male: '1032_Orator_Male_hd', female: '1034_Orator_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 5,
    growth: { hp: 12, mp: 15, pa: 60, ma: 50, spd: 100 },
    mult: { hp: 80, mp: 75, pa: 90, ma: 90, spd: 100 },
    requires: [{ job: 'mystic', level: 3 }],
    actionSet: 'talk-skill',
    learnable: [
      a('praise', 150),
      a('threaten', 200),
      a('persuade', 200),
      a('insult', 200),
      a('preach', 250),
      a('solution', 250),
      a('mimic-daravon', 300),
      a('invitation', 300),
      a('condemn', 400),
      a('refute', 400),
      a('rehabilitate', 500),
      a('monster-talk', 300),
      a('train', 500),
    ],
    equip: ['knife', 'gun', 'hat', 'clothing', 'accessory'],
    innate: [],
  },

  // ────────────────────────────────────────────────────── elite tier ──
  {
    id: 'samurai',
    name: 'Samurai',
    origin: 'fft',
    blurb: 'Draws the spirit out of a katana. Sometimes the katana breaks.',
    description:
      'Wanderers out of the far east, holding blades that remember their own names. Iaido ' +
      'invokes the equipped katana without swinging it: a field-wide effect at the risk of ' +
      'shattering the weapon. Blade Grasp turns Brave into a flat chance to nullify any ' +
      'physical attack, which is the single strongest defensive reaction in Ivalice.',
    sprite: { male: '1048_Samurai_Male_hd', female: '1050_Samurai_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 20,
    growth: { hp: 12, mp: 13, pa: 45, ma: 50, spd: 100 },
    mult: { hp: 100, mp: 90, pa: 120, ma: 110, spd: 100 },
    requires: [
      { job: 'knight', level: 4 },
      { job: 'monk', level: 5 },
    ],
    actionSet: 'draw-out',
    learnable: [
      a('asura', 200),
      a('koutetsu', 300),
      a('bizen-boat', 350),
      a('murasame', 400),
      a('heavens-cloud', 450),
      a('kiyomori', 500),
      a('muramasa', 600),
      a('kikuichimonji', 700),
      a('masamune', 800),
      a('chirijiraden', 900),
      a('blade-grasp', 900),
      a('reflexes', 300),
      a('two-hands', 900),
    ],
    equip: ['katana', 'helm', 'armor', 'accessory'],
    innate: [],
  },
  {
    id: 'ninja',
    name: 'Ninja',
    origin: 'fft',
    blurb: 'Two blades, four Move, and the highest class evasion in the game.',
    description:
      'Shinobi from the eastern isles who fight in cloth because armour is what gets you ' +
      'caught. Dual Wield doubles every physical action a unit takes and is the reason Ninja ' +
      'is the last job most companies unlock. Throw converts inventory into unavoidable ' +
      'ranged damage; a Ninja with a stack of shuriken never has a wasted turn.',
    sprite: { male: '1052_Ninja_Male_hd', female: '1054_Ninja_Female_hd' },
    move: 4,
    jump: 4,
    cEvade: 30,
    growth: { hp: 12, mp: 16, pa: 43, ma: 50, spd: 80 },
    mult: { hp: 80, mp: 50, pa: 120, ma: 75, spd: 120 },
    requires: [
      { job: 'archer', level: 4 },
      { job: 'thief', level: 5 },
    ],
    actionSet: 'throw',
    learnable: [
      a('throw-shuriken', 180),
      a('throw-ball', 200),
      a('throw-knife', 200),
      a('throw-stick', 250),
      a('throw-wand', 250),
      a('throw-sword', 300),
      a('throw-axe', 300),
      a('throw-hammer', 300),
      a('throw-spear', 350),
      a('throw-ninja-blade', 400),
      a('two-swords', 900),
      a('shadow-walk', 500),
      a('move-plus-3', 800),
    ],
    equip: ['knife', 'hat', 'clothing', 'accessory'],
    innate: [],
  },
  {
    id: 'arithmetician',
    name: 'Arithmetician',
    origin: 'fft',
    blurb: 'Casts a spell on every unit whose Level is a multiple of five. Free. Instantly.',
    description:
      'Scholars of the Akademy who reduced thaumaturgy to arithmetic. Arithmeticks selects a ' +
      'property — CT, Level, Experience, Height — and a divisor, then fires a known spell at ' +
      'every unit on the field satisfying it, at zero MP and zero charge time. It is the most ' +
      'broken command in the game and the job that carries it can barely lift a book.',
    sprite: { male: '1056_Arithmetician_Male_hd', female: '1058_Arithmetician_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 5,
    growth: { hp: 14, mp: 10, pa: 90, ma: 50, spd: 100 },
    mult: { hp: 60, mp: 110, pa: 50, ma: 80, spd: 50 },
    requires: [
      { job: 'white-mage', level: 4 },
      { job: 'black-mage', level: 4 },
      { job: 'time-mage', level: 3 },
      { job: 'mystic', level: 4 },
    ],
    actionSet: 'math-skill',
    learnable: [
      a('multiple-of-3', 400),
      a('multiple-of-4', 400),
      a('multiple-of-5', 400),
      a('prime-number', 400),
      a('calculate-ct', 800),
      a('calculate-level', 800),
      a('calculate-exp', 800),
      a('calculate-height', 800),
      a('gained-exp-up', 400),
    ],
    equip: ['book', 'staff', 'hat', 'robe', 'clothing', 'accessory'],
    innate: [],
  },
  {
    id: 'bard',
    name: 'Bard',
    origin: 'fft',
    blurb: 'Sings every tick, forever, to the whole party. Men only.',
    description:
      'Skalds who hold a note across the Charge Time queue. A song is not cast once — it ' +
      'ticks, raising Brave, Faith, HP, MP or Speed for every ally on the field until the ' +
      'Bard is interrupted. Nothing else in Ivalice scales with the length of a battle, so ' +
      'a Bard turns a grinding fight into a won one.',
    sprite: { male: '1060_Bard_Male_hd', female: '1060_Bard_Male_hd' },
    move: 3,
    jump: 3,
    cEvade: 5,
    growth: { hp: 12, mp: 15, pa: 100, ma: 50, spd: 100 },
    mult: { hp: 55, mp: 110, pa: 40, ma: 115, spd: 100 },
    requires: [
      { job: 'squire', level: 5 },
      { job: 'summoner', level: 5 },
      { job: 'orator', level: 5 },
    ],
    actionSet: 'sing',
    learnable: [
      a('angel-song', 300),
      a('life-song', 350),
      a('cheer-song', 350),
      a('battle-song', 400),
      a('magick-song', 400),
      a('nameless-song', 500),
      a('space-storage', 600),
      a('sky-demon', 700),
      a('last-song', 900),
      a('move-mp-up', 400),
    ],
    equip: ['instrument', 'hat', 'clothing', 'accessory'],
    innate: [],
  },
  {
    id: 'dancer',
    name: 'Dancer',
    origin: 'fft',
    blurb: 'Dances every tick, forever, to the whole enemy army. Women only.',
    description:
      'The Bard\'s mirror: a dance ticks against every enemy on the field, draining HP, MP, ' +
      'Speed, Brave or Faith without a single roll to hit. Slow Dance and Disillusion strip ' +
      'an enemy line down to something the front rank can walk through. Last Dance is the ' +
      'only ability in the game that hands a full turn to everyone you own.',
    sprite: { male: '1062_Dancer_Female_hd', female: '1062_Dancer_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 5,
    growth: { hp: 12, mp: 15, pa: 50, ma: 100, spd: 100 },
    mult: { hp: 60, mp: 110, pa: 110, ma: 40, spd: 100 },
    requires: [
      { job: 'squire', level: 5 },
      { job: 'geomancer', level: 5 },
      { job: 'dragoon', level: 5 },
    ],
    actionSet: 'dance',
    learnable: [
      a('witch-hunt', 300),
      a('wiznaibus', 300),
      a('slow-dance', 350),
      a('polka-polka', 350),
      a('disillusion', 400),
      a('nameless-dance', 500),
      a('obsidian-blade', 600),
      a('void-storage', 700),
      a('last-dance', 900),
      a('move-hp-up', 400),
    ],
    equip: ['cloth', 'hat', 'clothing', 'accessory'],
    innate: [],
  },
  {
    id: 'mime',
    name: 'Mime',
    origin: 'fft',
    blurb: 'Learns nothing. Equips nothing. Copies everything an ally does, for free.',
    description:
      'The end of the tree. A Mime has no command, no secondary, no reaction, no support and ' +
      'no equipment — and immediately repeats whatever an ally just did, at no MP and no ' +
      'charge time. Two Mimes behind a Summoner is three Bahamuts. Their unequipped stat ' +
      'multipliers are the highest in the game to pay for it.',
    sprite: { male: '1064_Mime_Male_hd', female: '1066_Mime_Female_hd' },
    move: 4,
    jump: 4,
    cEvade: 5,
    growth: { hp: 6, mp: 30, pa: 35, ma: 40, spd: 100 },
    mult: { hp: 140, mp: 50, pa: 120, ma: 115, spd: 120 },
    requires: [
      { job: 'squire', level: 8 },
      { job: 'chemist', level: 8 },
      { job: 'geomancer', level: 4 },
      { job: 'dragoon', level: 4 },
      { job: 'orator', level: 4 },
    ],
    actionSet: 'mimicry',
    // Authentic to FFT: the Mime learns nothing. Its power is entirely innate.
    learnable: [],
    equip: ['hat', 'clothing', 'accessory'],
    // `bare-mimicry` and `sole-command` are the two rules of the job written as
    // real passives rather than engine flags: the first pays for carrying no
    // gear, the second is the cost — no secondary, no reaction, no support.
    innate: ['mimic', 'bare-mimicry', 'sole-command'],
  },

  // ──────────────────────────────────────────────── War of the Lions ──
  {
    id: 'dark-knight',
    name: 'Dark Knight',
    origin: 'fft',
    blurb: 'Pays its own HP and MP for damage nothing resists.',
    description:
      'The forbidden discipline the Northern Sky does not admit it teaches. Dark Arts spend ' +
      'the wielder\'s own life to inflict dark-elemental damage that ignores most defences, ' +
      'crush a target\'s equipment outright, or offer up a fallen ally for a field-wide ' +
      'detonation. It is the only common job that gets stronger the closer it is to dying.',
    // Borrowed art. The WotL Dark Knight sheets (1110/1112) are broken in this
    // rip — 18-pixel grey noise strips with no artwork, flagged `broken: true` in
    // the manifest — so this borrows the Knight sheet, which is the same
    // silhouette the Dark Knight was drawn from anyway. Recolour is in docs/JOBS.md.
    sprite: { male: '1000_Knight_Male_hd', female: '1002_Knight_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 10,
    growth: { hp: 9, mp: 12, pa: 40, ma: 45, spd: 100 },
    mult: { hp: 130, mp: 80, pa: 130, ma: 110, spd: 100 },
    requires: [
      { job: 'knight', level: 8 },
      { job: 'black-mage', level: 8 },
    ],
    actionSet: 'dark-sword',
    learnable: [
      a('crush-helm', 500),
      a('crush-armor', 500),
      a('crush-accessory', 550),
      a('crush-weapon', 600),
      a('crushing-blow', 450),
      a('sanguine-sword', 700),
      a('night-sword', 750),
      a('infernal-strike', 750),
      a('abyssal-blade', 800),
      a('duskblade', 850),
      a('unyielding-blade', 850),
      a('unholy-sacrifice', 900),
      a('unholy-darkness', 900),
    ],
    equip: ['knife', 'sword', 'knightsword', 'shield', 'helm', 'armor', 'accessory'],
    innate: ['darkness-toll'],
  },
  {
    id: 'onion-knight',
    name: 'Onion Knight',
    origin: 'fft',
    blurb: 'Learns nothing, equips everything, and grows with every job you have mastered.',
    description:
      'A joke that becomes a threat. The Onion Knight has no abilities of its own and flat, ' +
      'unremarkable growth — but it can wear any weapon and any armour in Ivalice, and its ' +
      'multipliers rise with the number of jobs the unit has taken to level 8. Early it is ' +
      'worthless. Late, in full Onion gear, it outclasses everything.',
    // Borrowed art, same reason as the Dark Knight: 1114/1116 are broken stubs.
    // The Squire sheet is the right donor on its own merits — an Onion Knight is
    // a levy soldier who never specialised, which is exactly what a Squire is.
    sprite: { male: '924_Squire_Male_hd', female: '994_Squire_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 5,
    growth: { hp: 10, mp: 15, pa: 50, ma: 50, spd: 100 },
    mult: { hp: 100, mp: 100, pa: 100, ma: 100, spd: 100 },
    requires: [
      { job: 'squire', level: 6 },
      { job: 'chemist', level: 6 },
    ],
    actionSet: 'onion-skills',
    // FFT gives the Onion Knight nothing to learn, which reads as a bug rather
    // than a joke in a game with a job-detail panel. Onion Skills is the joke
    // played straight instead: six plain, cheap, unspecialised soldier's actions
    // whose ceiling is `onion-mastery`, not the abilities themselves.
    learnable: [
      a('onion-slash', 100),
      a('onion-guard', 150),
      a('onion-hurl', 200),
      a('onion-mend', 250),
      a('onion-resolve', 400),
      a('onion-blade', 800),
      a('equip-change', 500),
      a('move-plus-1', 300),
    ],
    equip: [
      'knife', 'sword', 'knightsword', 'katana', 'axe', 'hammer', 'spear', 'staff', 'rod',
      'flail', 'bow', 'crossbow', 'gun', 'instrument', 'cloth', 'book', 'fist', 'shield',
      'helm', 'hat', 'ribbon', 'armor', 'robe', 'clothing', 'accessory',
    ],
    innate: ['onion-mastery'],
  },
];
