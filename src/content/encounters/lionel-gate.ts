import {
  ARCHER_KIT,
  BLACK_MAGE_KIT,
  VETERAN_KNIGHT_KIT,
  WHITE_MAGE_KIT,
} from './loadouts';
import type { Encounter } from './types';

/**
 * The first Chapter 2 test: ranged defenders begin above the approach and make
 * the party spend movement, Jump, or magic to dismantle a layered position.
 */
export const lionelGateEncounter = {
  id: 'lionel-gate',
  chapter: 2,
  name: 'Lionel Gate — The High Ward',
  blurb: 'Archers and mages own the battlements while a shield line denies the central stair.',
  mapId: 'lionel-gate',
  seed: 20260804,
  enemies: [
    {
      id: 'e-alard', name: 'Alard', job: 'archer', gender: 'male', team: 'enemy',
      level: 18, zodiac: 'sagittarius', brave: 72, faith: 48,
      at: { x: 5, y: 1 }, facing: 'S', equipment: ARCHER_KIT,
      secondary: 'thief', reaction: 'arrow-guard', support: 'concentrate',
      movement: 'jump-plus-2', personality: 'assassin', ct: 58,
    },
    {
      id: 'e-vivienne', name: 'Vivienne', job: 'black-mage', gender: 'female', team: 'enemy',
      level: 19, zodiac: 'scorpio', brave: 44, faith: 86,
      at: { x: 6, y: 1 }, facing: 'S', equipment: BLACK_MAGE_KIT,
      secondary: 'time-mage', reaction: 'absorb-mp', support: 'magick-attack-up',
      personality: 'tactician', ct: 30,
    },
    {
      id: 'e-godfrey', name: 'Godfrey', job: 'knight', gender: 'male', team: 'enemy',
      level: 19, zodiac: 'taurus', brave: 80, faith: 42,
      at: { x: 7, y: 2 }, facing: 'S', equipment: VETERAN_KNIGHT_KIT,
      secondary: 'squire', reaction: 'counter', support: 'defense-up',
      movement: 'move-plus-1', personality: 'defensive', ct: 52,
    },
    {
      id: 'e-aude', name: 'Aude', job: 'white-mage', gender: 'female', team: 'enemy',
      level: 17, zodiac: 'virgo', brave: 50, faith: 84,
      at: { x: 8, y: 2 }, facing: 'S', equipment: WHITE_MAGE_KIT,
      secondary: 'chemist', reaction: 'regenerator', support: 'half-mp',
      personality: 'support', ct: 20,
    },
    {
      id: 'e-rambert', name: 'Rambert', job: 'samurai', gender: 'male', team: 'enemy',
      level: 19, zodiac: 'aries', brave: 84, faith: 38,
      at: { x: 9, y: 3 }, facing: 'S', equipment: VETERAN_KNIGHT_KIT,
      secondary: 'monk', reaction: 'brave-up', support: 'martial-arts',
      movement: 'jump-plus-2', personality: 'aggressive', ct: 46,
    },
  ],
  objective: { kind: 'defeat-all' },
  rewards: { exp: 40, jp: 65 },
  lighting: 'storm',
  lightingTune: { keyElevation: 48, keyAzimuth: 154, rimIntensity: 1.05 },
  grade: 'ivalice-noon',
  camera: {
    yawIndex: 0,
    frameField: true,
    pitchDegrees: 32,
    focusTile: { x: 8, y: 6, z: 6 },
  },
  post: { exposure: 1.55, dof: 0.9, ao: 1.1, vignette: 1 },
  banner: { title: 'Lionel Gate', subtitle: 'Take the high ward' },
} as const satisfies Encounter;
