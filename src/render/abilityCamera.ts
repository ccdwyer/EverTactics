/**
 * Camera attention around one already-resolved cast-fire event.
 *
 * Skipping restores only the presentation camera. The effect promise is still
 * awaited, so Game.play can continue through every later battle event in order.
 */

import type { Vec3 } from '@core/types';
import type { CinematicOptions } from './camera';
import type { AbilityCameraProfile } from './abilityPresentation';

export interface AbilityCameraRig {
  readonly devicePixelsPerTexel: number;
  cinematic(options?: CinematicOptions): Promise<void>;
  endCinematic(duration?: number): Promise<void>;
  cancelCinematic(): void;
}

function listenForAbilityCameraSkip(
  target: EventTarget,
  onSkip: () => void,
): () => void {
  const skip = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
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

export class AbilityCameraDirector {
  constructor(
    private readonly camera: AbilityCameraRig,
    private readonly input: EventTarget,
  ) {}

  async present(
    profile: AbilityCameraProfile,
    focus: Vec3,
    playEffect: () => Promise<void>,
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
      const push = this.camera.cinematic({
        focus,
        pixelScale: this.camera.devicePixelsPerTexel * profile.pushScale,
        pitchDegrees: profile.pitchDegrees,
        duration: profile.pushSeconds,
      });
      await Promise.all([push, playEffect()]);
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
