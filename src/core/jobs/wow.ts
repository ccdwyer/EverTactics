/**
 * EverTactics — World of Warcraft lineage jobs, reflavoured for Ivalice.
 *
 * Six jobs, each carrying one mechanic that the FFT roster genuinely cannot express:
 *
 *   Death Knight — a rune economy: three rune types recharge on a timer and pay for everything.
 *   Warlock      — stacking damage-over-time, soul shards harvested from kills, a demon pet.
 *   Druid        — stance shifting: bear, cat and caster forms swap sprite, stats and commands.
 *   Paladin      — persistent auras plus a Judgement debt that converts into burst.
 *   Rogue        — stealth as a real board state, combo points on the target, finishers.
 *   Shaman       — totems: persistent entities placed on tiles that project an effect radius.
 *
 * Everything a job needs beyond the `Job` contract is declared in `WOW_MECHANICS` below.
 */

import type { Job, LearnableAbility } from '../types';
import type { JobMechanics } from './index';

const a = (ability: string, jp: number): LearnableAbility => ({ ability, jp });

export const WOW_JOBS: readonly Job[] = [
  {
    id: 'death-knight',
    name: 'Death Knight',
    origin: 'wow',
    blurb: 'Three runes, recharging on their own clock. Spend them, or raise the dead with them.',
    description:
      'What the Church makes when a Dark Knight dies badly and is put back on his feet anyway. ' +
      'The Death Knight does not pay MP — he carries Blood, Frost and Unholy runes that ' +
      'recharge one step per turn and are spent by name, so his rotation is a genuine resource ' +
      'puzzle rather than a spell list. Blood strikes heal him, Frost strikes root and slow, ' +
      'and Unholy raises the corpse of anything that has fallen on the field as a ghoul that ' +
      'fights until it is destroyed. Cold, slow, and extremely hard to remove.',
    sprite: { male: '1110_Dark_Knight_Male_hd', female: '1112_Dark_Knight_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 10,
    growth: { hp: 9, mp: 14, pa: 42, ma: 50, spd: 100 },
    mult: { hp: 135, mp: 75, pa: 125, ma: 100, spd: 100 },
    requires: [
      { job: 'dark-knight', level: 3 },
      { job: 'mystic', level: 3 },
    ],
    actionSet: 'runeblade',
    learnable: [
      a('blood-strike', 200),
      a('icy-touch', 200),
      a('plague-strike', 250),
      a('death-coil', 350),
      a('howling-blast', 450),
      a('chains-of-ice', 300),
      a('raise-ghoul', 600),
      a('death-and-decay', 700),
      a('rune-tap', 400),
      a('anti-magic-shell', 500),
      a('obliterate', 650),
      a('army-of-the-dead', 1200),
    ],
    equip: ['sword', 'knightsword', 'axe', 'hammer', 'shield', 'helm', 'armor', 'accessory'],
    innate: ['rune-economy', 'unholy-vigour'],
  },
  {
    id: 'warlock',
    name: 'Warlock',
    origin: 'wow',
    blurb: 'Nothing dies fast. Everything dies. Shards are the receipt.',
    description:
      'Pact-bound casters who traffic with things that live under Ivalice. A Warlock lands ' +
      'almost no burst — the damage is in stacking Corruption, Immolate and Curse of Agony on ' +
      'as many enemies as possible and letting the field bleed out over the turn order. Every ' +
      'unit that dies while afflicted yields a Soul Shard, and shards pay for the expensive ' +
      'work: binding the Felguard, casting Soulstone on an ally so death is not final, and ' +
      'detonating the accumulated rot with Shadowburn.',
    sprite: { male: '1016_Black_Mage_Male_hd', female: '1018_Black_Mage_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 5,
    growth: { hp: 13, mp: 10, pa: 80, ma: 42, spd: 100 },
    mult: { hp: 75, mp: 125, pa: 70, ma: 125, spd: 100 },
    requires: [
      { job: 'black-mage', level: 4 },
      { job: 'summoner', level: 3 },
    ],
    actionSet: 'affliction',
    learnable: [
      a('corruption', 200),
      a('immolate', 250),
      a('curse-of-agony', 300),
      a('drain-life', 350),
      a('drain-soul', 400),
      a('shadow-bolt', 250),
      a('summon-felguard', 700),
      a('soulstone', 600),
      a('howl-of-terror', 450),
      a('shadowburn', 550),
      a('curse-of-tongues', 400),
      a('unstable-affliction', 800),
    ],
    equip: ['rod', 'staff', 'knife', 'book', 'hat', 'robe', 'clothing', 'accessory'],
    innate: ['soul-harvest'],
  },
  {
    id: 'druid',
    name: 'Druid',
    origin: 'wow',
    blurb: 'Three jobs in one body. Shift and the sprite, the stats and the command list change.',
    description:
      'Keepers of the deep woods who do not cast at nature so much as become it. Shifting is a ' +
      'free action once per turn: Dire Bear is a plate-weight tank with a taunt, Feral Cat is a ' +
      'Move 5 skirmisher that builds combo points, and unshifted Restoration is a genuine ' +
      'healer with heal-over-time. The trap is trying to be all three in one battle — shifting ' +
      'drops any form-locked effects, so the good Druid picks a role for the fight and shifts ' +
      'only when the fight changes.',
    sprite: { male: '1040_Geomancer_Male_hd', female: '1042_Geomancer_Female_hd' },
    move: 4,
    jump: 3,
    cEvade: 10,
    growth: { hp: 11, mp: 12, pa: 55, ma: 48, spd: 100 },
    mult: { hp: 105, mp: 110, pa: 100, ma: 110, spd: 100 },
    requires: [
      { job: 'geomancer', level: 4 },
      { job: 'white-mage', level: 3 },
    ],
    actionSet: 'wild-shape',
    learnable: [
      a('dire-bear-form', 300),
      a('feral-cat-form', 300),
      a('rejuvenation', 250),
      a('regrowth', 350),
      a('wrath', 200),
      a('moonfire', 300),
      a('entangling-roots', 300),
      a('mangle', 400),
      a('swipe', 350),
      a('shred', 400),
      a('tranquillity', 800),
      a('natures-swiftness', 600),
    ],
    equip: ['staff', 'knife', 'fist', 'hat', 'robe', 'clothing', 'armlet', 'accessory'],
    innate: ['shapeshift'],
  },
  {
    id: 'paladin',
    name: 'Paladin',
    origin: 'wow',
    blurb: 'Stands in one place and makes the ground around it better. Then cashes in the debt.',
    description:
      'The Order\'s sworn, half a Knight and half a priest, who fight by attrition and ' +
      'accumulation. An aura runs continuously — Devotion for armour, Retribution to burn ' +
      'attackers, Concentration to hold a spell through damage — and every seal the Paladin ' +
      'places on an enemy accrues a debt that Judgement collects all at once. Lay on Hands is ' +
      'the emergency button the whole company plans around: a full heal, once, at the cost of ' +
      'every point of the Paladin\'s own MP.',
    sprite: { male: '1000_Knight_Male_hd', female: '1002_Knight_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 10,
    growth: { hp: 10, mp: 13, pa: 45, ma: 50, spd: 100 },
    mult: { hp: 125, mp: 95, pa: 115, ma: 105, spd: 100 },
    requires: [
      { job: 'knight', level: 4 },
      { job: 'white-mage', level: 4 },
    ],
    actionSet: 'judgement',
    learnable: [
      a('devotion-aura', 250),
      a('retribution-aura', 300),
      a('concentration-aura', 350),
      a('seal-of-righteousness', 250),
      a('seal-of-justice', 300),
      a('judgement', 400),
      a('holy-strike', 200),
      a('hammer-of-justice', 450),
      a('lay-on-hands', 900),
      a('blessing-of-protection', 600),
      a('consecration', 500),
      a('divine-shield', 800),
    ],
    equip: ['sword', 'hammer', 'flail', 'knightsword', 'shield', 'helm', 'armor', 'accessory'],
    innate: ['aura-bearer'],
  },
  {
    id: 'rogue',
    name: 'Rogue',
    origin: 'wow',
    blurb: 'Invisible until it acts. Builds points on one target, then spends them all at once.',
    description:
      'Not the Thief. The Thief takes your sword; the Rogue takes your commander. Stealth is a ' +
      'board state, not a buff — a stealthed Rogue cannot be targeted by abilities or selected ' +
      'by enemy AI, and moves at full speed until it acts. Opening from stealth grants ' +
      'Ambush\'s guaranteed critical and puts combo points on the target; points build one per ' +
      'strike, cap at five, live on the target rather than the Rogue, and are spent whole by a ' +
      'finisher whose power scales with the count. Eviscerate at five points is the highest ' +
      'single-target burst any common job has.',
    sprite: { male: '1028_Thief_Male_hd', female: '1030_Thief_Female_hd' },
    move: 4,
    jump: 4,
    cEvade: 30,
    growth: { hp: 11, mp: 18, pa: 46, ma: 55, spd: 85 },
    mult: { hp: 90, mp: 50, pa: 122, ma: 60, spd: 115 },
    requires: [
      { job: 'thief', level: 4 },
      { job: 'ninja', level: 2 },
    ],
    actionSet: 'subtlety',
    learnable: [
      a('stealth', 300),
      a('ambush', 450),
      a('sinister-strike', 200),
      a('backstab', 350),
      a('rupture', 400),
      a('eviscerate', 500),
      a('kidney-shot', 450),
      a('cheap-shot', 400),
      a('vanish-rogue', 700),
      a('expose-armour', 350),
      a('slice-and-dice', 400),
      a('shadowstep', 600),
    ],
    equip: ['knife', 'sword', 'hat', 'clothing', 'accessory'],
    innate: ['shadow-training'],
  },
  {
    id: 'shaman',
    name: 'Shaman',
    origin: 'wow',
    blurb: 'Plants totems on tiles. They stay where you put them and do not move.',
    description:
      'Spirit-speakers who bargain with the four elements rather than commanding them. A ' +
      'Shaman\'s power is placed, not cast: a totem is a real entity occupying a tile, with its ' +
      'own small HP pool, projecting an effect over a radius until something breaks it. Searing ' +
      'Totem attacks, Healing Stream mends, Windfury hastes, Stoneskin absorbs, Tremor purges ' +
      'fear and charm. Four can stand at once, one of each element. Placement is the whole ' +
      'skill: totems do not follow you, so a Shaman that has to retreat has thrown the turn away.',
    sprite: { male: '1036_Mystic_Male_hd', female: '1038_Mystic_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 5,
    growth: { hp: 12, mp: 11, pa: 65, ma: 47, spd: 100 },
    mult: { hp: 95, mp: 115, pa: 90, ma: 115, spd: 100 },
    requires: [
      { job: 'mystic', level: 3 },
      { job: 'geomancer', level: 3 },
    ],
    actionSet: 'totemcraft',
    learnable: [
      a('searing-totem', 250),
      a('healing-stream-totem', 300),
      a('stoneskin-totem', 350),
      a('windfury-totem', 450),
      a('tremor-totem', 300),
      a('lightning-bolt', 200),
      a('chain-lightning', 500),
      a('earth-shock', 300),
      a('frost-shock', 300),
      a('ancestral-spirit', 700),
      a('bloodlust', 900),
      a('totemic-recall', 250),
    ],
    equip: ['hammer', 'axe', 'staff', 'shield', 'hat', 'clothing', 'armlet', 'accessory'],
    innate: ['totemic-focus'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Mechanics
// ─────────────────────────────────────────────────────────────────────────────

export const WOW_MECHANICS: readonly JobMechanics[] = [
  {
    job: 'death-knight',
    tags: ['resurrect', 'pet', 'lifetap', 'threat'],
    resources: [
      {
        id: 'blood-runes',
        name: 'Blood Runes',
        max: 2,
        startsAt: 2,
        perTurn: 1,
        decaysOnIdle: false,
        onTarget: false,
        description: 'Pays for self-sustaining strikes. Recharges 1 per turn to a cap of 2.',
      },
      {
        id: 'frost-runes',
        name: 'Frost Runes',
        max: 2,
        startsAt: 2,
        perTurn: 1,
        decaysOnIdle: false,
        onTarget: false,
        description: 'Pays for control: roots, slows and Howling Blast. Recharges 1 per turn.',
      },
      {
        id: 'unholy-runes',
        name: 'Unholy Runes',
        max: 2,
        startsAt: 2,
        perTurn: 1,
        decaysOnIdle: false,
        onTarget: false,
        description: 'Pays for disease, Death and Decay, and raising the dead. Recharges 1 per turn.',
      },
      {
        id: 'runic-power',
        name: 'Runic Power',
        max: 100,
        startsAt: 0,
        perTurn: -5,
        decaysOnIdle: true,
        onTarget: false,
        description:
          'Gains 10 per rune spent. Pays for Death Coil and Army of the Dead. Bleeds 5 per turn ' +
          'while idle, so it must be used inside the fight it was built in.',
      },
    ],
    pets: [
      {
        id: 'ghoul',
        name: 'Risen Ghoul',
        sprite: '1078_Skeleton_hd',
        scale: { hp: 0.5, pa: 0.7, ma: 0.2, spd: 1.0, move: 1.0, jump: 1.0 },
        actionSet: 'ghoul-hunger',
        permanent: false,
        deathPenalty: false,
      },
    ],
    stances: [],
    threat: { generated: 1.5, hasTaunt: true, perDamage: 1.0, perHeal: 0.5 },
    keyAbilities: ['blood-strike', 'icy-touch', 'raise-ghoul', 'death-coil', 'army-of-the-dead'],
    notes:
      'Runes are the identity: each ability declares which rune types it costs, and the UI must ' +
      'show three small pip bars rather than an MP bar. The Death Knight has an MP pool for ' +
      'secondary-command compatibility, but nothing in `runeblade` spends it. `raise-ghoul` ' +
      'targets a *corpse tile* — any unit that has been KO\'d and has not yet crystallised — and ' +
      'consumes it, which means it also denies the enemy their own raise. The ghoul inherits ' +
      '50% of the master\'s HP and 70% of PA, acts on its own CT entry, and is destroyed when ' +
      'the master falls. `army-of-the-dead` raises every eligible corpse on the field at once ' +
      'and is priced accordingly.',
    spriteBorrow: {
      from: '1110_Dark_Knight_Male_hd / 1112_Dark_Knight_Female_hd (ghoul: 1078_Skeleton_hd)',
      recolour:
        'Frost palette: desaturated steel-blue plate, rime-white edge highlights, cyan pinpoint ' +
        'eyes in the helm slit. This is the same base sheet as the Shadowknight and the FFT ' +
        'Dark Knight — three jobs distinguished entirely by palette, which is exactly what the ' +
        'GPU palette-LUT pipeline is for. Add frost fume to the idle cells; the shoulder shape ' +
        'is already correct.',
    },
  },
  {
    job: 'warlock',
    tags: ['dot', 'pet', 'lifetap'],
    resources: [
      {
        id: 'soul-shards',
        name: 'Soul Shards',
        max: 3,
        startsAt: 1,
        perTurn: 0,
        decaysOnIdle: false,
        onTarget: false,
        description:
          'Gained when any unit dies while carrying a Warlock damage-over-time, or from ' +
          '`drain-soul`. Pays for the Felguard, Soulstone and Shadowburn. Persists across a battle.',
      },
    ],
    pets: [
      {
        id: 'felguard',
        name: 'Felguard',
        sprite: '1106_Demon_hd',
        scale: { hp: 0.8, pa: 0.9, ma: 0.5, spd: 0.95, move: 1.0, jump: 1.0 },
        actionSet: 'fel-fury',
        permanent: false,
        deathPenalty: false,
      },
    ],
    stances: [],
    keyAbilities: ['corruption', 'immolate', 'curse-of-agony', 'drain-soul', 'summon-felguard'],
    notes:
      'Damage-over-time stacking is the whole job. Corruption (shadow), Immolate (fire) and ' +
      'Curse of Agony (dark) occupy three separate channels and coexist on one target; the ' +
      'status engine must tick them independently at the target\'s turn start, and Curse of ' +
      'Agony must ramp — 60%, 100%, 140% of base over its three ticks — so letting it run is ' +
      'rewarded. `unstable-affliction` punishes dispels: cleansing it damages the cleanser. ' +
      '`soulstone` is the one that changes how a party plays: spend a shard to pre-place a ' +
      'self-resurrection on an ally, and they stand back up once at 25% HP when KO\'d, before ' +
      'the crystal timer starts.',
    spriteBorrow: {
      from: '1016_Black_Mage_Male_hd / 1018_Black_Mage_Female_hd (pet: 1106_Demon_hd)',
      recolour:
        'Fel palette: acid-green robes over charcoal, with the Black Mage\'s signature shadowed ' +
        'face lit green instead of yellow. The straw hat silhouette is too iconic to keep — the ' +
        'head cells need reworking into a horned hood. The Demon sheet is used as-is with a ' +
        'green rim so it reads as bound rather than wild.',
    },
  },
  {
    job: 'druid',
    tags: ['stance', 'threat', 'combo'],
    resources: [
      {
        id: 'druid-combo',
        name: 'Feral Combo',
        max: 5,
        startsAt: 0,
        perTurn: 0,
        decaysOnIdle: true,
        onTarget: true,
        description:
          'Cat form only. Builds 1 per landed feral strike, held on the target, spent whole by ' +
          '`shred`. Lost on leaving cat form.',
      },
    ],
    pets: [],
    stances: [
      {
        id: 'dire-bear',
        name: 'Dire Bear Form',
        sprite: { male: '1090_Minotaur_hd', female: '1090_Minotaur_hd' },
        actionSet: 'bear-form',
        mult: { hp: 45, pa: 15, ma: -50, spd: -10 },
        move: 3,
        jump: 3,
        cEvade: 5,
        grants: ['defending'],
        description:
          'Tank form. +45% HP, +15% PA, magic effectively off. Gains a taunt and cannot cast, ' +
          'use items or equip-swap while shifted.',
      },
      {
        id: 'feral-cat',
        name: 'Feral Cat Form',
        sprite: { male: '1137_Coeurl_2_hd', female: '1137_Coeurl_2_hd' },
        actionSet: 'cat-form',
        mult: { hp: -15, pa: 25, ma: -50, spd: 15 },
        move: 5,
        jump: 5,
        cEvade: 25,
        grants: [],
        description:
          'Skirmisher form. Move 5, Jump 5, 25% class evade, builds combo points. Fragile: ' +
          '-15% HP and no access to healing.',
      },
    ],
    threat: { generated: 1.0, hasTaunt: true, perDamage: 1.0, perHeal: 0.7 },
    keyAbilities: ['dire-bear-form', 'feral-cat-form', 'rejuvenation', 'mangle', 'shred'],
    notes:
      'Shifting is a free action, once per turn, and does not consume the unit\'s move or act. ' +
      'On shift the renderer must swap the sprite sheet outright (that is why `sprite` is on ' +
      'the stance), the command list must be replaced by the stance `actionSet`, and any ' +
      'form-locked status must be dropped. Stance multipliers are *deltas on top of* the job ' +
      'multipliers, in percentage points: bear HP is `mult.hp 105 + 45 = 150%`. Equipment stays ' +
      'equipped and keeps granting stat mods while shifted, but weapon damage is replaced by ' +
      'the form\'s natural attack — otherwise bear form scales off a staff, which is absurd. ' +
      'The healing kit is deliberately unshifted-only so the Druid must commit.',
    spriteBorrow: {
      from: '1040_Geomancer_Male_hd / 1042_Geomancer_Female_hd, forms: 1090_Minotaur_hd, 1137_Coeurl_2_hd',
      recolour:
        'Caster form: mossy green and bark-brown over the Geomancer, antler motif worked into ' +
        'the hood cells. Bear: the Minotaur sheet is close in mass and stance but too bovine — ' +
        'it needs the horns shortened to stubs, the muzzle broadened, and a brown-black palette. ' +
        'Cat: Coeurl variant 2 recoloured tawny with the tendrils removed from the head cells. ' +
        'These two are the largest genuine art edits in the roster and should be budgeted as such.',
    },
  },
  {
    job: 'paladin',
    tags: ['aura', 'threat'],
    resources: [
      {
        id: 'holy-power',
        name: 'Judgement Debt',
        max: 3,
        startsAt: 0,
        perTurn: 0,
        decaysOnIdle: false,
        onTarget: true,
        description:
          'Accrues 1 each time a sealed target is struck, held on the target, capped at 3. ' +
          '`judgement` consumes the whole stack and scales with it.',
      },
    ],
    pets: [],
    stances: [],
    threat: { generated: 1.4, hasTaunt: false, perDamage: 1.0, perHeal: 0.6 },
    keyAbilities: ['devotion-aura', 'seal-of-righteousness', 'judgement', 'lay-on-hands'],
    notes:
      'Exactly one aura is active at a time; it is a persistent radius-3 effect centred on the ' +
      'Paladin, recomputed on move, and it stacks with Troubador anthems and Bard songs because ' +
      'all three write to different channels. Seals are placed on enemies and are the setup for ' +
      'Judgement, which is the payoff — the loop is seal, attack twice, judge. `lay-on-hands` ' +
      'restores a target to full HP and reduces the Paladin\'s MP to zero; it may be used once ' +
      'per battle and should be surfaced in the UI as a distinct, obviously-once resource. ' +
      '`divine-shield` grants total immunity for one round and zeroes all threat the Paladin ' +
      'holds, which is the intended escape valve, not an offensive tool.',
    spriteBorrow: {
      from: '1000_Knight_Male_hd / 1002_Knight_Female_hd',
      recolour:
        'Gold-and-ivory over the Knight base, distinct from the Templar\'s white-and-gold by ' +
        'being warmer and heavier: brass plate, crimson tabard, sunburst on the shield. The ' +
        'sword cells need repainting into a two-handed war hammer, which also separates the ' +
        'silhouette from Templar and plain Knight at a glance — important, because three jobs ' +
        'share this sheet.',
    },
  },
  {
    job: 'rogue',
    tags: ['stealth', 'combo'],
    resources: [
      {
        id: 'combo-points',
        name: 'Combo Points',
        max: 5,
        startsAt: 0,
        perTurn: 0,
        decaysOnIdle: false,
        onTarget: true,
        description:
          'Built 1 per landed builder (2 from `backstab` behind the target), held on the ' +
          'target, spent entirely by any finisher. Lost when the target dies or the Rogue is KO\'d.',
      },
    ],
    pets: [],
    stances: [],
    threat: { generated: 0.5, hasTaunt: false, perDamage: 1.0, perHeal: 0.0 },
    keyAbilities: ['stealth', 'ambush', 'sinister-strike', 'eviscerate', 'vanish-rogue'],
    notes:
      'Stealth is a board state the targeting layer must respect: while the `stealth` status is ' +
      'held the unit is excluded from enemy ability target lists and from AI target selection ' +
      'entirely, and is revealed the instant it acts with anything other than a move or an ' +
      'opener. Adjacent enemies get a detection roll at the start of their turn — ' +
      '`30 + (level - rogue.level) * 5` percent — so standing next to the enemy line is not ' +
      'free. Combo points live on the *target*, not the Rogue, which means switching targets ' +
      'abandons the build and is the core tension of the job. Finisher power scales as ' +
      '`base * (0.6 + 0.35 * points)`, so a five-point Eviscerate is 2.35x a one-point one. ' +
      '`vanish-rogue` re-enters stealth mid-combat and resets the detection clock.',
    spriteBorrow: {
      from: '1028_Thief_Male_hd / 1030_Thief_Female_hd',
      recolour:
        'Black and oxblood over the Thief\'s bright green-and-tan, with a raised cowl replacing ' +
        'the Thief\'s bandana in the head cells and a second dagger added to the off hand so the ' +
        'silhouette differs from both Thief and Ninja. The stealth state should render this ' +
        'sheet at ~35% opacity with the `transparent` shader path rather than needing new cells.',
    },
  },
  {
    job: 'shaman',
    tags: ['totem', 'aura'],
    resources: [
      {
        id: 'totem-slots',
        name: 'Totem Slots',
        max: 4,
        startsAt: 4,
        perTurn: 0,
        decaysOnIdle: false,
        onTarget: false,
        description:
          'One slot per element — earth, fire, water, air. Placing a totem of an element ' +
          'destroys the Shaman\'s existing totem of that element. `totemic-recall` returns all ' +
          'slots and refunds half the MP spent.',
      },
    ],
    pets: [
      {
        id: 'totem',
        name: 'Totem',
        sprite: '1088_Treant_hd',
        scale: { hp: 0.25, pa: 0.0, ma: 0.6, spd: 0.0, move: 0.0, jump: 0.0 },
        actionSet: 'totem-pulse',
        permanent: false,
        deathPenalty: false,
      },
    ],
    stances: [],
    keyAbilities: ['searing-totem', 'healing-stream-totem', 'windfury-totem', 'totemic-recall'],
    notes:
      'A totem is a real board entity, not a status: it occupies a tile (blocking movement ' +
      'through it), has HP equal to 25% of the Shaman\'s, cannot move, cannot be healed, has ' +
      'Speed 0 so it never takes a CT turn, and pulses its effect at the start of each of the ' +
      'Shaman\'s turns over a radius-2 area centred on its own tile. Enemies can and should ' +
      'attack them. Placement range is 3 tiles with a vertical tolerance of 2. Because they do ' +
      'not follow, the Shaman is the roster\'s only genuinely positional support job — the ' +
      'right play is to read where the line will be in two turns and plant there. ' +
      '`tremor-totem` pulses a cleanse of `charm`, `confuse` and `sleep`, which makes it the ' +
      'direct counter to an enemy Coercer.',
    spriteBorrow: {
      from: '1036_Mystic_Male_hd / 1038_Mystic_Female_hd (totems: 1088_Treant_hd)',
      recolour:
        'Earth-tone leathers, turquoise beading and a fetish-hung mantle over the Mystic base; ' +
        'the head cells want an antlered half-mask, which also separates this sheet from the ' +
        'Coercer that shares it. The totems are the real work: crop a single upright segment ' +
        'from the Treant sheet, scale it to roughly half a unit\'s height, and paint four ' +
        'variants — carved stone, burning brazier, running water, feathered pole. Static, no ' +
        'animation beyond a two-frame glow pulse.',
    },
  },
];
