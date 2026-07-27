/**
 * EverTactics — zodiac compatibility.
 *
 * Final Fantasy Tactics resolves compatibility from the angular distance between two
 * signs on the twelve-sign wheel:
 *
 *   distance 0  (same sign)      → Good
 *   distance 3  or 9 (square)    → Bad
 *   distance 4  or 8 (trine)     → Good
 *   distance 6  (opposition)     → Best or Worst, decided by gender
 *   everything else              → Neutral
 *
 * The opposition case is the famous one: opposite signs of *different* gender are the
 * best possible pairing, opposite signs of the *same* gender the worst.
 *
 * Serpentarius is the thirteenth sign and sits outside the wheel — it has no angular
 * relationship to the other twelve, so it reads Neutral against all of them. Against
 * another Serpentarius the gender rule applies, which is where Best/Worst comes from
 * for the handful of units that carry the sign.
 */

import type { Gender, Zodiac } from '../types';

export type Compatibility = 'best' | 'good' | 'neutral' | 'bad' | 'worst';

/** The twelve wheel signs in order. Serpentarius is deliberately absent. */
export const ZODIAC_WHEEL: readonly Zodiac[] = [
  'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
  'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces',
] as const;

export const ALL_ZODIAC: readonly Zodiac[] = [...ZODIAC_WHEEL, 'serpentarius'] as const;

export const COMPATIBILITY_MULTIPLIER: Readonly<Record<Compatibility, number>> = {
  best: 1.5,
  good: 1.25,
  neutral: 1.0,
  bad: 0.75,
  worst: 0.5,
};

const WHEEL_INDEX: ReadonlyMap<Zodiac, number> = new Map(
  ZODIAC_WHEEL.map((z, i) => [z, i] as const),
);

/**
 * Opposition resolves by gender: different sexes are Best, the same sex is Worst.
 * Monsters have no sex in the astrological sense, so an opposition involving one
 * settles at Good rather than swinging to either extreme.
 */
function opposition(a: Gender, b: Gender): Compatibility {
  if (a === 'monster' || b === 'monster') return 'good';
  return a === b ? 'worst' : 'best';
}

/** Raw compatibility band between two units. */
export function compatibility(
  a: Zodiac,
  b: Zodiac,
  genderA: Gender = 'male',
  genderB: Gender = 'female',
): Compatibility {
  if (a === 'serpentarius' || b === 'serpentarius') {
    // Serpentarius sits off the wheel. Only Serpentarius-on-Serpentarius has an angle.
    if (a === 'serpentarius' && b === 'serpentarius') return opposition(genderA, genderB);
    return 'neutral';
  }

  const ia = WHEEL_INDEX.get(a);
  const ib = WHEEL_INDEX.get(b);
  if (ia === undefined || ib === undefined) return 'neutral';

  const d = Math.abs(ia - ib);
  switch (d) {
    case 0: return 'good';
    case 3: case 9: return 'bad';
    case 4: case 8: return 'good';
    case 6: return opposition(genderA, genderB);
    default: return 'neutral';
  }
}

/** Damage / accuracy multiplier for a pairing. 0.5 – 1.5. */
export function compatibilityMultiplier(
  a: Zodiac,
  b: Zodiac,
  genderA: Gender = 'male',
  genderB: Gender = 'female',
): number {
  return COMPATIBILITY_MULTIPLIER[compatibility(a, b, genderA, genderB)];
}

/** Convenience wrapper for the shape the combat code actually holds. */
export interface ZodiacActor {
  zodiac: Zodiac;
  gender: Gender;
}

export function zodiacBand(caster: ZodiacActor, target: ZodiacActor): Compatibility {
  return compatibility(caster.zodiac, target.zodiac, caster.gender, target.gender);
}

export function zodiacMultiplier(caster: ZodiacActor, target: ZodiacActor): number {
  return COMPATIBILITY_MULTIPLIER[zodiacBand(caster, target)];
}

/** Sign the wheel assigns to a birthday, for character generation. */
export function zodiacForDay(month: number, day: number): Zodiac {
  const cutoffs: readonly (readonly [number, number, Zodiac])[] = [
    [1, 20, 'aquarius'], [2, 19, 'pisces'], [3, 21, 'aries'], [4, 20, 'taurus'],
    [5, 21, 'gemini'], [6, 22, 'cancer'], [7, 23, 'leo'], [8, 23, 'virgo'],
    [9, 23, 'libra'], [10, 23, 'scorpio'], [11, 22, 'sagittarius'], [12, 22, 'capricorn'],
  ];
  for (const entry of cutoffs) {
    const [m, d, sign] = entry;
    if (month === m) return day >= d ? sign : previousSign(sign);
  }
  return 'capricorn';
}

function previousSign(sign: Zodiac): Zodiac {
  const i = WHEEL_INDEX.get(sign);
  if (i === undefined) return 'capricorn';
  const prev = ZODIAC_WHEEL[(i + ZODIAC_WHEEL.length - 1) % ZODIAC_WHEEL.length];
  return prev ?? 'capricorn';
}
