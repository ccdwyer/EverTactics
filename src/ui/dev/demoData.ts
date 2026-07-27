/**
 * Sample view-models for the UI preview harness.
 *
 * These exist so the interface can be developed and visually reviewed before the
 * battle layer is wired up. They are shaped exactly like the data the game layer
 * will push, and they reference real portrait textures from public/assets.
 */

import type {
  AbilityItemVM,
  CommandItemVM,
  FormationScreenVM,
  JobScreenVM,
  ResultScreenVM,
  RosterScreenVM,
  TargetPreviewVM,
  TurnEntryVM,
  UnitVM,
} from '../types';

export const RAMZA: UnitVM = {
  id: 'u_ramza',
  name: 'Ramza Beoulve',
  team: 'player',
  job: 'Squire',
  jobId: 'squire',
  level: 12,
  hp: 138,
  maxHp: 176,
  mp: 34,
  maxMp: 42,
  brave: 70,
  faith: 68,
  ct: 84,
  portrait: 'wldface_001_08_uitx.png',
  pa: 9,
  ma: 7,
  spd: 8,
  move: 4,
  jump: 3,
  exp: 41,
  jp: 320,
  statuses: [
    { id: 'haste', name: 'Haste', remaining: 24, tone: 'buff', description: 'Charge time accrues 50% faster.' },
    { id: 'protect', name: 'Protect', remaining: 18, tone: 'buff', description: 'Physical damage taken reduced by a third.' },
  ],
};

export const AGRIAS: UnitVM = {
  id: 'u_agrias',
  name: 'Agrias Oaks',
  team: 'player',
  job: 'Holy Knight',
  jobId: 'holyknight',
  level: 13,
  hp: 191,
  maxHp: 204,
  mp: 27,
  maxMp: 40,
  brave: 74,
  faith: 63,
  ct: 41,
  portrait: 'wldface_003_08_uitx.png',
  pa: 11,
  ma: 6,
  spd: 7,
  move: 3,
  jump: 3,
  jp: 610,
  statuses: [],
};

export const WIZARD: UnitVM = {
  id: 'e_wizard',
  name: 'Gaffgarion',
  team: 'enemy',
  job: 'Dark Knight',
  jobId: 'darkknight',
  level: 15,
  hp: 96,
  maxHp: 232,
  mp: 51,
  maxMp: 58,
  brave: 62,
  faith: 44,
  ct: 66,
  portrait: 'blkface_05_04_uitx.png',
  pa: 13,
  ma: 8,
  spd: 8,
  move: 3,
  jump: 3,
  statuses: [
    { id: 'poison', name: 'Poison', remaining: 12, tone: 'debuff', description: 'Loses HP each tick.' },
    { id: 'slow', name: 'Slow', remaining: 20, tone: 'debuff', description: 'Charge time accrues at half rate.' },
    { id: 'oil', name: 'Oil', remaining: -1, tone: 'debuff', description: 'Fire damage doubled.' },
  ],
};

export const MUSTADIO: UnitVM = {
  id: 'u_mustadio',
  name: 'Mustadio',
  team: 'player',
  job: 'Machinist',
  jobId: 'machinist',
  level: 11,
  hp: 121,
  maxHp: 148,
  mp: 20,
  maxMp: 33,
  brave: 66,
  faith: 71,
  ct: 12,
  portrait: 'wldface_004_08_uitx.png',
  pa: 8,
  ma: 6,
  spd: 9,
  move: 4,
  jump: 3,
  jp: 145,
  statuses: [{ id: 'mark', name: 'Mark', remaining: 8, tone: 'debuff' }],
};

export const RAPHA: UnitVM = {
  id: 'u_rapha',
  name: 'Rapha Galthena',
  team: 'ally',
  job: 'Heaven Knight',
  jobId: 'heavenknight',
  level: 12,
  hp: 104,
  maxHp: 140,
  mp: 44,
  maxMp: 62,
  brave: 58,
  faith: 79,
  ct: 30,
  portrait: 'wldface_006_08_uitx.png',
  pa: 6,
  ma: 11,
  spd: 8,
  move: 3,
  jump: 3,
  jp: 240,
  statuses: [{ id: 'shell', name: 'Shell', remaining: 15, tone: 'buff' }],
};

export const ROSTER: UnitVM[] = [RAMZA, AGRIAS, MUSTADIO, RAPHA];

/* The HP figures are not decoration: they are the harness's coverage of the
   rail's health sliver, including one enemy under the 25% critical threshold so
   the ember treatment is exercised on every preview render. */
export const TURN_ORDER: TurnEntryVM[] = [
  { unitId: RAMZA.id, name: 'Ramza', team: 'player', portrait: RAMZA.portrait, current: true, ticksUntil: 0, hp: 158, maxHp: 182 },
  { unitId: WIZARD.id, name: 'Gaffgarion', team: 'enemy', portrait: WIZARD.portrait, current: false, ticksUntil: 2, note: 'Night Sword', hp: 61, maxHp: 240 },
  { unitId: AGRIAS.id, name: 'Agrias', team: 'player', portrait: AGRIAS.portrait, current: false, ticksUntil: 5, hp: 194, maxHp: 194 },
  { unitId: RAPHA.id, name: 'Rapha', team: 'ally', portrait: RAPHA.portrait, current: false, ticksUntil: 7, hp: 88, maxHp: 141 },
  { unitId: MUSTADIO.id, name: 'Mustadio', team: 'player', portrait: MUSTADIO.portrait, current: false, ticksUntil: 11, hp: 120, maxHp: 166 },
  { unitId: 'e_archer', name: 'Archer', team: 'enemy', portrait: 'wldface_012_08_uitx.png', current: false, ticksUntil: 14, hp: 31, maxHp: 155 },
];

export const COMMANDS: CommandItemVM[] = [
  { id: 'move', label: 'Move', enabled: true, icon: 'move', detail: '4', hint: 'Walk up to 4 tiles, jump 3 heights.' },
  { id: 'act', label: 'Act', enabled: true, icon: 'act', opensSubmenu: true, hint: 'Use a Guts ability or attack.' },
  { id: 'item', label: 'Item', enabled: true, icon: 'item', opensSubmenu: true, detail: '9', hint: 'Consume an item from the pack.' },
  { id: 'status', label: 'Status', enabled: true, icon: 'status', hint: 'Inspect this unit in detail.' },
  { id: 'wait', label: 'Wait', enabled: true, icon: 'wait', hint: 'End the turn and choose a facing.' },
];

export const ABILITIES: AbilityItemVM[] = [
  {
    id: 'attack',
    name: 'Attack',
    description: 'A measured swing with the equipped weapon. Damage scales with Physical Attack and weapon power.',
    mp: 0, ct: 0, range: 1, radius: 0, vertical: 3, element: 'none', enabled: true,
    stats: [{ label: 'Formula', value: 'PA × WP' }, { label: 'Accuracy', value: '100%' }],
  },
  {
    id: 'tailwind',
    name: 'Tailwind',
    description: 'A shout that quickens an ally, hastening the accrual of charge time for a short while.',
    mp: 12, ct: 0, range: 3, radius: 1, vertical: 3, element: 'wind', enabled: true,
    stats: [{ label: 'Effect', value: 'Haste, 24 ticks' }, { label: 'Accuracy', value: 'MA + 60%' }],
  },
  {
    id: 'fire2',
    name: 'Fire II',
    description: 'Draws a gout of flame down onto a wide area. Deals heavy fire damage; doubled against oiled targets.',
    mp: 24, ct: 12, range: 5, radius: 1, vertical: 2, element: 'fire', enabled: true,
    stats: [{ label: 'Formula', value: 'MA × 22' }, { label: 'Accuracy', value: 'Faith-based' }],
  },
  {
    id: 'holy',
    name: 'Holy',
    description: 'Calls down a pillar of blinding light. Extremely costly, and slow to summon.',
    mp: 56, ct: 20, range: 5, radius: 0, vertical: 3, element: 'holy', enabled: false,
    reason: 'Not enough MP',
    stats: [{ label: 'Formula', value: 'MA × 40' }],
  },
  {
    id: 'raise',
    name: 'Raise',
    description: 'Returns a fallen ally to consciousness with a fraction of their health restored.',
    mp: 20, ct: 10, range: 4, radius: 0, vertical: 3, element: 'holy', enabled: true,
    stats: [{ label: 'Restores', value: '20% max HP' }],
  },
  {
    id: 'nightsword',
    name: 'Night Sword',
    description: 'A black arc of force that drains the life it cuts, restoring the wielder.',
    mp: 0, ct: 0, range: 3, radius: 0, vertical: 3, element: 'dark', enabled: false,
    reason: 'Requires a knight sword',
  },
];

export const TARGET: TargetPreviewVM = {
  attackerName: 'Ramza',
  targetName: 'Gaffgarion',
  actionName: 'Fire II',
  hitChance: 78,
  facing: 'S',
  relative: 'back',
  targetHp: 96,
  targetMaxHp: 232,
  amountMin: 54,
  amountMax: 68,
  element: 'fire',
  critChance: 6,
  resultHpMin: 28,
  resultHpMax: 42,
  statusChances: [{ name: 'Burning', chance: 35 }],
  breakdown: [
    { label: 'Base accuracy', value: '100%' },
    { label: 'Faith modifier', value: '×0.68' },
    { label: 'Back attack', value: '+15%' },
    { label: 'Target evade', value: '−5%' },
  ],
};

export const JOB_SCREEN: JobScreenVM = {
  unit: RAMZA,
  selectedJob: 'knight',
  jobs: [
    { id: 'squire', name: 'Squire', origin: 'fft', blurb: 'The road every cadet walks first.', jobLevel: 6, jp: 320, totalJp: 1840, unlocked: true, current: true, tier: 0, parents: [], learned: 5, learnable: 8 },
    { id: 'chemist', name: 'Chemist', origin: 'fft', blurb: 'Field medicine and volatile flasks.', jobLevel: 3, jp: 120, totalJp: 640, unlocked: true, current: false, tier: 0, parents: [], learned: 3, learnable: 7 },
    { id: 'knight', name: 'Knight', origin: 'fft', blurb: 'Breaks arms, armour and morale alike.', jobLevel: 4, jp: 210, totalJp: 980, unlocked: true, current: false, tier: 1, parents: ['squire'], learned: 4, learnable: 9 },
    { id: 'archer', name: 'Archer', origin: 'fft', blurb: 'Patience, elevation, and a drawn string.', jobLevel: 2, jp: 60, totalJp: 320, unlocked: true, current: false, tier: 1, parents: ['squire'], learned: 2, learnable: 8 },
    { id: 'whitemage', name: 'White Mage', origin: 'fft', blurb: 'Mends what the field breaks.', jobLevel: 3, jp: 95, totalJp: 520, unlocked: true, current: false, tier: 1, parents: ['chemist'], learned: 4, learnable: 10 },
    { id: 'blackmage', name: 'Black Mage', origin: 'fft', blurb: 'Elemental ruin at range.', jobLevel: 2, jp: 40, totalJp: 260, unlocked: true, current: false, tier: 1, parents: ['chemist'], learned: 3, learnable: 10 },
    { id: 'monk', name: 'Monk', origin: 'fft', blurb: 'Bare hands, broken guards.', jobLevel: 0, jp: 0, totalJp: 0, unlocked: false, requirement: 'Knight Lv 2', current: false, tier: 2, parents: ['knight'], learned: 0, learnable: 8 },
    { id: 'shadowknight', name: 'Shadow Knight', origin: 'eq2', blurb: 'Trades health for the power to command a foe’s attention.', jobLevel: 0, jp: 0, totalJp: 0, unlocked: false, requirement: 'Knight Lv 4, Black Mage Lv 2', current: false, tier: 2, parents: ['knight', 'blackmage'], learned: 0, learnable: 9 },
    { id: 'warden', name: 'Warden', origin: 'eq2', blurb: 'Regrowth, roots, and the patience of forests.', jobLevel: 0, jp: 0, totalJp: 0, unlocked: false, requirement: 'White Mage Lv 3', current: false, tier: 2, parents: ['whitemage'], learned: 0, learnable: 8 },
    { id: 'arcanist', name: 'Arcanist', origin: 'wow', blurb: 'Stacks arcane charges, then spends them ruinously.', jobLevel: 0, jp: 0, totalJp: 0, unlocked: false, requirement: 'Black Mage Lv 4', current: false, tier: 2, parents: ['blackmage'], learned: 0, learnable: 9 },
  ],
  learnables: [
    { id: 'k_breakarm', name: 'Break Armour', description: 'Shatters the target’s body armour.', jp: 200, learned: true, affordable: true, slot: 'action' },
    { id: 'k_breakwep', name: 'Break Weapon', description: 'Ruins the weapon in the target’s hand.', jp: 200, learned: true, affordable: true, slot: 'action' },
    { id: 'k_breakshield', name: 'Break Shield', description: 'Splinters a carried shield.', jp: 180, learned: false, affordable: true, slot: 'action' },
    { id: 'k_breakmind', name: 'Break Mind', description: 'Cows the target, lowering their Brave.', jp: 320, learned: false, affordable: false, slot: 'action' },
    { id: 'k_equipsword', name: 'Equip Sword', description: 'Wield swords regardless of job.', jp: 400, learned: false, affordable: false, slot: 'support' },
    { id: 'k_parry', name: 'Parry', description: 'Chance to turn aside a melee blow.', jp: 260, learned: false, affordable: true, slot: 'reaction' },
    { id: 'k_move2', name: 'Move +1', description: 'Extends movement by one tile.', jp: 200, learned: false, affordable: true, slot: 'movement' },
  ],
  slots: [
    { slot: 'secondary', label: 'Secondary', assignedName: 'White Magic', assignedId: 'whitemagic', options: [
      { id: 'whitemagic', name: 'White Magic', description: 'Restorative and protective spells.' },
      { id: 'blackmagic', name: 'Black Magic', description: 'Elemental destruction.' },
      { id: 'item', name: 'Item', description: 'Field potions and remedies.' },
    ] },
    { slot: 'reaction', label: 'Reaction', assignedName: 'Counter', assignedId: 'counter', options: [
      { id: 'counter', name: 'Counter', description: 'Strike back when struck in melee.' },
      { id: 'autopotion', name: 'Auto-Potion', description: 'Drink a potion when damaged.' },
    ] },
    { slot: 'support', label: 'Support', options: [
      { id: 'equipsword', name: 'Equip Sword', description: 'Wield swords regardless of job.' },
      { id: 'attackup', name: 'Attack Up', description: 'Physical attack raised.' },
    ] },
    { slot: 'movement', label: 'Movement', assignedName: 'Move +1', assignedId: 'move1', options: [
      { id: 'move1', name: 'Move +1', description: 'Extends movement by one tile.' },
      { id: 'jump1', name: 'Jump +1', description: 'Extends jump height by one.' },
    ] },
  ],
};

export const FORMATION: FormationScreenVM = {
  title: 'Deployment',
  subtitle: 'Orbonne Monastery — the cloister approach',
  maxDeployed: 5,
  slots: [
    { index: 0, unitId: RAMZA.id, tile: 'B2' },
    { index: 1, unitId: AGRIAS.id, tile: 'B3' },
    { index: 2, tile: 'C2' },
    { index: 3, tile: 'C3' },
    { index: 4, tile: 'D2' },
    { index: 5, tile: 'D3', locked: true },
  ],
  roster: ROSTER,
};

export const ROSTER_SCREEN: RosterScreenVM = {
  title: 'Roster',
  units: ROSTER,
  gil: 24680,
  notes: { [MUSTADIO.id]: 'Wounded — recovers in 2 days.' },
};

export const RESULT: ResultScreenVM = {
  outcome: 'victory',
  title: 'Battle Report',
  subtitle: 'Orbonne Monastery',
  turns: 14,
  units: [
    { unitId: RAMZA.id, name: 'Ramza Beoulve', portrait: RAMZA.portrait, job: 'Squire', expGained: 62, jpGained: 148, levelBefore: 12, levelAfter: 13, jobLevelBefore: 6, jobLevelAfter: 6, learned: ['Focus'] },
    { unitId: AGRIAS.id, name: 'Agrias Oaks', portrait: AGRIAS.portrait, job: 'Holy Knight', expGained: 48, jpGained: 96, levelBefore: 13, levelAfter: 13, jobLevelBefore: 4, jobLevelAfter: 5 },
    { unitId: MUSTADIO.id, name: 'Mustadio', portrait: MUSTADIO.portrait, job: 'Machinist', expGained: 12, jpGained: 24, levelBefore: 11, levelAfter: 11, jobLevelBefore: 2, jobLevelAfter: 2, incapacitated: true },
    { unitId: RAPHA.id, name: 'Rapha Galthena', portrait: RAPHA.portrait, job: 'Heaven Knight', expGained: 55, jpGained: 110, levelBefore: 12, levelAfter: 13, jobLevelBefore: 3, jobLevelAfter: 4 },
  ],
  loot: [
    { name: 'Mythril Sword', count: 1, rarity: 'fine' },
    { name: 'Phoenix Down', count: 3 },
    { name: 'Chantage', count: 1, rarity: 'rare' },
    { name: 'Potion', count: 5 },
  ],
  gil: 3400,
};
