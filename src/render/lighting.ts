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
 *
 * COLOUR IS NOT OPTIONAL. Every preset here commits to a complementary split —
 * a saturated warm key against a saturated cool fill, or the reverse. Neutral
 * white light on a stone courtyard is the single fastest way to read as an
 * untuned engine test, and the reference corpus contains no such frame. Look at
 * `refs/curated/triangle/press_002_gematsu_1920x1080.jpg`: the entire village is
 * near-black except for orange pools around each fire, and the grass inside
 * those pools is *orange*, not green-with-a-warm-tint.
 *
 * PRACTICALS. Those pools come from real point lights, not from painting the
 * texture. `LIGHTING_PRACTICALS` gives each preset a handful of placed point
 * lights (braziers, window shafts, moon-through-the-arches) positioned in
 * normalised diorama space so they land correctly on any map size. They flicker
 * on a summed-sine noise so a torch never reads as a static blob.
 *
 * THE PROBE. `AmbientLight` is a constant added to every surface regardless of
 * which way it faces — a flat grey wash, which is exactly the thing the fail
 * list forbids. A `LightProbe` instead stores irradiance as spherical harmonics,
 * so ambient can be *directional*: warm from the key side, cold from the fill
 * side, earth-bounce from below. That is the cheap irradiance term that keeps
 * shadowed faces coloured rather than merely dark.
 */

import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  LightProbe,
  MathUtils,
  Object3D,
  PCFSoftShadowMap,
  PointLight,
  Scene,
  Sphere,
  SphericalHarmonics3,
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

  /**
   * Strength of the directional light probe. The probe projects the key, rim,
   * sky and ground colours into spherical harmonics, so a surface facing the
   * key picks up warm bounce and one facing away picks up the cold fill even
   * where no direct light reaches. 0 disables it and falls back to the flat
   * `ambient`, which is the look this whole file exists to avoid.
   */
  probeIntensity: number;

  /**
   * Saturation multiplier applied to every light colour on its way to the GPU.
   * 1 is "as authored". The presets sit near 1.8 because authored hex colours
   * are chosen by eye against a white page and read as grey once tone mapping
   * and a colour grade have both pulled chroma out of them.
   */
  chroma: number;

  /**
   * Strength of the complementary split, 0..1. Pushes the key warm and the rim,
   * sky and ambient cold about their authored hues. This is what survives a map
   * or scenario patching neutral colours in over the preset — hue is the
   * author's, the split is the rig's.
   */
  colorSplit: number;
}

/**
 * A placed point light — brazier, window shaft, lava vent.
 *
 * Position is normalised to the *fitted diorama bounds*, so one spec works on a
 * 12×12 courtyard and a 24×18 field alike: `u`/`v` are fractions across the
 * bounds in x/z, and `y` is an absolute world height (terrain sits around
 * y ∈ [0, 4], so 1.4–3 puts a flame at torch height).
 */
export interface PracticalSpec {
  u: number;
  v: number;
  y: number;
  color: number;
  /** Peak intensity in candela. Irradiance falls as `intensity / d²`. */
  intensity: number;
  /** Hard cutoff radius in world units. Small numbers are the point. */
  distance: number;
  /** Fraction of `intensity` that flickers, 0..1. */
  flicker?: number;
  /** Flicker rate in Hz. Fire lives around 6–11. */
  rate?: number;
  /** Positional wander amplitude in world units. Keeps the pool from being a decal. */
  sway?: number;
}

/** Hard cap on placed lights, so material shader permutations never change. */
export const MAX_PRACTICALS = 6;

/**
 * Scene point lights whose name starts with this are adopted by the rig and
 * given flicker. `terrain.ts` names its brazier lights `brazier-light`.
 */
export const ADOPTED_LIGHT_PREFIX = 'brazier';

/** Upper bound on adopted prop lights, so a big map cannot make the sweep costly. */
const MAX_ADOPTED = 8;

export const LIGHTING_PRESETS: Readonly<Record<LightingPresetName, LightingPreset>> = {
  /**
   * Cold blue dawn broken by a low amber sun. Amber key at 20° rakes across the
   * courtyard; a saturated cyan fill from behind separates every silhouette;
   * anything neither light reaches falls to near-black navy. This is the map's
   * committed complementary split — orange against cyan, both saturated.
   */
  dawn: {
    keyColor: 0xffae55,
    keyIntensity: 4.4,
    keyAzimuth: 118,
    keyElevation: 20,
    skyColor: 0x3a6ad4,
    groundColor: 0x7e3c17,
    hemiIntensity: 1.0,
    rimColor: 0x46a6ff,
    rimIntensity: 1.6,
    rimAzimuth: 296,
    rimElevation: 30,
    ambientColor: 0x0e1a30,
    ambientIntensity: 0.1,
    background: 0x0a1424,
    fogColor: 0x13253e,
    fogStart: 4,
    fogEnd: 40,
    // The scenario multiplies its own exposure by this one, and the preset's
    // half of that product is where "how bright is this time of day" lives. A
    // dawn that reads as a moonless night has deep shadow but no key, and the
    // reference frames always give you one clearly readable lit band to look at.
    exposure: 1.5,
    shadowRadius: 2.0,
    shadowNormalBiasScale: 1.0,
    probeIntensity: 1.35,
    chroma: 1.85,
    colorSplit: 0.42,
  },

  /**
   * Diffused daylight. Still not neutral: a silver-cool sky key against warm
   * sand bounce and a low sodium rim. "Overcast" is a colour temperature split,
   * not an absence of colour.
   */
  overcast: {
    keyColor: 0xcfe0ff,
    keyIntensity: 3.1,
    keyAzimuth: 140,
    keyElevation: 46,
    skyColor: 0x7fa8e4,
    groundColor: 0x8d6b3e,
    hemiIntensity: 1.25,
    rimColor: 0xffc07a,
    rimIntensity: 0.85,
    rimAzimuth: 320,
    rimElevation: 34,
    ambientColor: 0x28303f,
    ambientIntensity: 0.14,
    background: 0x33445a,
    fogColor: 0x44586e,
    fogStart: 8,
    fogEnd: 52,
    // Higher than the others, and it reaches the frame through *both* paths, so
    // treat it as the master brightness for every dawn map — including
    // `battle-open`, the shipping one. With post off it lands on
    // `renderer.toneMappingExposure`; with post on the renderer is switched to
    // `NoToneMapping` and `Game.applyPostProfile` multiplies this into
    // `PostStack.settings.exposure` instead. (An earlier note here claimed the
    // dawn scenes all run post-off. None of them do — `sprites-only` is the
    // post-off diagnostic and it uses `overcast`.) At 1.0 the cloister read as a
    // silhouette; this is what makes the garden legible.
    exposure: 1.75,
    shadowRadius: 3.2,
    shadowNormalBiasScale: 1.2,
    probeIntensity: 0.9,
    chroma: 1.7,
    colorSplit: 0.34,
  },

  /**
   * Golden hour against violet shadow with a teal kicker — Triangle Strategy's
   * throne-room grammar applied outdoors. The most aggressive split in the set.
   */
  dusk: {
    keyColor: 0xff9440,
    keyIntensity: 4.0,
    keyAzimuth: 250,
    keyElevation: 18,
    skyColor: 0x7154d6,
    groundColor: 0x5e2510,
    hemiIntensity: 1.1,
    rimColor: 0x33d2ff,
    rimIntensity: 1.35,
    rimAzimuth: 66,
    rimElevation: 26,
    ambientColor: 0x1c1231,
    ambientIntensity: 0.12,
    background: 0x150d21,
    fogColor: 0x301d3d,
    fogStart: 2,
    fogEnd: 34,
    exposure: 1.06,
    shadowRadius: 2.4,
    shadowNormalBiasScale: 1.0,
    probeIntensity: 1.05,
    chroma: 1.9,
    colorSplit: 0.5,
  },

  /** Cold steel key, sodium underlight from the wet ground. Reads as wet stone. */
  storm: {
    keyColor: 0x9dc6ff,
    keyIntensity: 2.1,
    keyAzimuth: 165,
    keyElevation: 40,
    skyColor: 0x395884,
    groundColor: 0x4c3a29,
    hemiIntensity: 1.15,
    rimColor: 0xff9f60,
    rimIntensity: 0.75,
    rimAzimuth: 345,
    rimElevation: 28,
    ambientColor: 0x18202f,
    ambientIntensity: 0.14,
    background: 0x1d2735,
    fogColor: 0x27364a,
    fogStart: -5,
    fogEnd: 24,
    exposure: 1.2,
    shadowRadius: 4.5,
    shadowNormalBiasScale: 1.5,
    probeIntensity: 0.9,
    chroma: 1.7,
    colorSplit: 0.36,
  },

  /**
   * Moon key over near-black. This preset carries almost no ambient on purpose:
   * the readable light is supposed to come from the braziers in
   * `LIGHTING_PRACTICALS.night` and from spell VFX, exactly as in the FFT night
   * battles. Turn the practicals off and the map should look genuinely unlit.
   */
  night: {
    keyColor: 0x7ba6ff,
    keyIntensity: 1.9,
    keyAzimuth: 205,
    keyElevation: 50,
    skyColor: 0x142c5c,
    groundColor: 0x090c15,
    hemiIntensity: 0.7,
    rimColor: 0x4478d4,
    rimIntensity: 0.85,
    rimAzimuth: 25,
    rimElevation: 28,
    ambientColor: 0x070b16,
    ambientIntensity: 0.1,
    background: 0x03060e,
    fogColor: 0x060c19,
    fogStart: -1,
    fogEnd: 32,
    exposure: 1.35,
    shadowRadius: 2.8,
    shadowNormalBiasScale: 1.0,
    probeIntensity: 0.8,
    chroma: 1.8,
    colorSplit: 0.44,
  },
};

/**
 * Placed practical lights per mood.
 *
 * These are what put *pools* on the ground. Compare the reference village frame:
 * the light is not a global level, it is a set of discrete sources with hard
 * falloff and everything between them is black. Intensities look large because
 * they are candela with inverse-square decay — at 3 units from a 34 cd source
 * the irradiance is ~3.8, at 6 units it is ~0.9, and past `distance` it is zero.
 */
export const LIGHTING_PRACTICALS: Readonly<Record<LightingPresetName, readonly PracticalSpec[]>> = {
  /**
   * Cold accents only.
   *
   * The *warm* practicals on this map are real props: `terrain.ts` builds
   * braziers with coals and gives each one a point light, and the rig picks
   * those up through `ADOPTED_LIGHT_PREFIX` to add flicker. Duplicating them
   * here just produced a second, worse set of orange blobs sitting on top of
   * the courtyard wall. So the preset supplies the half of the split the props
   * cannot: cold bounce out of the reflecting pool, and cold sky spill down the
   * north arcade — which is what stops the frame collapsing into one orange
   * tone the moment the braziers light up.
   */
  dawn: [
    { u: 0.5, v: 0.54, y: 0.55, color: 0x4d90ff, intensity: 9, distance: 7.5, flicker: 0.07, rate: 1.7, sway: 0.04 },
    // Outside the colonnade, not among it. Parked at v = 0.12 these sat inside a
    // pillar and put a blown blue highlight on its shaft — a sky wash has to
    // originate beyond the architecture it is washing, or it reads as a lamp.
    { u: 0.5, v: 0.02, y: 3.2, color: 0x6aa4ff, intensity: 11, distance: 12.0, flicker: 0.04, rate: 0.7 },
    { u: 0.02, v: 0.62, y: 3.0, color: 0x5c96f0, intensity: 8, distance: 10.0, flicker: 0.04, rate: 0.9 },
  ],

  overcast: [
    { u: 0.5, v: 0.5, y: 1.2, color: 0xffb469, intensity: 6, distance: 10, flicker: 0.05, rate: 2.1 },
  ],

  dusk: [
    { u: 0.3, v: 0.36, y: 2.0, color: 0xff8e34, intensity: 16, distance: 6.0, flicker: 0.32, rate: 8.9, sway: 0.1 },
    { u: 0.72, v: 0.66, y: 2.0, color: 0xff9c46, intensity: 16, distance: 6.0, flicker: 0.32, rate: 7.3, sway: 0.1 },
    { u: 0.5, v: 0.16, y: 3.2, color: 0x4fbcff, intensity: 12, distance: 8.0, flicker: 0.1, rate: 1.3 },
  ],

  storm: [
    { u: 0.36, v: 0.5, y: 2.0, color: 0xff9a52, intensity: 12, distance: 6.0, flicker: 0.45, rate: 11.5, sway: 0.14 },
  ],

  /**
   * The night map is lit *by* these. Placed inside the playfield rather than on
   * its perimeter — a light on the outer wall illuminates the wall's outside
   * face and nothing the player is looking at.
   */
  night: [
    { u: 0.32, v: 0.3, y: 1.9, color: 0xff9440, intensity: 22, distance: 6.5, flicker: 0.36, rate: 8.2, sway: 0.12 },
    { u: 0.7, v: 0.36, y: 1.9, color: 0xffa252, intensity: 18, distance: 6.2, flicker: 0.36, rate: 6.7, sway: 0.12 },
    { u: 0.3, v: 0.74, y: 1.7, color: 0xff8a30, intensity: 20, distance: 6.5, flicker: 0.4, rate: 9.9, sway: 0.13 },
    { u: 0.72, v: 0.7, y: 1.7, color: 0xffb066, intensity: 15, distance: 6.0, flicker: 0.33, rate: 7.7, sway: 0.11 },
    { u: 0.5, v: 0.5, y: 4.2, color: 0x6a95ff, intensity: 14, distance: 10.0, flicker: 0.06, rate: 0.9 },
  ],
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

/**
 * Smooth deterministic pseudo-noise in roughly [-1, 1]. Three summed sines with
 * incommensurate periods: no table, no allocation, and — critically for a flame
 * — no repeat you can see. A `Math.random()` flicker reads as television static;
 * fire wanders.
 */
function flickerNoise(t: number, seed: number): number {
  return (
    Math.sin(t + seed) * 0.55 +
    Math.sin(t * 2.31 + seed * 1.7) * 0.28 +
    Math.sin(t * 4.77 + seed * 2.9) * 0.17
  );
}

export class LightingRig {
  readonly group = new Group();
  readonly key: DirectionalLight;
  readonly rim: DirectionalLight;
  readonly hemisphere: HemisphereLight;
  readonly ambient: AmbientLight;
  /** Directional ambient. Coloured by the map mood rather than flat grey. */
  readonly probe: LightProbe;
  /** Placed point lights — braziers, shafts, pool bounce. Fixed-size pool. */
  readonly practicals: PointLight[] = [];

  private readonly scene: Scene;
  private renderer: WebGLRenderer | null = null;

  private practicalSpecs: readonly PracticalSpec[] = [];
  private readonly practicalHome: Vector3[] = [];
  private readonly practicalBase: number[] = [];
  private flickerClock = 0;
  /** Prop lights owned by other modules that the rig drives the flicker of. */
  private readonly adopted: PointLight[] = [];
  private readonly adoptedBase: number[] = [];
  private readonly adoptedHome: Vector3[] = [];
  private adoptScan = 0;
  /** Set once an owner drives `update()`, which retires the fallback ticker. */
  private externallyDriven = false;
  private rafHandle: number | null = null;
  private rafLast = 0;
  private readonly shBasis: number[] = new Array<number>(9).fill(0);
  private readonly shColor = new Vector3();
  private readonly probeSh = new SphericalHarmonics3();

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

    this.probe = new LightProbe();
    this.probe.name = 'IrradianceProbe';
    this.probe.intensity = 1;
    this.group.add(this.probe);

    // The pool is allocated once and never resized. Adding or removing a light
    // at runtime changes `NUM_POINT_LIGHTS`, which recompiles every material in
    // the scene — a visible hitch on the exact frame a spell goes off. Unused
    // slots sit at intensity 0, which costs one dot product per fragment.
    for (let i = 0; i < MAX_PRACTICALS; i++) {
      const p = new PointLight(0xffffff, 0, 10, 2);
      p.name = `Practical${i}`;
      p.castShadow = false;
      p.visible = true;
      this.practicals.push(p);
      this.practicalHome.push(new Vector3());
      this.practicalBase.push(0);
      this.group.add(p);
    }
    this.practicalSpecs = LIGHTING_PRACTICALS[this.presetName];

    scene.add(this.group);

    this.fitTo(this.bounds);
    this.commit();
    this.startFallbackTicker();
  }

  /**
   * Flicker has to advance every frame or a torch is just a static blob, but
   * nothing in the current frame loop calls `update()` on the rig. Rather than
   * silently rendering dead flames, the rig drives itself off rAF until an owner
   * calls `update()` — at which point the ticker retires and the owner's delta
   * takes over, so the two can never double-advance the clock.
   */
  private startFallbackTicker(): void {
    if (typeof requestAnimationFrame !== 'function') return;
    const tick = (now: number): void => {
      this.rafHandle = null;
      if (this.externallyDriven) return;
      const dt = this.rafLast === 0 ? 1 / 60 : Math.min(0.1, (now - this.rafLast) / 1000);
      this.rafLast = now;
      this.advanceFlicker(dt);
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
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
    // Practicals are placed objects, not numbers, so they cannot be lerped the
    // way the rest of the mood is. They swap at the midpoint of the cross-fade,
    // where the two moods are least distinguishable and the cut is least visible.
    if (durationSeconds <= 0) this.setPracticals(LIGHTING_PRACTICALS[name]);
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

  /**
   * Patch individual fields of the live mood without leaving the current preset.
   *
   * This is how a map's own authored lighting (`MapDef.lighting` in
   * `core/grid.ts` carries sun colour, bearing, elevation, sky/ground fill and
   * fog per map) reaches the rig: pick the preset for the time of day, then tune
   * it to the diorama. Applies immediately and cancels any cross-fade in flight,
   * since a half-finished fade plus a patch is not a state worth defining.
   */
  tune(patch: Partial<LightingPreset>): void {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      (this.live as Record<string, number>)[key] = value;
      (this.to as Record<string, number>)[key] = value;
      (this.from as Record<string, number>)[key] = value;
    }
    this.blend = 1;
    this.blendDuration = 0;
    this.commit();
  }

  /** True when no cross-fade is in flight. Used for render convergence. */
  get settled(): boolean {
    return this.blend >= 1;
  }

  /** Read-only snapshot of the currently applied values (post cross-fade). */
  get current(): Readonly<LiveState> {
    return this.live;
  }

  /**
   * Replace the placed-light set. Public so a map with authored torch positions
   * can hand the rig its own practicals instead of the preset's generic ring.
   */
  setPracticals(specs: readonly PracticalSpec[]): void {
    this.practicalSpecs = specs.slice(0, MAX_PRACTICALS);
    this.placePracticals();
  }

  update(dt: number): void {
    this.externallyDriven = true;
    this.advanceFlicker(dt);
    if (this.blend >= 1) return;
    const wasBeforeMidpoint = this.blend < 0.5;
    this.blend = Math.min(1, this.blend + dt / Math.max(1e-4, this.blendDuration));
    if (wasBeforeMidpoint && this.blend >= 0.5) {
      this.setPracticals(LIGHTING_PRACTICALS[this.presetName]);
    }
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
    this.rim.intensity = s.rimIntensity;
    placeDirectional(this.rim, centre, s.rimAzimuth, s.rimElevation, distance, this.tmpVec);

    // Fill
    this.hemisphere.intensity = s.hemiIntensity;
    this.hemisphere.position.set(centre.x, centre.y + radius, centre.z);
    this.ambient.intensity = s.ambientIntensity;

    // ── Committed colour ──────────────────────────────────────────────────
    // Every light colour goes through `gradeLight` rather than straight onto the
    // object. Hue comes from whoever authored it — the preset, the map, or a
    // scenario `tune()` — but chroma and the warm/cool split are the rig's, and
    // they are not negotiable. A map author writing a tasteful 0x9fbcd8 sky and a
    // 0xffd9a8 sun produces, after tone mapping, a frame that is essentially
    // monochrome; the reference corpus never does this. So the key is pushed
    // warm, the rim and sky are pushed cold, and saturation is multiplied up
    // until the split is legible at a glance.
    // Chroma is spent on the FILL, not on the key. A key saturated to the same
    // degree as the fill stops being light and starts being a paint bucket: at
    // chroma 1.85 an authored 0xffd9a8 sun loses almost all its blue channel, and
    // every sprite it touches — blue knight, teal mage, white chocobo — comes out
    // the same shade of orange. Real warm sunlight is only mildly amber; the mood
    // comes from the *shadows* being violently blue by comparison. Cheap, too:
    // the fill is the dim half, so saturating it costs no dynamic range.
    const chroma = s.chroma;
    const split = s.colorSplit;
    // The key is deliberately *below* the preset chroma. Measured against the
    // reference frames, dawn sunlight sits around (1.0, 0.70, 0.42) — warm, but
    // it still carries a real blue channel. Push it to (1.12, 0.67, 0.27) and
    // every white robe on the field turns salmon.
    gradeLight(this.key.color, s.keyColor, 0.55 + chroma * 0.2, split * 0.3);
    gradeLight(this.rim.color, s.rimColor, chroma * 1.1, -split * 1.2);
    gradeLight(this.hemisphere.color, s.skyColor, chroma * 1.15, -split * 1.15);
    gradeLight(this.hemisphere.groundColor, s.groundColor, chroma, split * 0.4);
    gradeLight(this.ambient.color, s.ambientColor, chroma * 1.2, -split * 1.2);

    this.updateProbe(s);
    this.placePracticals();

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

  /**
   * Rebuild the light probe's spherical harmonics from the live mood.
   *
   * Four directional lobes are projected into SH9: warm bounce arriving from the
   * key side, cold fill from the rim side, sky from straight up and earth bounce
   * from straight down. The result is an ambient term that *has a direction* —
   * a wall facing the sun picks up amber even in shadow, the one facing away
   * goes blue — which is the difference between "dark" and "unlit".
   */
  private updateProbe(s: LiveState): void {
    const sh = this.probeSh;
    sh.zero();
    if (s.probeIntensity <= 0) {
      this.probe.sh.zero();
      this.probe.intensity = 0;
      return;
    }

    const add = (hex: number, azimuth: number, elevation: number, weight: number, warmth: number): void => {
      gradeLight(this.tmpColorA, hex, s.chroma, warmth);
      const az = MathUtils.degToRad(azimuth);
      const el = MathUtils.degToRad(elevation);
      const h = Math.cos(el);
      this.tmpVec.set(Math.sin(az) * h, Math.sin(el), -Math.cos(az) * h);
      SphericalHarmonics3.getBasisAt(this.tmpVec, this.shBasis);
      // SH coefficients are Vector3s; the colour has to cross the type boundary.
      this.shColor.set(this.tmpColorA.r, this.tmpColorA.g, this.tmpColorA.b);
      for (let i = 0; i < 9; i++) {
        sh.coefficients[i]!.addScaledVector(this.shColor, this.shBasis[i]! * weight);
      }
    };

    const split = s.colorSplit;
    // Bounce off whatever the key is hitting: same bearing, but arriving from
    // low down, because that is where the lit ground is.
    add(s.keyColor, s.keyAzimuth, Math.max(4, s.keyElevation * 0.35), s.keyIntensity * 0.12, split * 0.55);
    add(s.rimColor, s.rimAzimuth, s.rimElevation * 0.6, 0.35 + s.rimIntensity * 0.8, -split * 1.2);
    add(s.skyColor, 0, 90, s.hemiIntensity * 0.62, -split * 1.15);
    add(s.groundColor, 0, -90, s.hemiIntensity * 0.24, split * 0.45);

    this.probe.sh.copy(sh);
    this.probe.intensity = s.probeIntensity;
  }

  /**
   * Position the practical pool inside the fitted bounds and cache the flicker
   * baselines. Called from `commit()`, so a `fitTo()` re-lays them out.
   */
  private placePracticals(): void {
    const min = this.bounds.min;
    const max = this.bounds.max;
    const spanX = max.x - min.x;
    const spanZ = max.z - min.z;

    for (let i = 0; i < this.practicals.length; i++) {
      const light = this.practicals[i]!;
      const spec = this.practicalSpecs[i];
      if (!spec) {
        light.intensity = 0;
        this.practicalBase[i] = 0;
        continue;
      }
      const home = this.practicalHome[i]!;
      home.set(min.x + spanX * spec.u, spec.y, min.z + spanZ * spec.v);
      light.position.copy(home);
      // Practicals keep their authored hue *exactly*. They are sources, not
      // fill, so the split does not apply — and the chroma stretch must not
      // either: pushing an already-saturated 0xff8e34 further from grey lands on
      // pure red, and fire photographs amber, never red.
      light.color.setHex(spec.color, 'srgb');
      light.distance = spec.distance;
      light.decay = 2;
      this.practicalBase[i] = spec.intensity;
      light.intensity = spec.intensity;
    }
  }

  /**
   * Find scene point lights that belong to props and take over their intensity.
   *
   * `terrain.ts` builds real braziers — iron legs, a stone bowl, emissive coals —
   * and hangs a point light on each so the fire actually lights the flagstones.
   * What it cannot reasonably own is the *behaviour* of that light, and a
   * perfectly steady flame is one of the giveaways this rig exists to remove.
   *
   * So the rig adopts them by name: it records each light's authored intensity
   * and position once, then drives flicker and sway on top. The prop author
   * keeps control of placement, colour and brightness; the rig only makes them
   * breathe. Re-scanned on an interval because terrain can be rebuilt at any
   * time, and lights that leave the scene are dropped on the next sweep.
   */
  private refreshAdoptedLights(): void {
    this.adopted.length = 0;
    this.adoptedBase.length = 0;
    this.adoptedHome.length = 0;
    this.scene.traverse((o: Object3D) => {
      if (this.adopted.length >= MAX_ADOPTED) return;
      const light = o as PointLight;
      if (!light.isPointLight) return;
      if (!o.name.startsWith(ADOPTED_LIGHT_PREFIX)) return;
      // Never adopt our own pool — that would double-drive the flicker.
      if (light.parent === this.group) return;
      this.adopted.push(light);
      this.adoptedBase.push(light.userData['baseIntensity'] as number | undefined ?? light.intensity);
      light.userData['baseIntensity'] = this.adoptedBase[this.adoptedBase.length - 1];
      this.adoptedHome.push(light.position.clone());
    });
  }

  /** Advance torch flicker. Split out so the fallback ticker and `update()` share it. */
  private advanceFlicker(dt: number): void {
    this.flickerClock += dt;
    const t = this.flickerClock;

    this.adoptScan -= dt;
    if (this.adoptScan <= 0) {
      this.adoptScan = 0.75;
      this.refreshAdoptedLights();
    }
    for (let i = 0; i < this.adopted.length; i++) {
      const light = this.adopted[i]!;
      const base = this.adoptedBase[i]!;
      const home = this.adoptedHome[i]!;
      const n = flickerNoise(t * 5.6, i * 4.7);
      light.intensity = base * (0.78 + 0.34 * (n * 0.5 + 0.5) * 1.4);
      light.position.set(
        home.x + flickerNoise(t * 2.9, i * 2.3) * 0.05,
        home.y + flickerNoise(t * 3.7, i * 6.1) * 0.07,
        home.z + flickerNoise(t * 2.4, i * 8.7) * 0.05,
      );
    }

    if (this.practicalSpecs.length === 0) return;
    for (let i = 0; i < this.practicals.length; i++) {
      const spec = this.practicalSpecs[i];
      if (!spec) continue;
      const light = this.practicals[i]!;
      const base = this.practicalBase[i]!;
      const amp = spec.flicker ?? 0;
      if (amp > 0) {
        const rate = (spec.rate ?? 8) * 0.62;
        // Biased low: a flame spends more time guttering than flaring, so the
        // noise is squared toward the dark side before being re-centred.
        const n = flickerNoise(t * rate, i * 7.3);
        light.intensity = base * (1 - amp * 0.5 + amp * 0.5 * (n * 0.5 + 0.5) * 1.7);
      }
      const sway = spec.sway ?? 0;
      if (sway > 0) {
        const home = this.practicalHome[i]!;
        light.position.set(
          home.x + flickerNoise(t * 2.7, i * 3.1) * sway,
          home.y + flickerNoise(t * 3.4, i * 5.9) * sway * 1.6,
          home.z + flickerNoise(t * 2.2, i * 9.4) * sway,
        );
      }
    }
  }

  dispose(): void {
    this.externallyDriven = true;
    if (this.rafHandle !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.key.shadow.map?.dispose();
    this.key.dispose();
    this.rim.dispose();
    this.hemisphere.dispose();
    this.ambient.dispose();
    for (const p of this.practicals) p.dispose();
    this.group.removeFromParent();
  }
}

/**
 * Write `hex` onto `target` with the rig's committed chroma and temperature.
 *
 * `chroma` multiplies the distance from neutral grey — 1 leaves the colour
 * alone, 2 doubles its saturation. `warmth` in [-1, 1] then tilts the result
 * toward amber or toward cyan-blue. Luminance is renormalised afterwards so
 * grading a light never silently changes how bright the scene is; that is what
 * `intensity` is for.
 */
function gradeLight(target: Color, hex: number, chroma: number, warmth: number): void {
  target.setHex(hex, 'srgb');
  const before = target.r * 0.2126 + target.g * 0.7152 + target.b * 0.0722;
  if (before <= 1e-6) return;

  // How saturated was the author's colour to begin with?
  const hi = Math.max(target.r, target.g, target.b);
  const lo = Math.min(target.r, target.g, target.b);
  const sourceSat = hi > 1e-6 ? (hi - lo) / hi : 0;

  // Limit the stretch so no channel is driven to (or through) zero.
  //
  // Naively multiplying the distance from grey clips: an authored 0x46a6ff rim
  // at chroma 2.0 wants a red channel of −0.24, lands on exactly 0, and a light
  // with a hard zero in one channel is not a colour any real source has — it
  // reads as an electric-blue filter and it silently breaks the luminance
  // renormalisation below. So the stretch is capped at whatever keeps the
  // darkest channel a few percent above black, which also means an *already*
  // saturated colour is left alone rather than being pushed into nonsense.
  const floor = before * 0.05;
  let k = chroma;
  if (lo < before) k = Math.min(k, (before - floor) / (before - lo));
  k = Math.max(1, k);

  target.setRGB(
    before + (target.r - before) * k,
    before + (target.g - before) * k,
    before + (target.b - before) * k,
  );

  // The chroma stretch multiplies the distance from grey, which means it does
  // nothing at all to a near-white light — and a map author writing a perfectly
  // reasonable 0xfff3d6 sun would sail straight through it and land back on the
  // neutral daylight this rig exists to prevent. So the temperature tilt gets
  // *stronger* the less colour the source had: white gets pushed nearly twice as
  // far as an already-amber source, and the mood is committed either way.
  const tilt = warmth * (1 + 0.95 * (1 - Math.min(1, sourceSat)));
  if (tilt > 0) {
    const w = Math.min(1, tilt);
    target.setRGB(target.r * (1 + 0.34 * w), target.g * (1 + 0.05 * w), target.b * (1 - 0.5 * w));
  } else if (tilt < 0) {
    const c = Math.min(1, -tilt);
    target.setRGB(target.r * (1 - 0.5 * c), target.g * (1 - 0.04 * c), target.b * (1 + 0.36 * c));
  }

  const after = target.r * 0.2126 + target.g * 0.7152 + target.b * 0.0722;
  if (after > 1e-6) target.multiplyScalar(before / after);
  // A channel can still have gone negative through the chroma stretch.
  target.setRGB(Math.max(0, target.r), Math.max(0, target.g), Math.max(0, target.b));
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
