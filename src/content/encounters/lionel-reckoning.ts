import {
  BLACK_MAGE_KIT,
  CUTPURSE_KIT,
  VETERAN_KNIGHT_KIT,
  WHITE_MAGE_KIT,
} from './loadouts';
import type { Encounter } from './types';

/**
 * The elite occupier roster remapped to Lionel's six high-ground starts and
 * tuned to resolve under AI-only play. It is a final exam for the siege route.
 */
export const lionelReckoningEncounter = {
  id: 'lionel-reckoning',
  chapter: 2,
  name: 'Lionel Gate — Reckoning',
  blurb: 'The Lion Guard makes its last stand across every tier of the gatehouse.',
  mapId: 'lionel-gate',
  seed: 20260801,
  enemies: [
    {
      id: 'e-judas', name: 'Judas', job: 'dark-knight', gender: 'male', team: 'enemy',
      level: 20, zodiac: 'serpentarius', brave: 88, faith: 62,
      at: { x: 5, y: 1 }, facing: 'S', equipment: VETERAN_KNIGHT_KIT,
      secondary: 'knight', reaction: 'counter', support: 'defense-up',
      movement: 'move-plus-2', personality: 'aggressive', ct: 76,
    },
    {
      id: 'e-sybil', name: 'Sybil', job: 'summoner', gender: 'female', team: 'enemy',
      level: 19, zodiac: 'scorpio', brave: 48, faith: 88,
      at: { x: 6, y: 1 }, facing: 'S', equipment: BLACK_MAGE_KIT,
      secondary: 'black-mage', reaction: 'absorb-mp', support: 'magick-attack-up',
      personality: 'tactician', ct: 35,
    },
    {
      id: 'e-roderic', name: 'Roderic', job: 'samurai', gender: 'male', team: 'enemy',
      level: 19, zodiac: 'leo', brave: 86, faith: 42,
      at: { x: 7, y: 2 }, facing: 'S', equipment: VETERAN_KNIGHT_KIT,
      secondary: 'monk', reaction: 'brave-up', support: 'martial-arts',
      personality: 'defensive', ct: 60,
    },
    {
      id: 'e-nyx', name: 'Nyx', job: 'ninja', gender: 'female', team: 'enemy',
      level: 19, zodiac: 'gemini', brave: 84, faith: 40,
      at: { x: 8, y: 2 }, facing: 'S', equipment: CUTPURSE_KIT,
      secondary: 'thief', reaction: 'sunken-state', support: 'concentrate',
      movement: 'move-plus-3', personality: 'assassin', ct: 82,
    },
    {
      id: 'e-celia', name: 'Celia', job: 'white-mage', gender: 'female', team: 'enemy',
      level: 18, zodiac: 'virgo', brave: 55, faith: 90,
      at: { x: 9, y: 3 }, facing: 'S', equipment: WHITE_MAGE_KIT,
      secondary: 'time-mage', reaction: 'regenerator', support: 'half-mp',
      personality: 'support', ct: 42,
    },
    {
      id: 'e-voss', name: 'Voss', job: 'samurai', gender: 'male', team: 'enemy',
      level: 20, zodiac: 'aries', brave: 86, faith: 38,
      at: { x: 10, y: 3 }, facing: 'S', equipment: VETERAN_KNIGHT_KIT,
      secondary: 'monk', reaction: 'brave-up', support: 'martial-arts',
      personality: 'aggressive', ct: 68,
    },
  ],
  objective: { kind: 'defeat-all' },
  rewards: { exp: 55, jp: 90 },
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
  banner: { title: 'Lionel Reckoning', subtitle: 'Break the Lion Guard' },
} as const satisfies Encounter;
