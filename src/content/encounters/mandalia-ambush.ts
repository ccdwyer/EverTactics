import {
  BLACK_MAGE_KIT,
  HUNTER_KIT,
  THIEF_KIT,
  VETERAN_KNIGHT_KIT,
  WHITE_MAGE_KIT,
} from './loadouts';
import type { Encounter } from './types';

/** The late-game Mandalia roster, tuned to avoid indefinite AI-only Jump stalls. */
export const mandaliaAmbushEncounter = {
  id: 'mandalia-ambush',
  chapter: 2,
  name: 'Mandalia Plains — River Ambush',
  blurb: 'Fast blades close from the ridge while spellcasters command the crossing you thought you knew.',
  mapId: 'mandalia-plains',
  seed: 20260731,
  enemies: [
    {
      id: 'e-rusk', name: 'Rusk', job: 'ninja', gender: 'male', team: 'enemy',
      level: 17, zodiac: 'gemini', brave: 78, faith: 42,
      at: { x: 12, y: 2 }, facing: 'S', equipment: THIEF_KIT,
      secondary: 'thief', reaction: 'sunken-state', support: 'concentrate',
      movement: 'move-plus-3', personality: 'assassin', ct: 72,
    },
    {
      id: 'e-senna', name: 'Senna', job: 'summoner', gender: 'female', team: 'enemy',
      level: 17, zodiac: 'aquarius', brave: 44, faith: 84,
      at: { x: 13, y: 3 }, facing: 'S', equipment: BLACK_MAGE_KIT,
      secondary: 'time-mage', reaction: 'absorb-mp', support: 'half-mp',
      personality: 'tactician', ct: 18,
    },
    {
      id: 'e-holt', name: 'Holt', job: 'knight', gender: 'male', team: 'enemy',
      level: 18, zodiac: 'taurus', brave: 82, faith: 40,
      at: { x: 11, y: 3 }, facing: 'S', equipment: VETERAN_KNIGHT_KIT,
      secondary: 'knight', reaction: 'counter', support: 'defense-up',
      personality: 'aggressive', ct: 49,
    },
    {
      id: 'e-avelin', name: 'Avelin', job: 'white-mage', gender: 'female', team: 'enemy',
      level: 16, zodiac: 'virgo', brave: 52, faith: 86,
      at: { x: 12, y: 4 }, facing: 'S', equipment: WHITE_MAGE_KIT,
      secondary: 'chemist', reaction: 'regenerator', support: 'half-mp',
      personality: 'support', ct: 31,
    },
    {
      id: 'e-dain', name: 'Dain', job: 'archer', gender: 'male', team: 'enemy',
      level: 17, zodiac: 'sagittarius', brave: 72, faith: 48,
      at: { x: 13, y: 5 }, facing: 'S', equipment: HUNTER_KIT,
      secondary: 'thief', reaction: 'arrow-guard', support: 'concentrate',
      personality: 'assassin', ct: 56,
    },
  ],
  objective: { kind: 'defeat-all' },
  rewards: { exp: 40, jp: 65 },
  lighting: 'dusk',
  grade: 'dusk-plains',
  camera: { yawIndex: 0, frameField: true },
  banner: { title: 'Mandalia Ambush', subtitle: 'Take back the crossing' },
} as const satisfies Encounter;
