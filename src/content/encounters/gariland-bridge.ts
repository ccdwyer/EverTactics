import { ARCHER_KIT, KNIGHT_KIT, WHITE_MAGE_KIT } from './loadouts';
import type { Encounter } from './types';

/**
 * A narrow bridge line. The shield pair blocks the cheap route while ranged
 * support makes standing still worse than committing to a flank.
 */
export const garilandBridgeEncounter = {
  id: 'gariland-bridge',
  chapter: 1,
  name: 'Gariland Bridge — The Toll Line',
  blurb: 'Break a disciplined shield wall on a crossing too narrow for the whole company.',
  mapId: 'gariland-bridge',
  seed: 20260802,
  enemies: [
    {
      id: 'e-edric', name: 'Edric', job: 'knight', gender: 'male', team: 'enemy',
      level: 13, zodiac: 'taurus', brave: 76, faith: 44,
      at: { x: 4, y: 1 }, facing: 'S', equipment: KNIGHT_KIT,
      secondary: 'squire', reaction: 'counter', support: 'defense-up',
      movement: 'move-plus-1', personality: 'defensive', ct: 48,
    },
    {
      id: 'e-hugh', name: 'Hugh', job: 'knight', gender: 'male', team: 'enemy',
      level: 12, zodiac: 'cancer', brave: 72, faith: 46,
      at: { x: 6, y: 2 }, facing: 'S', equipment: KNIGHT_KIT,
      secondary: 'squire', reaction: 'counter', support: 'defense-up',
      personality: 'defensive', ct: 32,
    },
    {
      id: 'e-rosamund', name: 'Rosamund', job: 'archer', gender: 'female', team: 'enemy',
      level: 12, zodiac: 'sagittarius', brave: 64, faith: 52,
      at: { x: 8, y: 1 }, facing: 'S', equipment: ARCHER_KIT,
      secondary: 'thief', reaction: 'arrow-guard', support: 'concentrate',
      personality: 'assassin', ct: 24,
    },
    {
      id: 'e-ansel', name: 'Ansel', job: 'white-mage', gender: 'male', team: 'enemy',
      level: 11, zodiac: 'virgo', brave: 48, faith: 78,
      at: { x: 10, y: 2 }, facing: 'S', equipment: WHITE_MAGE_KIT,
      secondary: 'black-mage', reaction: 'regenerator', support: 'half-mp',
      personality: 'support', ct: 14,
    },
  ],
  objective: { kind: 'defeat-all' },
  rewards: { exp: 32, jp: 48 },
  lighting: 'overcast',
  lightingTune: { keyElevation: 42, keyAzimuth: 172, rimIntensity: 0.8 },
  grade: 'ivalice-noon',
  camera: {
    yawIndex: 0,
    frameField: true,
    pitchDegrees: 30,
    focusTile: { x: 7, y: 5, z: 2 },
  },
  post: { exposure: 1.35, dof: 0.85, vignette: 0.9 },
  banner: { title: 'Gariland Bridge', subtitle: 'Break the toll line' },
} as const satisfies Encounter;
