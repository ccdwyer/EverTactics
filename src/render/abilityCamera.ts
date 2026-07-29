/**
 * Camera attention around one already-resolved cast-fire event.
 *
 * Skipping restores only the presentation camera. The effect promise is still
 * awaited, so Game.play can continue through every later battle event in order.
 */

import { Vector3 } from 'three';

import type { AbilityId, Vec3 } from '@core/types';
import {
  HUMANOID_TEXEL_HEIGHT,
  TEXELS_PER_UNIT,
  type CinematicOptions,
} from './camera';
import {
  signatureAbilityPresentation,
  type AbilityCameraProfile,
} from './abilityPresentation';

/** Fast target attention for attacks, items, reactions and non-signature abilities. */
export const ORDINARY_ACTION_CAMERA_PROFILE: AbilityCameraProfile = Object.freeze({
  pushScale: 1.06,
  pushSeconds: 0.2,
  restoreSeconds: 0.18,
  effectAfterPush: true,
});

/** Preserve authored signature beats and give every other resolved action a quick target frame. */
export function abilityCameraProfile(ability: AbilityId): AbilityCameraProfile {
  return signatureAbilityPresentation(ability)?.camera ?? ORDINARY_ACTION_CAMERA_PROFILE;
}

/**
 * Centre the camera on the bounds of the selected panel and every impacted panel.
 * Bounds, rather than an average, keep a sparse target at either edge equally visible.
 */
export function abilityCameraFocus(primary: Vec3, impacts: readonly Vec3[]): Vector3 {
  let minX = primary.x;
  let maxX = primary.x;
  let minY = primary.y;
  let maxY = primary.y;
  let minZ = primary.z;
  let maxZ = primary.z;
  for (const target of impacts) {
    minX = Math.min(minX, target.x);
    maxX = Math.max(maxX, target.x);
    minY = Math.min(minY, target.y);
    maxY = Math.max(maxY, target.y);
    minZ = Math.min(minZ, target.z);
    maxZ = Math.max(maxZ, target.z);
  }
  // Tile world positions sit at a unit's feet. Aim halfway up the visible
  // humanoid so the sprite, hit spark and damage number share the frame.
  const figureCentre = HUMANOID_TEXEL_HEIGHT / TEXELS_PER_UNIT / 2;
  return new Vector3(
    (minX + maxX) * 0.5,
    (minY + maxY) * 0.5 + figureCentre,
    (minZ + maxZ) * 0.5,
  );
}

export interface AbilityCameraRig {
  readonly devicePixelsPerTexel: number;
  pixelScaleToFrameTargets?(
    targets: readonly Vec3[],
    maximum: number,
    paddingCssPixels?: number,
  ): number;
  cinematic(options?: CinematicOptions): Promise<void>;
  endCinematic(duration?: number): Promise<void>;
  cancelCinematic(): void;
}

function listenForAbilityCameraSkip(
  target: EventTarget,
  onSkip: () => void,
): () => void {
  const skip = (event: Event): void => {
    const code = 'code' in event ? String(event.code) : '';
    const handsBackToCameraControls = CAMERA_CONTROL_CODES.has(code);
    event.preventDefault();
    if (!handsBackToCameraControls) event.stopPropagation();
    onSkip();
  };
  const capture = { capture: true };
  const wheel = { capture: true, passive: false };
  target.addEventListener('keydown', skip, capture);
  target.addEventListener('pointerdown', skip, capture);
  target.addEventListener('wheel', skip, wheel);
  return () => {
    target.removeEventListener('keydown', skip, capture);
    target.removeEventListener('pointerdown', skip, capture);
    target.removeEventListener('wheel', skip, wheel);
  };
}

const CAMERA_CONTROL_CODES = new Set([
  'KeyI',
  'KeyJ',
  'KeyK',
  'KeyL',
  'KeyQ',
  'KeyE',
  'Equal',
  'NumpadAdd',
  'Minus',
  'NumpadSubtract',
  'KeyR',
]);

export class AbilityCameraDirector {
  constructor(
    private readonly camera: AbilityCameraRig,
    private readonly input: EventTarget,
  ) {}

  async present(
    profile: AbilityCameraProfile,
    focus: Vec3,
    playEffect: () => Promise<void>,
    targets: readonly Vec3[] = [focus],
  ): Promise<void> {
    let skipped = false;
    let restored = false;
    let stopListening = (): void => {};

    const skip = (): void => {
      if (skipped) return;
      skipped = true;
      stopListening();
      this.camera.cancelCinematic();
    };
    stopListening = listenForAbilityCameraSkip(this.input, skip);

    try {
      const maximumScale = this.camera.devicePixelsPerTexel * profile.pushScale;
      const push = this.camera.cinematic({
        focus,
        pixelScale: this.camera.pixelScaleToFrameTargets?.(targets, maximumScale)
          ?? maximumScale,
        pitchDegrees: profile.pitchDegrees,
        duration: profile.pushSeconds,
      });
      const effect = profile.effectAfterPush
        ? push.then(playEffect)
        : playEffect();
      await Promise.all([push, effect]);
      if (!skipped) {
        await this.camera.endCinematic(profile.restoreSeconds);
        restored = true;
      }
    } finally {
      stopListening();
      if (!skipped && !restored) this.camera.cancelCinematic();
    }
  }
}
