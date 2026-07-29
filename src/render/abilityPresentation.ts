/**
 * Sparse, exact presentation policy for the abilities that deserve a camera beat.
 *
 * The ability ids and VFX paths already live in core data. This render-side table
 * only decides how those authored abilities are presented; it never changes battle
 * state or contributes events.
 */

import type { AbilityId } from '@core/types';

export type SignatureSilhouette =
  | 'collapsed-star'
  | 'dragon-wings'
  | 'judgement-cross'
  | 'healing-lotus'
  | 'spear-crater'
  | 'clock-face'
  | 'fire-caldera'
  | 'soul-tether';

export interface AbilityCameraProfile {
  /** Multiplier over the player's current gameplay zoom. */
  readonly pushScale: number;
  /** Seconds for the push-in and the exact return. */
  readonly pushSeconds: number;
  readonly restoreSeconds: number;
  /** Delay the effect until the camera reaches an initially distant target. */
  readonly effectAfterPush?: boolean;
  /** Optional authored pitch while the effect is active. */
  readonly pitchDegrees?: number;
}

export interface SignatureAbilityPresentation {
  readonly vfx: string;
  readonly silhouette: SignatureSilhouette;
  /** Presence is the explicit significant-ability marker. */
  readonly camera: AbilityCameraProfile;
}

export const SIGNATURE_ABILITY_IDS = [
  'flare',
  'bahamut',
  'holy',
  'curaja',
  'dragon-dive',
  'slow',
  'firaja',
  'drain-life',
] as const satisfies readonly AbilityId[];

export const SIGNATURE_ABILITY_PRESENTATIONS: Readonly<
  Record<(typeof SIGNATURE_ABILITY_IDS)[number], SignatureAbilityPresentation>
> = {
  flare: {
    vfx: 'black/flare',
    silhouette: 'collapsed-star',
    camera: { pushScale: 1.22, pushSeconds: 0.42, restoreSeconds: 0.36, pitchDegrees: 27 },
  },
  bahamut: {
    vfx: 'summon/bahamut',
    silhouette: 'dragon-wings',
    camera: { pushScale: 1.28, pushSeconds: 0.58, restoreSeconds: 0.44, pitchDegrees: 25 },
  },
  holy: {
    vfx: 'white/holy',
    silhouette: 'judgement-cross',
    camera: { pushScale: 1.18, pushSeconds: 0.38, restoreSeconds: 0.34, pitchDegrees: 27 },
  },
  curaja: {
    vfx: 'white/cure-4',
    silhouette: 'healing-lotus',
    camera: { pushScale: 1.12, pushSeconds: 0.34, restoreSeconds: 0.3 },
  },
  'dragon-dive': {
    vfx: 'jump/dive',
    silhouette: 'spear-crater',
    camera: { pushScale: 1.16, pushSeconds: 0.3, restoreSeconds: 0.28, pitchDegrees: 28 },
  },
  slow: {
    vfx: 'time/slow',
    silhouette: 'clock-face',
    camera: { pushScale: 1.08, pushSeconds: 0.26, restoreSeconds: 0.24 },
  },
  firaja: {
    vfx: 'black/fire-4',
    silhouette: 'fire-caldera',
    camera: { pushScale: 1.2, pushSeconds: 0.4, restoreSeconds: 0.34, pitchDegrees: 27 },
  },
  'drain-life': {
    vfx: 'dot/drain-life',
    silhouette: 'soul-tether',
    camera: { pushScale: 1.1, pushSeconds: 0.28, restoreSeconds: 0.26 },
  },
};

export function signatureAbilityPresentation(
  ability: AbilityId,
): SignatureAbilityPresentation | undefined {
  return (
    SIGNATURE_ABILITY_PRESENTATIONS as Readonly<
      Partial<Record<AbilityId, SignatureAbilityPresentation>>
    >
  )[ability];
}
