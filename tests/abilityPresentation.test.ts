import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { requireAbility } from '../src/core/abilities';
import { IsoCamera } from '../src/render/camera';
import {
  SIGNATURE_ABILITY_IDS,
  SIGNATURE_ABILITY_PRESENTATIONS,
  signatureAbilityPresentation,
} from '../src/render/abilityPresentation';
import {
  AbilityCameraDirector,
  ORDINARY_ACTION_CAMERA_PROFILE,
  abilityCameraFocus,
  abilityCameraProfile,
  type AbilityCameraRig,
} from '../src/render/abilityCamera';
import { VFX_KEYS } from '../src/render/vfx';
import { runAiBattle } from './helpers/aiBattle';

const EXPECTED_SIGNATURES = [
  'flare',
  'bahamut',
  'holy',
  'curaja',
  'dragon-dive',
  'slow',
  'firaja',
  'drain-life',
] as const;

describe('signature ability presentation', () => {
  it('registers eight exact authored effects with eight still-frame silhouettes', () => {
    expect(SIGNATURE_ABILITY_IDS).toEqual(EXPECTED_SIGNATURES);

    const silhouettes = new Set<string>();
    for (const id of EXPECTED_SIGNATURES) {
      const ability = requireAbility(id);
      const presentation = signatureAbilityPresentation(id);
      expect(presentation, id).toBeDefined();
      expect(presentation!.vfx, id).toBe(ability.vfx);
      expect(VFX_KEYS, id).toContain(presentation!.vfx);
      expect(presentation!.camera, id).toBeDefined();
      silhouettes.add(presentation!.silhouette);
    }

    expect(silhouettes.size).toBe(EXPECTED_SIGNATURES.length);
    expect(Object.keys(SIGNATURE_ABILITY_PRESENTATIONS).sort()).toEqual(
      [...EXPECTED_SIGNATURES].sort(),
    );
  });

  it('leaves basic attacks, ordinary abilities, and every item unmarked', () => {
    expect(signatureAbilityPresentation('attack')).toBeUndefined();
    expect(signatureAbilityPresentation('fire')).toBeUndefined();
    expect(signatureAbilityPresentation('use-potion')).toBeUndefined();
    expect(signatureAbilityPresentation('use-elixir')).toBeUndefined();
  });

  it('gives ordinary actions a fast fallback while preserving signature profiles', () => {
    expect(abilityCameraProfile('attack')).toBe(ORDINARY_ACTION_CAMERA_PROFILE);
    expect(abilityCameraProfile('fire')).toBe(ORDINARY_ACTION_CAMERA_PROFILE);
    expect(abilityCameraProfile('use-potion')).toBe(ORDINARY_ACTION_CAMERA_PROFILE);
    expect(abilityCameraProfile('flare')).toBe(SIGNATURE_ABILITY_PRESENTATIONS.flare.camera);
    expect(
      ORDINARY_ACTION_CAMERA_PROFILE.pushSeconds
        + ORDINARY_ACTION_CAMERA_PROFILE.restoreSeconds,
    ).toBeLessThan(0.5);
  });

  it('frames the bounds of every impacted target around the selected panel', () => {
    expect(
      abilityCameraFocus(
        new Vector3(4, 2, 8),
        [
          new Vector3(-2, 0, 6),
          new Vector3(10, 4, -2),
        ],
      ),
    ).toEqual(new Vector3(4, 2.75, 3));
  });

  it('keeps seeded event bytes stable when applying the render-side presentation policy', () => {
    const baseline = runAiBattle(7);
    const observed = runAiBattle(7, 'battle-open', false, 400, true, (events) => {
      for (const event of events) {
        if (event.kind === 'cast-fire') abilityCameraProfile(event.ability);
      }
    });

    expect(observed.turns).toBe(baseline.turns);
    expect(JSON.stringify(observed.events)).toBe(JSON.stringify(baseline.events));
  });
});

class FakeCamera implements AbilityCameraRig {
  readonly devicePixelsPerTexel = 3;
  cinematicCalls = 0;
  restoreCalls = 0;
  skipCalls = 0;

  async cinematic(): Promise<void> {
    this.cinematicCalls++;
  }

  async endCinematic(): Promise<void> {
    this.restoreCalls++;
  }

  cancelCinematic(): void {
    this.skipCalls++;
  }
}

class GatedPushCamera extends FakeCamera {
  private finishPush!: () => void;
  readonly push = new Promise<void>((resolve) => {
    this.finishPush = resolve;
  });

  override cinematic(): Promise<void> {
    this.cinematicCalls++;
    return this.push;
  }

  override cancelCinematic(): void {
    this.skipCalls++;
    this.landOnTarget();
  }

  landOnTarget(): void {
    this.finishPush();
  }
}

describe('AbilityCameraDirector', () => {
  const profile = SIGNATURE_ABILITY_PRESENTATIONS.flare.camera;

  it('restores normally after the effect observer completes', async () => {
    const target = new EventTarget();
    const camera = new FakeCamera();
    const director = new AbilityCameraDirector(camera, target);
    let played = 0;

    await director.present(profile, new Vector3(3, 1, 5), async () => {
      played++;
    });

    expect(played).toBe(1);
    expect(camera.cinematicCalls).toBe(1);
    expect(camera.restoreCalls).toBe(1);
    expect(camera.skipCalls).toBe(0);
  });

  it('lands on an ordinary target before its visible effect starts', async () => {
    const target = new EventTarget();
    const camera = new GatedPushCamera();
    const director = new AbilityCameraDirector(camera, target);
    let played = false;

    const running = director.present(
      ORDINARY_ACTION_CAMERA_PROFILE,
      new Vector3(3, 1, 5),
      async () => {
        played = true;
      },
    );
    await Promise.resolve();
    expect(played).toBe(false);

    camera.landOnTarget();
    await running;

    expect(played).toBe(true);
    expect(camera.restoreCalls).toBe(1);
  });

  it('starts an ordinary effect after a skipped push and still awaits its completion', async () => {
    const target = new EventTarget();
    const camera = new GatedPushCamera();
    const director = new AbilityCameraDirector(camera, target);
    let finishEffect!: () => void;
    let effectStarted = false;
    const effect = new Promise<void>((resolve) => {
      finishEffect = resolve;
    });

    const running = director.present(
      ORDINARY_ACTION_CAMERA_PROFILE,
      new Vector3(3, 1, 5),
      () => {
        effectStarted = true;
        return effect;
      },
    );
    await Promise.resolve();

    target.dispatchEvent(new Event('keydown', { cancelable: true }));
    await Promise.resolve();
    expect(effectStarted).toBe(true);
    expect(camera.skipCalls).toBe(1);

    finishEffect();
    await running;
    expect(camera.restoreCalls).toBe(0);
  });

  it('skips camera attention without cancelling the effect or later event playback', async () => {
    const target = new EventTarget();
    const camera = new FakeCamera();
    const director = new AbilityCameraDirector(camera, target);
    let finishEffect!: () => void;
    const effect = new Promise<void>((resolve) => {
      finishEffect = resolve;
    });
    let laterEventObserved = false;

    const running = director.present(profile, new Vector3(3, 1, 5), () => effect);
    await Promise.resolve();

    const skip = new Event('keydown', { cancelable: true });
    target.dispatchEvent(skip);
    expect(skip.defaultPrevented).toBe(true);
    expect(camera.skipCalls).toBe(1);

    finishEffect();
    await running;
    laterEventObserved = true;

    expect(laterEventObserved).toBe(true);
    expect(camera.restoreCalls).toBe(0);
  });
});

interface CameraFrame {
  focus: number[];
  position: number[];
  quaternion: number[];
  projection: number[];
  scale: number;
  pitch: number;
  yaw: number;
  projected: ReturnType<IsoCamera['worldToScreen']>[];
}

function cameraFrame(camera: IsoCamera): CameraFrame {
  return {
    focus: camera.focusPoint.toArray(),
    position: camera.camera.position.toArray(),
    quaternion: camera.camera.quaternion.toArray(),
    projection: camera.camera.projectionMatrix.toArray(),
    scale: camera.devicePixelsPerTexel,
    pitch: camera.pitchRadians,
    yaw: camera.yawRadians,
    projected: [
      new Vector3(0, 0, 0),
      new Vector3(5, 2, -3),
      new Vector3(-4, 1, 7),
    ].map((point) => camera.worldToScreen(point)),
  };
}

async function advance(
  camera: IsoCamera,
  work: Promise<void>,
  frames: number,
  dt = 1 / 60,
): Promise<void> {
  for (let i = 0; i < frames; i++) camera.update(dt);
  await work;
}

describe('IsoCamera ability framing', () => {
  it('lands exactly on the requested focus when the push resolves', async () => {
    const camera = new IsoCamera({ pixelScale: 3, pitchDegrees: 30 });
    camera.setViewport(1600, 900, 1);
    camera.focus(new Vector3(0, 0, 0), { immediate: true });
    const target = new Vector3(12, 4, -9);

    await advance(
      camera,
      camera.cinematic({
        focus: target,
        pixelScale: 3.2,
        duration: 0.2,
      }),
      12,
    );

    expect(camera.focusPoint.toArray()).toEqual(target.toArray());
    expect(camera.settled).toBe(true);
  });

  it('zooms out far enough to keep a wide target group in frame', () => {
    const camera = new IsoCamera({ pixelScale: 5, pitchDegrees: 30 });
    camera.setViewport(1600, 900, 1);

    const fitted = camera.pixelScaleToFrameTargets(
      [
        new Vector3(-8, 0, 0),
        new Vector3(8, 0, 0),
      ],
      5.3,
    );

    expect(fitted).toBeLessThan(5.3);
    expect(fitted).toBeGreaterThan(1);
  });

  it('returns byte-for-byte to its prior framing when restoration resolves', async () => {
    const camera = new IsoCamera({ pixelScale: 3, pitchDegrees: 30 });
    camera.setViewport(1600, 900, 1);
    camera.focus(new Vector3(5, 1.5, -4), { immediate: true });
    const before = cameraFrame(camera);

    await advance(
      camera,
      camera.cinematic({
        focus: new Vector3(-6, 4, 8),
        pixelScale: 3.75,
        pitchDegrees: 26,
        duration: 0.12,
      }),
      8,
    );
    await advance(camera, camera.endCinematic(0.12), 8);

    expect(cameraFrame(camera)).toEqual(before);
    expect(camera.settled).toBe(true);
  });

  it('restores exactly when skipped during the push-in', async () => {
    const camera = new IsoCamera({ pixelScale: 3, pitchDegrees: 30 });
    camera.setViewport(1600, 900, 1);
    camera.focus(new Vector3(2, 0.5, 3), { immediate: true });
    const before = cameraFrame(camera);

    const pushing = camera.cinematic({
      focus: new Vector3(9, 3, -7),
      pixelScale: 3.8,
      pitchDegrees: 25,
      duration: 0.6,
    });
    camera.update(0.1);
    camera.cancelCinematic();
    await pushing;

    expect(cameraFrame(camera)).toEqual(before);
    expect(camera.settled).toBe(true);
  });

  it('restores exactly when skipped during the return', async () => {
    const camera = new IsoCamera({ pixelScale: 3, pitchDegrees: 30 });
    camera.setViewport(1600, 900, 1);
    camera.focus(new Vector3(2, 0.5, 3), { immediate: true });
    const before = cameraFrame(camera);

    await advance(
      camera,
      camera.cinematic({
        focus: new Vector3(9, 3, -7),
        pixelScale: 3.8,
        pitchDegrees: 25,
        duration: 0.1,
      }),
      7,
    );
    const returning = camera.endCinematic(0.6);
    camera.update(0.1);
    camera.cancelCinematic();
    await returning;

    expect(cameraFrame(camera)).toEqual(before);
    expect(camera.settled).toBe(true);
  });

  it('does not accumulate framing drift across one hundred casts', async () => {
    const camera = new IsoCamera({ pixelScale: 3, pitchDegrees: 30 });
    camera.setViewport(1600, 900, 1);
    camera.focus(new Vector3(1, 2, 3), { immediate: true });
    const before = cameraFrame(camera);

    for (let i = 0; i < 100; i++) {
      await advance(
        camera,
        camera.cinematic({
          focus: new Vector3(i % 7, 1 + (i % 3), -(i % 5)),
          pixelScale: 3.4,
          duration: 0.03,
        }),
        2,
      );
      await advance(camera, camera.endCinematic(0.03), 2);
    }

    expect(cameraFrame(camera)).toEqual(before);
    expect(camera.settled).toBe(true);
  });
});
