/**
 * EverTactics — atmosphere: particulate, haze banks, and the environment
 * orchestrator that ties sky + backdrop + air together.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT LIVES HERE
 * ─────────────────────────────────────────────────────────────────────────────
 *  • 'MoteField'  — GPU-animated dust and embers. Both reference frames have
 *    them and they are a surprisingly large part of why those frames read as a
 *    *place* rather than a render: air with something in it has volume.
 *  • 'HazeBanks'  — a handful of large, soft, camera-facing quads sitting at
 *    authored depths. They are what separates the board from the surround and
 *    the surround from the sky, and a ground bank at the board's base is what
 *    stops the diorama terminating on a hard silhouette.
 *  • 'WorldEnvironment' — measures the board, solves the framing, and keeps the
 *    sky, the surround and the air agreeing with each other every frame.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW IT INSTALLS
 * ─────────────────────────────────────────────────────────────────────────────
 * 'Stage' constructs one of these and updates it in 'present()'. Nothing else
 * has to call anything: the palette is *read back* from 'scene.background',
 * 'scene.fog' and the key 'DirectionalLight' that 'lighting.ts' owns, and the
 * board bounds are measured from whatever 'terrain.ts' added to the scene. That
 * keeps the module boundary to "the scene is the contract" and lets the other
 * fixers change lighting presets and map geometry without touching this file.
 *
 * Escape hatches for the other agents are on 'Stage':
 *   'stage.environment'            — the live instance
 *   'stage.environment.enabled'    — kill switch
 *   'stage.environment.setBoardBounds(box)' — skip the measurement heuristic
 *   'stage.environment.refresh()'  — re-read palette + relayout now
 */

import {
  AdditiveBlending,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  NormalBlending,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
  type Camera,
  type Object3D,
} from 'three';

import { Backdrop, type BackdropLayout, type BoardFootprint } from './backdrop.js';
import {
  deriveEnvironmentPalette,
  GLSL_NOISE,
  Sky,
  type EnvironmentPalette,
  type PaletteTuning,
} from './sky.js';

// ─────────────────────────────────────────────────────────────────────────────
// Motes
// ─────────────────────────────────────────────────────────────────────────────

const MOTE_VERT = /* glsl */ `
attribute float aSeed;
attribute float aSize;
attribute float aWarm;

uniform float uTime;
uniform float uRise;
uniform float uBoxMinY;
uniform float uBoxHeight;
uniform float uPointScale;
uniform float uZMin;
uniform float uZMax;

varying float vAlpha;
varying float vWarm;

void main() {
  vec3 p = position;

  // Everything is driven from the seed, so the field is deterministic: the
  // screenshot harness must produce the same frame twice.
  float sway = 0.55 + aSeed * 1.4;
  p.x += sin(uTime * (0.13 + aSeed * 0.19) + aSeed * 41.0) * sway;
  p.z += cos(uTime * (0.11 + aSeed * 0.17) + aSeed * 23.0) * sway;

  // Embers climb, dust hangs. Wrapped so the field never empties.
  float rise = uRise * (0.25 + aWarm * 1.5) * (0.5 + aSeed);
  p.y = mod(p.y - uBoxMinY + uTime * rise, uBoxHeight) + uBoxMinY;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  // Depth stratification. The rig is orthographic, so there is no perspective
  // size falloff to inherit — every mote projected at exactly the same screen
  // size, which is the "uniform round dots, no parallax, no size falloff with
  // depth, a flat 2D overlay" note verbatim. Near motes are made large and faint
  // (they are the ones the lens defocuses into bokeh) and far ones small and
  // crisp, which is what gives the air depth in a still frame.
  float nearT = clamp((p.z - uZMin) / max(uZMax - uZMin, 1e-3), 0.0, 1.0);
  gl_PointSize = aSize * uPointScale * (0.45 + 1.55 * nearT * nearT);

  // Slow scintillation, plus a fade at the top and bottom of the volume so
  // particles are never seen popping in or out at the wrap seam.
  float band = smoothstep(0.0, 0.12, (p.y - uBoxMinY) / uBoxHeight)
             * (1.0 - smoothstep(0.72, 1.0, (p.y - uBoxMinY) / uBoxHeight));
  vAlpha = band * (0.45 + 0.55 * (0.5 + 0.5 * sin(uTime * (1.1 + aSeed * 2.7) + aSeed * 12.0)));
  // Conservation of energy, roughly: a mote spread over four times the area is
  // a quarter as bright. Without this the near band is a screen of hard dots.
  vAlpha *= mix(1.0, 0.34, nearT * nearT);
  vWarm = aWarm;
}
`;

const MOTE_FRAG = /* glsl */ `
precision highp float;
uniform vec3  uCool;
uniform vec3  uWarmColor;
uniform float uIntensity;
varying float vAlpha;
varying float vWarm;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  // Soft core with a wider halo — a hard disc reads as a dead pixel.
  float a = exp(-r * r * 3.4) * 0.85 + exp(-r * 1.6) * 0.25;
  a *= smoothstep(1.0, 0.55, r);
  vec3 col = mix(uCool, uWarmColor, vWarm);
  gl_FragColor = vec4(col * a * vAlpha * uIntensity, 1.0);
}
`;

export interface MoteFieldOptions {
  /** Dust particles (cool, hanging). */
  dust?: number;
  /** Ember particles (warm, rising). */
  embers?: number;
  seed?: number;
}

/**
 * One 'Points' draw call of GPU-animated air. Positions are baked once, in the
 * yaw-local frame of the surround, and animated entirely in the vertex shader.
 */
export class MoteField {
  readonly points: Points;
  readonly material: ShaderMaterial;
  private geometry: BufferGeometry;
  private readonly opts: Required<MoteFieldOptions>;

  constructor(palette: EnvironmentPalette, options: MoteFieldOptions = {}) {
    this.opts = {
      dust: options.dust ?? 1150,
      embers: options.embers ?? 300,
      seed: options.seed ?? 0x5eed,
    };
    this.geometry = new BufferGeometry();
    this.material = new ShaderMaterial({
      name: 'env-motes',
      uniforms: {
        uTime: { value: 0 },
        uRise: { value: 0.35 },
        uBoxMinY: { value: 0 },
        uBoxHeight: { value: 20 },
        uPointScale: { value: 1 },
        uZMin: { value: -40 },
        uZMax: { value: 0 },
        uCool: { value: new Color() },
        uWarmColor: { value: new Color() },
        uIntensity: { value: 1 },
      },
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      // Depth-tested: motes must go behind the board, not through it. That
      // occlusion is most of what makes them read as being *in* the space.
      depthTest: true,
      fog: false,
      toneMapped: false,
    });
    this.points = new Points(this.geometry, this.material);
    this.points.name = 'env-motes';
    this.points.frustumCulled = false;
    this.points.renderOrder = 400;
    this.setPalette(palette);
  }

  /** Rebuild the volume. 'box' is in the surround's yaw-local frame. */
  layout(minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): void {
    const total = this.opts.dust + this.opts.embers;
    const pos = new Float32Array(total * 3);
    const seed = new Float32Array(total);
    const size = new Float32Array(total);
    const warm = new Float32Array(total);

    let s = this.opts.seed >>> 0;
    const rnd = (): number => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let i = 0; i < total; i += 1) {
      const isEmber = i >= this.opts.dust;
      pos[i * 3 + 0] = minX + rnd() * (maxX - minX);
      pos[i * 3 + 1] = minY + rnd() * (maxY - minY);
      // Embers cluster nearer the board (they come off the practicals); dust
      // fills the whole depth so the far haze has something moving in it.
      const zt = isEmber ? 0.25 + rnd() * 0.5 : rnd();
      pos[i * 3 + 2] = minZ + zt * (maxZ - minZ);
      seed[i] = rnd();
      size[i] = isEmber ? 2.6 + rnd() * 5.4 : 1.4 + rnd() * 4.2;
      // Even the "dust" carries some warmth: these particles are in the air
      // above a courtyard full of lanterns, and neutral-white specks read as
      // dirt on the lens rather than as lit motes.
      warm[i] = isEmber ? 0.7 + rnd() * 0.3 : 0.08 + rnd() * 0.42;
    }

    this.geometry.dispose();
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(pos, 3));
    this.geometry.setAttribute('aSeed', new BufferAttribute(seed, 1));
    this.geometry.setAttribute('aSize', new BufferAttribute(size, 1));
    this.geometry.setAttribute('aWarm', new BufferAttribute(warm, 1));
    this.points.geometry = this.geometry;

    this.material.uniforms.uBoxMinY!.value = minY;
    this.material.uniforms.uBoxHeight!.value = Math.max(1, maxY - minY);
    this.material.uniforms.uZMin!.value = minZ;
    this.material.uniforms.uZMax!.value = maxZ;
  }

  setPalette(palette: EnvironmentPalette): void {
    (this.material.uniforms.uCool!.value as Color)
      .copy(palette.haze)
      .lerp(palette.horizon, 0.6)
      .multiplyScalar(2.3);
    // Embers are the one thing in the environment allowed to be a highlight —
    // they should be the only pixels here that cross the bloom threshold.
    (this.material.uniforms.uWarmColor!.value as Color).copy(palette.sun).multiplyScalar(0.42);
  }

  setPointScale(v: number): void {
    this.material.uniforms.uPointScale!.value = v;
  }

  setIntensity(v: number): void {
    this.material.uniforms.uIntensity!.value = v;
  }

  update(elapsed: number): void {
    this.material.uniforms.uTime!.value = elapsed;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Haze banks
// ─────────────────────────────────────────────────────────────────────────────

const HAZE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vLocal;
void main() {
  vUv = uv;
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HAZE_FRAG = /* glsl */ `
precision highp float;
uniform vec3  uColor;
uniform float uOpacity;
uniform float uTime;
uniform float uDrift;
uniform float uSoftBottom;
varying vec2 vUv;
varying vec3 vLocal;

${GLSL_NOISE}

void main() {
  // Elliptical falloff so a bank has no edge anywhere.
  vec2 d = (vUv - 0.5) * 2.0;
  float fall = 1.0 - smoothstep(0.15, 1.0, length(d * vec2(1.0, 1.35)));

  // Torn, drifting body. The first version remapped the noise into [0.35,1.1]
  // before the smoothstep, which saturated it to ~1 everywhere and turned each
  // bank into a flat grey wash across a third of the frame — a worse artefact
  // than the void it was covering. Threshold the raw fbm instead, and take two
  // octave sets so the tears have tears.
  vec2 flow = vec2(uTime * uDrift, uTime * uDrift * 0.35);
  float n = etFbm(vUv * vec2(3.1, 1.7) + flow, 4);
  float n2 = etFbm(vUv * vec2(9.5, 5.5) - flow * 1.7, 3);
  float body = smoothstep(0.34, 0.72, n) * (0.55 + 0.45 * smoothstep(0.25, 0.75, n2));

  // Fog is densest at its base and thins upward.
  float vertical = mix(1.0, smoothstep(1.0, 0.05, vUv.y), uSoftBottom);

  float a = fall * body * vertical * uOpacity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * a, a);
}
`;

interface BankSpec {
  /** Yaw-local depth (positive = away from the camera). */
  depth: number;
  /** Lateral centre offset, in half-widths. */
  lateral: number;
  /** Height of the bank centre above the ground plate. */
  rise: number;
  width: number;
  height: number;
  opacity: number;
  warm: number;
  softBottom: number;
  drift: number;
}

/** Soft volumetric-ish haze planes that separate the depth layers. */
export class HazeBanks extends Group {
  private readonly materials: ShaderMaterial[] = [];
  private readonly meshes: Mesh[] = [];
  private palette: EnvironmentPalette;

  constructor(palette: EnvironmentPalette) {
    super();
    this.name = 'env-haze';
    this.palette = palette;
  }

  layout(layout: BackdropLayout): void {
    this.clearContents();
    const R = layout.boardRadius;
    const W = layout.halfW;

    // Every bank sits strictly outside the board footprint. An earlier revision
    // put a ground-fog bank at the board centre to soften the base; it went
    // straight through the courtyard floor and washed two units out of the
    // frame. Fog that hugs the *board's own* base belongs in the ground plate's
    // shader, not in a quad the board can intersect.
    const run = Math.max(2.5, layout.visibleDepth - R);
    const clear = R * 1.12;
    const specs: BankSpec[] = [
      // Immediately beyond the pedestal: this is the pair that kills the hard
      // silhouette where the board's edge used to meet nothing.
      { depth: clear, lateral: -0.7, rise: 0.5, width: W * 1.5, height: R * 0.55, opacity: 0.20, warm: 0.2, softBottom: 0.25, drift: 0.009 },
      { depth: clear, lateral: 0.72, rise: 0.4, width: W * 1.4, height: R * 0.5, opacity: 0.18, warm: 0.45, softBottom: 0.25, drift: -0.008 },
      // Between the apron and the ridge — the band that makes the surround
      // feel deep rather than pasted.
      { depth: R + run * 0.5, lateral: -0.25, rise: 1.1, width: W * 2.6, height: R * 0.9, opacity: 0.24, warm: 0.3, softBottom: 0.5, drift: 0.005 },
      { depth: R + run * 1.0, lateral: 0.3, rise: 1.7, width: W * 2.8, height: R * 1.1, opacity: 0.30, warm: 0.55, softBottom: 0.55, drift: -0.004 },
      // Flanking wisps at the frame edges, out where the board does not reach.
      { depth: R * 0.2, lateral: -1.5, rise: 0.8, width: W * 1.0, height: R * 0.7, opacity: 0.17, warm: 0.2, softBottom: 0.3, drift: 0.011 },
      { depth: R * 0.2, lateral: 1.5, rise: 0.8, width: W * 1.0, height: R * 0.7, opacity: 0.17, warm: 0.35, softBottom: 0.3, drift: -0.010 },
    ];

    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i]!;
      const material = new ShaderMaterial({
        name: `env-haze-${i}`,
        uniforms: {
          uColor: { value: new Color() },
          uOpacity: { value: spec.opacity },
          uTime: { value: 0 },
          uDrift: { value: spec.drift },
          uSoftBottom: { value: spec.softBottom },
        },
        vertexShader: HAZE_VERT,
        fragmentShader: HAZE_FRAG,
        transparent: true,
        blending: NormalBlending,
        depthWrite: false,
        depthTest: true,
        fog: false,
        toneMapped: false,
      });
      material.userData.warm = spec.warm;

      const mesh = new Mesh(new PlaneGeometry(spec.width, spec.height, 1, 1), material);
      mesh.name = `env-haze-${i}`;
      mesh.position.set(spec.lateral * layout.halfW, layout.groundY + spec.rise, -spec.depth);
      mesh.frustumCulled = false;
      mesh.renderOrder = 300 + i;
      this.meshes.push(mesh);
      this.materials.push(material);
      this.add(mesh);
    }
    this.applyPalette();
  }

  /** Keep the quads square to the camera. 'pitch' in radians. */
  setPitch(pitch: number): void {
    for (const mesh of this.meshes) mesh.rotation.x = -pitch;
  }

  setPalette(palette: EnvironmentPalette): void {
    this.palette = palette;
    this.applyPalette();
  }

  private applyPalette(): void {
    for (const m of this.materials) {
      const warm = (m.userData.warm as number) ?? 0;
      (m.uniforms.uColor!.value as Color)
        .copy(this.palette.haze)
        .lerp(this.palette.horizon, warm)
        .multiplyScalar(1.6);
    }
  }

  update(elapsed: number): void {
    for (const m of this.materials) m.uniforms.uTime!.value = elapsed;
  }

  private clearContents(): void {
    for (const mesh of this.meshes) {
      this.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.length = 0;
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }

  dispose(): void {
    this.clearContents();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WorldEnvironment
// ─────────────────────────────────────────────────────────────────────────────

export interface WorldEnvironmentOptions {
  /** Start disabled (diagnostic scenes). */
  enabled?: boolean;
  /** Screen fraction, 0 = bottom, where the ground plate dissolves. */
  horizonScreenFraction?: number;
  /** Palette lift knobs. */
  palette?: PaletteTuning;
  /** Overall brightness of everything the environment draws. */
  exposure?: number;
  /** Deterministic layout seed. */
  seed?: number;
  motes?: MoteFieldOptions;
}

const FORWARD = new Vector3();
const TMP_A = new Vector3();
const TMP_B = new Vector3();
const TMP_C = new Vector3();

/**
 * Everything behind, below and around the board.
 *
 * The awkward part of this job is that nothing tells us how the shot is framed:
 * 'Stage' only holds a 'StageCamera', and the board is added to the scene long
 * after 'Stage' is constructed. So the environment *measures*:
 *
 *   1. board bounds  — from the 'terrain:*' group if present, else the scene
 *   2. framing       — by projecting two probe points and reading back NDC,
 *                      which works for both an orthographic and a perspective
 *                      rig without caring which one is installed
 *   3. palette       — from 'scene.background', 'scene.fog' and the key light
 *
 * and relayouts when any of those move materially.
 */
export class WorldEnvironment {
  readonly group = new Group();
  readonly sky: Sky;
  readonly backdrop: Backdrop;
  readonly motes: MoteField;
  readonly haze: HazeBanks;

  enabled: boolean;

  private palette: EnvironmentPalette;
  private readonly options: Required<Omit<WorldEnvironmentOptions, 'palette' | 'motes'>> & {
    palette: PaletteTuning;
    motes: MoteFieldOptions;
  };

  private scene: Scene | null = null;
  private explicitBounds: Box3 | null = null;
  private readonly bounds = new Box3();
  private haveBounds = false;

  private lastBoardRadius = -1;
  private lastHalfW = -1;
  private lastGroundY = Number.NaN;
  private lastYaw = Number.NaN;
  private framesSinceMeasure = 1e9;
  private aspect = 16 / 9;
  private pixelRatio = 1;

  constructor(options: WorldEnvironmentOptions = {}) {
    this.options = {
      enabled: options.enabled ?? true,
      horizonScreenFraction: options.horizonScreenFraction ?? 0.94,
      exposure: options.exposure ?? 1,
      seed: options.seed ?? 1337,
      palette: options.palette ?? {},
      motes: options.motes ?? {},
    };
    this.enabled = this.options.enabled;

    // A neutral starting palette; 'refresh()' replaces it as soon as the
    // lighting rig has published its preset.
    this.palette = {
      zenith: new Color().setHex(0x0d1526, 'srgb'),
      horizon: new Color().setHex(0x35506f, 'srgb'),
      haze: new Color().setHex(0x22334c, 'srgb'),
      ground: new Color().setHex(0x161f31, 'srgb'),
      sun: new Color().setHex(0xffc07a, 'srgb'),
      deep: new Color().setHex(0x080d18, 'srgb'),
      sunDirection: new Vector3(-0.5, -0.7, -0.5).normalize(),
      sunIntensity: 3,
      hasKey: false,
    };

    this.sky = new Sky(this.palette);
    this.backdrop = new Backdrop(this.palette, { exposure: this.options.exposure });
    this.motes = new MoteField(this.palette, this.options.motes);
    this.haze = new HazeBanks(this.palette);

    this.group.name = 'WorldEnvironment';
    this.group.add(this.sky.mesh);
    this.group.add(this.backdrop);
    this.group.visible = this.enabled;
    // Motes and haze live inside the backdrop's yaw frame conceptually, but
    // keeping them as siblings under a shared yaw group is simpler and lets the
    // backdrop own its own rebuild lifecycle.
    this.yawGroup.add(this.motes.points);
    this.yawGroup.add(this.haze);
    this.group.add(this.yawGroup);
  }

  private readonly yawGroup = new Group();

  addTo(scene: Scene): void {
    this.scene = scene;
    scene.add(this.group);
  }

  /** Override the measured board bounds (world space). */
  setBoardBounds(box: Box3): void {
    this.explicitBounds = box.clone();
    this.framesSinceMeasure = 1e9;
  }

  /** Force a palette re-read and relayout on the next update. */
  refresh(): void {
    this.lastBoardRadius = -1;
    this.framesSinceMeasure = 1e9;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
  }

  /**
   * Overall brightness of the surround, independent of the board.
   *
   * 'BackdropOptions.exposure' was always documented as "overall gain, matched
   * to the map's exposure" — but nothing ever matched it, so the surround sat at
   * a fixed gain of 1 while post exposure moved underneath it. Round 6 halved
   * post exposure to put the board in the reference night band and the surround
   * went with it: measured on 'battle-open', the connected-component void jumped
   * 0.114 -> 0.246 (reference band 0.087–0.180, hard fail above 0.25) and
   * background detail fell 13.58 -> 7.31. The distant town, its lit windows and
   * the silhouette layer were all still being drawn; they had simply been
   * crushed below the black point. 'Game.applyPostProfile' now drives this from
   * the scenario exposure so the surround holds its final luminance whatever
   * absolute exposure the composition picks.
   */
  setExposure(v: number): void {
    this.options.exposure = v;
    this.backdrop.setExposure(v);
  }

  setViewport(widthPx: number, heightPx: number, pixelRatio: number): void {
    this.aspect = widthPx / Math.max(1, heightPx);
    this.pixelRatio = pixelRatio;
    this.sky.setAspect(this.aspect);
    // Scale with the drawing buffer, not just the DPR: a mote sized in raw
    // points is a different physical size on a 720p and a 4K render, and the
    // screenshot harness runs at 1920 wide.
    this.motes.setPointScale(pixelRatio * Math.max(0.75, widthPx / (1920 * pixelRatio)) * 2.1);
  }

  // ── per-frame ────────────────────────────────────────────────────────────

  update(camera: Camera, elapsed: number): void {
    if (!this.enabled || !this.scene) return;

    // Re-measure occasionally rather than every frame: 'Box3.setFromObject'
    // walks the graph, and the board only changes when a scenario loads.
    this.framesSinceMeasure += 1;
    if (this.framesSinceMeasure > (this.haveBounds ? 90 : 5)) {
      this.framesSinceMeasure = 0;
      this.measure();
      this.palette = deriveEnvironmentPalette(this.scene, this.options.palette);
      this.sky.setPalette(this.palette);
      // No lighting rig means no committed key direction, so the bloom would be
      // placed arbitrarily. Drop it rather than invent one.
      this.sky.setSunGlow(this.palette.hasKey ? 0.16 : 0.02);
      this.backdrop.setPalette(this.palette);
      this.motes.setPalette(this.palette);
      this.haze.setPalette(this.palette);
      if (this.haveBounds) this.relayoutIfNeeded(camera);
    }

    if (!this.haveBounds) return;

    camera.updateMatrixWorld();
    FORWARD.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    const pitch = Math.asin(Math.min(1, Math.max(-1, -FORWARD.y)));
    const yaw = Math.atan2(-FORWARD.x, -FORWARD.z);

    // Both yaw-following groups are re-centred on the board every frame. Missing
    // this is what put the first pass's outbuildings *inside* the cloister: the
    // layout is authored relative to the board, so the frame it lives in has to
    // be too. Y stays at 0 because the geometry already carries an absolute
    // ground height.
    this.bounds.getCenter(TMP_C);
    this.backdrop.position.set(TMP_C.x, 0, TMP_C.z);
    this.backdrop.update(FORWARD, elapsed);
    this.yawGroup.position.set(TMP_C.x, 0, TMP_C.z);
    this.yawGroup.rotation.y = yaw;
    this.haze.setPitch(pitch);
    this.haze.update(elapsed);
    this.motes.update(elapsed);
    this.sky.update(elapsed);

    // Sun bloom position: project a point out along the reverse key direction.
    // Under an orthographic rig that is a well-defined screen offset even
    // though the light itself has no position.
    TMP_A.copy(this.bounds.getCenter(TMP_B));
    TMP_A.addScaledVector(this.palette.sunDirection, -Math.max(20, this.lastBoardRadius * 4));
    TMP_A.project(camera);
    const sunU = Math.min(1.35, Math.max(-0.35, TMP_A.x * 0.5 + 0.5));
    const sunV = Math.min(1.45, Math.max(0.2, TMP_A.y * 0.5 + 0.5));
    this.sky.setSunScreen(sunU, sunV);
  }

  // ── measurement / layout ─────────────────────────────────────────────────

  private measure(): void {
    if (this.explicitBounds) {
      this.bounds.copy(this.explicitBounds);
      this.haveBounds = true;
      return;
    }
    const scene = this.scene;
    if (!scene) return;

    // Prefer the terrain group: it is exactly the playable diorama, whereas the
    // whole scene includes VFX volumes and light helpers whose bounds lie.
    let target: Object3D | null = null;
    scene.traverse((o) => {
      if (target === null && o.name.startsWith('terrain:')) target = o;
    });
    if (target === null) {
      this.haveBounds = false;
      return;
    }

    this.bounds.setFromObject(target as Object3D);
    if (!Number.isFinite(this.bounds.min.x) || this.bounds.isEmpty()) {
      this.haveBounds = false;
      return;
    }
    this.haveBounds = true;

    // The footprint walk is O(terrain vertices) plus a 128x128 morphology and
    // distance transform. 'measure()' runs on a 90-frame heartbeat whether or
    // not anything moved, so rebuilding unconditionally would burn that every
    // second and a half for the entire battle. The board only changes when a
    // scenario loads, and the bounds change with it.
    const signature = `${this.bounds.min.x.toFixed(2)},${this.bounds.min.z.toFixed(2)},${this.bounds.max.x.toFixed(2)},${this.bounds.max.z.toFixed(2)},${this.bounds.max.y.toFixed(2)}`;
    if (signature !== this.footprintSignature || this.footprint === null) {
      this.footprintSignature = signature;
      this.footprint = buildFootprintField(target as Object3D, this.bounds);
    }
  }

  private footprint: BoardFootprint | null = null;
  private footprintSignature = '';

  private relayoutIfNeeded(camera: Camera): void {
    const size = this.bounds.getSize(TMP_A);
    // Circumscribing radius, not the half-side: the clearance test is radial, so
    // a half-side would let structures land in the board's four corners.
    const boardRadius = Math.max(2, Math.hypot(size.x, size.z) * 0.5);
    const groundY = this.bounds.min.y;

    const { halfW, halfH } = visibleHalfExtents(camera, this.aspect);

    camera.updateMatrixWorld();
    FORWARD.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    const pitch = Math.asin(Math.min(1, Math.max(-1, -FORWARD.y)));
    const yaw = Math.atan2(-FORWARD.x, -FORWARD.z);

    // Yaw is a relayout trigger because the footprint clearance test is exact
    // in the yaw-local frame. The rig snaps between four slots, so this fires at
    // most four times a battle.
    const changed =
      Math.abs(boardRadius - this.lastBoardRadius) > this.lastBoardRadius * 0.08 ||
      Math.abs(halfW - this.lastHalfW) > this.lastHalfW * 0.1 ||
      !(Math.abs(groundY - this.lastGroundY) < 0.01) ||
      Math.abs(angleDelta(yaw, this.lastYaw)) > 0.05;
    if (!changed) return;

    this.lastBoardRadius = boardRadius;
    this.lastHalfW = halfW;
    this.lastGroundY = groundY;
    this.lastYaw = yaw;

    const centre = this.bounds.getCenter(TMP_B);

    // Solve for the depth at which a point on the ground plate reaches the
    // target screen height. Under ortho the mapping is affine, so two probes
    // give it exactly; under perspective it is a good first-order answer.
    const away = TMP_C.set(FORWARD.x, 0, FORWARD.z);
    if (away.lengthSq() < 1e-6) away.set(0, 0, -1);
    away.normalize();

    const probe = new Vector3();
    probe.set(centre.x, groundY, centre.z).project(camera);
    const y0 = probe.y;
    probe.set(centre.x + away.x * 10, groundY, centre.z + away.z * 10).project(camera);
    const slope = (probe.y - y0) / 10;

    const depthAt = (ndc: number): number =>
      Math.abs(slope) > 1e-5 ? (ndc - y0) / slope : boardRadius * 3;

    // The three numbers that define the usable window. 'visibleDepth' is where
    // the ground plate leaves the top of the frame and 'nearDepth' where it
    // leaves the bottom; nothing outside that band can ever be seen, which is
    // the constraint an orthographic rig imposes and the one the first pass
    // ignored.
    const visibleDepth = Math.max(boardRadius + 2.5, depthAt(1));
    const nearDepth = Math.min(-2, depthAt(-1));
    const horizonDepth = Math.min(
      Math.max(depthAt(this.options.horizonScreenFraction * 2 - 1), boardRadius + 1.2),
      visibleDepth * 1.02,
    );

    const layout: BackdropLayout = {
      boardRadius,
      groundY,
      focusY: centre.y,
      pitch,
      halfW,
      halfH,
      horizonDepth,
      visibleDepth,
      nearDepth,
      boardHalfX: size.x * 0.5,
      boardHalfZ: size.z * 0.5,
      yaw,
      seed: this.options.seed,
      footprint: this.footprint,
    };

    this.backdrop.layout(layout);
    this.haze.layout(layout);
    // The mote volume is clipped to what the frame can actually show: a box
    // reaching 2.6 board radii into the sky put 80% of the particles above the
    // top edge, where they cost fill rate and read as nothing.
    this.motes.layout(
      -halfW * 1.9,
      halfW * 1.9,
      groundY - 0.5,
      groundY + halfH * 2.0,
      -visibleDepth,
      -nearDepth,
    );

    // Put the sky's horizon band exactly where the ground plate vanishes.
    this.sky.setHorizon(this.options.horizonScreenFraction);
  }

  dispose(): void {
    this.sky.dispose();
    this.backdrop.dispose();
    this.motes.dispose();
    this.haze.dispose();
    this.scene?.remove(this.group);
    this.scene = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Board footprint field
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why this exists.
 *
 * Everything the surround does about "where the board is" — the ground plate's
 * occlusion bowl, the contact darkening, the bounce spill, and the clearance
 * test that places the skirt and verge clutter — used the board's axis-aligned
 * BOUNDING BOX. On a rectangular grid map with towers at the corners that box is
 * a long way outside the mass the camera actually sees: measured on the round-4
 * frame the near-corner facet sat about two and a half world units inside the
 * AABB edge, so every ring of clutter authored to hug the wall was generated in
 * open ground beyond it, and the shading terms shaped to the same rectangle
 * missed the facet entirely. The wall/ground boundary stayed a razor line
 * through four separate attempts to break it, all of which were aimed at the
 * wrong place.
 *
 * So: rasterise the terrain's real XZ occupancy into a coarse grid, close the
 * gaps, and run a chamfer distance transform over it. The result is a signed
 * distance to the actual silhouette, cheap to sample from both JS (placement)
 * and GLSL (shading), and it costs one vertex walk per scenario load.
 */

const FOOTPRINT_RES = 128;
/** Cap on vertices visited; beyond this the walk strides. */
const FOOTPRINT_VERTEX_BUDGET = 600_000;

function buildFootprintField(target: Object3D, bounds: Box3): BoardFootprint | null {
  const size = bounds.getSize(new Vector3());
  const centre = bounds.getCenter(new Vector3());
  const radius = Math.max(2, Math.hypot(size.x, size.z) * 0.5);
  // Padding sets how far outside the board the field stays meaningful. The
  // widest consumer is the occlusion bowl at 1.15 board radii, so 1.6 leaves
  // headroom and still keeps the cell size under a third of a tile.
  const pad = radius * 1.6;
  const span = Math.max(size.x, size.z) + pad * 2;
  const res = FOOTPRINT_RES;
  const cell = span / res;
  const originX = -span * 0.5;
  const originZ = -span * 0.5;

  const occ = new Uint8Array(res * res);
  let total = 0;
  const meshes: { pos: Float32Array | Float64Array; matrix: number[]; count: number }[] = [];
  target.traverse((o) => {
    const mesh = o as Mesh;
    const attr = mesh.geometry?.attributes?.position;
    if (!mesh.isMesh || !attr) return;
    o.updateWorldMatrix(true, false);
    meshes.push({
      pos: attr.array as Float32Array,
      matrix: o.matrixWorld.elements as unknown as number[],
      count: attr.count,
    });
    total += attr.count;
  });
  if (total === 0) return null;

  const stride = Math.max(1, Math.ceil(total / FOOTPRINT_VERTEX_BUDGET));
  for (const m of meshes) {
    const e = m.matrix;
    for (let i = 0; i < m.count; i += stride) {
      const x = m.pos[i * 3]!;
      const y = m.pos[i * 3 + 1]!;
      const z = m.pos[i * 3 + 2]!;
      // Manual transform: allocating a Vector3 per vertex is the difference
      // between a 4 ms measure and a 60 ms one on a large map.
      const wx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]! - centre.x;
      const wz = e[2]! * x + e[6]! * y + e[10]! * z + e[14]! - centre.z;
      const cx = Math.floor((wx - originX) / cell);
      const cz = Math.floor((wz - originZ) / cell);
      if (cx < 0 || cz < 0 || cx >= res || cz >= res) continue;
      occ[cz * res + cx] = 1;
    }
  }

  // Morphological close. Vertices only exist at block corners, so a tile top a
  // world unit across marks two cells and leaves the two between them empty;
  // without this the field is a sieve and the distance transform reports open
  // ground in the middle of the courtyard.
  const closeRadius = Math.max(1, Math.ceil(0.75 / cell));
  dilate(occ, res, closeRadius);
  erode(occ, res, closeRadius);

  const INF = 1e9;
  const outside = new Float32Array(res * res);
  const inside = new Float32Array(res * res);
  for (let i = 0; i < occ.length; i += 1) {
    outside[i] = occ[i] ? 0 : INF;
    inside[i] = occ[i] ? INF : 0;
  }
  chamfer(outside, res);
  chamfer(inside, res);

  const distance = new Float32Array(res * res);
  const encoded = new Uint8Array(res * res);
  const range = pad;
  for (let i = 0; i < distance.length; i += 1) {
    const d = (outside[i]! - inside[i]!) * cell;
    distance[i] = d;
    encoded[i] = Math.max(0, Math.min(255, Math.round(((d / range) * 0.5 + 0.5) * 255)));
  }

  return { res, span, cell, originX, originZ, distance, range, encoded };
}

/** In-place Chebyshev max filter. Separable, so two linear passes. */
function dilate(grid: Uint8Array, res: number, r: number): void {
  morph(grid, res, r, true);
}
function erode(grid: Uint8Array, res: number, r: number): void {
  morph(grid, res, r, false);
}
function morph(grid: Uint8Array, res: number, r: number, max: boolean): void {
  const tmp = new Uint8Array(res * res);
  for (let z = 0; z < res; z += 1) {
    for (let x = 0; x < res; x += 1) {
      let v = max ? 0 : 1;
      for (let k = -r; k <= r; k += 1) {
        const xx = x + k;
        // Outside the grid counts as empty, which is correct on both passes:
        // the board never reaches the padded border.
        const s = xx < 0 || xx >= res ? 0 : grid[z * res + xx]!;
        v = max ? Math.max(v, s) : Math.min(v, s);
      }
      tmp[z * res + x] = v;
    }
  }
  for (let z = 0; z < res; z += 1) {
    for (let x = 0; x < res; x += 1) {
      let v = max ? 0 : 1;
      for (let k = -r; k <= r; k += 1) {
        const zz = z + k;
        const s = zz < 0 || zz >= res ? 0 : tmp[zz * res + x]!;
        v = max ? Math.max(v, s) : Math.min(v, s);
      }
      grid[z * res + x] = v;
    }
  }
}

/** Two-pass chamfer distance transform, in cells. Seeds are the zeroes. */
function chamfer(d: Float32Array, res: number): void {
  const D = Math.SQRT2;
  for (let z = 0; z < res; z += 1) {
    for (let x = 0; x < res; x += 1) {
      const i = z * res + x;
      let v = d[i]!;
      if (z > 0) {
        v = Math.min(v, d[i - res]! + 1);
        if (x > 0) v = Math.min(v, d[i - res - 1]! + D);
        if (x < res - 1) v = Math.min(v, d[i - res + 1]! + D);
      }
      if (x > 0) v = Math.min(v, d[i - 1]! + 1);
      d[i] = v;
    }
  }
  for (let z = res - 1; z >= 0; z -= 1) {
    for (let x = res - 1; x >= 0; x -= 1) {
      const i = z * res + x;
      let v = d[i]!;
      if (z < res - 1) {
        v = Math.min(v, d[i + res]! + 1);
        if (x > 0) v = Math.min(v, d[i + res - 1]! + D);
        if (x < res - 1) v = Math.min(v, d[i + res + 1]! + D);
      }
      if (x < res - 1) v = Math.min(v, d[i + 1]! + 1);
      d[i] = v;
    }
  }
}

/** Signed smallest angle between two headings, radians. */
function angleDelta(a: number, b: number): number {
  if (!Number.isFinite(b)) return Math.PI;
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Visible half-extents at the focus plane, in world units.
 *
 * Handles both camera types because 'camera.ts' is owned by another agent this
 * round and one of the review notes asks them to move to a narrow perspective
 * FOV. If that lands, the environment must not need a matching edit.
 */
function visibleHalfExtents(camera: Camera, aspect: number): { halfW: number; halfH: number } {
  const ortho = camera as OrthographicCamera;
  if (ortho.isOrthographicCamera) {
    const zoom = ortho.zoom || 1;
    return {
      halfW: Math.abs(ortho.right - ortho.left) * 0.5 / zoom,
      halfH: Math.abs(ortho.top - ortho.bottom) * 0.5 / zoom,
    };
  }
  const persp = camera as PerspectiveCamera;
  if (persp.isPerspectiveCamera) {
    // No focus distance is exposed, so assume the rig's usual standoff.
    const dist = 160;
    const halfH = Math.tan((persp.fov * Math.PI) / 360) * dist;
    return { halfH, halfW: halfH * (persp.aspect || aspect) };
  }
  return { halfW: 20, halfH: 20 / aspect };
}
