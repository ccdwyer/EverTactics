/**
 * EverTactics — lighting rig.
 *
 * The diorama read in HD-2D comes almost entirely from light: a single strong,
 * warm-or-cold key with a *tight* shadow map, a hemisphere fill that carries the
 * sky/ground colour into the shadows, and a low, cool rim from behind that
 * separates sprites from the terrain. Everything else is post.
 *
 * Two things are worth understanding before touching the numbers:
 *
 * SHADOW FITTING. A directional light's shadow camera is orthographic; its
 * texel density is `mapSize / frustumExtent`. Leaving the default 500-unit
 * frustum over a 20×20 tile map wastes 95% of the map and gives ~4 texels per
 * tile — mush. `fitTo()` fits the shadow frustum to the actual diorama bounds,
 * which at 2048² over a 24-tile map is ~85 texels per tile: crisp contact
 * shadows under every sprite's feet.
 *
 * BIAS. Constant `bias` fights acne on surfaces facing away from the light but
 * causes peter-panning (shadows detaching from feet) when raised. `normalBias`
 * offsets the shadow lookup along the surface normal instead, which kills acne
 * on curved/angled geometry without detaching contact shadows. So: keep `bias`
 * near zero and do the work with `normalBias`, scaled to the world size of one
 * shadow texel. `fitTo()` recomputes `normalBias` from the fitted extent for
 * exactly that reason.
 *
 * Intensities are physical (three ≥ r155 has no legacy lighting mode). The key
 * is in the low single digits and the tone mapper does the rest; `exposure` is
 * part of the preset because mood is exposure as much as it is colour.
 */

import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  MathUtils,
  Object3D,
  PCFSoftShadowMap,
  Scene,
  Sphere,
  Vector3,
  type WebGLRenderer,
} from 'three';

import { RIG_DISTANCE } from './camera.js';

// ─────────────────────────────────────────────────────────────────────────────
// Presets
// ─────────────────────────────────────────────────────────────────────────────

export type LightingPresetName = 'dawn' | 'overcast' | 'dusk' | 'storm' | 'night';

export interface LightingPreset {
  /** Key light colour. */
  keyColor: number;
  /** Key light intensity (physical units). */
  keyIntensity: number;
  /** Compass bearing of the key, degrees. 0 = from world −Z (north). */
  keyAzimuth: number;
  /** Elevation of the key above the horizon, degrees. */
  keyElevation: number;

  /** Hemisphere fill: sky and ground colours. */
  skyColor: number;
  groundColor: number;
  hemiIntensity: number;

  /** Cool back-light that separates sprite silhouettes from the terrain. */
  rimColor: number;
  rimIntensity: number;
  /** Rim bearing, degrees. Usually key azimuth + ~150. */
  rimAzimuth: number;
  rimElevation: number;

  /** Flat bounce so crevices never go fully black. Keep small. */
  ambientColor: number;
  ambientIntensity: number;

  /** Scene background / clear colour. */
  background: number;
  /**
   * Atmospheric fog. Measured in world units from the camera's FOCUS PLANE, not
   * from the camera: 0 is the point the camera is looking at, positive values
   * are further away. The rig converts these to three's camera-relative
   * `Fog.near`/`Fog.far` using `fogReference` (default `RIG_DISTANCE`), because
   * an orthographic rig sits a fixed, framing-irrelevant distance back and
   * absolute fog distances would either miss the diorama entirely or bury it.
   */
  fogColor: number;
  fogStart: number;
  fogEnd: number;

  /** Renderer tone-mapping exposure for this mood. */
  exposure: number;

  /** Shadow softness (PCF kernel radius) and darkness. */
  shadowRadius: number;
  /** Multiplier on the auto-computed normal bias; raise if acne appears. */
  shadowNormalBiasScale: number;
}

export const LIGHTING_PRESETS: Readonly<Record<LightingPresetName, LightingPreset>> = {
  /** Low warm sun raking across the map, long shadows, cool blue fill. */
  dawn: {
    keyColor: 0xffd2a1,
    keyIntensity: 2.6,
    keyAzimuth: 118,
    keyElevation: 24,
    skyColor: 0x92b2e8,
    groundColor: 0x5a4a3a,
    hemiIntensity: 0.85,
    rimColor: 0xa9c8ff,
    rimIntensity: 0.55,
    rimAzimuth: 292,
    rimElevation: 34,
    ambientColor: 0x3d4a63,
    ambientIntensity: 0.26,
    background: 0x1d2a3d,
    fogColor: 0x2f4258,
    fogStart: 3,
    fogEnd: 38,
    exposure: 1.05,
    shadowRadius: 2.0,
    shadowNormalBiasScale: 1.0,
  },

  /** Flat, neutral, high sun. The "read the board clearly" preset. */
  overcast: {
    keyColor: 0xf2f4f8,
    keyIntensity: 2.4,
    keyAzimuth: 140,
    keyElevation: 50,
    skyColor: 0xc9d6e6,
    groundColor: 0x6b6a63,
    hemiIntensity: 1.15,
    rimColor: 0xdde6f2,
    rimIntensity: 0.3,
    rimAzimuth: 320,
    rimElevation: 40,
    ambientColor: 0x59606c,
    ambientIntensity: 0.3,
    background: 0x51616f,
    fogColor: 0x6e7c8a,
    fogStart: 8,
    fogEnd: 52,
    exposure: 0.95,
    shadowRadius: 3.2,
    shadowNormalBiasScale: 1.2,
  },

  /** Deep amber key, violet shadows. The classic FFT chapter-ending look. */
  dusk: {
    keyColor: 0xffb277,
    keyIntensity: 2.15,
    keyAzimuth: 250,
    keyElevation: 26,
    skyColor: 0x8d88c8,
    groundColor: 0x4a3326,
    hemiIntensity: 1.15,
    rimColor: 0xff8a5c,
    rimIntensity: 0.6,
    rimAzimuth: 70,
    rimElevation: 22,
    ambientColor: 0x3a2f4a,
    ambientIntensity: 0.3,
    background: 0x2a1f33,
    fogColor: 0x4a3350,
    fogStart: 2,
    fogEnd: 34,
    exposure: 0.95,
    shadowRadius: 2.4,
    shadowNormalBiasScale: 1.0,
  },

  /** Bruised sky, weak diffused key, heavy fill. Reads as wet stone. */
  storm: {
    keyColor: 0xb9c4d6,
    keyIntensity: 1.35,
    keyAzimuth: 165,
    keyElevation: 44,
    skyColor: 0x6b7690,
    groundColor: 0x38363a,
    hemiIntensity: 1.1,
    rimColor: 0x9fb4d8,
    rimIntensity: 0.45,
    rimAzimuth: 345,
    rimElevation: 30,
    ambientColor: 0x363b47,
    ambientIntensity: 0.34,
    background: 0x2b3240,
    fogColor: 0x3b4453,
    fogStart: -5,
    fogEnd: 24,
    exposure: 1.12,
    shadowRadius: 4.5,
    shadowNormalBiasScale: 1.5,
  },

  /** Moon key, strong blue hemisphere, near-black bounce. */
  night: {
    keyColor: 0xa8c0ff,
    keyIntensity: 1.35,
    keyAzimuth: 205,
    keyElevation: 52,
    skyColor: 0x24365e,
    groundColor: 0x141822,
    hemiIntensity: 0.75,
    rimColor: 0x6f8fd8,
    rimIntensity: 0.5,
    rimAzimuth: 25,
    rimElevation: 28,
    ambientColor: 0x171e30,
    ambientIntensity: 0.3,
    background: 0x0c1120,
    fogColor: 0x101827,
    fogStart: -1,
    fogEnd: 32,
    exposure: 1.25,
    shadowRadius: 2.8,
    shadowNormalBiasScale: 1.0,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Rig
// ─────────────────────────────────────────────────────────────────────────────

export interface LightingRigOptions {
  /** Shadow map resolution. 2048 is the sweet spot for a 24-tile diorama. */
  shadowMapSize?: number;
  /** Take ownership of `scene.background` and `scene.fog`. */
  manageBackground?: boolean;
  /** Take ownership of `renderer.toneMappingExposure`. */
  manageExposure?: boolean;
  /** Preset to start on. */
  preset?: LightingPresetName;
  /**
   * Distance from the camera to its focus plane, used to convert focus-relative
   * fog distances into three's camera-relative ones. Defaults to the iso rig's
   * `RIG_DISTANCE`; only change this if you swap in a different camera.
   */
  fogReference?: number;
}

/** Mutable numeric copy of a preset, so we can cross-fade between two of them. */
type LiveState = { [K in keyof LightingPreset]: number };

function toLive(p: LightingPreset): LiveState {
  return { ...p };
}

const COLOR_KEYS = [
  'keyColor',
  'skyColor',
  'groundColor',
  'rimColor',
  'ambientColor',
  'background',
  'fogColor',
] as const;

const COLOR_KEY_SET = new Set<string>(COLOR_KEYS);

function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

export class LightingRig {
  readonly group = new Group();
  readonly key: DirectionalLight;
  readonly rim: DirectionalLight;
  readonly hemisphere: HemisphereLight;
  readonly ambient: AmbientLight;

  private readonly scene: Scene;
  private renderer: WebGLRenderer | null = null;

  private readonly manageBackground: boolean;
  private readonly manageExposure: boolean;

  private live: LiveState;
  private from: LiveState;
  private to: LiveState;
  private blend = 1;
  private blendDuration = 0;
  private presetName: LightingPresetName;

  /** World-space bounds the shadow frustum is fitted to. */
  private readonly bounds = new Box3(new Vector3(-12, -2, -12), new Vector3(12, 8, 12));
  private readonly boundsSphere = new Sphere();
  private shadowMapSize: number;
  private fogReference: number;

  private readonly tmpColorA = new Color();
  private readonly tmpColorB = new Color();
  private readonly tmpVec = new Vector3();

  constructor(scene: Scene, options: LightingRigOptions = {}) {
    this.scene = scene;
    this.shadowMapSize = options.shadowMapSize ?? 2048;
    this.manageBackground = options.manageBackground ?? true;
    this.manageExposure = options.manageExposure ?? true;
    this.presetName = options.preset ?? 'dawn';
    this.fogReference = options.fogReference ?? RIG_DISTANCE;

    const start = LIGHTING_PRESETS[this.presetName];
    this.live = toLive(start);
    this.from = toLive(start);
    this.to = toLive(start);

    this.group.name = 'LightingRig';

    this.key = new DirectionalLight(0xffffff, 1);
    this.key.name = 'KeyLight';
    this.key.castShadow = true;
    this.key.shadow.mapSize.setScalar(this.shadowMapSize);
    this.key.shadow.bias = -0.00008;
    this.key.shadow.normalBias = 0.02;
    this.key.shadow.camera.near = 0.5;
    this.key.shadow.camera.far = 200;
    this.group.add(this.key, this.key.target);

    this.rim = new DirectionalLight(0xffffff, 0.5);
    this.rim.name = 'RimLight';
    this.rim.castShadow = false;
    this.group.add(this.rim, this.rim.target);

    this.hemisphere = new HemisphereLight(0xffffff, 0x000000, 1);
    this.hemisphere.name = 'HemisphereFill';
    this.group.add(this.hemisphere);

    this.ambient = new AmbientLight(0xffffff, 0.2);
    this.ambient.name = 'BounceAmbient';
    this.group.add(this.ambient);

    scene.add(this.group);

    this.fitTo(this.bounds);
    this.commit();
  }

  /** Update the fog reference plane if the camera rig's distance changes. */
  setFogReference(distance: number): void {
    this.fogReference = distance;
    this.commit();
  }

  get preset(): LightingPresetName {
    return this.presetName;
  }

  /**
   * Bind the renderer so the rig can own tone mapping and shadow-map settings.
   * Safe to call more than once.
   */
  bindRenderer(renderer: WebGLRenderer): void {
    this.renderer = renderer;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    this.commit();
  }

  /** Switch mood. `durationSeconds` 0 applies instantly. */
  apply(name: LightingPresetName, durationSeconds = 0): void {
    const target = LIGHTING_PRESETS[name];
    this.presetName = name;
    if (durationSeconds <= 0) {
      this.from = toLive(target);
      this.to = toLive(target);
      this.live = toLive(target);
      this.blend = 1;
      this.blendDuration = 0;
      this.commit();
      return;
    }
    this.from = { ...this.live };
    this.to = toLive(target);
    this.blend = 0;
    this.blendDuration = durationSeconds;
  }

  /** True when no cross-fade is in flight. Used for render convergence. */
  get settled(): boolean {
    return this.blend >= 1;
  }

  /** Read-only snapshot of the currently applied values (post cross-fade). */
  get current(): Readonly<LiveState> {
    return this.live;
  }

  update(dt: number): void {
    if (this.blend >= 1) return;
    this.blend = Math.min(1, this.blend + dt / Math.max(1e-4, this.blendDuration));
    const t = easeInOutSine(this.blend);

    for (const rawKey of Object.keys(this.to) as (keyof LiveState)[]) {
      const a = this.from[rawKey];
      const b = this.to[rawKey];
      if (COLOR_KEY_SET.has(rawKey)) {
        // Interpolate colours in linear-sRGB so a warm→cool fade does not dip
        // through mud the way a raw hex lerp does.
        this.tmpColorA.setHex(a, 'srgb');
        this.tmpColorB.setHex(b, 'srgb');
        this.tmpColorA.lerp(this.tmpColorB, t);
        this.live[rawKey] = this.tmpColorA.getHex('srgb');
      } else {
        this.live[rawKey] = MathUtils.lerp(a, b, t);
      }
    }
    this.commit();
  }

  /**
   * Fit the key light's shadow frustum to the diorama. Call after terrain is
   * built; re-call if the map bounds change.
   */
  fitTo(bounds: Box3): void {
    this.bounds.copy(bounds);
    this.bounds.getBoundingSphere(this.boundsSphere);
    // A little slack so units standing on the outermost tiles still cast.
    this.boundsSphere.radius = Math.max(1, this.boundsSphere.radius * 1.08 + 1);
    this.commit();
  }

  /** Convenience: fit to a `width × height` tile grid with the given max height. */
  fitToGrid(width: number, height: number, maxHeightUnits = 8): void {
    this.fitTo(
      new Box3(new Vector3(-1, -1.5, -1), new Vector3(width + 1, maxHeightUnits * 0.5 + 2, height + 1)),
    );
  }

  /** Change shadow resolution at runtime (disposes the old map). */
  setShadowMapSize(size: number): void {
    if (size === this.shadowMapSize) return;
    this.shadowMapSize = size;
    this.key.shadow.mapSize.setScalar(size);
    this.key.shadow.map?.dispose();
    this.key.shadow.map = null;
    this.commit();
  }

  /** Push the live state onto the three.js objects. */
  private commit(): void {
    const s = this.live;
    const centre = this.boundsSphere.center;
    const radius = this.boundsSphere.radius;
    const distance = radius * 2.6 + 4;

    // Key
    this.key.color.setHex(s.keyColor, 'srgb');
    this.key.intensity = s.keyIntensity;
    placeDirectional(this.key, centre, s.keyAzimuth, s.keyElevation, distance, this.tmpVec);

    const cam = this.key.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = Math.max(0.1, distance - radius - 2);
    cam.far = distance + radius + 2;
    cam.updateProjectionMatrix();

    this.key.shadow.radius = s.shadowRadius;
    // One shadow texel, in world units. normalBias must be a little over one
    // texel diagonal or slanted tile faces alias; much more and feet detach.
    const texelWorld = (radius * 2) / this.shadowMapSize;
    this.key.shadow.normalBias = texelWorld * 1.6 * s.shadowNormalBiasScale;
    this.key.shadow.bias = -0.00008;

    // Rim
    this.rim.color.setHex(s.rimColor, 'srgb');
    this.rim.intensity = s.rimIntensity;
    placeDirectional(this.rim, centre, s.rimAzimuth, s.rimElevation, distance, this.tmpVec);

    // Fill
    this.hemisphere.color.setHex(s.skyColor, 'srgb');
    this.hemisphere.groundColor.setHex(s.groundColor, 'srgb');
    this.hemisphere.intensity = s.hemiIntensity;
    this.hemisphere.position.set(centre.x, centre.y + radius, centre.z);

    this.ambient.color.setHex(s.ambientColor, 'srgb');
    this.ambient.intensity = s.ambientIntensity;

    if (this.manageBackground) {
      if (this.scene.background instanceof Color) this.scene.background.setHex(s.background, 'srgb');
      else this.scene.background = new Color().setHex(s.background, 'srgb');

      const fog = this.scene.fog;
      if (fog instanceof Fog) {
        fog.color.setHex(s.fogColor, 'srgb');
        fog.near = this.fogReference + s.fogStart;
        fog.far = this.fogReference + s.fogEnd;
      } else {
        const fogColor = new Color().setHex(s.fogColor, 'srgb');
        this.scene.fog = new Fog(fogColor, this.fogReference + s.fogStart, this.fogReference + s.fogEnd);
      }
    }

    if (this.manageExposure && this.renderer) {
      this.renderer.toneMappingExposure = s.exposure;
    }
  }

  dispose(): void {
    this.key.shadow.map?.dispose();
    this.key.dispose();
    this.rim.dispose();
    this.hemisphere.dispose();
    this.ambient.dispose();
    this.group.removeFromParent();
  }
}

/**
 * Place a directional light on a sphere around `centre`.
 *
 * `azimuth` is a compass bearing in degrees: 0 puts the light due north of the
 * subject (world −Z), 90 due east (world +X). `elevation` is degrees above the
 * horizon. The light's target is parented into the same group, so moving both
 * keeps the direction exact regardless of where the group sits.
 */
function placeDirectional(
  light: DirectionalLight,
  centre: Vector3,
  azimuthDeg: number,
  elevationDeg: number,
  distance: number,
  scratch: Vector3,
): void {
  const az = MathUtils.degToRad(azimuthDeg);
  const el = MathUtils.degToRad(elevationDeg);
  const horizontal = Math.cos(el);
  scratch.set(Math.sin(az) * horizontal, Math.sin(el), -Math.cos(az) * horizontal);
  light.position.copy(centre).addScaledVector(scratch, distance);
  light.target.position.copy(centre);
  light.target.updateMatrixWorld();
}

/** Escape hatch for tools that want to drop the rig into an arbitrary parent. */
export function attachRig(rig: LightingRig, parent: Object3D): void {
  parent.add(rig.group);
}
