/**
 * EverTactics — EverQuest II lineage jobs, reflavoured for Ivalice.
 *
 * These are not recoloured FFT jobs. Each one brings a mechanic the FFT roster has no
 * vocabulary for, and each mechanic is declared in `EQ2_MECHANICS` so the ability, combat
 * and AI layers can implement it without guessing:
 *
 *   Shadowknight — a real threat table plus lifetap; the only job that wants to be hit.
 *   Templar      — wards that absorb damage before HP, and heals that fire reactively.
 *   Coercer      — charm and mesmerise: takes enemy units off the board by using them.
 *   Beastlord    — a permanent warder that shares a resource bar with its master.
 *   Troubador    — persistent radius auras that stack with (not replace) Bard songs.
 *   Dirge        — debuff marks that multiply everyone else's damage.
 *
 * Where they sit in the tree: each hangs off the FFT jobs whose fantasy it extends, so the
 * roster reads as one continuous tree rather than two rosters bolted together.
 */

import type { Job, LearnableAbility } from '../types';
import type { JobMechanics } from './index';

const a = (ability: string, jp: number): LearnableAbility => ({ ability, jp });

export const EQ2_JOBS: readonly Job[] = [
  {
    id: 'shadowknight',
    name: 'Shadowknight',
    origin: 'eq2',
    blurb: 'Wants to be hit. Every wound it takes becomes fuel, and every blow it lands heals it.',
    description:
      'The oathbroken heavy of the eastern orders, bound to a covenant that keeps him upright ' +
      'past the point a man should fall. A Shadowknight builds Dread by taking damage and ' +
      'spends it on lifetaps that convert enemy HP directly into his own. His presence forces ' +
      'target selection — Unholy Presence multiplies the threat he generates, and Grasp of ' +
      'Night is a hard taunt no AI can refuse. Play him as the anchor the enemy line cannot ' +
      'walk past, not as a damage dealer.',
    // The Dark Knight sheets this job used to borrow (1110/1112) are broken in
    // the rip. The Dragoon is the better donor anyway: the horned helm reads as a
    // dread knight at a glance, and it keeps three plate jobs off one sheet.
    sprite: { male: '1044_Dragoon_Male_hd', female: '1046_Dragoon_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 10,
    growth: { hp: 9, mp: 13, pa: 45, ma: 50, spd: 100 },
    mult: { hp: 130, mp: 90, pa: 118, ma: 105, spd: 100 },
    requires: [
      { job: 'knight', level: 4 },
      { job: 'black-mage', level: 3 },
    ],
    actionSet: 'dread-arts',
    learnable: [
      a('taunt', 200),
      a('siphon-strike', 250),
      a('unholy-blessing', 300),
      a('malevolence', 350),
      a('doom-judgement', 400),
      a('harm-touch', 500),
      a('bulwark', 400),
      a('sentinel-roar', 600),
      a('vehement-threat', 500),
      a('shield-slam', 550),
      a('provoking-wound', 700),
      a('sanguine-covenant', 900),
    ],
    equip: ['sword', 'knightsword', 'knife', 'flail', 'shield', 'helm', 'armor', 'accessory'],
    innate: ['covenant-of-dread'],
  },
  {
    id: 'templar',
    name: 'Templar',
    origin: 'eq2',
    blurb: 'Puts the shield up before the blow lands. Wards absorb; they do not repair.',
    description:
      'Cathedral healers who reject the White Mage\'s doctrine of repairing damage after the ' +
      'fact. A Templar\'s Ward sits on an ally as a pool of absorption: incoming damage eats ' +
      'the ward first and only spills onto HP when the ward is gone. Sanctuary goes further — ' +
      'a reactive blessing that fires a heal the instant the warded ally is struck, before ' +
      'the Charge Time queue moves. Slower and more expensive than a White Mage, and far ' +
      'harder to burst through.',
    sprite: { male: '1000_Knight_Male_hd', female: '880_Agrias_hd' },
    move: 3,
    jump: 3,
    cEvade: 10,
    growth: { hp: 11, mp: 11, pa: 60, ma: 48, spd: 100 },
    mult: { hp: 110, mp: 115, pa: 95, ma: 110, spd: 100 },
    requires: [
      { job: 'white-mage', level: 4 },
      { job: 'knight', level: 3 },
    ],
    actionSet: 'sacraments',
    learnable: [
      a('ward-of-salvation', 150),
      a('sanctuary', 300),
      a('divine-arbitration', 500),
      a('reprieve', 250),
      a('smite-of-conviction', 200),
      a('unyielding-benediction', 700),
      a('sacrament-of-stone', 400),
      a('faithful-bulwark', 450),
      a('perseverance', 400),
      a('act-of-war', 350),
      a('resurrection-rite', 600),
      a('shield-of-faith', 800),
    ],
    equip: ['flail', 'hammer', 'staff', 'shield', 'helm', 'hat', 'armor', 'robe', 'accessory'],
    innate: ['greater-wards'],
  },
  {
    id: 'coercer',
    name: 'Coercer',
    origin: 'eq2',
    blurb: 'Does not remove enemies from the field. Uses them.',
    description:
      'Enchanters of the old Akademy who learned that a mind is a lock. Charm takes an enemy ' +
      'unit under your command for as long as you maintain Domination — the bar drains every ' +
      'turn the charm holds and drains faster the stronger the target — and the charmed unit ' +
      'acts on your side, with its own abilities, against its own army. Mesmerise takes a ' +
      'unit out of the turn order entirely until something damages it. Nothing else in the ' +
      'roster changes the arithmetic of a fight this hard, and nothing else is this fragile.',
    sprite: { male: '1036_Mystic_Male_hd', female: '1038_Mystic_Female_hd' },
    move: 3,
    jump: 3,
    cEvade: 5,
    growth: { hp: 13, mp: 10, pa: 75, ma: 45, spd: 100 },
    mult: { hp: 70, mp: 125, pa: 70, ma: 120, spd: 100 },
    requires: [
      { job: 'mystic', level: 4 },
      { job: 'orator', level: 3 },
    ],
    actionSet: 'enthrall',
    learnable: [
      a('mesmerize', 250),
      a('dominate', 600),
      a('possess-essence', 900),
      a('terrorize', 300),
      a('mana-flow', 400),
      a('peaceful-link', 350),
      a('spellbind', 300),
      a('mind-blank', 350),
      a('breeze', 300),
      a('cannibalise-thoughts', 450),
      a('mass-mesmerize', 500),
      a('puppetmaster', 800),
    ],
    equip: ['rod', 'staff', 'book', 'hat', 'robe', 'clothing', 'accessory'],
    innate: ['domination'],
  },
  {
    id: 'beastlord',
    name: 'Beastlord',
    origin: 'eq2',
    blurb: 'Two bodies, one bar. The warder is not a summon — it is half the job.',
    description:
      'Wild-bonded hunters out of the Yuguo woods who fight beside a warder taken as a cub. ' +
      'The warder is on the field from the first tick, is not summoned and cannot be ' +
      'resummoned mid-battle, and takes its own turns in the Charge Time queue. When master ' +
      'and warder strike the same target they build Savagery, which the master spends on ' +
      'Bestial Fury: a paired attack where both bodies act at once. Lose the warder and the ' +
      'Beastlord is a mediocre skirmisher for the rest of the battle. Protect it.',
    sprite: { male: '1040_Geomancer_Male_hd', female: '1042_Geomancer_Female_hd' },
    move: 4,
    jump: 4,
    cEvade: 15,
    growth: { hp: 10, mp: 14, pa: 48, ma: 50, spd: 95 },
    mult: { hp: 115, mp: 85, pa: 115, ma: 90, spd: 105 },
    requires: [
      { job: 'geomancer', level: 3 },
      { job: 'thief', level: 3 },
    ],
    actionSet: 'primal-bond',
    learnable: [
      a('warder-rush', 200),
      a('savage-mauling', 250),
      a('bestial-fury', 600),
      a('primal-instinct', 350),
      a('pack-tactics', 400),
      a('harrying-strike', 300),
      a('bond-of-blood', 500),
      a('rending-maul', 450),
      a('enrage-warder', 550),
      a('warders-guard', 400),
      a('call-of-the-wild', 700),
      a('shared-senses', 380),
    ],
    equip: ['knife', 'spear', 'fist', 'hat', 'clothing', 'armlet', 'accessory'],
    innate: ['warder-bond'],
  },
  {
    id: 'troubador',
    name: 'Troubador',
    origin: 'eq2',
    blurb: 'Radius auras that stack with Bard songs instead of overwriting them.',
    description:
      'Court performers of Lesalia who play *to a place*, not to an army. A Troubador\'s ' +
      'anthem is anchored to the tiles around them and moves as they move: allies inside the ' +
      'radius get the effect, allies outside get nothing, and the whole point is deciding ' +
      'where to stand. Critically, anthems occupy a different slot from Bard songs — a ' +
      'Troubador standing in a Bard\'s formation stacks both, which is the single strongest ' +
      'support combination in the roster and the reason to run two performers.',
    sprite: { male: '1032_Orator_Male_hd', female: '1034_Orator_Female_hd' },
    move: 4,
    jump: 3,
    cEvade: 10,
    growth: { hp: 12, mp: 12, pa: 70, ma: 50, spd: 100 },
    mult: { hp: 85, mp: 110, pa: 80, ma: 110, spd: 105 },
    requires: [
      { job: 'orator', level: 4 },
      { job: 'squire', level: 5 },
    ],
    actionSet: 'anthems',
    learnable: [
      a('anthem-of-valour', 250),
      a('bria-entrancing-sonnet', 350),
      a('jesters-cap', 300),
      a('countersong', 400),
      a('perfect-shrill', 450),
      a('dodge-and-cover', 400),
      a('reverberation', 350),
      a('lucky-break', 500),
      a('allegretto', 600),
      a('resonance', 450),
      a('demoralising-processional', 550),
      a('maestros-cadence', 800),
    ],
    equip: ['knife', 'sword', 'instrument', 'hat', 'clothing', 'accessory'],
    innate: ['resonant-aura'],
  },
  {
    id: 'dirge',
    name: 'Dirge',
    origin: 'eq2',
    blurb: 'Marks a target. Everything the party does to it lands harder.',
    description:
      'Grave-singers who keep the roll of the dead and read it aloud on the field. A Dirge ' +
      'does modest damage and applies Vulnerable marks that multiply damage from *everyone ' +
      'else* — a marked target takes more from the Knight, the Black Mage and the Dragoon ' +
      'alike. Percussion of Force and Hymn of Horror sit on the enemy line while Oration of ' +
      'Sacrifice feeds the party\'s MP off enemy deaths. The Dirge is the job that makes the ' +
      'rest of the company\'s numbers bigger, and it is worth a slot for exactly that.',
    sprite: { male: '1060_Bard_Male_hd', female: '1062_Dancer_Female_hd' },
    move: 4,
    jump: 3,
    cEvade: 15,
    growth: { hp: 11, mp: 12, pa: 60, ma: 50, spd: 95 },
    mult: { hp: 95, mp: 105, pa: 100, ma: 105, spd: 105 },
    requires: [
      { job: 'mystic', level: 4 },
      { job: 'thief', level: 3 },
    ],
    actionSet: 'dirges',
    learnable: [
      a('percussion-of-force', 300),
      a('hymn-of-horror', 350),
      a('oration-of-sacrifice', 450),
      a('cacophony-of-blades', 500),
      a('gravitas', 400),
      a('luda-nefarious-wail', 550),
      a('exuberant-encore', 700),
      a('claras-chaotic-cacophony', 600),
      a('shroud-of-the-fallen', 400),
      a('death-knell', 650),
      a('requiem', 500),
      a('darksong-blade', 450),
    ],
    equip: ['knife', 'sword', 'instrument', 'hat', 'clothing', 'accessory'],
    innate: ['funeral-rites'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Mechanics
// ─────────────────────────────────────────────────────────────────────────────

export const EQ2_MECHANICS: readonly JobMechanics[] = [
  {
    job: 'shadowknight',
    tags: ['threat', 'lifetap'],
    resources: [
      {
        id: 'dread',
        name: 'Dread',
        max: 100,
        startsAt: 0,
        perTurn: 0,
        decaysOnIdle: false,
        onTarget: false,
        description:
          'Gains 1 Dread per 4 HP of damage taken and 5 Dread per enemy that targets him in a ' +
          'round. Spent by lifetaps and by Reaver. Persists across the whole battle.',
      },
    ],
    pets: [],
    stances: [],
    threat: { generated: 2.0, hasTaunt: true, perDamage: 1.0, perHeal: 0.5 },
    keyAbilities: ['grasp-of-night', 'siphon-strike', 'harm-touch', 'reaver', 'unholy-presence'],
    notes:
      'The threat table is the point. `generated: 2.0` means every action the Shadowknight ' +
      'takes is worth double threat, and `grasp-of-night` is a hard taunt that applies the ' +
      '`taunted` status: while it holds, enemy AI must select the Shadowknight as its target ' +
      'if he is in range of any of its abilities. Lifetaps (`siphon-strike`, `harm-touch`, ' +
      '`reaver`) return 50% of damage dealt as HP, which is why his sustain does not need a ' +
      'healer. Balance lever: Dread income, not lifetap percentage.',
    spriteBorrow: {
      from: '1044_Dragoon_Male_hd / 1046_Dragoon_Female_hd',
      recolour:
        'Battle palette 4 (violet): bruised purple plate, bone-white trim, sickly green sigil. ' +
        'The Dragoon\'s horned helm and heavy pauldrons are already the right silhouette for a ' +
        'dread knight — shorten the helm horns to a duller crest so it does not read as a ' +
        'lancer, repaint the spear cells into a flail, and add a shield to the off hand. ' +
        '(Was 1110/1112 Dark Knight, which is a broken rip: 18-pixel noise, no artwork.)',
    },
  },
  {
    job: 'templar',
    tags: ['ward', 'threat'],
    resources: [],
    pets: [],
    stances: [],
    threat: { generated: 0.75, hasTaunt: false, perDamage: 1.0, perHeal: 0.8 },
    ward: { coefficient: 2.4, duration: 300, stacks: false },
    keyAbilities: ['ward-of-salvation', 'sanctuary', 'divine-arbitration', 'shield-of-faith'],
    notes:
      'Wards are a damage pre-emption layer: the combat resolver must subtract from the ' +
      '`shielded` pool before touching HP, and emit a `status-remove` for `shielded` when the ' +
      'pool empties. Ward size is `MA * 2.4` and it does not stack — recasting replaces, ' +
      'taking the larger value. `sanctuary` is the reactive piece: it fires a heal when the ' +
      'warded ally is hit, resolving before the attacker\'s CT is deducted, which lets a ' +
      'Templar keep a front-liner alive through a turn the White Mage could not reach. ' +
      'Healing generates 0.8 threat per point, so an over-healing Templar will pull.',
    spriteBorrow: {
      from: '1000_Knight_Male_hd / 880_Agrias_hd',
      recolour:
        'White-and-gold liturgical palette over the Knight base; Agrias reads as a female holy ' +
        'knight already and needs only the palette swap. Male sheet needs the sword cells ' +
        'repainted into a flanged mace and a stole added over the pauldrons.',
    },
  },
  {
    job: 'coercer',
    tags: ['charm'],
    resources: [
      {
        id: 'domination',
        name: 'Domination',
        max: 100,
        startsAt: 100,
        perTurn: 0,
        decaysOnIdle: false,
        onTarget: false,
        description:
          'Upkeep pool for active charms. Each charmed unit drains `10 + floor(target.level / 4)` ' +
          'Domination at the start of the Coercer\'s turn. At 0 all charms break immediately.',
      },
    ],
    pets: [],
    stances: [],
    keyAbilities: ['charm', 'mesmerise', 'possess-essence', 'puppetmaster'],
    notes:
      'Charm re-teams the target (`unit.team` becomes the Coercer\'s team) and applies the ' +
      '`charm` status; it does NOT copy the unit or spawn anything. Break conditions, in ' +
      'priority order: Domination hits 0, the Coercer is KO\'d, the charmed unit takes damage ' +
      'from the Coercer\'s own team, or the duration expires. On break the unit reverts to its ' +
      'original team and gains immunity to charm from the same caster for 200 ticks so it ' +
      'cannot be perma-locked. Base success chance is Faith-scaled and reduced by target ' +
      'level: `50 + (MA - target.MA) * 2 - (target.level - level) * 3`, floored at 5%. ' +
      '`mesmerise` applies `sleep` with a damage-break clause. Bosses and story units must be ' +
      'flagged charm-immune by the scenario, not by this table.',
    spriteBorrow: {
      from: '1036_Mystic_Male_hd / 1038_Mystic_Female_hd',
      recolour:
        'Deep indigo and brass over the Mystic\'s teal. The Mystic\'s wide sleeves and pole ' +
        'read as an enchanter already; add a floating focus-gem to the idle cells and swap the ' +
        'pole cells for an open palm.',
    },
  },
  {
    job: 'beastlord',
    tags: ['pet', 'combo'],
    resources: [
      {
        id: 'savagery',
        name: 'Savagery',
        max: 5,
        startsAt: 0,
        perTurn: 0,
        decaysOnIdle: false,
        onTarget: true,
        description:
          'Builds 1 per attack the master or the warder lands on the same target. Held on the ' +
          'target. Spent in full by `bestial-fury`, which scales with the stacks consumed.',
      },
    ],
    pets: [
      {
        id: 'warder',
        name: 'Warder',
        sprite: '1074_Coeurl_hd',
        scale: { hp: 0.7, pa: 0.85, ma: 0.4, spd: 1.1, move: 1.25, jump: 1.0 },
        actionSet: 'warder-instincts',
        permanent: true,
        deathPenalty: true,
      },
    ],
    stances: [],
    keyAbilities: ['bestial-fury', 'sic-warder', 'warder-rush', 'bond-of-blood'],
    notes:
      'The warder deploys with the master at battle start, takes its own slot in the CT queue ' +
      'and is driven by `core/ai` even on the player\'s team unless `sic-warder` retargets it. ' +
      'Its stats are derived at deploy time from the master\'s (`scale`), so it never needs its ' +
      'own level track. Death penalty: while the warder is down the master loses the ' +
      '`warder-bond` innate (-20% PA) and cannot use any Savagery spender for the rest of the ' +
      'battle — deliberately harsh, because a resummonable pet is not an identity. ' +
      '`bond-of-blood` transfers HP the other way, master to warder, as the only in-battle ' +
      'repair.',
    spriteBorrow: {
      from: '1040_Geomancer_Male_hd / 1042_Geomancer_Female_hd (master), 1074_Coeurl_hd (warder)',
      recolour:
        'Master: ochre and tanned hide over the Geomancer\'s green, fur mantle instead of the ' +
        'bell-sleeve, claw-wraps replacing the sword cells. Warder: the Coeurl sheet needs only ' +
        'a warmer palette to stop reading as a wild monster and start reading as a bonded one — ' +
        'a collar detail on the neck cells would sell it completely.',
    },
  },
  {
    job: 'troubador',
    tags: ['aura'],
    resources: [],
    pets: [],
    stances: [],
    keyAbilities: ['anthem-of-valour', 'countersong', 'allegretto', 'maestros-cadence'],
    notes:
      'Anthems are persistent radius-2 effects anchored to the Troubador and recomputed every ' +
      'time the unit moves; allies entering the radius gain the buff on entry and lose it on ' +
      'exit, which makes formation a real decision. Only one anthem is active at a time — ' +
      'starting a second cancels the first. The stacking rule that matters: anthems apply to ' +
      'the `empowered` status channel, Bard songs apply to their own; the combat layer sums ' +
      'them rather than taking the max, so a Bard + Troubador pair is additive. `countersong` ' +
      'is the counter-play: it suppresses all enemy songs, dances and anthems inside its ' +
      'radius while it holds.',
    spriteBorrow: {
      from: '1032_Orator_Male_hd / 1034_Orator_Female_hd',
      recolour:
        'Jewel-tone motley — sapphire and gold — over the Orator\'s muted browns. The Orator\'s ' +
        'plumed hat and long coat are already the right silhouette; the gun/scroll cells need ' +
        'repainting into a lute held across the body, borrowing the arm poses from ' +
        '1060_Bard_Male_hd.',
    },
  },
  {
    job: 'dirge',
    tags: ['dot', 'aura'],
    resources: [],
    pets: [],
    stances: [],
    keyAbilities: ['percussion-of-force', 'hymn-of-horror', 'oration-of-sacrifice', 'death-knell'],
    notes:
      'The Dirge sells damage it does not deal. `percussion-of-force` applies `vulnerable`, a ' +
      'multiplicative +25% damage-taken modifier the combat layer must apply after defence and ' +
      'before elemental modifiers, so it multiplies every ally\'s output rather than adding to ' +
      'one. `mark` (from `death-knell`) is the single-target version: +40%, but only for the ' +
      'next hit from any source. `oration-of-sacrifice` converts an enemy dying anywhere on ' +
      'the field into MP for every ally within radius 3 of the Dirge, which is the sustain ' +
      'engine for a mage-heavy company. Keep the Dirge\'s own damage low: if it out-damages ' +
      'the units it is buffing, the design has failed.',
    spriteBorrow: {
      from: '1060_Bard_Male_hd / 1062_Dancer_Female_hd',
      recolour:
        'Funereal black, bone-white and dried blood over the performer sheets. Male: hood the ' +
        'Bard\'s head cells and swap the harp for a slung drum. Female: the Dancer\'s trailing ' +
        'silks recolour cleanly to mourning weeds; darken the veil cells and drop the ribbon ' +
        'highlights.',
    },
  },
];
