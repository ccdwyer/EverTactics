import {
  BLACK_MAGE_KIT,
  CUTPURSE_KIT,
  KNIGHT_KIT,
  VETERAN_KNIGHT_KIT,
} from './loadouts';
import type { Encounter } from './types';

/**
 * The elite occupier roster remapped to Lionel's high-ground starts. Four
 * distinct roles make it a final exam without duplicating the Samurai front.
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
      level: 16, zodiac: 'serpentarius', brave: 88, faith: 62,
      at: { x: 5, y: 1 }, facing: 'S', equipment: VETERAN_KNIGHT_KIT,
      secondary: 'knight', reaction: 'counter', support: 'defense-up',
      movement: 'move-plus-2', personality: 'aggressive', ct: 76,
    },
    {
      id: 'e-sybil', name: 'Sybil', job: 'summoner', gender: 'female', team: 'enemy',
      level: 15, zodiac: 'scorpio', brave: 48, faith: 88,
      at: { x: 6, y: 1 }, facing: 'S', equipment: BLACK_MAGE_KIT,
      secondary: 'black-mage', reaction: 'absorb-mp', support: 'magick-attack-up',
      personality: 'tactician', ct: 35,
    },
    {
      id: 'e-roderic', name: 'Roderic', job: 'samurai', gender: 'male', team: 'enemy',
      level: 12, zodiac: 'leo', brave: 86, faith: 42,
      at: { x: 7, y: 2 }, facing: 'S', equipment: KNIGHT_KIT,
      secondary: 'monk',
      personality: 'defensive', ct: 60,
    },
    {
      id: 'e-nyx', name: 'Nyx', job: 'ninja', gender: 'female', team: 'enemy',
      level: 15, zodiac: 'gemini', brave: 84, faith: 40,
      at: { x: 8, y: 2 }, facing: 'S', equipment: CUTPURSE_KIT,
      secondary: 'thief', reaction: 'sunken-state', support: 'concentrate',
      movement: 'move-plus-3', personality: 'assassin', ct: 82,
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
