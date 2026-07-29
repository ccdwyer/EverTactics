import {
  BLACK_MAGE_KIT,
  TIME_MAGE_KIT,
  VETERAN_KNIGHT_KIT,
} from './loadouts';
import type { Encounter } from './types';

/** A veteran Orbonne roster built around a defended elevated line. */
export const orbonneReturnEncounter = {
  id: 'orbonne-return',
  chapter: 2,
  name: 'Orbonne Monastery — Ashen Cloister',
  blurb: 'A veteran company occupies the terraces and turns the familiar garden into a redoubt.',
  mapId: 'orbonne-courtyard',
  seed: 20260730,
  enemies: [
    {
      id: 'e-garran', name: 'Garran', job: 'samurai', gender: 'male', team: 'enemy',
      level: 18, zodiac: 'capricorn', brave: 76, faith: 45,
      at: { x: 4, y: 2 }, facing: 'S', equipment: VETERAN_KNIGHT_KIT,
      secondary: 'monk', reaction: 'brave-up', support: 'martial-arts',
      movement: 'move-plus-1', personality: 'aggressive', ct: 58,
    },
    {
      id: 'e-mirelle', name: 'Mirelle', job: 'time-mage', gender: 'female', team: 'enemy',
      level: 17, zodiac: 'libra', brave: 48, faith: 80,
      at: { x: 5, y: 2 }, facing: 'S', equipment: TIME_MAGE_KIT,
      secondary: 'black-mage', reaction: 'regenerator', support: 'half-mp',
      personality: 'tactician', ct: 33,
    },
    {
      id: 'e-cassian', name: 'Cassian', job: 'samurai', gender: 'male', team: 'enemy',
      level: 18, zodiac: 'leo', brave: 82, faith: 50,
      at: { x: 8, y: 2 }, facing: 'S', equipment: VETERAN_KNIGHT_KIT,
      secondary: 'squire', reaction: 'brave-up', support: 'martial-arts',
      personality: 'aggressive', ct: 44,
    },
    {
      id: 'e-yseult', name: 'Yseult', job: 'mystic', gender: 'female', team: 'enemy',
      level: 17, zodiac: 'pisces', brave: 52, faith: 82,
      at: { x: 9, y: 2 }, facing: 'S', equipment: BLACK_MAGE_KIT,
      secondary: 'black-mage', reaction: 'absorb-mp', support: 'magick-attack-up',
      personality: 'tactician', ct: 27,
    },
    {
      id: 'e-bors', name: 'Bors', job: 'knight', gender: 'male', team: 'enemy',
      level: 18, zodiac: 'cancer', brave: 74, faith: 46,
      at: { x: 4, y: 1 }, facing: 'S', equipment: VETERAN_KNIGHT_KIT,
      secondary: 'squire', reaction: 'counter', support: 'defense-up',
      personality: 'aggressive', ct: 36,
    },
  ],
  objective: { kind: 'defeat-all' },
  rewards: { exp: 35, jp: 55 },
  lighting: 'dawn',
  lightingTune: {
    keyElevation: 54,
    keyAzimuth: 138,
    keyIntensity: 3.1,
    hemiIntensity: 1.62,
    ambientIntensity: 0.62,
    skyColor: 0xb6c6da,
    groundColor: 0x7a6248,
    rimIntensity: 0.7,
    shadowRadius: 2.4,
  },
  grade: 'ivalice-noon',
  camera: {
    yawIndex: 0,
    frameField: true,
    pitchDegrees: 30,
    focusTile: { x: 6, y: 6, z: 2 },
  },
  post: { exposure: 1.94, dof: 1, vignette: 1 },
  banner: { title: 'Return to Orbonne', subtitle: 'Clear the ashen cloister' },
} as const satisfies Encounter;
