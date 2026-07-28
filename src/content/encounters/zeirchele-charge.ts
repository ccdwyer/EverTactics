import { HUNTER_KIT, THIEF_KIT, VETERAN_KNIGHT_KIT } from './loadouts';
import type { Encounter } from './types';

/**
 * A long, open approach against five fast units. Mobility and threat projection
 * matter more than holding a compact formation.
 */
export const zeircheleChargeEncounter = {
  id: 'zeirchele-charge',
  chapter: 1,
  name: 'Zeirchele Ridge — Running Battle',
  blurb: 'A mobile raiding line races across the ridge, punishing any company that advances as one block.',
  mapId: 'zeirchele-ridge',
  seed: 20260803,
  enemies: [
    {
      id: 'e-kael', name: 'Kael', job: 'ninja', gender: 'male', team: 'enemy',
      level: 14, zodiac: 'gemini', brave: 80, faith: 38,
      at: { x: 14, y: 2 }, facing: 'S', equipment: THIEF_KIT,
      secondary: 'thief', reaction: 'sunken-state', support: 'concentrate',
      movement: 'move-plus-3', personality: 'assassin', ct: 70,
    },
    {
      id: 'e-lissa', name: 'Lissa', job: 'thief', gender: 'female', team: 'enemy',
      level: 13, zodiac: 'pisces', brave: 70, faith: 52,
      at: { x: 15, y: 2 }, facing: 'S', equipment: THIEF_KIT,
      secondary: 'archer', reaction: 'sunken-state', support: 'gained-jp-up',
      movement: 'move-plus-3', personality: 'assassin', ct: 62,
    },
    {
      id: 'e-wulfric', name: 'Wulfric', job: 'knight', gender: 'male', team: 'enemy',
      level: 14, zodiac: 'aries', brave: 82, faith: 40,
      at: { x: 16, y: 2 }, facing: 'S', equipment: VETERAN_KNIGHT_KIT,
      secondary: 'knight', reaction: 'counter', support: 'defense-up',
      movement: 'move-plus-1', personality: 'aggressive', ct: 50,
    },
    {
      id: 'e-petra', name: 'Petra', job: 'archer', gender: 'female', team: 'enemy',
      level: 12, zodiac: 'sagittarius', brave: 66, faith: 48,
      at: { x: 14, y: 3 }, facing: 'S', equipment: HUNTER_KIT,
      secondary: 'thief', reaction: 'arrow-guard', support: 'concentrate',
      movement: 'jump-plus-2', personality: 'assassin', ct: 34,
    },
    {
      id: 'e-tamon', name: 'Tamon', job: 'thief', gender: 'male', team: 'enemy',
      level: 12, zodiac: 'leo', brave: 76, faith: 36,
      at: { x: 16, y: 3 }, facing: 'S', equipment: THIEF_KIT,
      secondary: 'squire', reaction: 'sunken-state', support: 'gained-jp-up',
      movement: 'move-plus-2', personality: 'aggressive', ct: 44,
    },
  ],
  objective: { kind: 'defeat-all' },
  rewards: { exp: 35, jp: 55 },
  lighting: 'dawn',
  lightingTune: { keyElevation: 38, keyAzimuth: 218, rimIntensity: 0.9 },
  grade: 'ivalice-noon',
  camera: {
    yawIndex: 1,
    frameField: true,
    pitchDegrees: 28,
    focusTile: { x: 9, y: 6, z: 4 },
  },
  post: { exposure: 1.45, dof: 0.8, vignette: 0.85 },
  banner: { title: 'Zeirchele Ridge', subtitle: 'Catch the raiding line' },
} as const satisfies Encounter;
