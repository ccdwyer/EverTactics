import type { Encounter } from './types';

/** A short, low-pressure lesson in movement, facing and the turn forecast. */
export const firstLessonEncounter = {
  id: 'first-lesson',
  chapter: 1,
  name: 'Orbonne Monastery — First Watch',
  blurb: 'Close the distance, expose a novice flank, and win before the guard can organise.',
  mapId: 'orbonne-courtyard',
  seed: 20260728,
  enemies: [
    {
      id: 'e-owain', name: 'Owain', job: 'squire', gender: 'male', team: 'enemy',
      level: 4, zodiac: 'taurus', brave: 58, faith: 48,
      at: { x: 6, y: 8 }, facing: 'N',
      equipment: { rightHand: 'dagger', body: 'leather-outfit' },
      secondary: 'chemist', personality: 'defensive', ct: 8,
    },
    {
      id: 'e-maud', name: 'Maud', job: 'chemist', gender: 'female', team: 'enemy',
      level: 3, zodiac: 'virgo', brave: 46, faith: 56,
      at: { x: 4, y: 8 }, facing: 'N',
      equipment: { rightHand: 'dagger', head: 'feather-hat', body: 'linen-robe' },
      secondary: 'squire', personality: 'support', ct: 3,
    },
    {
      id: 'e-ren', name: 'Ren', job: 'archer', gender: 'male', team: 'enemy',
      level: 4, zodiac: 'sagittarius', brave: 54, faith: 44,
      at: { x: 8, y: 8 }, facing: 'N',
      equipment: { rightHand: 'long-bow', body: 'leather-outfit' },
      secondary: 'squire', personality: 'defensive', ct: 12,
    },
  ],
  objective: { kind: 'defeat-all' },
  rewards: { exp: 15, jp: 25 },
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
  banner: { title: 'First Watch', subtitle: 'Break the novice guard' },
} as const satisfies Encounter;
