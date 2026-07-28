import {
  BLACK_MAGE_KIT,
  CUTPURSE_KIT,
  MONK_KIT,
  THIEF_KIT,
  VETERAN_KNIGHT_KIT,
} from './loadouts';
import type { Encounter } from './types';

/**
 * An interior knife fight. Corners sever sight lines, so fast melee units can
 * isolate a target before the back-line mystic is visible.
 */
export const dorterStorehouseEncounter = {
  id: 'dorter-storehouse',
  chapter: 2,
  name: 'Dorter Storehouse — Blind Corners',
  blurb: 'Cutpurses spring from cramped aisles where long sight lines and broad formations disappear.',
  mapId: 'dorter-storehouse',
  seed: 20260805,
  enemies: [
    {
      id: 'e-marten', name: 'Marten', job: 'thief', gender: 'male', team: 'enemy',
      level: 16, zodiac: 'gemini', brave: 74, faith: 46,
      at: { x: 8, y: 2 }, facing: 'S', equipment: THIEF_KIT,
      secondary: 'archer', reaction: 'sunken-state', support: 'concentrate',
      movement: 'move-plus-3', personality: 'assassin', ct: 76,
    },
    {
      id: 'e-elowen', name: 'Elowen', job: 'mystic', gender: 'female', team: 'enemy',
      level: 17, zodiac: 'pisces', brave: 48, faith: 86,
      at: { x: 9, y: 2 }, facing: 'S', equipment: BLACK_MAGE_KIT,
      secondary: 'black-mage', reaction: 'absorb-mp', support: 'magick-attack-up',
      personality: 'tactician', ct: 28,
    },
    {
      id: 'e-gautier', name: 'Gautier', job: 'monk', gender: 'male', team: 'enemy',
      level: 17, zodiac: 'leo', brave: 86, faith: 36,
      at: { x: 10, y: 2 }, facing: 'S', equipment: MONK_KIT,
      secondary: 'squire', reaction: 'brave-up', support: 'martial-arts',
      movement: 'move-plus-2', personality: 'aggressive', ct: 64,
    },
    {
      id: 'e-iseult', name: 'Iseult', job: 'ninja', gender: 'female', team: 'enemy',
      level: 18, zodiac: 'scorpio', brave: 82, faith: 42,
      at: { x: 9, y: 4 }, facing: 'W', equipment: CUTPURSE_KIT,
      secondary: 'thief', reaction: 'sunken-state', support: 'concentrate',
      movement: 'move-plus-3', personality: 'assassin', ct: 84,
    },
    {
      id: 'e-berthold', name: 'Berthold', job: 'knight', gender: 'male', team: 'enemy',
      level: 15, zodiac: 'cancer', brave: 78, faith: 44,
      at: { x: 11, y: 5 }, facing: 'W', equipment: VETERAN_KNIGHT_KIT,
      secondary: 'squire', reaction: 'counter', support: 'defense-up',
      personality: 'defensive', ct: 40,
    },
  ],
  objective: { kind: 'defeat-all' },
  rewards: { exp: 45, jp: 70 },
  lighting: 'night',
  lightingTune: {
    keyElevation: 58,
    keyAzimuth: 126,
    keyIntensity: 2.4,
    ambientIntensity: 0.72,
    rimIntensity: 0.95,
  },
  grade: 'dusk-plains',
  camera: {
    yawIndex: 3,
    frameField: true,
    pitchDegrees: 34,
    focusTile: { x: 7, y: 5, z: 2 },
  },
  post: { exposure: 1.65, dof: 1, ao: 1.15, vignette: 1 },
  banner: { title: 'Dorter Storehouse', subtitle: 'Clear the blind corners' },
} as const satisfies Encounter;
