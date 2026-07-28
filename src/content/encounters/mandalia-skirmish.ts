import { ARCHER_KIT, BLACK_MAGE_KIT, KNIGHT_KIT, MONK_KIT } from './loadouts';
import type { Encounter } from './types';

/** A river-line fight that teaches the choice between the bridge and the ford. */
export const mandaliaSkirmishEncounter = {
  id: 'mandalia-skirmish',
  chapter: 1,
  name: 'Mandalia Plains — Scout Line',
  blurb: 'A light screen holds the crossing, forcing the company to choose speed, cover, or a wet flank.',
  mapId: 'mandalia-plains',
  seed: 20260729,
  enemies: [
    {
      id: 'e-merek', name: 'Merek', job: 'knight', gender: 'male', team: 'enemy',
      level: 12, zodiac: 'taurus', brave: 70, faith: 48,
      at: { x: 12, y: 2 }, facing: 'S', equipment: KNIGHT_KIT,
      secondary: 'squire', reaction: 'counter', support: 'defense-up',
      movement: 'move-plus-1', personality: 'defensive', ct: 38,
    },
    {
      id: 'e-linnet', name: 'Linnet', job: 'archer', gender: 'female', team: 'enemy',
      level: 11, zodiac: 'sagittarius', brave: 68, faith: 52,
      at: { x: 13, y: 3 }, facing: 'S', equipment: ARCHER_KIT,
      secondary: 'squire', reaction: 'arrow-guard', support: 'concentrate',
      personality: 'assassin', ct: 22,
    },
    {
      id: 'e-osric', name: 'Osric', job: 'monk', gender: 'male', team: 'enemy',
      level: 11, zodiac: 'aries', brave: 78, faith: 42,
      at: { x: 11, y: 3 }, facing: 'S', equipment: MONK_KIT,
      secondary: 'squire', reaction: 'brave-up', support: 'martial-arts',
      personality: 'aggressive', ct: 51,
    },
    {
      id: 'e-vara', name: 'Vara', job: 'black-mage', gender: 'female', team: 'enemy',
      level: 11, zodiac: 'scorpio', brave: 46, faith: 78,
      at: { x: 12, y: 4 }, facing: 'S', equipment: BLACK_MAGE_KIT,
      secondary: 'chemist', reaction: 'absorb-mp', support: 'magick-attack-up',
      personality: 'tactician', ct: 16,
    },
  ],
  objective: { kind: 'defeat-all' },
  rewards: { exp: 30, jp: 45 },
  lighting: 'dusk',
  grade: 'dusk-plains',
  camera: { yawIndex: 0, frameField: true },
  banner: { title: 'Mandalia Plains', subtitle: 'Break the scout line' },
} as const satisfies Encounter;
