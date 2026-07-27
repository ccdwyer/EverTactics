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
 *
 * ── Two policies the rig enforces over its callers ──────────────────────────
 *
 * Both exist because round 2 shipped a frame that scored 2.2/10 on lighting
 * while every individual number in this file was defensible. Correct parts,
 * wrong system.
 *
 * KEY/VIEW SEPARATION (`resolveBearings`). `battle-open` authored its key at
 * azimuth 138° and the iso camera looks from bearing 128°. Ten degrees apart is
 * the one geometry in which a shadow map is invisible: every shadow falls
 * directly behind the object casting it, into pixels that object already covers.
 * We were rendering a fitted 2048² shadow map into a view that could not see a
 * texel of it — which is why the critique said "casts no shadows anywhere" about
 * a scene whose shadows had been on the whole time. The rig now swings the key
 * (and the rim with it) into a band either side of the camera bearing. Authored
 * azimuth survives wherever it is already legal.
 *
 * KEY/FILL RATIO (`applyContrast`). Authors set fill by eye and set it too high;
 * the cloister arrived with hemi + ambient + probe adding up to roughly 60% of
 * the key, which makes a cast shadow a smudge and leaves every wall plane within
 * a few percent of every other. Fill *level* is therefore the rig's, not the
 * author's — hue stays theirs. The redistribution is brightness-neutral: what
 * comes off the flat fill is handed to the key and the rim, so the lit band
 * stays where it was and only the shadows fall away.
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

import { DEFAULT_YAW_TRIM_DEGREES, RIG_DISTANCE, YAW_ANGLES } from './camera.js';

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

  /**
   * PCF kernel radius, in shadow texels.
   *
   * Only `PCFShadowMap` reads this — `PCFSoftShadowMap`, which is what
   * `bindRenderer()` selects, derives its own kernel from the texel size and
   * ignores the field. It is kept because the softness a preset *wants* is real
   * information (a storm wants a wide diffuse penumbra, a night brazier scene
   * wants a tight one) and because `setShadowMapSize()` is the lever that
   * actually delivers it: penumbra under PCF-soft is a fixed number of texels,
   * so halving the resolution doubles the blur.
   */
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

  /**
   * How much of the key-to-fill *ratio* the rig owns, 0..1.
   *
   * Measured on the round-2 frame: the cloister ran hemi 1.25 + ambient 0.42 +
   * probe 1.35 against a key of 3.1, which puts a shadowed face at roughly 60%
   * of a lit one. At that ratio a cast shadow is a smudge, every wall plane sits
   * within a few percent of every other, and the box never resolves into a
   * volume — which is exactly the note the critics wrote three different ways.
   *
   * Map and scenario authors *always* set fill too high, because they tune it on
   * a bright monitor against a white editor chrome and the frame looks "correct"
   * before the grade crushes it. So fill level is not theirs. Hue is theirs; the
   * ratio is the rig's, and `applyContrast()` lerps their numbers toward the
   * rig's target by this amount. Crucially it does not darken the picture — the
   * irradiance it takes off the fill is handed to the key, so the *lit* band
   * stays where the author put it and only the shadows fall away.
   *
   * 0 restores the pre-policy behaviour (author's fill verbatim).
   */
  contrast: number;

  /**
   * Multiplier on every placed and adopted practical light.
   *
   * Braziers are authored in `terrain.ts` at an intensity that reads correctly
   * when you are looking at one brazier. Six of them across a diorama, seen from
   * twenty tiles back through a tone mapper, need to be pushed considerably
   * harder before a *pool* appears on the flagstones — and the pool is the whole
   * point. See the reference village frame: the ground under each fire is
   * orange, not "green with a warm tint".
   */
  practicalGain: number;

  /**
   * Falloff exponent for every practical. 2 is physical inverse-square.
   *
   * ROUND-4 NOTE, and it is the difference between a fire and a flashbulb.
   *
   * At decay 2 a brazier's irradiance is 4× its nominal at half a tile and a
   * ninth of it at three tiles: a 36:1 range across the pool. Drive that hard
   * enough for the far edge to be visible and the near edge is at 36× — which
   * is the mechanism behind "the wall beside the fire is washed to featureless
   * cream", "a blown-out white bloom disc", and "no flame core". The critics were
   * not describing a bloom bug. They were describing the near field of an
   * inverse-square point light with the gain turned up until its far field
   * showed.
   *
   * A real flame is not a point. It is a half-metre column of luminous gas, and
   * the irradiance near an extended source falls off closer to 1/d than 1/d² —
   * which is exactly why photographs of braziers show a *pool*, several tiles
   * across, with structure in it, rather than one clipped disc. Backing the
   * exponent off to ~1.5 buys three times the readable radius for a third of
   * the peak, at the same total energy.
   *
   * Cold fills stay nearer 2: a shaft of sky through an arch really is a distant
   * source and should behave like one. So this is authored per preset rather
   * than being a constant.
   */
  practicalDecay: number;
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
  /**
   * Per-light falloff exponent, overriding the preset's `practicalDecay`.
   *
   * Cold fills want this near 2 even on a fire preset: a shaft of sky through an
   * arcade is a genuinely distant source, and softening its falloff turns a
   * directional wash into a floating blue lamp.
   */
  decay?: number;
}

/** Hard cap on placed lights, so material shader permutations never change. */
export const MAX_PRACTICALS = 6;

/**
 * Compass bearing the camera looks *from*, for the default iso rig.
 *
 * `camera.ts` describes its orientation as a yaw angle where the eye offset is
 * `(cos p·sin yaw, sin p, cos p·cos yaw)`; this file describes light bearings as
 * `(sin az·cos el, sin el, −cos az·cos el)`. Matching the horizontal components
 * gives `az = 180° − yaw`, which is the only conversion between the two spaces
 * and the reason it is written down once, here.
 */
function bearingFromYawDegrees(yawDegrees: number): number {
  return 180 - yawDegrees;
}

const DEFAULT_VIEW_BEARING = bearingFromYawDegrees(
  MathUtils.radToDeg(YAW_ANGLES[0] ?? Math.PI / 4) + DEFAULT_YAW_TRIM_DEGREES,
);

/**
 * How far the key must sit from the camera's own bearing, in degrees.
 *
 * THIS IS THE ONE THAT COST US ROUND 2. `battle-open` authored a key at azimuth
 * 138° and the iso rig looks from bearing 128° — ten degrees apart. A light over
 * the camera's shoulder is the one direction from which its shadows are entirely
 * invisible: every shadow falls *behind* the object that casts it, exactly into
 * the pixels that object already covers. The rig was rendering a perfectly
 * correct 2048² shadow map into a view that could not see a single texel of it,
 * which is why six critics independently wrote "casts no shadows anywhere" about
 * a scene whose shadows were switched on the whole time.
 *
 * The upper bound matters too: past ~130° the key is behind the subject and
 * every face the camera can see is a shadow face, which is a backlit silhouette
 * shot, not a lit diorama. So the key is clamped into a band either side of the
 * view — far enough that the shadows land in open frame, near enough that the
 * faces we look at are the faces that are lit.
 */
const KEY_VIEW_SEPARATION_MIN = 90;
const KEY_VIEW_SEPARATION_MAX = 128;

/**
 * How high the key is allowed to sit, in degrees above the horizon.
 *
 * THIS IS THE ROUND-3 SIBLING OF THE AZIMUTH POLICY, and it fails the same way.
 * A shadow's length on the ground is `height / tan(elevation)`. `battle-open`
 * authors its key at 54°, which turns a 4.5-unit cloister wall into a 3.3-unit
 * shadow — and the wall is 1 unit thick and sits on a 2-unit plinth, so almost
 * the entire shadow lands on the wall's own footprint and the plinth beside it.
 * Nothing reaches the garden. Six critics then wrote "not one wall throws a
 * shadow onto the courtyard floor" about a scene rendering a fitted 2048²
 * shadow map every frame, for the second round running.
 *
 * Drop the same wall to 38° and it lays 5.8 units across the flagstones — over
 * two tiles of visible, unmistakable cast shadow, which is the thing the eye
 * reads as "these blocks are in a place" rather than "these blocks are shaded".
 *
 * The lower bound matters as much. Below ~24° a walled cloister self-occludes:
 * the sun never clears its own perimeter and the whole playable interior is one
 * flat shadow, which is what the map author was (correctly) running from when
 * they typed 54. So the rig takes the elevation off them and puts it in the
 * narrow band where a wall casts *into* the courtyard without swallowing it.
 *
 * Authored elevation survives wherever it is already inside the band.
 */
const KEY_ELEVATION_MIN = 26;
const KEY_ELEVATION_MAX = 39;

/** Wrap to (−180, 180]. */
function wrapSigned(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d <= -180) d += 360;
  return d;
}

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
    // TEAL, not blue — and this is the map's tertiary hue, not a detail.
    //
    // Round 3's loudest colour note was "a two-hue lockup (navy + amber) with
    // nothing between… material identity dissolves". It was correct, and the
    // cause was that every cool light in this preset sat on the same hue: sky
    // 0x3a6ad4, rim 0x46a6ff and ambient 0x0e1a30 are three shades of one blue,
    // so a surface could only ever be some mix of amber and navy. Splitting the
    // rim to teal and the flat bounce to violet gives the shadow side two
    // distinguishable families of its own — which is exactly the grammar of
    // `refs/curated/triangle/press_041`: warm orange key, cold *teal* fill, and
    // violet in the deepest crevices.
    rimColor: 0x3ec2d8,
    rimIntensity: 1.6,
    rimAzimuth: 296,
    rimElevation: 30,
    ambientColor: 0x181040,
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
    contrast: 0.85,
    // Raised with the fill cut. Once a shadowed flagstone is receiving a tenth of
    // the key rather than a third, a brazier finally *can* be the brightest thing
    // on the ground near it — but only if it is driven hard enough to reach two
    // or three tiles before inverse-square eats it.
    // Cut hard for round 4, and the cut is *paid for* by `practicalDecay`.
    //
    // At 3.3 with inverse-square the near field of every brazier clipped: the
    // cloister wall a tile behind the fire came out as featureless cream with no
    // masonry left in it, which is a fail condition on its own ("any flat
    // untextured surface") as well as being the "blown-out white disc" note.
    // Softening the falloff to 1.5 buys most of that reach back at a third of
    // the peak — the pool is wider now and the stone inside it still has stones
    // in it.
    practicalGain: 2.15,
    practicalDecay: 1.35,
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
    contrast: 0.55,
    practicalGain: 1.8,
    practicalDecay: 1.8,
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
    // Lifted with the round-3 fill cut. Dusk authors the most aggressive contrast
    // in the set (0.9) and it was already the darkest exposure by a wide margin;
    // once a shadowed surface was receiving an eighth of the key rather than a
    // third, `mandalia-ford` arrived at a mean luma of 6/255 with the far bank
    // unreadable. Deep shadow is the goal, an unreadable board is a fail
    // condition, and exposure is the right lever because it moves the whole
    // curve rather than putting the flat fill back and flattening the volume.
    exposure: 1.26,
    shadowRadius: 2.4,
    shadowNormalBiasScale: 1.0,
    probeIntensity: 1.05,
    chroma: 1.9,
    colorSplit: 0.5,
    contrast: 0.9,
    practicalGain: 2.6,
    practicalDecay: 1.5,
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
    contrast: 0.7,
    practicalGain: 2.2,
    practicalDecay: 1.6,
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
    contrast: 0.95,
    practicalGain: 2.8,
    practicalDecay: 1.45,
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
    { u: 0.5, v: 0.54, y: 0.55, color: 0x4d90ff, intensity: 9, distance: 7.5, flicker: 0.07, rate: 1.7, sway: 0.04, decay: 2 },
    // Outside the colonnade, not among it. Parked at v = 0.12 these sat inside a
    // pillar and put a blown blue highlight on its shaft — a sky wash has to
    // originate beyond the architecture it is washing, or it reads as a lamp.
    { u: 0.5, v: 0.02, y: 3.2, color: 0x6aa4ff, intensity: 11, distance: 12.0, flicker: 0.04, rate: 0.7, decay: 2 },
    { u: 0.02, v: 0.62, y: 3.0, color: 0x5c96f0, intensity: 8, distance: 10.0, flicker: 0.04, rate: 0.9, decay: 2 },
  ],

  overcast: [
    { u: 0.5, v: 0.5, y: 1.2, color: 0xffb469, intensity: 6, distance: 10, flicker: 0.05, rate: 2.1 },
  ],

  dusk: [
    { u: 0.3, v: 0.36, y: 2.0, color: 0xff8e34, intensity: 16, distance: 6.0, flicker: 0.32, rate: 8.9, sway: 0.1 },
    { u: 0.72, v: 0.66, y: 2.0, color: 0xff9c46, intensity: 16, distance: 6.0, flicker: 0.32, rate: 7.3, sway: 0.1 },
    { u: 0.5, v: 0.16, y: 3.2, color: 0x4fbcff, intensity: 12, distance: 8.0, flicker: 0.1, rate: 1.3, decay: 2 },
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
    { u: 0.5, v: 0.5, y: 4.2, color: 0x6a95ff, intensity: 14, distance: 10.0, flicker: 0.06, rate: 0.9, decay: 2 },
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
  /** Authored hue of each adopted prop light, before the flicker's colour shift. */
  private readonly adoptedColor: Color[] = [];
  /** The one adopted light allowed to render a cube shadow. See `promoteShadowCaster`. */
  private shadowCaster: PointLight | null = null;
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
  /** Compass bearing the camera looks from. Drives the key-separation policy. */
  private viewBearing = DEFAULT_VIEW_BEARING;

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

  /**
   * Tell the rig where the camera is looking from, so the key-separation policy
   * has something real to work against.
   *
   * Takes the camera's *yaw* in degrees (what `IsoCamera.yawRadians` reports),
   * not a light bearing — callers should never have to know the two spaces
   * differ. Call it on a yaw snap; the key swings to keep its shadows in frame,
   * which is also what a real DoP does when the camera moves.
   */
  setViewYawDegrees(yawDegrees: number): void {
    const bearing = bearingFromYawDegrees(yawDegrees);
    if (Math.abs(wrapSigned(bearing - this.viewBearing)) < 0.25) return;
    this.viewBearing = bearing;
    this.commit();
  }

  /**
   * Swing the key into the band where its shadows are actually visible, and take
   * the rim with it so the complementary split keeps its geometry.
   *
   * Authored azimuth is preserved wherever it is already legal — this only moves
   * a key that is hiding its own shadows behind the objects casting them.
   */
  private resolveBearings(s: LiveState): { key: number; rim: number } {
    const delta = wrapSigned(s.keyAzimuth - this.viewBearing);
    // A key dead-on the view axis has no "side" to be pushed to. Default to the
    // camera's left, because that is where the reference corpus puts it: the
    // Triangle throne room, the FFT chapel and the village square all key from
    // high screen-left and fill cold from the right.
    const sign = delta > 1 || (delta >= -1 && delta <= 1) ? 1 : -1;
    const magnitude = MathUtils.clamp(
      Math.abs(delta),
      KEY_VIEW_SEPARATION_MIN,
      KEY_VIEW_SEPARATION_MAX,
    );
    const key = this.viewBearing + sign * magnitude;
    const shift = wrapSigned(key - s.keyAzimuth);
    return { key, rim: s.rimAzimuth + shift };
  }

  /**
   * Clamp the key into the elevation band where its shadows land in open frame.
   * See `KEY_ELEVATION_MIN` / `KEY_ELEVATION_MAX` for why this is the rig's call
   * and not the map author's.
   */
  private resolveKeyElevation(s: LiveState): number {
    return MathUtils.clamp(s.keyElevation, KEY_ELEVATION_MIN, KEY_ELEVATION_MAX);
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

    const elevation = this.resolveKeyElevation(s);
    const rig = this.applyContrast(s, elevation);
    const bearing = this.resolveBearings(s);

    // Key
    this.key.color.setHex(s.keyColor, 'srgb');
    this.key.intensity = rig.key;
    placeDirectional(this.key, centre, bearing.key, elevation, distance, this.tmpVec);

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

    // Rim. Directional fill, not flat fill: it lights the faces the key misses
    // *from a bearing*, so raising it adds colour separation without adding the
    // uniform wash that flattens the volume. That is why the contrast policy
    // pushes irradiance into the rim rather than simply deleting it.
    this.rim.intensity = rig.rim;
    placeDirectional(this.rim, centre, bearing.rim, s.rimElevation, distance, this.tmpVec);

    // Fill
    this.hemisphere.intensity = rig.hemi;
    this.hemisphere.position.set(centre.x, centre.y + radius, centre.z);
    this.ambient.intensity = rig.ambient;

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
    // …but "below the fill" is not the same as "none", and round 2 shipped a key
    // that was effectively ungraded: at chroma 1.85 the old 0.55 + 0.2·chroma
    // came out at 0.92, which `gradeLight` clamps up to 1.0 — an identity. The
    // sun was whatever the map author typed, the fill was violently cold, and the
    // frame read as one desaturated slate because the two never met in the
    // middle. This is enough amber to see on stone without cooking white cloth.
    gradeLight(this.key.color, s.keyColor, 0.8 + chroma * 0.3, split * 0.6);
    // The rim is stretched *less* than the rest of the fill, not more, now that
    // the presets author a genuinely saturated tertiary hue there. The 1.1×
    // multiplier existed to rescue map authors who typed a polite grey-blue; run
    // it over an already-committed teal and every stone plane the rim touches
    // comes out cyan, which trades the two-hue lockup for a three-hue one and
    // makes moss and masonry the same colour.
    gradeLight(this.rim.color, s.rimColor, chroma * 0.8, -split * 0.85);
    gradeLight(this.hemisphere.color, s.skyColor, chroma * 1.15, -split * 1.15);
    gradeLight(this.hemisphere.groundColor, s.groundColor, chroma, split * 0.4);
    gradeLight(this.ambient.color, s.ambientColor, chroma * 1.2, -split * 1.2);

    this.updateProbe(s, rig, bearing, elevation);
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
   * Redistribute irradiance from the flat fill into the key and the rim.
   *
   * This is the rig's one non-negotiable opinion about level, as opposed to hue.
   *
   * The measured failure: `battle-open` arrives here with hemi 1.25, ambient
   * 0.42 and probe 1.35 against a key of 3.1. Work it out on a floor tile with
   * the key at 54°: lit irradiance ≈ 3.1·sin 54° + 1.25 + 0.42 + probe ≈ 5.1,
   * and the same tile inside a cast shadow still receives ≈ 2.6. A shadow that
   * only halves the value it falls on is not a shadow, it is a slightly darker
   * paint. Every critic note about "no consistent key", "no volume", "every wall
   * top-face the same brightness" and "no cast shadows anywhere" is that one
   * number. Look at the reference throne room: the shadow side is a *fifth* of
   * the lit side, and it is a different colour as well as a different value.
   *
   * The fix has to be brightness-neutral or it just trades one failure (flat)
   * for another (murk). So the flat fill is pulled down toward the rig's target
   * ratio, and every unit of irradiance removed is handed straight to the key —
   * lit surfaces land within a few percent of where the author put them and only
   * the unlit ones fall away. A third of the recovered budget goes to the rim
   * instead, because the rim is *directional* fill: it lights the faces the key
   * misses from a committed bearing and a complementary hue, which is how the
   * references keep their shadow side readable without flattening it.
   */
  private applyContrast(s: LiveState, keyElevation: number): {
    key: number;
    rim: number;
    hemi: number;
    ambient: number;
    probe: number;
  } {
    const drama = MathUtils.clamp(s.contrast, 0, 1);
    const key = Math.max(0, s.keyIntensity);
    if (drama <= 0) {
      return {
        key,
        rim: s.rimIntensity,
        hemi: s.hemiIntensity,
        ambient: s.ambientIntensity,
        probe: s.probeIntensity,
      };
    }

    // Rig targets, expressed as fractions of the key. Read off the reference
    // frames rather than invented: a sky fill around a sixth of the sun, a
    // near-zero flat term (crevices are meant to go black), a rim strong enough
    // to draw a silhouette but never to compete for "which way is the light".
    //
    // Round 3 pulled all three flat terms down again. Measured on the round-2
    // targets, a shadowed floor tile still received hemi 0.53 + ambient 0.08 +
    // probe 0.85 ≈ 1.4 against a lit 3.9 — a 2.8:1 range, which is an overcast
    // afternoon, not the reference corpus. In
    // `refs/curated/triangle/press_002_gematsu_1920x1080.jpg` the ground four
    // tiles from a fire is *black*; the frame carries maybe a 20:1 range and
    // spends most of its area at the bottom of it. Pulling the fill to a tenth
    // of the key is what lets a brazier's own pool become the brightest thing on
    // the flagstones instead of a warm tint over an already-lit floor.
    //
    // Round 4 pulled them again, and this time it was measured against
    // `refs/curated/triangle/press_002_gematsu_1920x1080.jpg` rather than argued
    // from first principles. In that frame the four corners are *pure black* —
    // not navy, black — and the readable image occupies warm pools two or three
    // tiles across around each fire. Our round-4 frame at the same moment had a
    // mean luma of 57/255 with a p05 of 8, i.e. almost nothing in it was dark;
    // every top face across the whole diorama sat inside one gold value band.
    // That is the difference the critics keep describing as "lit like a viewport,
    // not like a place".
    //
    // Note what this does *not* do: it does not dim the frame. Every unit of
    // irradiance taken off the flat terms below is handed back to the key a few
    // lines down, so the lit band holds and only the unlit half falls away. The
    // measurable effect is a wider luminance histogram, which is exactly the
    // metric `tools/metrics.mjs` gates on.
    const targetHemi = key * 0.1;
    const targetAmbient = key * 0.009;
    const targetRim = key * 0.27;
    // Not lower than this. Measured on `mandalia-ford`, which authors contrast 0.9
    // over an already-dim dusk exposure: at a 0.6 cap the far bank of the river
    // went to unreadable black and the fail list explicitly forbids obscuring
    // tiles the player has to count. The probe is *directional* irradiance, so it
    // is the cheapest term to keep — it holds hue and form in the shadow side
    // without flattening the volume the way raising the flat ambient would.
    // 0.56 rather than round 3's 0.68. The probe is the largest single fill term
    // once hemi and ambient have been cut, so it is also the one still holding
    // the shadow side up at roughly a third of the key. It stays the *last* term
    // to be cut, though, and never to zero: it is directional irradiance, so it
    // is what keeps a shadowed wall coloured and legible rather than merely
    // black, and the fail list forbids obscuring tiles the player has to count.
    const targetProbe = Math.min(s.probeIntensity, 0.56);

    const hemi = MathUtils.lerp(s.hemiIntensity, targetHemi, drama);
    const ambient = MathUtils.lerp(s.ambientIntensity, targetAmbient, drama);
    const probe = MathUtils.lerp(s.probeIntensity, targetProbe, drama);

    // What the flat terms gave up. The probe is spherical-harmonic irradiance
    // rather than a lambert term, so its intensity is not in the same units;
    // count it at a discount rather than pretending it is interchangeable.
    const surrendered =
      Math.max(0, s.hemiIntensity - hemi) +
      Math.max(0, s.ambientIntensity - ambient) +
      Math.max(0, s.probeIntensity - probe) * 0.55;

    const rim = Math.max(s.rimIntensity, MathUtils.lerp(s.rimIntensity, targetRim, drama));
    const rimCost = Math.max(0, rim - s.rimIntensity);
    // The key absorbs whatever the rim did not, divided by the angle it will be
    // seen through — a low sun only delivers sin(elevation) of its intensity to
    // the floor, so handing it the raw number under-compensates and the frame
    // dims. But dividing by the raw sine over-compensates the *walls*: a vertical
    // face is lit by cos(elevation), so at 39° the same division that restores a
    // floor tile to par pushes every wall plane 1.3× past where the author had
    // it, and the frame arrives with clipped gold on every masonry face. Splitting
    // the difference keeps both within a few percent, which is what
    // "brightness-neutral" was supposed to mean.
    const sine = Math.max(0.35, Math.sin(MathUtils.degToRad(keyElevation)));
    const throughput = Math.max(0.5, (1 + sine) * 0.5);
    const recovered = Math.max(0, surrendered - rimCost * 0.5) / throughput;

    return { key: key + recovered * 0.85, rim, hemi, ambient, probe };
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
  private updateProbe(
    s: LiveState,
    rig: { key: number; rim: number; hemi: number; probe: number },
    bearing: { key: number; rim: number },
    keyElevation: number,
  ): void {
    const sh = this.probeSh;
    sh.zero();
    if (rig.probe <= 0) {
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
    // Lobe weights read from the *post-policy* levels, not the authored ones —
    // otherwise the probe quietly puts back the flat sky fill that `applyContrast`
    // just took out, and the shadows stay grey.
    add(s.keyColor, bearing.key, Math.max(4, keyElevation * 0.35), rig.key * 0.12, split * 0.55);
    add(s.rimColor, bearing.rim, s.rimElevation * 0.6, 0.3 + rig.rim * 0.8, -split * 1.2);
    add(s.skyColor, 0, 90, rig.hemi * 0.62, -split * 1.15);
    add(s.groundColor, 0, -90, rig.hemi * 0.24, split * 0.45);

    this.probe.sh.copy(sh);
    this.probe.intensity = rig.probe;
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
      // Extended-source falloff by default (see `practicalDecay`), overridable
      // per light so a cold sky shaft can stay physically distant.
      light.decay = Math.max(0, spec.decay ?? this.live.practicalDecay);
      // The gain is the rig's, for the same reason the contrast policy is: a
      // brazier authored to look right on its own is invisible once it is one of
      // six, twenty tiles back, behind a tone mapper and a grade.
      this.practicalBase[i] = spec.intensity * Math.max(0, this.live.practicalGain);
      light.intensity = this.practicalBase[i]!;
      // Published for anyone downstream who needs to know how hard this source is
      // *meant* to burn once the rig has started flickering it. `vfx.ts` reads it
      // to size the glare card and to rate-limit embers, using exactly the same
      // convention `terrain.ts` uses for its brazier props — so a preset-placed
      // torch and a prop-placed torch behave identically.
      light.userData['baseIntensity'] = this.practicalBase[i]!;
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
    this.adoptedColor.length = 0;
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
      // Cached once, because the flicker rewrites `light.color` every frame and
      // re-reading it would let the temperature shift compound into pure red
      // over a few seconds.
      const authored = light.userData['baseColor'] as Color | undefined;
      if (authored) {
        this.adoptedColor.push(authored);
      } else {
        const c = light.color.clone();
        light.userData['baseColor'] = c;
        this.adoptedColor.push(c);
      }
      // Falloff is the rig's, for the same reason level is. A prop author places
      // a brazier and picks a candela that looks right standing next to it; what
      // they cannot see from there is that at decay 2 the pool is 36:1 from its
      // near edge to its far one, so the fire either clips the stone beside it or
      // reaches nothing. See `practicalDecay`.
      light.decay = Math.max(0, this.live.practicalDecay);
    });
    this.promoteShadowCaster();
  }

  /**
   * Give the brightest fire on the map a real shadow.
   *
   * A point light with `castShadow` off illuminates *through* everything: the
   * railing standing in front of a brazier lights up on both sides, the wall
   * behind it takes the full pool with no bar of darkness across it, and the
   * unit standing between the fire and the stone leaves no mark. That is the
   * mechanism behind three separate round-3 notes — "the warm pools read as
   * emissive quads rather than as illumination", "no character casts anything
   * onto the tile it stands on", "several courtyard blocks pick up warm light
   * with no source in the direction the falloff implies". A directional key
   * cannot fix any of them, because none of them are about the sun.
   *
   * Exactly one light is promoted, and deliberately so. A point-light shadow is
   * a cube map: six render passes per light per frame. One is affordable at 512²
   * over a five-tile radius (~0.02 world units per texel, finer than the
   * directional map gets over the whole diorama); four would quadruple the
   * scene's shadow cost for pools that mostly do not overlap anything anyway.
   *
   * The promotion is sticky. Toggling `castShadow` changes
   * `NUM_POINT_LIGHT_SHADOWS`, which recompiles every material in the scene, so
   * it must not chase the flicker — the choice is made on the *authored* base
   * intensity, which is constant, and re-evaluated only when the adopted set
   * itself changes (terrain rebuild).
   */
  private promoteShadowCaster(): void {
    let best: PointLight | null = null;
    let bestScore = 0;
    for (let i = 0; i < this.adopted.length; i++) {
      const light = this.adopted[i]!;
      // Reach, not raw candela: a 6-candela lamp with a 12-unit radius throws its
      // occlusion across far more of the frame than a 30-candela one clamped to 3.
      const score = (this.adoptedBase[i] ?? 0) * Math.max(0.5, light.distance);
      if (score > bestScore) {
        bestScore = score;
        best = light;
      }
    }
    if (best === this.shadowCaster) return;

    if (this.shadowCaster) {
      this.shadowCaster.castShadow = false;
      this.shadowCaster.shadow.map?.dispose();
      this.shadowCaster.shadow.map = null;
    }
    this.shadowCaster = best;
    if (!best) return;

    best.castShadow = true;
    best.shadow.mapSize.setScalar(512);
    // Near has to clear the brazier's own bowl or the fire shadows itself and the
    // pool comes out with a black disc punched in the middle of it.
    best.shadow.camera.near = 0.25;
    best.shadow.camera.far = Math.max(2, best.distance > 0 ? best.distance : 8);
    best.shadow.camera.updateProjectionMatrix();
    // Same policy as the key: near-zero constant bias so contact stays attached,
    // and the work done by a normal offset sized to roughly one shadow texel.
    best.shadow.bias = -0.0006;
    best.shadow.normalBias = 0.045;
    best.shadow.radius = 3;
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
    const gain = Math.max(0, this.live.practicalGain);
    for (let i = 0; i < this.adopted.length; i++) {
      const light = this.adopted[i]!;
      const base = this.adoptedBase[i]! * gain;
      const home = this.adoptedHome[i]!;
      // Deepened for round 4, and biased low.
      //
      // The old curve ran 0.78–1.26 of base: a ±23% wobble, which on stone that
      // is also carrying a directional key is under the threshold at which a
      // still frame shows anything at all. The brief for this round is that the
      // surrounding stone should visibly *pulse*, and both reference corpora
      // support a far wider swing — a brazier in
      // `refs/curated/triangle/press_002_gematsu_1920x1080.jpg` puts its pool
      // over roughly a two-stop range as it breathes.
      //
      // `pow(x, 1.35)` spends more of the cycle guttering than flaring, which is
      // what fire does; the mean lands within a few percent of base so the map's
      // overall exposure does not move.
      const n = flickerNoise(t * 5.6, i * 4.7);
      const x = Math.min(1, Math.max(0, n * 0.5 + 0.5));
      const drive = 0.55 + 1.0 * Math.pow(x, 1.35);
      light.intensity = base * drive;
      // Temperature follows brightness, because it does in a real flame: a
      // guttering coal is deep orange and a flare is nearly yellow-white. This is
      // also what `vfx.ts` reads to tint the embers and the flame tongues, so the
      // plume changes colour on the same curve as the light — one event, not two
      // systems that happen to be flickering nearby.
      const authored = this.adoptedColor[i];
      if (authored) {
        const warm = drive - 1;
        light.color.setRGB(
          authored.r,
          authored.g * (1 + 0.13 * warm),
          authored.b * (1 + 0.42 * warm),
        );
      }
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
    // Hand the prop light back the way it was found. It belongs to `terrain.ts`,
    // and leaving a disposed cube shadow attached to a live scene light outlives
    // this rig in a way nothing else here does.
    if (this.shadowCaster) {
      this.shadowCaster.castShadow = false;
      this.shadowCaster.shadow.map?.dispose();
      this.shadowCaster.shadow.map = null;
      this.shadowCaster = null;
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
