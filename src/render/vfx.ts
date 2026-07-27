/**
 * EverTactics ability VFX.
 *
 * Design constraints, in priority order:
 *
 *  1. **Readable at gameplay zoom.** The camera sits ~20 tiles back on a tilted ortho rig.
 *     A gorgeous 8000-particle turbulence sim reads as grey fuzz from there. Every effect
 *     here is built from a small number of *large, high-contrast, silhouetted* elements
 *     with a clear shape — a ring, an arc, a pillar, a spike — and particles are the
 *     garnish, not the effect.
 *  2. **GPU-instanced.** One draw call per blend mode for every particle on screen. The
 *     motion is integrated analytically in the vertex shader (p = p0 + v·t + ½a·t², plus
 *     optional exponential drag and vertical-axis orbit), so the CPU touches an instance
 *     exactly once — at spawn — and never again.
 *  3. **Deterministic.** All randomness comes from a seeded xorshift, so a screenshot of
 *     the same beat of the same ability is byte-identical run to run. That is what makes
 *     the visual critic loop meaningful.
 *  4. **Event-driven.** Abilities play as a timeline (windup → cast → travel → impact →
 *     aftermath). `play()` returns a promise that resolves when the effect is done, so the
 *     battle event stream can await it, and `onImpact` fires on the exact frame the hit
 *     lands so damage numbers and hit-stop are in sync with the visuals.
 */

import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NormalBlending,
  Object3D,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Camera,
  type Scene,
  type Texture,
} from 'three';

import type { Element } from '../core/types';
import type { PostEffectsHost } from './post';

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic RNG (render-side; core has its own contract)
// ─────────────────────────────────────────────────────────────────────────────

class VfxRng {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** Symmetric jitter in [-a, a]. */
  jitter(a: number): number {
    return (this.next() * 2 - 1) * a;
  }
  unitSphere(out: Vector3): Vector3 {
    const z = this.next() * 2 - 1;
    const t = this.next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return out.set(r * Math.cos(t), z, r * Math.sin(t));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Procedural sprite atlas
// ─────────────────────────────────────────────────────────────────────────────

export const ATLAS_GRID = 8;
const ATLAS_CELL = 128;

/** Named cells so effect definitions read as intent, not magic numbers. */
export const SPR = {
  dot: 0,
  spark: 1,
  smoke: 2,
  flame: 3,
  shard: 4,
  ring: 5,
  star4: 6,
  star6: 7,
  streak: 8,
  crescent: 9,
  droplet: 10,
  bolt: 11,
  dust: 12,
  halo: 13,
  runeA: 14,
  runeB: 15,
  runeC: 16,
  runeD: 17,
  petal: 18,
  splinter: 19,
  caustic: 20,
  wisp: 21,
  bubble: 22,
  ember: 23,
} as const;

function valueNoise(rng: VfxRng, size: number): Float32Array {
  const grid = 8;
  const lattice = new Float32Array((grid + 1) * (grid + 1));
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();
  const out = new Float32Array(size * size);
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let amp = 0.5;
      let freq = 1;
      let v = 0;
      for (let o = 0; o < 3; o++) {
        const gx = (x / size) * grid * freq;
        const gy = (y / size) * grid * freq;
        const x0 = Math.floor(gx) % grid;
        const y0 = Math.floor(gy) % grid;
        const fx = smooth(gx - Math.floor(gx));
        const fy = smooth(gy - Math.floor(gy));
        const i00 = lattice[y0 * (grid + 1) + x0] ?? 0;
        const i10 = lattice[y0 * (grid + 1) + x0 + 1] ?? 0;
        const i01 = lattice[(y0 + 1) * (grid + 1) + x0] ?? 0;
        const i11 = lattice[(y0 + 1) * (grid + 1) + x0 + 1] ?? 0;
        const a = i00 + (i10 - i00) * fx;
        const b = i01 + (i11 - i01) * fx;
        v += (a + (b - a) * fy) * amp;
        amp *= 0.5;
        freq *= 2;
      }
      out[y * size + x] = v;
    }
  }
  return out;
}

/**
 * Builds the particle atlas procedurally. This is authored art, not placeholder art:
 * every cell is a deliberate shape with a controlled falloff, and generating it in code
 * means it is resolution-independent and costs zero bytes of download.
 */
function buildAtlas(): HTMLCanvasElement {
  const size = ATLAS_GRID * ATLAS_CELL;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.clearRect(0, 0, size, size);
  const rng = new VfxRng(0x51ed270b);
  const C = ATLAS_CELL;
  const H = C / 2;

  // NOTE: `draw` receives the cell's canvas-space origin because `putImageData` ignores
  // the current transform and clip — pixel-authored cells must place themselves.
  const cell = (index: number, draw: (g: CanvasRenderingContext2D, cx: number, cy: number) => void): void => {
    const cx = (index % ATLAS_GRID) * C;
    const cy = Math.floor(index / ATLAS_GRID) * C;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.rect(0, 0, C, C);
    ctx.clip();
    draw(ctx, cx, cy);
    ctx.restore();
  };

  const radial = (g: CanvasRenderingContext2D, stops: [number, string][], r = H): void => {
    const grad = g.createRadialGradient(H, H, 0, H, H, r);
    for (const [o, c] of stops) grad.addColorStop(o, c);
    g.fillStyle = grad;
    g.fillRect(0, 0, C, C);
  };

  // 0 soft dot — the workhorse. Gaussian-ish falloff, no visible disc edge.
  cell(SPR.dot, (g) =>
    radial(g, [
      [0, 'rgba(255,255,255,1)'],
      [0.25, 'rgba(255,255,255,0.72)'],
      [0.55, 'rgba(255,255,255,0.22)'],
      [1, 'rgba(255,255,255,0)'],
    ]),
  );

  // 1 hard spark — tight core with a faint bloom skirt.
  cell(SPR.spark, (g) =>
    radial(g, [
      [0, 'rgba(255,255,255,1)'],
      [0.1, 'rgba(255,255,255,0.95)'],
      [0.2, 'rgba(255,255,255,0.35)'],
      [0.45, 'rgba(255,255,255,0.08)'],
      [1, 'rgba(255,255,255,0)'],
    ]),
  );

  // 2 smoke puff — noise-modulated blob.
  cell(SPR.smoke, (g, cx, cy) => {
    const noise = valueNoise(rng, C);
    const img = g.createImageData(C, C);
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const dx = (x - H) / H;
        const dy = (y - H) / H;
        const r = Math.sqrt(dx * dx + dy * dy);
        const n = noise[y * C + x] ?? 0.5;
        let a = Math.max(0, 1 - r) ** 1.6;
        a *= 0.45 + n * 1.1;
        a = Math.max(0, Math.min(1, a));
        const i = (y * C + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 255;
        img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, cx, cy);
  });

  // 3 flame wisp — teardrop, hot at the base, torn at the tip.
  cell(SPR.flame, (g, cx, cy) => {
    const noise = valueNoise(rng, C);
    const img = g.createImageData(C, C);
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const u = (x - H) / H;
        const v = y / C; // 0 top, 1 bottom
        const width = 0.32 + 0.62 * Math.pow(v, 0.8);
        let a = Math.max(0, 1 - Math.abs(u) / width);
        a *= Math.pow(v, 0.55) * (1.15 - v * 0.15);
        const n = noise[y * C + x] ?? 0.5;
        a *= 0.55 + n * 0.95;
        a = Math.max(0, Math.min(1, a * 1.25));
        const i = (y * C + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 255;
        img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, cx, cy);
  });

  // 4 crystal shard — hard-edged rhombus with a bright inner facet.
  cell(SPR.shard, (g) => {
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.beginPath();
    g.moveTo(H, 4);
    g.lineTo(H + 26, H + 6);
    g.lineTo(H, C - 4);
    g.lineTo(H - 26, H + 6);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(255,255,255,1)';
    g.beginPath();
    g.moveTo(H, 14);
    g.lineTo(H + 9, H + 4);
    g.lineTo(H, C - 20);
    g.lineTo(H - 9, H + 4);
    g.closePath();
    g.fill();
  });

  // 5 thin ring — expanding shockwave rings.
  cell(SPR.ring, (g) => {
    const grad = g.createRadialGradient(H, H, H * 0.62, H, H, H * 0.98);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.45, 'rgba(255,255,255,1)');
    grad.addColorStop(0.7, 'rgba(255,255,255,0.5)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, C, C);
  });

  const star = (g: CanvasRenderingContext2D, points: number, inner: number, sharp: number): void => {
    g.save();
    g.translate(H, H);
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < points; i++) {
      const a = (i / points) * Math.PI * 2;
      g.save();
      g.rotate(a);
      const grad = g.createLinearGradient(0, 0, 0, -H * 0.98);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(-sharp, 0);
      g.lineTo(0, -H * 0.98);
      g.lineTo(sharp, 0);
      g.closePath();
      g.fill();
      g.restore();
    }
    const core = g.createRadialGradient(0, 0, 0, 0, 0, H * inner);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = core;
    g.beginPath();
    g.arc(0, 0, H * inner, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };

  cell(SPR.star4, (g) => star(g, 4, 0.22, 7));
  cell(SPR.star6, (g) => star(g, 6, 0.18, 5));

  // 8 streak — for velocity-stretched sparks. Bright leading end.
  cell(SPR.streak, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, C);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.42, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.55, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    for (let x = 0; x < C; x++) {
      const falloff = Math.max(0, 1 - Math.abs(x - H) / (H * 0.32));
      g.globalAlpha = Math.pow(falloff, 1.5);
      g.fillRect(x, 0, 1, C);
    }
    g.globalAlpha = 1;
  });

  // 9 crescent — the blade of a slash arc.
  cell(SPR.crescent, (g) => {
    g.save();
    g.globalCompositeOperation = 'source-over';
    const grad = g.createRadialGradient(H, H, H * 0.5, H, H, H * 0.99);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.78, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(H, H, H, -Math.PI * 0.78, Math.PI * 0.02);
    g.lineTo(H, H);
    g.closePath();
    g.fill();
    g.restore();
  });

  // 10 droplet
  cell(SPR.droplet, (g) => {
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.moveTo(H, 10);
    g.quadraticCurveTo(H + 30, H + 6, H, C - 12);
    g.quadraticCurveTo(H - 30, H + 6, H, 10);
    g.fill();
    const grad = g.createRadialGradient(H - 8, H + 12, 0, H - 8, H + 12, 22);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(H - 8, H + 12, 22, 0, Math.PI * 2);
    g.fill();
  });

  // 11 bolt fragment — jagged vertical segment.
  cell(SPR.bolt, (g) => {
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const [w, a] of [
      [13, 0.16],
      [6, 0.4],
      [2.2, 1],
    ] as [number, number][]) {
      g.lineWidth = w;
      g.globalAlpha = a;
      g.beginPath();
      g.moveTo(H, 2);
      let y = 2;
      let x = H;
      const r2 = new VfxRng(0x1337);
      while (y < C - 2) {
        y += C / 5;
        x = H + r2.jitter(H * 0.42);
        g.lineTo(Math.max(6, Math.min(C - 6, x)), Math.min(C - 2, y));
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  });

  // 12 dust — flat, low-contrast, wide.
  cell(SPR.dust, (g, cx, cy) => {
    const noise = valueNoise(rng, C);
    const img = g.createImageData(C, C);
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const dx = (x - H) / H;
        const dy = (y - H) / H;
        const r = Math.sqrt(dx * dx + dy * dy);
        const n = noise[y * C + x] ?? 0.5;
        let a = Math.max(0, 1 - r);
        a = Math.pow(a, 2.1) * (0.5 + n * 0.9);
        const i = (y * C + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 255;
        img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 200);
      }
    }
    g.putImageData(img, cx, cy);
  });

  // 13 halo — very wide, very soft. Glow beds under bright cores.
  cell(SPR.halo, (g) =>
    radial(g, [
      [0, 'rgba(255,255,255,0.6)'],
      [0.35, 'rgba(255,255,255,0.22)'],
      [0.7, 'rgba(255,255,255,0.05)'],
      [1, 'rgba(255,255,255,0)'],
    ]),
  );

  // 14-17 rune glyphs — angular sigils, in the spirit of Ivalice's script.
  const glyph = (g: CanvasRenderingContext2D, seed: number): void => {
    const r = new VfxRng(seed);
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineWidth = 7;
    g.lineCap = 'square';
    g.lineJoin = 'miter';
    const pts: [number, number][] = [];
    const n = 4 + Math.floor(r.next() * 3);
    for (let i = 0; i < n; i++) {
      pts.push([20 + r.next() * (C - 40), 20 + r.next() * (C - 40)]);
    }
    g.beginPath();
    const first = pts[0]!;
    g.moveTo(first[0], first[1]);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i]!;
      // Axis-locked steps read as "written", not "scribbled".
      const prev = pts[i - 1]!;
      if (r.next() < 0.6) g.lineTo(p[0], prev[1]);
      g.lineTo(p[0], p[1]);
    }
    g.stroke();
    g.lineWidth = 4;
    g.beginPath();
    g.arc(C / 2, C / 2, 30 + r.next() * 18, r.next() * 6.28, r.next() * 6.28 + 3.4);
    g.stroke();
  };
  cell(SPR.runeA, (g) => glyph(g, 0xa11ce));
  cell(SPR.runeB, (g) => glyph(g, 0xb0b));
  cell(SPR.runeC, (g) => glyph(g, 0xc0ffee));
  cell(SPR.runeD, (g) => glyph(g, 0xd00d));

  // 18 petal / leaf — wind debris.
  cell(SPR.petal, (g) => {
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.beginPath();
    g.moveTo(12, H);
    g.quadraticCurveTo(H, 18, C - 12, H);
    g.quadraticCurveTo(H, C - 18, 12, H);
    g.fill();
  });

  // 19 splinter — thin shatter triangle.
  cell(SPR.splinter, (g) => {
    g.fillStyle = 'rgba(255,255,255,1)';
    g.beginPath();
    g.moveTo(H, 6);
    g.lineTo(H + 12, C - 8);
    g.lineTo(H - 7, C - 14);
    g.closePath();
    g.fill();
  });

  // 20 caustic — water light blob.
  cell(SPR.caustic, (g, cx, cy) => {
    const noise = valueNoise(rng, C);
    const img = g.createImageData(C, C);
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const dx = (x - H) / H;
        const dy = (y - H) / H;
        const r = Math.sqrt(dx * dx + dy * dy);
        const n = noise[y * C + x] ?? 0.5;
        const band = Math.pow(Math.max(0, 1 - Math.abs(n - 0.5) * 5), 2.0);
        const a = band * Math.pow(Math.max(0, 1 - r), 1.4);
        const i = (y * C + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 255;
        img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
      }
    }
    g.putImageData(img, cx, cy);
  });

  // 21 wisp — elongated soft smear for tendrils and vortex trails.
  cell(SPR.wisp, (g) => {
    for (let y = 0; y < C; y++) {
      const v = y / C;
      const width = H * (0.22 + 0.5 * Math.sin(Math.PI * v));
      const a = Math.pow(Math.sin(Math.PI * v), 1.2);
      const grad = g.createLinearGradient(H - width, 0, H + width, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, `rgba(255,255,255,${a.toFixed(3)})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(H - width, y, width * 2, 1);
    }
  });

  // 22 bubble — rim-lit ring, for water.
  cell(SPR.bubble, (g) => {
    const grad = g.createRadialGradient(H, H, H * 0.55, H, H, H * 0.95);
    grad.addColorStop(0, 'rgba(255,255,255,0.06)');
    grad.addColorStop(0.75, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.92, 'rgba(255,255,255,0.95)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, C, C);
    const hi = g.createRadialGradient(H - 22, H - 24, 0, H - 22, H - 24, 18);
    hi.addColorStop(0, 'rgba(255,255,255,0.9)');
    hi.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = hi;
    g.fillRect(0, 0, C, C);
  });

  // 23 ember — bright dot with a short tail.
  cell(SPR.ember, (g) => {
    const grad = g.createLinearGradient(H, C * 0.9, H, H * 0.6);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(255,255,255,0.55)');
    g.fillStyle = grad;
    g.fillRect(H - 5, H * 0.6, 10, C * 0.3);
    const core = g.createRadialGradient(H, H * 0.6, 0, H, H * 0.6, 16);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = core;
    g.fillRect(0, 0, C, C);
  });

  return canvas;
}

// ─────────────────────────────────────────────────────────────────────────────
// Particle batch
// ─────────────────────────────────────────────────────────────────────────────

const PARTICLE_VERT = /* glsl */ `
precision highp float;

attribute vec3 aOrigin;
attribute vec3 aVel;
attribute vec3 aAcc;
attribute vec4 aLife;    // birth, lifetime, seed, spriteIndex
attribute vec2 aSize;    // start, end
attribute vec4 aColor0;
attribute vec4 aColor1;
attribute vec2 aSpin;    // angle0, rate
attribute vec4 aEnv;     // fadeIn, fadeOut, drag, stretch
attribute vec4 aOrbit;   // centreX, centreZ, omega, radialRate

uniform float uTime;
uniform float uAtlasGrid;

varying vec4 vColor;
varying vec2 vAtlasUv;
varying float vViewDist;

void main() {
  float life = max(aLife.y, 1e-4);
  float t = (uTime - aLife.x) / life;

  if (t < 0.0 || t >= 1.0) {
    // Retired instance: collapse it outside the clip volume. Costs one vertex, no fill.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec4(0.0);
    vAtlasUv = vec2(0.0);
    vViewDist = 0.0;
    return;
  }

  float T = t * life;

  // Analytic integration with optional exponential drag.
  vec3 disp;
  if (aEnv.z > 1e-4) {
    disp = aVel * (1.0 - exp(-aEnv.z * T)) / aEnv.z;
  } else {
    disp = aVel * T;
  }
  vec3 p = aOrigin + disp + 0.5 * aAcc * T * T;

  if (abs(aOrbit.z) > 1e-5) {
    vec2 rel = p.xz - aOrbit.xy;
    float ang = aOrbit.z * T;
    float c = cos(ang), s = sin(ang);
    rel = vec2(rel.x * c - rel.y * s, rel.x * s + rel.y * c);
    rel *= max(0.0, 1.0 + aOrbit.w * T);
    p.xz = aOrbit.xy + rel;
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float size = mix(aSize.x, aSize.y, t);

  vec2 corner;
  if (aEnv.w > 1e-4) {
    // Velocity-stretched billboard: aligns the quad's local +Y with screen-space motion.
    vec3 vv = (modelViewMatrix * vec4(aVel + aAcc * T, 0.0)).xyz;
    vec2 dir = length(vv.xy) > 1e-5 ? normalize(vv.xy) : vec2(0.0, 1.0);
    vec2 perp = vec2(-dir.y, dir.x);
    corner = dir * position.y * size * (1.0 + aEnv.w) + perp * position.x * size;
  } else {
    float ang = aSpin.x + aSpin.y * T;
    float c = cos(ang), s = sin(ang);
    vec2 q = position.xy * size;
    corner = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  }

  mv.xy += corner;
  vViewDist = -mv.z;
  gl_Position = projectionMatrix * mv;

  float idx = aLife.w;
  vec2 cellIndex = vec2(mod(idx, uAtlasGrid), floor(idx / uAtlasGrid));
  vAtlasUv = (cellIndex + uv) / uAtlasGrid;

  float fadeIn = max(aEnv.x, 1e-4);
  float fadeOut = clamp(aEnv.y, 0.0, 0.999);
  float env = smoothstep(0.0, fadeIn, t) * (1.0 - smoothstep(fadeOut, 1.0, t));
  vColor = mix(aColor0, aColor1, t);
  vColor.a *= env;
}
`;

const PARTICLE_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uAtlas;
uniform float uIntensity;

#ifdef SOFT_PARTICLES
uniform sampler2D uSceneDepth;
uniform vec2 uResolution;
uniform mat4 uProjInv;
uniform float uSoftness;
#endif

varying vec4 vColor;
varying vec2 vAtlasUv;
varying float vViewDist;

void main() {
  vec4 tex = texture2D(uAtlas, vAtlasUv);
  float a = tex.a * vColor.a;
  if (a < 0.004) discard;

  vec3 rgb = vColor.rgb * tex.rgb * uIntensity;

#ifdef SOFT_PARTICLES
  vec2 suv = gl_FragCoord.xy / uResolution;
  float d = texture2D(uSceneDepth, suv).x;
  vec4 clip = vec4(suv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 vp = uProjInv * clip;
  float sceneDist = -(vp.z / vp.w);
  a *= clamp((sceneDist - vViewDist) / max(uSoftness, 1e-3), 0.0, 1.0);
#endif

  gl_FragColor = vec4(rgb, a);
}
`;

interface ParticleSpawn {
  position: Vector3;
  velocity: Vector3;
  acceleration: Vector3;
  lifetime: number;
  sizeStart: number;
  sizeEnd: number;
  color0: [number, number, number, number];
  color1: [number, number, number, number];
  sprite: number;
  angle: number;
  spin: number;
  fadeIn: number;
  fadeOut: number;
  drag: number;
  stretch: number;
  orbit: [number, number, number, number];
}

class ParticleBatch {
  readonly mesh: Mesh;
  private readonly geometry: InstancedBufferGeometry;
  private readonly attrs: Record<string, InstancedBufferAttribute> = {};
  private readonly capacity: number;
  private cursor = 0;
  private dirtyMin = Infinity;
  private dirtyMax = -Infinity;
  readonly material: ShaderMaterial;

  constructor(capacity: number, atlas: Texture, additive: boolean, renderOrder: number) {
    this.capacity = capacity;

    const base = new PlaneGeometry(1, 1);
    const geometry = new InstancedBufferGeometry();
    geometry.index = base.index;
    geometry.setAttribute('position', base.getAttribute('position'));
    geometry.setAttribute('uv', base.getAttribute('uv'));
    geometry.instanceCount = capacity;
    // Particles are placed in world space by the vertex shader; the bounding sphere would
    // have to cover the whole battlefield anyway, so culling is simply off.
    geometry.boundingSphere = null;

    const add = (name: string, itemSize: number, fill = 0): void => {
      const array = new Float32Array(capacity * itemSize);
      if (fill !== 0) array.fill(fill);
      const attr = new InstancedBufferAttribute(array, itemSize);
      attr.setUsage(DynamicDrawUsage);
      geometry.setAttribute(name, attr);
      this.attrs[name] = attr;
    };

    add('aOrigin', 3);
    add('aVel', 3);
    add('aAcc', 3);
    add('aLife', 4, -1); // birth -1 => permanently retired until written
    add('aSize', 2);
    add('aColor0', 4);
    add('aColor1', 4);
    add('aSpin', 2);
    add('aEnv', 4);
    add('aOrbit', 4);

    // Retire every slot: lifetime 0 means t is +Inf, which the vertex shader culls.
    const life = this.attrs['aLife']!;
    for (let i = 0; i < capacity; i++) {
      life.array[i * 4 + 0] = -1e9;
      life.array[i * 4 + 1] = 1e-4;
      life.array[i * 4 + 2] = 0;
      life.array[i * 4 + 3] = 0;
    }
    life.needsUpdate = true;

    this.geometry = geometry;

    this.material = new ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAtlas: { value: atlas },
        uAtlasGrid: { value: ATLAS_GRID },
        uIntensity: { value: 1 },
        uSceneDepth: { value: null },
        uResolution: { value: new Vector2(1, 1) },
        uProjInv: { value: new Matrix4() },
        uSoftness: { value: 0.6 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
      side: DoubleSide,
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
  }

  spawn(s: ParticleSpawn, now: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;

    const set = (name: string, ...values: number[]): void => {
      const attr = this.attrs[name]!;
      const off = i * attr.itemSize;
      for (let k = 0; k < values.length; k++) attr.array[off + k] = values[k]!;
    };

    set('aOrigin', s.position.x, s.position.y, s.position.z);
    set('aVel', s.velocity.x, s.velocity.y, s.velocity.z);
    set('aAcc', s.acceleration.x, s.acceleration.y, s.acceleration.z);
    set('aLife', now, Math.max(s.lifetime, 1e-3), 0, s.sprite);
    set('aSize', s.sizeStart, s.sizeEnd);
    set('aColor0', s.color0[0], s.color0[1], s.color0[2], s.color0[3]);
    set('aColor1', s.color1[0], s.color1[1], s.color1[2], s.color1[3]);
    set('aSpin', s.angle, s.spin);
    set('aEnv', s.fadeIn, s.fadeOut, s.drag, s.stretch);
    set('aOrbit', s.orbit[0], s.orbit[1], s.orbit[2], s.orbit[3]);

    this.dirtyMin = Math.min(this.dirtyMin, i);
    this.dirtyMax = Math.max(this.dirtyMax, i);
  }

  flush(time: number): void {
    this.material.uniforms['uTime']!.value = time;
    if (this.dirtyMax < this.dirtyMin) return;
    const start = this.dirtyMin;
    const count = this.dirtyMax - this.dirtyMin + 1;
    for (const attr of Object.values(this.attrs)) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(start * attr.itemSize, count * attr.itemSize);
      attr.needsUpdate = true;
    }
    this.dirtyMin = Infinity;
    this.dirtyMax = -Infinity;
  }

  setSoftParticles(depth: Texture | null, resolution: Vector2, projInv: Matrix4, softness: number): void {
    const defines = this.material.defines as Record<string, unknown>;
    const want = depth !== null;
    const have = defines['SOFT_PARTICLES'] === '';
    if (want !== have) {
      if (want) defines['SOFT_PARTICLES'] = '';
      else delete defines['SOFT_PARTICLES'];
      this.material.needsUpdate = true;
    }
    this.material.uniforms['uSceneDepth']!.value = depth;
    (this.material.uniforms['uResolution']!.value as Vector2).copy(resolution);
    (this.material.uniforms['uProjInv']!.value as Matrix4).copy(projInv);
    this.material.uniforms['uSoftness']!.value = softness;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ribbons — lightning, slash arcs, tendrils
// ─────────────────────────────────────────────────────────────────────────────

const RIBBON_VERT = /* glsl */ `
precision highp float;
attribute float aSide;
attribute float aAlong;
varying float vSide;
varying float vAlong;
void main() {
  vSide = aSide;
  vAlong = aAlong;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RIBBON_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uCoreColor;
uniform vec3 uEdgeColor;
uniform float uOpacity;
uniform float uHead;     // 0..1 sweep position; geometry beyond this is hidden
uniform float uTail;
uniform float uCoreWidth;
varying float vSide;
varying float vAlong;

void main() {
  float reveal = smoothstep(uTail - 0.12, uTail + 0.02, vAlong) * (1.0 - smoothstep(uHead - 0.02, uHead + 0.12, vAlong));
  if (reveal <= 0.001) discard;

  float d = abs(vSide);
  float core = 1.0 - smoothstep(0.0, uCoreWidth, d);
  float glow = pow(1.0 - smoothstep(0.0, 1.0, d), 2.2);

  vec3 color = mix(uEdgeColor, uCoreColor, core);
  float a = clamp(core + glow * 0.85, 0.0, 1.0) * uOpacity * reveal;
  gl_FragColor = vec4(color * (0.4 + core * 1.6), a);
}
`;

const MAX_RIBBON_POINTS = 64;

class Ribbon {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly positions: Float32Array;
  private readonly geometry: BufferGeometry;
  private pointCount = 0;
  active = false;

  constructor() {
    const geometry = new BufferGeometry();
    this.positions = new Float32Array(MAX_RIBBON_POINTS * 2 * 3);
    const side = new Float32Array(MAX_RIBBON_POINTS * 2);
    const along = new Float32Array(MAX_RIBBON_POINTS * 2);
    const index: number[] = [];
    for (let i = 0; i < MAX_RIBBON_POINTS; i++) {
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
      if (i < MAX_RIBBON_POINTS - 1) {
        const a = i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const posAttr = new BufferAttribute(this.positions, 3);
    posAttr.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('aSide', new BufferAttribute(side, 1));
    const alongAttr = new BufferAttribute(along, 1);
    alongAttr.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aAlong', alongAttr);
    geometry.setIndex(index);
    geometry.setDrawRange(0, 0);
    geometry.boundingSphere = null;
    this.geometry = geometry;

    this.material = new ShaderMaterial({
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      uniforms: {
        uCoreColor: { value: new Color(1, 1, 1) },
        uEdgeColor: { value: new Color(0.4, 0.6, 1) },
        uOpacity: { value: 1 },
        uHead: { value: 1 },
        uTail: { value: 0 },
        uCoreWidth: { value: 0.35 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 12;
  }

  /** Rebuild the strip from a polyline, widened perpendicular to the view direction. */
  setPath(points: Vector3[], width: number, cameraDir: Vector3): void {
    const n = Math.min(points.length, MAX_RIBBON_POINTS);
    this.pointCount = n;
    if (n < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }
    const along = this.geometry.getAttribute('aAlong') as BufferAttribute;
    const tangent = new Vector3();
    const side = new Vector3();

    for (let i = 0; i < n; i++) {
      const p = points[i]!;
      const prev = points[Math.max(0, i - 1)]!;
      const next = points[Math.min(n - 1, i + 1)]!;
      tangent.subVectors(next, prev);
      if (tangent.lengthSq() < 1e-9) tangent.set(0, 1, 0);
      side.crossVectors(tangent, cameraDir);
      if (side.lengthSq() < 1e-9) side.set(1, 0, 0);
      side.normalize().multiplyScalar(width * 0.5);

      const o = i * 6;
      this.positions[o + 0] = p.x - side.x;
      this.positions[o + 1] = p.y - side.y;
      this.positions[o + 2] = p.z - side.z;
      this.positions[o + 3] = p.x + side.x;
      this.positions[o + 4] = p.y + side.y;
      this.positions[o + 5] = p.z + side.z;

      const t = i / (n - 1);
      along.array[i * 2] = t;
      along.array[i * 2 + 1] = t;
    }

    (this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    along.needsUpdate = true;
    this.geometry.setDrawRange(0, (n - 1) * 6);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Magic circles (ground decals)
// ─────────────────────────────────────────────────────────────────────────────

const CIRCLE_VERT = /* glsl */ `
precision highp float;
varying vec2 vLocal;
void main() {
  vLocal = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CIRCLE_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform vec3 uAccent;
uniform float uTime;
uniform float uOpacity;
uniform float uGrow;      // 0..1 radial reveal
uniform float uRings;
uniform float uSpokes;
uniform float uRuneCount;
uniform float uSpin;

varying vec2 vLocal;

float ringBand(float r, float centre, float width) {
  return 1.0 - smoothstep(0.0, width, abs(r - centre));
}

/** Angular tick marks: the thing that makes a circle read as a *sigil*, not a hoop. */
float ticks(float ang, float count, float duty) {
  float f = fract(ang / 6.2831853 * count);
  return step(f, duty) * step(1.0 - duty, 1.0 - f + duty);
}

void main() {
  float r = length(vLocal);
  if (r > 1.0) discard;

  float ang = atan(vLocal.y, vLocal.x) + uTime * uSpin;

  float reveal = smoothstep(uGrow, uGrow - 0.35, r);
  if (reveal <= 0.001) discard;

  float pattern = 0.0;
  pattern += ringBand(r, 0.98, 0.02) * 1.0;
  pattern += ringBand(r, 0.90, 0.012) * 0.7;
  pattern += ringBand(r, 0.62, 0.016) * 0.85;
  pattern += ringBand(r, 0.58, 0.008) * 0.5;
  pattern += ringBand(r, 0.30, 0.02) * 0.6;

  // Rune band between the two inner rings.
  float runeBand = step(0.62, r) * step(r, 0.90);
  float runeTicks = ticks(ang, uRuneCount, 0.34);
  float runeRadial = ringBand(r, 0.76, 0.09);
  pattern += runeBand * runeTicks * runeRadial * 0.9;

  // Spokes from the inner ring outward.
  float spokes = ticks(ang * 1.0, uSpokes, 0.02) * step(0.30, r) * step(r, 0.62);
  pattern += spokes * 0.8;

  // Inner star polygon.
  float star = ringBand(abs(cos(ang * uRings * 0.5)) * 0.30, r, 0.02) * step(r, 0.32);
  pattern += star * 0.7;

  float glow = pow(1.0 - r, 2.5) * 0.35;
  float a = clamp(pattern, 0.0, 1.4);

  vec3 color = mix(uColor, uAccent, clamp(pattern - 0.6, 0.0, 1.0));
  float alpha = (a + glow) * uOpacity * reveal;
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(color * (0.6 + a), alpha);
}
`;

export interface MagicCircleOptions {
  radius?: number;
  color?: Color;
  accent?: Color;
  spin?: number;
  runes?: number;
  spokes?: number;
  segments?: number;
}

/**
 * A ground sigil. Built as a tessellated disc rather than a screen-space decal so it can
 * be conformed to stepped terrain via the `groundHeight` sampler without needing to read
 * the depth buffer we are currently rendering into.
 */
class MagicCircle {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly geometry: PlaneGeometry;
  private readonly segments: number;
  active = false;

  constructor(segments = 24) {
    this.segments = segments;
    this.geometry = new PlaneGeometry(1, 1, segments, segments);
    this.geometry.rotateX(-Math.PI / 2);

    this.material = new ShaderMaterial({
      vertexShader: CIRCLE_VERT,
      fragmentShader: CIRCLE_FRAG,
      uniforms: {
        uColor: { value: new Color(0.45, 0.7, 1.0) },
        uAccent: { value: new Color(1.0, 0.95, 0.8) },
        uTime: { value: 0 },
        uOpacity: { value: 1 },
        uGrow: { value: 1 },
        uRings: { value: 6 },
        uSpokes: { value: 12 },
        uRuneCount: { value: 16 },
        uSpin: { value: 0.35 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 8;
  }

  place(centre: Vector3, radius: number, groundHeight?: (x: number, z: number) => number): void {
    this.mesh.position.copy(centre);
    this.mesh.scale.set(radius * 2, 1, radius * 2);

    const pos = this.geometry.getAttribute('position') as BufferAttribute;
    if (groundHeight) {
      const n = this.segments + 1;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const k = j * n + i;
          const lx = pos.getX(k) * radius * 2;
          const lz = pos.getZ(k) * radius * 2;
          const h = groundHeight(centre.x + lx, centre.z + lz);
          pos.setY(k, (h - centre.y) / 1.0);
        }
      }
      pos.needsUpdate = true;
    } else {
      let changed = false;
      for (let k = 0; k < pos.count; k++) {
        if (pos.getY(k) !== 0) {
          pos.setY(k, 0);
          changed = true;
        }
      }
      if (changed) pos.needsUpdate = true;
    }
    this.mesh.updateMatrixWorld();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Column effects (holy pillar, dark column, water surge)
// ─────────────────────────────────────────────────────────────────────────────

const PILLAR_VERT = /* glsl */ `
precision highp float;
varying vec2 vUvP;
varying vec3 vViewNormal;
varying vec3 vViewPos;
void main() {
  vUvP = uv;
  vViewNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const PILLAR_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColorCore;
uniform vec3 uColorEdge;
uniform float uTime;
uniform float uOpacity;
uniform float uRise;
uniform float uScroll;
uniform float uRayCount;
uniform float uNoiseAmount;

varying vec2 vUvP;
varying vec3 vViewNormal;
varying vec3 vViewPos;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float bands(float x, float count, float t) {
  float f = fract(x * count + t);
  return pow(abs(sin(f * 3.14159)), 3.0);
}

void main() {
  // Rim-lit hollow cylinder: brightest where the surface is edge-on to the camera, which
  // is what makes a transparent column read as volume rather than as a decal tube.
  vec3 V = normalize(-vViewPos);
  float facing = abs(dot(normalize(vViewNormal), V));
  float rim = pow(1.0 - facing, 1.6);

  // Vertical reveal: the pillar grows from the ground up.
  float rise = smoothstep(uRise - 0.35, uRise, 1.0 - vUvP.y);
  float taper = smoothstep(1.0, 0.55, vUvP.y);

  // God rays: angular bands scrolling around the column.
  float rays = bands(vUvP.x, uRayCount, uTime * uScroll);
  float rays2 = bands(vUvP.x, uRayCount * 0.37, -uTime * uScroll * 0.6);

  float n = mix(1.0, hash(floor(vec2(vUvP.x * 64.0, vUvP.y * 24.0 - uTime * 3.0))), uNoiseAmount);

  float a = (rim * 0.75 + 0.18) * (0.45 + rays * 0.8 + rays2 * 0.45) * rise * taper * n;
  vec3 color = mix(uColorEdge, uColorCore, clamp(rim + rays * 0.5, 0.0, 1.0));

  a *= uOpacity;
  if (a <= 0.003) discard;
  gl_FragColor = vec4(color * (0.7 + rays), a);
}
`;

class Pillar {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly geometry: CylinderGeometry;
  active = false;

  constructor() {
    this.geometry = new CylinderGeometry(1, 1, 1, 28, 8, true);
    this.geometry.translate(0, 0.5, 0);
    this.material = new ShaderMaterial({
      vertexShader: PILLAR_VERT,
      fragmentShader: PILLAR_FRAG,
      uniforms: {
        uColorCore: { value: new Color(1, 0.98, 0.86) },
        uColorEdge: { value: new Color(1, 0.85, 0.5) },
        uTime: { value: 0 },
        uOpacity: { value: 1 },
        uRise: { value: 1 },
        uScroll: { value: 0.4 },
        uRayCount: { value: 9 },
        uNoiseAmount: { value: 0.25 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 10;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Solid geometry effects (earth spikes, ice shards)
// ─────────────────────────────────────────────────────────────────────────────

interface RisingInstance {
  base: Vector3;
  height: number;
  scale: number;
  rotation: number;
  tilt: number;
  delay: number;
  rise: number;
  hold: number;
  fall: number;
}

class RisingShapes {
  readonly mesh: InstancedMesh;
  private readonly instances: RisingInstance[] = [];
  private readonly matrix = new Matrix4();
  private readonly quat = new Quaternion();
  private readonly pos = new Vector3();
  private readonly scl = new Vector3();
  private readonly axis = new Vector3();
  private elapsed = 0;
  active = false;

  constructor(geometry: BufferGeometry, material: MeshStandardMaterial, capacity: number) {
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  begin(instances: RisingInstance[]): void {
    this.instances.length = 0;
    for (const i of instances) this.instances.push(i);
    this.mesh.count = Math.min(instances.length, this.mesh.instanceMatrix.count);
    this.elapsed = 0;
    this.active = true;
    this.mesh.visible = true;
    this.update(0);
  }

  /** @returns true while still animating. */
  update(dt: number): boolean {
    if (!this.active) return false;
    this.elapsed += dt;
    let anyAlive = false;

    for (let i = 0; i < this.mesh.count; i++) {
      const inst = this.instances[i]!;
      const t = this.elapsed - inst.delay;
      let progress = 0;
      if (t <= 0) {
        progress = 0;
      } else if (t < inst.rise) {
        // Overshoot then settle: a spike that punches out of the ground.
        const x = t / inst.rise;
        progress = 1 - Math.pow(1 - x, 3);
        progress *= 1 + 0.14 * Math.sin(x * Math.PI * 2) * (1 - x);
        anyAlive = true;
      } else if (t < inst.rise + inst.hold) {
        progress = 1;
        anyAlive = true;
      } else if (t < inst.rise + inst.hold + inst.fall) {
        const x = (t - inst.rise - inst.hold) / inst.fall;
        progress = 1 - x * x;
        anyAlive = true;
      } else {
        progress = 0;
      }

      const h = inst.height * progress;
      this.pos.set(inst.base.x, inst.base.y + h * 0.5 - inst.height * 0.5 * (1 - progress), inst.base.z);
      this.axis.set(Math.sin(inst.tilt), 0, Math.cos(inst.tilt));
      this.quat.setFromAxisAngle(this.axis, inst.tilt * 0.35);
      this.scl.set(inst.scale * (0.7 + 0.3 * progress), Math.max(h, 1e-4), inst.scale * (0.7 + 0.3 * progress));
      this.matrix.compose(this.pos, this.quat, this.scl);
      this.mesh.setMatrixAt(i, this.matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (!anyAlive) {
      this.active = false;
      this.mesh.visible = false;
      this.mesh.count = 0;
    }
    return anyAlive;
  }

  dispose(): void {
    this.mesh.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Camera shake + time control
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trauma-based shake (Squirrel Eiserloh's model): callers add *trauma*, the rig reads
 * `offset`/`roll` which are driven by trauma², so small hits barely register and heavy
 * ones snap the frame. Camera.ts should apply `offset` in camera-local space.
 */
export class ShakeRig {
  /** Camera-local offset in world units. */
  readonly offset = new Vector3();
  /** Camera roll in radians. */
  roll = 0;

  private trauma = 0;
  private t = 0;
  private readonly rng = new VfxRng(0x2545f491);
  private readonly seeds: number[] = [];

  maxOffset = 0.55;
  maxRoll = 0.045;
  frequency = 22;
  decay = 1.7;

  constructor() {
    for (let i = 0; i < 3; i++) this.seeds.push(this.rng.next() * 1000);
  }

  add(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  get intensity(): number {
    return this.trauma;
  }

  update(dt: number): void {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - this.decay * dt);
    const s = this.trauma * this.trauma;
    if (s <= 0) {
      this.offset.set(0, 0, 0);
      this.roll = 0;
      return;
    }
    const n = (seed: number, freq: number): number => {
      // Smooth pseudo-noise from summed sines — deterministic and cheap.
      const x = this.t * freq + seed;
      return Math.sin(x) * 0.6 + Math.sin(x * 1.7 + 1.3) * 0.3 + Math.sin(x * 3.1 + 2.7) * 0.1;
    };
    this.offset.set(
      n(this.seeds[0]!, this.frequency) * this.maxOffset * s,
      n(this.seeds[1]!, this.frequency * 1.13) * this.maxOffset * s * 0.7,
      0,
    );
    this.roll = n(this.seeds[2]!, this.frequency * 0.83) * this.maxRoll * s;
  }
}

/** Hit-stop / freeze-frame. Owns the global animation time scale. */
export class TimeControl {
  private stops: { remaining: number; scale: number }[] = [];
  /** Baseline scale — set to 0 to pause, 0.25 for slow-motion cutscenes. */
  base = 1;

  get scale(): number {
    let s = this.base;
    for (const stop of this.stops) s = Math.min(s, stop.scale);
    return s;
  }

  /** Freeze (or heavily slow) the frame for `seconds`. The classic heavy-hit punctuation. */
  stop(seconds: number, scale = 0.02): void {
    this.stops.push({ remaining: seconds, scale });
  }

  /** Advance using *unscaled* wall-clock dt; returns the scaled dt for everything else. */
  update(rawDt: number): number {
    const s = this.scale;
    for (let i = this.stops.length - 1; i >= 0; i--) {
      const stop = this.stops[i]!;
      stop.remaining -= rawDt;
      if (stop.remaining <= 0) this.stops.splice(i, 1);
    }
    return rawDt * s;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline
// ─────────────────────────────────────────────────────────────────────────────

export type VfxPhase = 'windup' | 'cast' | 'travel' | 'impact' | 'aftermath';

interface TimelineCue {
  at: number;
  fired: boolean;
  fn: (ctx: TimelineContext) => void;
}

interface TimelineSpan {
  from: number;
  to: number;
  fn: (t: number, ctx: TimelineContext) => void;
  finished: boolean;
}

export interface TimelineContext {
  time: number;
  dt: number;
}

/**
 * A tiny keyframe sequencer. Cues fire once at a time; spans get called every frame with a
 * normalised 0..1 parameter. `promise` resolves when the timeline ends, which is what the
 * battle event pump awaits before advancing to the next event.
 */
export class VfxTimeline {
  readonly promise: Promise<void>;
  private resolve!: () => void;
  private readonly cues: TimelineCue[] = [];
  private readonly spans: TimelineSpan[] = [];
  private time = 0;
  private duration = 0;
  private done = false;
  private cancelled = false;

  constructor() {
    this.promise = new Promise<void>((res) => {
      this.resolve = res;
    });
  }

  at(time: number, fn: (ctx: TimelineContext) => void): this {
    this.cues.push({ at: time, fired: false, fn });
    this.duration = Math.max(this.duration, time);
    return this;
  }

  span(from: number, to: number, fn: (t: number, ctx: TimelineContext) => void): this {
    this.spans.push({ from, to, fn, finished: false });
    this.duration = Math.max(this.duration, to);
    return this;
  }

  /** Extend the timeline without adding behaviour (tail time before resolving). */
  hold(until: number): this {
    this.duration = Math.max(this.duration, until);
    return this;
  }

  get length(): number {
    return this.duration;
  }

  cancel(): void {
    if (this.done) return;
    this.cancelled = true;
    this.done = true;
    this.resolve();
  }

  get finished(): boolean {
    return this.done;
  }

  update(dt: number): boolean {
    if (this.done) return false;
    this.time += dt;
    const ctx: TimelineContext = { time: this.time, dt };

    for (const cue of this.cues) {
      if (!cue.fired && this.time >= cue.at) {
        cue.fired = true;
        cue.fn(ctx);
      }
    }
    for (const span of this.spans) {
      if (span.finished) continue;
      if (this.time < span.from) continue;
      const denom = Math.max(span.to - span.from, 1e-4);
      const t = Math.min(1, (this.time - span.from) / denom);
      span.fn(t, ctx);
      if (t >= 1) span.finished = true;
    }

    if (this.time >= this.duration && !this.cancelled) {
      this.done = true;
      this.resolve();
      return false;
    }
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Emission spec
// ─────────────────────────────────────────────────────────────────────────────

export type EmitShape = 'point' | 'sphere' | 'disc' | 'ring' | 'cone' | 'line' | 'column';

export interface BurstSpec {
  count: number;
  position: Vector3;
  /** For 'line' bursts, the far end. */
  positionTo?: Vector3;
  shape?: EmitShape;
  /** Emission volume radius. */
  radius?: number;
  /** Vertical extent for 'column'. */
  height?: number;
  direction?: Vector3;
  /** Cone half-angle in radians. */
  spread?: number;
  speed?: [number, number];
  gravity?: number;
  drag?: number;
  size?: [number, number];
  sizeJitter?: number;
  life?: [number, number];
  color0: [number, number, number, number];
  color1: [number, number, number, number];
  /** Random hue-ish jitter applied to color0/color1 rgb, 0..1. */
  colorJitter?: number;
  sprite: number | number[];
  additive?: boolean;
  spin?: [number, number];
  stretch?: number;
  fadeIn?: number;
  fadeOut?: number;
  /** Rotational motion about the vertical axis through `position`. */
  orbit?: { omega: number; radial?: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Effect palette
// ─────────────────────────────────────────────────────────────────────────────

type RGBA = [number, number, number, number];

/**
 * Element palettes. Colours are in linear HDR: the core of a fire burst is well above 1.0
 * so it drives bloom on its own, exactly like a real emitter would, instead of needing the
 * bloom threshold to be lowered until everything glows.
 */
const ELEMENT_COLORS: Record<Element, { core: RGBA; mid: RGBA; fade: RGBA }> = {
  none: { core: [2.4, 2.3, 2.2, 1], mid: [1.1, 1.05, 1.0, 0.9], fade: [0.35, 0.34, 0.33, 0] },
  fire: { core: [5.5, 2.4, 0.6, 1], mid: [2.6, 0.7, 0.12, 0.9], fade: [0.35, 0.08, 0.02, 0] },
  ice: { core: [1.6, 3.4, 5.0, 1], mid: [0.7, 1.6, 2.6, 0.9], fade: [0.16, 0.34, 0.55, 0] },
  lightning: { core: [3.4, 3.8, 6.5, 1], mid: [1.5, 1.7, 3.4, 0.9], fade: [0.3, 0.32, 0.7, 0] },
  wind: { core: [1.9, 2.9, 2.2, 1], mid: [0.9, 1.5, 1.1, 0.75], fade: [0.24, 0.4, 0.3, 0] },
  earth: { core: [2.2, 1.5, 0.8, 1], mid: [0.9, 0.62, 0.32, 0.9], fade: [0.28, 0.2, 0.12, 0] },
  water: { core: [1.2, 2.4, 3.6, 1], mid: [0.5, 1.2, 2.0, 0.9], fade: [0.14, 0.3, 0.48, 0] },
  holy: { core: [6.0, 5.4, 3.4, 1], mid: [2.6, 2.3, 1.4, 0.9], fade: [0.5, 0.45, 0.28, 0] },
  dark: { core: [1.5, 0.5, 2.2, 1], mid: [0.62, 0.18, 0.95, 0.85], fade: [0.14, 0.04, 0.24, 0] },
};

// ─────────────────────────────────────────────────────────────────────────────
// VfxSystem
// ─────────────────────────────────────────────────────────────────────────────

export interface VfxSystemOptions {
  /** World units per tile. Every effect scales off this so maps can use any tile size. */
  tileSize?: number;
  /** Max simultaneous particles per blend batch. */
  capacity?: number;
  /** Optional terrain height sampler so magic circles conform to stepped ground. */
  groundHeight?: (x: number, z: number) => number;
  /** Layer to put VFX objects on, if the renderer wants to isolate them. */
  layer?: number;
  seed?: number;
}

export interface VfxPlayOptions {
  origin: Vector3;
  target: Vector3;
  /** Additional impact points for area abilities. */
  targets?: readonly Vector3[];
  element?: Element;
  /** 0..1 severity. Scales shake, hit-stop and particle counts. */
  power?: number;
  /** Fires on the exact frame the hit lands. Hook damage numbers here. */
  onImpact?: (index: number, position: Vector3) => void;
  /** Extra windup seconds inserted before the cast (used for CT charge abilities). */
  windup?: number;
}

/** Handle returned while a unit is charging an ability across CT ticks. */
export interface ChargeHandle {
  release(): void;
  cancel(): void;
}

type EffectBuilder = (sys: VfxSystem, tl: VfxTimeline, o: Required<Pick<VfxPlayOptions, 'origin' | 'target'>> & VfxPlayOptions) => void;

export class VfxSystem {
  readonly group = new Group();
  readonly shake = new ShakeRig();
  readonly time = new TimeControl();

  private readonly additive: ParticleBatch;
  private readonly alpha: ParticleBatch;
  private readonly atlas: CanvasTexture;
  private readonly ribbons: Ribbon[] = [];
  private readonly circles: MagicCircle[] = [];
  private readonly pillars: Pillar[] = [];
  private readonly spikes: RisingShapes;
  private readonly shards: RisingShapes;
  private readonly timelines: VfxTimeline[] = [];

  private readonly rng: VfxRng;
  private readonly tileSize: number;
  private readonly groundHeight: ((x: number, z: number) => number) | undefined;

  private post: PostEffectsHost | null = null;
  private clock = 0;
  private readonly resolution = new Vector2(1, 1);
  private readonly projInv = new Matrix4();
  private cameraDir = new Vector3(0, 0, 1);
  private softDepth: Texture | null = null;

  // Scratch — VFX runs every frame, so it allocates nothing per frame.
  private readonly v0 = new Vector3();
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private readonly spawnScratch: ParticleSpawn = {
    position: new Vector3(),
    velocity: new Vector3(),
    acceleration: new Vector3(),
    lifetime: 1,
    sizeStart: 1,
    sizeEnd: 1,
    color0: [1, 1, 1, 1],
    color1: [1, 1, 1, 0],
    sprite: 0,
    angle: 0,
    spin: 0,
    fadeIn: 0.08,
    fadeOut: 0.6,
    drag: 0,
    stretch: 0,
    orbit: [0, 0, 0, 0],
  };

  constructor(opts: VfxSystemOptions = {}) {
    this.tileSize = opts.tileSize ?? 1;
    this.groundHeight = opts.groundHeight;
    this.rng = new VfxRng(opts.seed ?? 0x5eed1234);

    this.atlas = new CanvasTexture(buildAtlas());
    this.atlas.flipY = false;
    this.atlas.minFilter = LinearFilter;
    this.atlas.magFilter = LinearFilter;
    this.atlas.wrapS = ClampToEdgeWrapping;
    this.atlas.wrapT = ClampToEdgeWrapping;
    this.atlas.generateMipmaps = false;
    this.atlas.needsUpdate = true;

    const capacity = opts.capacity ?? 3072;
    this.additive = new ParticleBatch(capacity, this.atlas, true, 14);
    this.alpha = new ParticleBatch(Math.floor(capacity / 2), this.atlas, false, 13);
    this.group.add(this.additive.mesh, this.alpha.mesh);

    for (let i = 0; i < 6; i++) {
      const r = new Ribbon();
      this.ribbons.push(r);
      this.group.add(r.mesh);
    }
    for (let i = 0; i < 4; i++) {
      const c = new MagicCircle();
      this.circles.push(c);
      this.group.add(c.mesh);
    }
    for (let i = 0; i < 3; i++) {
      const p = new Pillar();
      this.pillars.push(p);
      this.group.add(p.mesh);
    }

    const spikeGeo = new ConeGeometry(0.5, 1, 5, 1);
    spikeGeo.translate(0, 0.5, 0);
    this.spikes = new RisingShapes(
      spikeGeo,
      new MeshStandardMaterial({ color: 0x6b5334, roughness: 0.92, metalness: 0.02, flatShading: true }),
      24,
    );
    const shardGeo = new OctahedronGeometry(0.5, 0);
    shardGeo.scale(0.55, 1.0, 0.55);
    shardGeo.translate(0, 0.5, 0);
    this.shards = new RisingShapes(
      shardGeo,
      new MeshStandardMaterial({
        color: 0x9fd8ff,
        roughness: 0.12,
        metalness: 0.0,
        emissive: 0x2a5b86,
        emissiveIntensity: 0.8,
        transparent: true,
        opacity: 0.85,
        flatShading: true,
      }),
      24,
    );
    this.group.add(this.spikes.mesh, this.shards.mesh);

    if (opts.layer !== undefined) {
      this.group.traverse((o: Object3D) => o.layers.set(opts.layer!));
    }

    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
  }

  /** Wire the post stack so impacts can request screen distortion. */
  attachPost(post: PostEffectsHost): void {
    this.post = post;
  }

  /**
   * Enable soft particles. Requires a depth texture that is *not* the one currently being
   * rendered into (a depth prepass), otherwise WebGL hits a feedback loop. Off by default.
   */
  setSceneDepth(depth: Texture | null, width: number, height: number): void {
    this.softDepth = depth;
    this.resolution.set(Math.max(1, width), Math.max(1, height));
  }

  addTo(scene: Scene): void {
    scene.add(this.group);
  }

  // ── Per-frame ───────────────────────────────────────────────────────────

  /**
   * @param rawDt unscaled wall-clock delta.
   * @returns the *scaled* delta (after hit-stop), which the caller should use for
   *          everything else it animates so the whole frame freezes together.
   */
  update(rawDt: number, camera: Camera): number {
    const dt = this.time.update(rawDt);
    this.clock += dt;
    this.shake.update(rawDt); // shake keeps moving during hit-stop; that is the point

    camera.getWorldDirection(this.cameraDir);
    this.projInv.copy(camera.projectionMatrix).invert();

    for (let i = this.timelines.length - 1; i >= 0; i--) {
      const tl = this.timelines[i]!;
      if (!tl.update(dt)) this.timelines.splice(i, 1);
    }

    for (const c of this.circles) c.material.uniforms['uTime']!.value = this.clock;
    for (const p of this.pillars) p.material.uniforms['uTime']!.value = this.clock;
    this.spikes.update(dt);
    this.shards.update(dt);

    this.additive.setSoftParticles(this.softDepth, this.resolution, this.projInv, 0.6 * this.tileSize);
    this.alpha.setSoftParticles(this.softDepth, this.resolution, this.projInv, 0.6 * this.tileSize);
    this.additive.flush(this.clock);
    this.alpha.flush(this.clock);

    return dt;
  }

  // ── Emission ────────────────────────────────────────────────────────────

  /** Spawn a burst. This is the primitive every effect definition is written in. */
  emit(spec: BurstSpec): void {
    const rng = this.rng;
    const batch = spec.additive === false ? this.alpha : this.additive;
    const shape = spec.shape ?? 'point';
    const radius = (spec.radius ?? 0) * this.tileSize;
    const height = (spec.height ?? 0) * this.tileSize;
    const speed = spec.speed ?? [0, 0];
    const life = spec.life ?? [0.5, 0.9];
    const size = spec.size ?? [0.3, 0.1];
    const sizeJitter = spec.sizeJitter ?? 0.25;
    const spread = spec.spread ?? Math.PI;
    const dir = spec.direction ? this.v2.copy(spec.direction).normalize() : this.v2.set(0, 1, 0);
    const gravity = (spec.gravity ?? 0) * this.tileSize;
    const jitterC = spec.colorJitter ?? 0.06;
    const s = this.spawnScratch;

    for (let i = 0; i < spec.count; i++) {
      // ── position ──
      s.position.copy(spec.position);
      switch (shape) {
        case 'sphere': {
          rng.unitSphere(this.v0).multiplyScalar(radius * Math.cbrt(rng.next()));
          s.position.add(this.v0);
          break;
        }
        case 'disc': {
          const a = rng.next() * Math.PI * 2;
          const r = radius * Math.sqrt(rng.next());
          s.position.x += Math.cos(a) * r;
          s.position.z += Math.sin(a) * r;
          break;
        }
        case 'ring': {
          const a = rng.next() * Math.PI * 2;
          const r = radius * (0.88 + rng.next() * 0.12);
          s.position.x += Math.cos(a) * r;
          s.position.z += Math.sin(a) * r;
          break;
        }
        case 'column': {
          const a = rng.next() * Math.PI * 2;
          const r = radius * Math.sqrt(rng.next());
          s.position.x += Math.cos(a) * r;
          s.position.z += Math.sin(a) * r;
          s.position.y += rng.next() * height;
          break;
        }
        case 'line': {
          const to = spec.positionTo ?? spec.position;
          const t = rng.next();
          s.position.lerpVectors(spec.position, to, t);
          rng.unitSphere(this.v0).multiplyScalar(radius);
          s.position.add(this.v0);
          break;
        }
        case 'cone':
        case 'point':
        default: {
          if (radius > 0) {
            rng.unitSphere(this.v0).multiplyScalar(radius * rng.next());
            s.position.add(this.v0);
          }
          break;
        }
      }

      // ── velocity ──
      const sp = rng.range(speed[0], speed[1]) * this.tileSize;
      if (sp !== 0) {
        if (shape === 'cone' || spec.direction) {
          // Sample inside a cone about `dir`.
          const cosA = Math.cos(spread);
          const z = rng.range(cosA, 1);
          const phi = rng.next() * Math.PI * 2;
          const r = Math.sqrt(Math.max(0, 1 - z * z));
          this.v0.set(r * Math.cos(phi), r * Math.sin(phi), z);
          // Rotate the +Z-aligned sample onto `dir`.
          this.v1.set(0, 0, 1);
          const q = new Quaternion().setFromUnitVectors(this.v1, dir);
          this.v0.applyQuaternion(q);
        } else if (shape === 'ring' || shape === 'disc') {
          this.v0.set(s.position.x - spec.position.x, 0, s.position.z - spec.position.z);
          if (this.v0.lengthSq() < 1e-8) this.v0.set(1, 0, 0);
          this.v0.normalize();
        } else {
          rng.unitSphere(this.v0);
        }
        s.velocity.copy(this.v0).multiplyScalar(sp);
      } else {
        s.velocity.set(0, 0, 0);
      }

      s.acceleration.set(0, gravity, 0);
      s.lifetime = rng.range(life[0], life[1]);

      const scale = 1 + rng.jitter(sizeJitter);
      s.sizeStart = size[0] * this.tileSize * scale;
      s.sizeEnd = size[1] * this.tileSize * scale;

      const cj = () => 1 + rng.jitter(jitterC);
      const j0 = cj();
      const j1 = cj();
      s.color0 = [spec.color0[0] * j0, spec.color0[1] * j0, spec.color0[2] * j0, spec.color0[3]];
      s.color1 = [spec.color1[0] * j1, spec.color1[1] * j1, spec.color1[2] * j1, spec.color1[3]];

      if (Array.isArray(spec.sprite)) {
        s.sprite = spec.sprite[Math.floor(rng.next() * spec.sprite.length)] ?? spec.sprite[0]!;
      } else {
        s.sprite = spec.sprite;
      }

      s.angle = rng.next() * Math.PI * 2;
      s.spin = spec.spin ? rng.range(spec.spin[0], spec.spin[1]) : 0;
      s.fadeIn = spec.fadeIn ?? 0.1;
      s.fadeOut = spec.fadeOut ?? 0.55;
      s.drag = spec.drag ?? 0;
      s.stretch = spec.stretch ?? 0;
      if (spec.orbit) {
        s.orbit = [spec.position.x, spec.position.z, spec.orbit.omega, spec.orbit.radial ?? 0];
      } else {
        s.orbit = [0, 0, 0, 0];
      }

      batch.spawn(s, this.clock);
    }
  }

  // ── Resource acquisition ────────────────────────────────────────────────

  private takeRibbon(): Ribbon | null {
    for (const r of this.ribbons) if (!r.active) return r;
    return null;
  }

  private takeCircle(): MagicCircle | null {
    for (const c of this.circles) if (!c.active) return c;
    return null;
  }

  private takePillar(): Pillar | null {
    for (const p of this.pillars) if (!p.active) return p;
    return null;
  }

  // ── Composite primitives used by effect definitions ─────────────────────

  /**
   * A ground sigil that grows in, holds while the spell charges, then snaps out.
   * Returns a disposer so a charging effect can hold it open indefinitely.
   */
  spawnMagicCircle(
    centre: Vector3,
    tl: VfxTimeline,
    o: { radius?: number; color?: Color; accent?: Color; growAt?: number; holdUntil?: number; spin?: number; runes?: number },
  ): void {
    const circle = this.takeCircle();
    if (!circle) return;
    circle.active = true;
    circle.mesh.visible = true;
    const radius = (o.radius ?? 1.6) * this.tileSize;
    circle.place(centre, radius, this.groundHeight);
    const u = circle.material.uniforms;
    (u['uColor']!.value as Color).copy(o.color ?? new Color(0.4, 0.7, 1.3));
    (u['uAccent']!.value as Color).copy(o.accent ?? new Color(1.6, 1.4, 1.0));
    u['uSpin']!.value = o.spin ?? 0.35;
    u['uRuneCount']!.value = o.runes ?? 16;
    u['uOpacity']!.value = 0;
    u['uGrow']!.value = 0;

    const growAt = o.growAt ?? 0;
    const holdUntil = o.holdUntil ?? growAt + 0.9;
    tl.span(growAt, growAt + 0.36, (t) => {
      u['uGrow']!.value = t;
      u['uOpacity']!.value = t;
    });
    tl.span(holdUntil, holdUntil + 0.3, (t) => {
      u['uOpacity']!.value = 1 - t;
      if (t >= 1) {
        circle.mesh.visible = false;
        circle.active = false;
      }
    });
  }

  /** A lightning bolt from A to B, with recursive branches. Rebuilt each frame to flicker. */
  spawnBolt(
    from: Vector3,
    to: Vector3,
    tl: VfxTimeline,
    o: { at?: number; duration?: number; width?: number; core?: Color; edge?: Color; branches?: number; jag?: number },
  ): void {
    const at = o.at ?? 0;
    const duration = o.duration ?? 0.28;
    const width = (o.width ?? 0.16) * this.tileSize;
    const jag = (o.jag ?? 0.5) * this.tileSize;
    const branchCount = o.branches ?? 3;

    const main = this.takeRibbon();
    if (!main) return;
    main.active = true;

    const branches: Ribbon[] = [];
    for (let i = 0; i < branchCount; i++) {
      const r = this.takeRibbon();
      if (!r) break;
      r.active = true;
      branches.push(r);
    }

    const core = o.core ?? new Color(4.0, 4.2, 6.0);
    const edge = o.edge ?? new Color(0.7, 0.9, 2.4);
    for (const r of [main, ...branches]) {
      (r.material.uniforms['uCoreColor']!.value as Color).copy(core);
      (r.material.uniforms['uEdgeColor']!.value as Color).copy(edge);
      r.material.uniforms['uCoreWidth']!.value = 0.3;
    }

    const segments = 18;
    const buildPath = (a: Vector3, b: Vector3, amp: number, seedOffset: number): Vector3[] => {
      const pts: Vector3[] = [];
      const perpA = new Vector3();
      const perpB = new Vector3();
      const dir = new Vector3().subVectors(b, a);
      const len = dir.length() || 1;
      dir.normalize();
      perpA.set(0, 1, 0).cross(dir);
      if (perpA.lengthSq() < 1e-6) perpA.set(1, 0, 0);
      perpA.normalize();
      perpB.crossVectors(dir, perpA).normalize();
      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const p = new Vector3().lerpVectors(a, b, t);
        // Envelope: pinned at both ends, wildest in the middle.
        const env = Math.sin(t * Math.PI) * amp * len * 0.12;
        const n1 = Math.sin(t * 11.7 + seedOffset) * 0.6 + Math.sin(t * 27.3 + seedOffset * 1.7) * 0.4;
        const n2 = Math.cos(t * 9.1 + seedOffset * 2.1) * 0.6 + Math.cos(t * 23.9 + seedOffset) * 0.4;
        p.addScaledVector(perpA, n1 * env);
        p.addScaledVector(perpB, n2 * env);
        pts.push(p);
      }
      return pts;
    };

    tl.span(at, at + duration, (t) => {
      // Flicker: reseed a few times across the life so the bolt crackles.
      const flickerIndex = Math.floor(t * 5);
      const path = buildPath(from, to, jag * 4, flickerIndex * 3.77);
      main.mesh.visible = true;
      main.setPath(path, width * (1.0 + 0.5 * (1 - t)), this.cameraDir);
      main.material.uniforms['uHead']!.value = Math.min(1, t * 3.2);
      main.material.uniforms['uOpacity']!.value = t < 0.15 ? t / 0.15 : Math.pow(1 - (t - 0.15) / 0.85, 1.4);

      for (let i = 0; i < branches.length; i++) {
        const r = branches[i]!;
        const anchorT = 0.25 + (i / Math.max(1, branches.length)) * 0.55;
        const anchor = path[Math.floor(anchorT * segments)] ?? to;
        const endT = anchorT + 0.22;
        const base = path[Math.min(segments, Math.floor(endT * segments))] ?? to;
        this.v0.copy(base).sub(anchor);
        const away = new Vector3(
          this.v0.z + (i % 2 === 0 ? 1 : -1) * 0.6,
          this.v0.y * 0.4 - 0.25,
          -this.v0.x + (i % 2 === 0 ? -0.6 : 0.6),
        ).multiplyScalar(1.7 * this.tileSize);
        const end = new Vector3().copy(anchor).add(away);
        r.mesh.visible = true;
        r.setPath(buildPath(anchor, end, jag * 5, flickerIndex * 5.1 + i * 2.3), width * 0.5, this.cameraDir);
        r.material.uniforms['uHead']!.value = Math.min(1, Math.max(0, (t - 0.06) * 5));
        r.material.uniforms['uOpacity']!.value = Math.pow(Math.max(0, 1 - t * 1.4), 1.6);
      }

      if (t >= 1) {
        main.mesh.visible = false;
        main.active = false;
        for (const r of branches) {
          r.mesh.visible = false;
          r.active = false;
        }
      }
    });
  }

  /** A swept crescent, the readable part of any melee hit. */
  spawnSlashArc(
    centre: Vector3,
    tl: VfxTimeline,
    o: { at?: number; duration?: number; radius?: number; arc?: number; tilt?: number; color?: Color; width?: number },
  ): void {
    const ribbon = this.takeRibbon();
    if (!ribbon) return;
    ribbon.active = true;
    const at = o.at ?? 0;
    const duration = o.duration ?? 0.2;
    const radius = (o.radius ?? 1.1) * this.tileSize;
    const arc = o.arc ?? Math.PI * 1.15;
    const tilt = o.tilt ?? -0.55;
    const width = (o.width ?? 0.34) * this.tileSize;

    (ribbon.material.uniforms['uCoreColor']!.value as Color).copy(o.color ?? new Color(3.2, 3.2, 3.6));
    (ribbon.material.uniforms['uEdgeColor']!.value as Color).copy(new Color(0.9, 1.0, 1.5));
    ribbon.material.uniforms['uCoreWidth']!.value = 0.22;

    const pts: Vector3[] = [];
    const N = 26;
    for (let i = 0; i <= N; i++) {
      const a = -arc * 0.5 + arc * (i / N);
      pts.push(
        new Vector3(
          centre.x + Math.cos(a) * radius,
          centre.y + Math.sin(a) * radius * Math.sin(tilt),
          centre.z + Math.sin(a) * radius * Math.cos(tilt),
        ),
      );
    }

    tl.span(at, at + duration, (t) => {
      ribbon.mesh.visible = true;
      ribbon.setPath(pts, width * (1.2 - 0.6 * t), this.cameraDir);
      // Head runs ahead of the tail: the blade draws, then the trail catches up.
      ribbon.material.uniforms['uHead']!.value = Math.min(1.15, t * 1.85);
      ribbon.material.uniforms['uTail']!.value = Math.max(0, (t - 0.42) * 1.9);
      ribbon.material.uniforms['uOpacity']!.value = t < 0.1 ? t / 0.1 : Math.pow(1 - (t - 0.1) / 0.9, 1.2);
      if (t >= 1) {
        ribbon.mesh.visible = false;
        ribbon.active = false;
      }
    });
  }

  /** Vertical light column with rotating god rays. */
  spawnPillar(
    base: Vector3,
    tl: VfxTimeline,
    o: {
      at?: number;
      rise?: number;
      hold?: number;
      fall?: number;
      radius?: number;
      height?: number;
      core?: Color;
      edge?: Color;
      rays?: number;
      scroll?: number;
    },
  ): void {
    const pillar = this.takePillar();
    if (!pillar) return;
    pillar.active = true;
    const at = o.at ?? 0;
    const rise = o.rise ?? 0.22;
    const hold = o.hold ?? 0.45;
    const fall = o.fall ?? 0.4;
    const radius = (o.radius ?? 1.0) * this.tileSize;
    const height = (o.height ?? 6.5) * this.tileSize;

    pillar.mesh.position.copy(base);
    pillar.mesh.scale.set(radius, height, radius);
    pillar.mesh.updateMatrixWorld();
    const u = pillar.material.uniforms;
    (u['uColorCore']!.value as Color).copy(o.core ?? new Color(5.0, 4.6, 3.2));
    (u['uColorEdge']!.value as Color).copy(o.edge ?? new Color(1.6, 1.35, 0.75));
    u['uRayCount']!.value = o.rays ?? 9;
    u['uScroll']!.value = o.scroll ?? 0.35;
    u['uOpacity']!.value = 0;
    u['uRise']!.value = 0;

    tl.span(at, at + rise, (t) => {
      pillar.mesh.visible = true;
      u['uRise']!.value = t;
      u['uOpacity']!.value = t;
    });
    tl.span(at + rise + hold, at + rise + hold + fall, (t) => {
      u['uOpacity']!.value = Math.pow(1 - t, 1.6);
      if (t >= 1) {
        pillar.mesh.visible = false;
        pillar.active = false;
      }
    });
  }

  /** Earth spikes punching up through the ground. */
  spawnSpikes(centre: Vector3, count: number, spreadTiles: number): void {
    const instances: RisingInstance[] = [];
    for (let i = 0; i < count; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = spreadTiles * this.tileSize * Math.sqrt(this.rng.next());
      const base = new Vector3(centre.x + Math.cos(a) * r, centre.y, centre.z + Math.sin(a) * r);
      instances.push({
        base,
        height: this.rng.range(0.9, 2.1) * this.tileSize,
        scale: this.rng.range(0.32, 0.6) * this.tileSize,
        rotation: this.rng.next() * Math.PI * 2,
        tilt: this.rng.jitter(0.5),
        delay: (r / Math.max(spreadTiles * this.tileSize, 1e-3)) * 0.16 + this.rng.range(0, 0.05),
        rise: 0.11,
        hold: 0.5,
        fall: 0.35,
      });
    }
    this.spikes.begin(instances);
  }

  /** Ice shards erupting, then shattering. */
  spawnIceShards(centre: Vector3, count: number, spreadTiles: number): void {
    const instances: RisingInstance[] = [];
    for (let i = 0; i < count; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = spreadTiles * this.tileSize * Math.sqrt(this.rng.next());
      instances.push({
        base: new Vector3(centre.x + Math.cos(a) * r, centre.y, centre.z + Math.sin(a) * r),
        height: this.rng.range(1.0, 2.4) * this.tileSize,
        scale: this.rng.range(0.28, 0.5) * this.tileSize,
        rotation: this.rng.next() * Math.PI * 2,
        tilt: this.rng.jitter(0.42),
        delay: this.rng.range(0, 0.09),
        rise: 0.09,
        hold: 0.34,
        fall: 0.1,
      });
    }
    this.shards.begin(instances);
  }

  /** Screen shake + optional hit-stop + optional distortion ring, in one call. */
  impactPunch(position: Vector3, power: number): void {
    this.shake.add(0.28 + 0.55 * power);
    if (power >= 0.55) this.time.stop(0.035 + 0.075 * power, 0.03);
    this.post?.addShockwave(position, {
      amplitude: 0.006 + 0.016 * power,
      duration: 0.32 + 0.2 * power,
      maxRadius: 0.28 + 0.28 * power,
    });
  }

  // ── Playback ────────────────────────────────────────────────────────────

  /**
   * Play an ability effect. Resolves when the whole timeline (including aftermath) is done.
   * Unknown vfx keys fall back to a generic elemental burst rather than rendering nothing —
   * a missing effect should still read as "something happened".
   */
  play(key: string, opts: VfxPlayOptions): Promise<void> {
    const tl = new VfxTimeline();
    const builder = EFFECTS[key] ?? EFFECTS[`${opts.element ?? 'none'}-generic`] ?? genericBurst;
    const resolved = { ...opts, origin: opts.origin, target: opts.target };
    if (opts.windup && opts.windup > 0) {
      // Shift everything by inserting a leading charge glow.
      chargeGlow(this, tl, resolved, opts.windup);
    }
    builder(this, tl, resolved);
    this.timelines.push(tl);
    return tl.promise;
  }

  /**
   * Start a persistent charge effect (FFT charge-time abilities). The circle and motes
   * stay up until `release()` or `cancel()`.
   */
  beginCharge(origin: Vector3, element: Element = 'none'): ChargeHandle {
    const tl = new VfxTimeline();
    const pal = ELEMENT_COLORS[element];
    const colour = new Color(pal.mid[0], pal.mid[1], pal.mid[2]);
    const accent = new Color(pal.core[0] * 0.4, pal.core[1] * 0.4, pal.core[2] * 0.4);

    let running = true;
    const circle = this.takeCircle();
    if (circle) {
      circle.active = true;
      circle.mesh.visible = true;
      circle.place(origin, 1.35 * this.tileSize, this.groundHeight);
      const u = circle.material.uniforms;
      (u['uColor']!.value as Color).copy(colour);
      (u['uAccent']!.value as Color).copy(accent);
      u['uSpin']!.value = 0.5;
      u['uOpacity']!.value = 0;
      u['uGrow']!.value = 0;
      tl.span(0, 0.4, (t) => {
        u['uGrow']!.value = t;
        u['uOpacity']!.value = t * 0.9;
      });
    }

    // Motes spiralling up into the caster's hands.
    let acc = 0;
    tl.span(0, 3600, (_t, ctx) => {
      acc += ctx.dt;
      if (acc < 0.06) return;
      acc = 0;
      this.emit({
        count: 2,
        position: this.v1.copy(origin).setY(origin.y + 0.05 * this.tileSize),
        shape: 'ring',
        radius: 1.1,
        speed: [0.6, 1.0],
        direction: new Vector3(0, 1, 0),
        spread: 0.35,
        drag: 1.4,
        gravity: 0.6,
        size: [0.16, 0.02],
        life: [0.6, 0.95],
        color0: pal.core,
        color1: [pal.fade[0], pal.fade[1], pal.fade[2], 0],
        sprite: [SPR.spark, SPR.star4],
        orbit: { omega: 2.6, radial: -0.55 },
        fadeIn: 0.15,
        fadeOut: 0.5,
      });
    });

    this.timelines.push(tl);

    const close = (burst: boolean): void => {
      if (!running) return;
      running = false;
      if (circle) {
        circle.mesh.visible = false;
        circle.active = false;
      }
      if (burst) {
        this.emit({
          count: 22,
          position: origin.clone().setY(origin.y + 0.7 * this.tileSize),
          shape: 'sphere',
          radius: 0.35,
          speed: [1.6, 3.6],
          drag: 3.0,
          size: [0.26, 0.02],
          life: [0.25, 0.45],
          color0: pal.core,
          color1: [pal.mid[0], pal.mid[1], pal.mid[2], 0],
          sprite: SPR.spark,
          stretch: 1.5,
        });
      }
      tl.cancel();
    };

    return {
      release: () => close(true),
      cancel: () => close(false),
    };
  }

  /** Immediate one-shot helpers the renderer can call outside the ability system. */
  playLandingDust(position: Vector3, power = 0.5): void {
    this.emit({
      count: Math.round(10 + 14 * power),
      position,
      shape: 'disc',
      radius: 0.25,
      speed: [0.7, 1.9],
      drag: 3.4,
      gravity: -0.4,
      size: [0.32, 1.0],
      life: [0.5, 0.9],
      color0: [0.42, 0.36, 0.29, 0.55],
      color1: [0.3, 0.27, 0.23, 0],
      sprite: [SPR.dust, SPR.smoke],
      additive: false,
      spin: [-0.8, 0.8],
      fadeIn: 0.12,
      fadeOut: 0.35,
    });
  }

  playHitSpark(position: Vector3, power = 0.5, element: Element = 'none'): void {
    const pal = ELEMENT_COLORS[element];
    this.emit({
      count: Math.round(8 + 16 * power),
      position,
      shape: 'sphere',
      radius: 0.08,
      speed: [3.0, 7.5],
      gravity: -7,
      drag: 1.2,
      size: [0.13, 0.02],
      life: [0.18, 0.36],
      color0: pal.core,
      color1: [pal.fade[0], pal.fade[1], pal.fade[2], 0],
      sprite: SPR.streak,
      stretch: 2.4,
      fadeIn: 0.04,
      fadeOut: 0.4,
    });
    this.emit({
      count: 1,
      position,
      size: [0.9 + power, 2.4 + power * 2],
      life: [0.14, 0.14],
      color0: [pal.core[0], pal.core[1], pal.core[2], 0.85],
      color1: [pal.mid[0], pal.mid[1], pal.mid[2], 0],
      sprite: SPR.halo,
      fadeIn: 0.05,
      fadeOut: 0.15,
    });
  }

  playBloodBurst(position: Vector3, power = 0.5): void {
    this.emit({
      count: Math.round(9 + 12 * power),
      position,
      shape: 'sphere',
      radius: 0.1,
      speed: [1.6, 4.2],
      gravity: -11,
      size: [0.11, 0.05],
      life: [0.35, 0.6],
      color0: [0.36, 0.03, 0.04, 0.95],
      color1: [0.16, 0.01, 0.02, 0],
      sprite: SPR.droplet,
      additive: false,
      stretch: 1.4,
      fadeIn: 0.03,
      fadeOut: 0.65,
    });
  }

  /** Cancel every running effect. Used on battle end / scene teardown. */
  clear(): void {
    for (const tl of this.timelines) tl.cancel();
    this.timelines.length = 0;
    for (const r of this.ribbons) {
      r.active = false;
      r.mesh.visible = false;
    }
    for (const c of this.circles) {
      c.active = false;
      c.mesh.visible = false;
    }
    for (const p of this.pillars) {
      p.active = false;
      p.mesh.visible = false;
    }
  }

  dispose(): void {
    this.clear();
    this.additive.dispose();
    this.alpha.dispose();
    for (const r of this.ribbons) r.dispose();
    for (const c of this.circles) c.dispose();
    for (const p of this.pillars) p.dispose();
    this.spikes.dispose();
    this.shards.dispose();
    this.atlas.dispose();
    this.group.removeFromParent();
  }

  /** Exposed for effect builders. */
  get scale(): number {
    return this.tileSize;
  }
  get palette(): typeof ELEMENT_COLORS {
    return ELEMENT_COLORS;
  }
  get random(): VfxRng {
    return this.rng;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Effect definitions
// ─────────────────────────────────────────────────────────────────────────────

type Opts = Required<Pick<VfxPlayOptions, 'origin' | 'target'>> & VfxPlayOptions;

function pal(o: Opts) {
  return ELEMENT_COLORS[o.element ?? 'none'];
}

function fadeOf(p: { fade: RGBA }): RGBA {
  return [p.fade[0], p.fade[1], p.fade[2], 0];
}

function impactPoints(o: Opts): Vector3[] {
  return o.targets && o.targets.length > 0 ? o.targets.map((v) => v.clone()) : [o.target.clone()];
}

/** Leading charge glow used when an ability declares a windup. */
function chargeGlow(sys: VfxSystem, tl: VfxTimeline, o: Opts, seconds: number): void {
  const p = pal(o);
  let acc = 0;
  tl.span(0, seconds, (_t, ctx) => {
    acc += ctx.dt;
    if (acc < 0.07) return;
    acc = 0;
    sys.emit({
      count: 2,
      position: o.origin.clone().setY(o.origin.y + 0.6 * sys.scale),
      shape: 'sphere',
      radius: 0.9,
      speed: [-1.4, -0.7],
      drag: 0.6,
      size: [0.12, 0.03],
      life: [0.4, 0.6],
      color0: p.mid,
      color1: fadeOf(p),
      sprite: SPR.spark,
    });
  });
}

/** Fallback: a solid, readable elemental pop. Never nothing. */
const genericBurst: EffectBuilder = (sys, tl, o) => {
  const p = pal(o);
  const power = o.power ?? 0.5;
  tl.at(0.0, () => {
    sys.emit({
      count: 26,
      position: o.target,
      shape: 'sphere',
      radius: 0.3,
      speed: [2.2, 5.0],
      drag: 2.6,
      gravity: -1.5,
      size: [0.42, 0.06],
      life: [0.32, 0.6],
      color0: p.core,
      color1: fadeOf(p),
      sprite: [SPR.dot, SPR.spark],
    });
    sys.emit({
      count: 1,
      position: o.target,
      size: [0.6, 3.2],
      life: [0.22, 0.22],
      color0: [p.core[0], p.core[1], p.core[2], 0.9],
      color1: fadeOf(p),
      sprite: SPR.halo,
      fadeIn: 0.06,
      fadeOut: 0.2,
    });
    sys.impactPunch(o.target, power * 0.6);
    o.onImpact?.(0, o.target);
  });
  tl.hold(0.7);
};

const EFFECTS: Record<string, EffectBuilder> = {
  // ── Fire ────────────────────────────────────────────────────────────────
  'fire-burst': (sys, tl, o) => {
    const p = ELEMENT_COLORS.fire;
    const power = o.power ?? 0.6;
    const pts = impactPoints(o);

    sys.spawnMagicCircle(o.origin, tl, {
      radius: 1.3,
      color: new Color(2.2, 0.7, 0.15),
      accent: new Color(4.0, 2.0, 0.4),
      growAt: 0,
      holdUntil: 0.34,
      runes: 12,
    });

    tl.at(0.36, () => {
      for (const pt of pts) {
        // Ignition: a compact bright core so the eye lands on the hit tile instantly.
        sys.emit({
          count: 1,
          position: pt,
          size: [0.4, 4.4],
          life: [0.26, 0.26],
          color0: [p.core[0], p.core[1], p.core[2], 1],
          color1: [p.mid[0], p.mid[1], p.mid[2], 0],
          sprite: SPR.halo,
          fadeIn: 0.05,
          fadeOut: 0.18,
        });
        // Rolling flame body — few, large, silhouetted.
        sys.emit({
          count: 18,
          position: pt,
          shape: 'sphere',
          radius: 0.28,
          speed: [1.6, 3.6],
          direction: new Vector3(0, 1, 0),
          spread: 1.1,
          drag: 2.4,
          gravity: 2.2,
          size: [0.85, 0.24],
          life: [0.42, 0.72],
          color0: p.core,
          color1: [p.mid[0] * 0.35, p.mid[1] * 0.2, p.mid[2] * 0.1, 0],
          sprite: SPR.flame,
          spin: [-1.4, 1.4],
          fadeIn: 0.07,
          fadeOut: 0.45,
        });
        // Embers, velocity-stretched so they read as motion, not dots.
        sys.emit({
          count: 24,
          position: pt,
          shape: 'sphere',
          radius: 0.2,
          speed: [3.0, 6.5],
          drag: 1.6,
          gravity: -5.5,
          size: [0.13, 0.03],
          life: [0.5, 1.0],
          color0: p.core,
          color1: fadeOf(p),
          sprite: SPR.ember,
          stretch: 1.2,
          fadeOut: 0.6,
        });
        // Smoke aftermath, alpha-blended so it actually darkens the frame.
        sys.emit({
          count: 12,
          position: pt,
          shape: 'disc',
          radius: 0.4,
          speed: [0.5, 1.3],
          direction: new Vector3(0, 1, 0),
          spread: 0.8,
          drag: 1.5,
          gravity: 0.5,
          size: [0.6, 1.9],
          life: [0.9, 1.6],
          color0: [0.16, 0.13, 0.11, 0.5],
          color1: [0.12, 0.1, 0.09, 0],
          sprite: SPR.smoke,
          additive: false,
          spin: [-0.5, 0.5],
          fadeIn: 0.2,
          fadeOut: 0.3,
        });
        sys.impactPunch(pt, power);
      }
      pts.forEach((pt, i) => o.onImpact?.(i, pt));
    });
    tl.hold(1.7);
  },

  // ── Ice ─────────────────────────────────────────────────────────────────
  'ice-shard': (sys, tl, o) => {
    const p = ELEMENT_COLORS.ice;
    const power = o.power ?? 0.6;
    const pts = impactPoints(o);

    sys.spawnMagicCircle(o.origin, tl, {
      radius: 1.25,
      color: new Color(0.5, 1.4, 2.4),
      accent: new Color(1.6, 2.6, 3.6),
      growAt: 0,
      holdUntil: 0.3,
      spin: -0.4,
      runes: 20,
    });

    tl.at(0.32, () => {
      for (const pt of pts) {
        // Frost bloom on the ground first: telegraphs where the shards will erupt.
        sys.emit({
          count: 16,
          position: pt,
          shape: 'disc',
          radius: 0.7,
          speed: [0.2, 0.7],
          size: [0.5, 0.9],
          life: [0.4, 0.7],
          color0: [p.mid[0] * 0.7, p.mid[1] * 0.7, p.mid[2] * 0.7, 0.6],
          color1: fadeOf(p),
          sprite: SPR.caustic,
          spin: [-0.3, 0.3],
          fadeIn: 0.1,
          fadeOut: 0.45,
        });
      }
    });

    tl.at(0.44, () => {
      for (const pt of pts) sys.spawnIceShards(pt, 7, 0.75);
    });

    // Shatter.
    tl.at(0.86, () => {
      for (const pt of pts) {
        sys.emit({
          count: 30,
          position: pt.clone().setY(pt.y + 0.8 * sys.scale),
          shape: 'sphere',
          radius: 0.5,
          speed: [2.4, 6.0],
          gravity: -10,
          drag: 0.6,
          size: [0.26, 0.09],
          life: [0.5, 0.95],
          color0: p.core,
          color1: fadeOf(p),
          sprite: [SPR.shard, SPR.splinter],
          spin: [-6, 6],
          fadeOut: 0.7,
        });
        sys.emit({
          count: 1,
          position: pt.clone().setY(pt.y + 0.6 * sys.scale),
          size: [0.5, 3.6],
          life: [0.24, 0.24],
          color0: [p.core[0], p.core[1], p.core[2], 0.95],
          color1: fadeOf(p),
          sprite: SPR.halo,
          fadeIn: 0.05,
          fadeOut: 0.2,
        });
        sys.impactPunch(pt, power);
      }
      pts.forEach((pt, i) => o.onImpact?.(i, pt));
    });
    tl.hold(1.9);
  },

  // ── Lightning ───────────────────────────────────────────────────────────
  'lightning-bolt': (sys, tl, o) => {
    const p = ELEMENT_COLORS.lightning;
    const power = o.power ?? 0.7;
    const pts = impactPoints(o);

    sys.spawnMagicCircle(o.origin, tl, {
      radius: 1.2,
      color: new Color(1.0, 1.2, 2.6),
      accent: new Color(2.6, 2.8, 4.4),
      growAt: 0,
      holdUntil: 0.24,
      spin: 0.9,
      runes: 24,
    });

    for (const pt of pts) {
      const sky = pt.clone().setY(pt.y + 9 * sys.scale);
      sys.spawnBolt(sky, pt, tl, { at: 0.28, duration: 0.3, width: 0.22, branches: 3, jag: 0.55 });
    }

    tl.at(0.3, () => {
      for (const pt of pts) {
        // Flash first, geometry second: an electrical hit is a lighting event.
        sys.emit({
          count: 1,
          position: pt.clone().setY(pt.y + 0.4 * sys.scale),
          size: [1.0, 6.0],
          life: [0.16, 0.16],
          color0: [p.core[0] * 1.4, p.core[1] * 1.4, p.core[2] * 1.4, 1],
          color1: fadeOf(p),
          sprite: SPR.halo,
          fadeIn: 0.03,
          fadeOut: 0.12,
        });
        sys.emit({
          count: 26,
          position: pt,
          shape: 'disc',
          radius: 0.2,
          speed: [4.0, 9.0],
          gravity: -6,
          drag: 2.2,
          size: [0.16, 0.02],
          life: [0.16, 0.34],
          color0: p.core,
          color1: fadeOf(p),
          sprite: SPR.streak,
          stretch: 2.8,
          fadeIn: 0.03,
          fadeOut: 0.35,
        });
        sys.emit({
          count: 4,
          position: pt,
          shape: 'ring',
          radius: 0.15,
          speed: [2.6, 3.4],
          size: [0.7, 3.0],
          life: [0.3, 0.42],
          color0: [p.mid[0], p.mid[1], p.mid[2], 0.85],
          color1: fadeOf(p),
          sprite: SPR.ring,
          fadeIn: 0.05,
          fadeOut: 0.25,
        });
        sys.impactPunch(pt, power);
      }
      pts.forEach((pt, i) => o.onImpact?.(i, pt));
    });
    tl.hold(1.2);
  },

  // ── Wind ────────────────────────────────────────────────────────────────
  'wind-vortex': (sys, tl, o) => {
    const p = ELEMENT_COLORS.wind;
    const power = o.power ?? 0.5;
    const pts = impactPoints(o);

    tl.at(0.1, () => {
      for (const pt of pts) {
        sys.emit({
          count: 46,
          position: pt,
          shape: 'ring',
          radius: 1.5,
          speed: [0.4, 0.9],
          direction: new Vector3(0, 1, 0),
          spread: 0.25,
          size: [0.42, 0.16],
          life: [0.9, 1.5],
          color0: [p.mid[0], p.mid[1], p.mid[2], 0.7],
          color1: fadeOf(p),
          sprite: SPR.wisp,
          orbit: { omega: 6.5, radial: -0.55 },
          spin: [-3, 3],
          fadeIn: 0.14,
          fadeOut: 0.4,
        });
        sys.emit({
          count: 18,
          position: pt,
          shape: 'ring',
          radius: 1.8,
          speed: [0.5, 1.1],
          direction: new Vector3(0, 1, 0),
          spread: 0.3,
          size: [0.3, 0.12],
          life: [1.0, 1.6],
          color0: [0.55, 0.5, 0.4, 0.8],
          color1: [0.4, 0.38, 0.3, 0],
          sprite: SPR.petal,
          additive: false,
          orbit: { omega: 5.6, radial: -0.5 },
          spin: [-8, 8],
          fadeIn: 0.15,
          fadeOut: 0.5,
        });
      }
    });

    tl.at(0.85, () => {
      for (const pt of pts) {
        sys.emit({
          count: 24,
          position: pt.clone().setY(pt.y + 0.8 * sys.scale),
          shape: 'sphere',
          radius: 0.4,
          speed: [4.0, 8.0],
          drag: 2.2,
          size: [0.3, 0.06],
          life: [0.3, 0.5],
          color0: p.core,
          color1: fadeOf(p),
          sprite: SPR.streak,
          stretch: 2.0,
        });
        sys.impactPunch(pt, power * 0.8);
      }
      pts.forEach((pt, i) => o.onImpact?.(i, pt));
    });
    tl.hold(2.0);
  },

  // ── Earth ───────────────────────────────────────────────────────────────
  'earth-spike': (sys, tl, o) => {
    const p = ELEMENT_COLORS.earth;
    const power = o.power ?? 0.8;
    const pts = impactPoints(o);

    tl.at(0.0, () => {
      for (const pt of pts) {
        // Ground cracks telegraph, dust rises, then the spikes hit.
        sys.emit({
          count: 14,
          position: pt,
          shape: 'disc',
          radius: 0.8,
          speed: [0.3, 0.9],
          direction: new Vector3(0, 1, 0),
          spread: 0.6,
          drag: 2.0,
          size: [0.45, 1.3],
          life: [0.6, 1.0],
          color0: [0.35, 0.29, 0.22, 0.55],
          color1: [0.26, 0.22, 0.17, 0],
          sprite: SPR.dust,
          additive: false,
          fadeIn: 0.12,
          fadeOut: 0.35,
        });
      }
    });

    tl.at(0.18, () => {
      for (const pt of pts) sys.spawnSpikes(pt, 8, 0.85);
    });

    tl.at(0.26, () => {
      for (const pt of pts) {
        sys.emit({
          count: 26,
          position: pt,
          shape: 'disc',
          radius: 0.7,
          speed: [2.0, 5.5],
          direction: new Vector3(0, 1, 0),
          spread: 0.7,
          gravity: -13,
          size: [0.2, 0.1],
          life: [0.55, 0.95],
          color0: [0.42, 0.33, 0.24, 1],
          color1: [0.3, 0.24, 0.18, 0],
          sprite: [SPR.splinter, SPR.shard],
          additive: false,
          spin: [-7, 7],
          fadeOut: 0.7,
        });
        sys.emit({
          count: 8,
          position: pt,
          shape: 'ring',
          radius: 0.5,
          speed: [1.4, 2.2],
          size: [0.8, 2.4],
          life: [0.4, 0.6],
          color0: [p.mid[0] * 0.5, p.mid[1] * 0.5, p.mid[2] * 0.5, 0.5],
          color1: fadeOf(p),
          sprite: SPR.dust,
          additive: false,
          fadeIn: 0.1,
          fadeOut: 0.3,
        });
        sys.impactPunch(pt, power);
      }
      pts.forEach((pt, i) => o.onImpact?.(i, pt));
    });
    tl.hold(1.6);
  },

  // ── Water ───────────────────────────────────────────────────────────────
  'water-surge': (sys, tl, o) => {
    const p = ELEMENT_COLORS.water;
    const power = o.power ?? 0.6;
    const pts = impactPoints(o);

    tl.at(0.0, () => {
      for (const pt of pts) {
        sys.emit({
          count: 10,
          position: pt,
          shape: 'ring',
          radius: 0.9,
          speed: [1.0, 1.6],
          size: [0.7, 2.2],
          life: [0.5, 0.8],
          color0: [p.mid[0], p.mid[1], p.mid[2], 0.7],
          color1: fadeOf(p),
          sprite: SPR.caustic,
          fadeIn: 0.1,
          fadeOut: 0.35,
        });
      }
    });

    tl.at(0.22, () => {
      for (const pt of pts) {
        sys.emit({
          count: 40,
          position: pt,
          shape: 'disc',
          radius: 0.5,
          speed: [4.5, 8.5],
          direction: new Vector3(0, 1, 0),
          spread: 0.55,
          gravity: -12,
          size: [0.3, 0.12],
          life: [0.7, 1.15],
          color0: p.core,
          color1: fadeOf(p),
          sprite: [SPR.droplet, SPR.dot],
          stretch: 1.1,
          fadeOut: 0.6,
        });
        sys.emit({
          count: 14,
          position: pt,
          shape: 'column',
          radius: 0.45,
          height: 2.4,
          speed: [1.0, 2.0],
          direction: new Vector3(0, 1, 0),
          spread: 0.4,
          drag: 1.6,
          size: [0.8, 0.3],
          life: [0.6, 0.95],
          color0: [p.mid[0] * 1.2, p.mid[1] * 1.2, p.mid[2] * 1.2, 0.75],
          color1: fadeOf(p),
          sprite: SPR.wisp,
          spin: [-1.2, 1.2],
          fadeIn: 0.12,
          fadeOut: 0.4,
        });
        sys.emit({
          count: 12,
          position: pt,
          shape: 'sphere',
          radius: 0.5,
          speed: [1.2, 2.6],
          gravity: -3,
          size: [0.16, 0.08],
          life: [0.6, 1.0],
          color0: [p.core[0] * 0.6, p.core[1] * 0.6, p.core[2] * 0.6, 0.8],
          color1: fadeOf(p),
          sprite: SPR.bubble,
        });
        sys.impactPunch(pt, power * 0.85);
      }
      pts.forEach((pt, i) => o.onImpact?.(i, pt));
    });
    tl.hold(1.7);
  },

  // ── Holy ────────────────────────────────────────────────────────────────
  'holy-pillar': (sys, tl, o) => {
    const p = ELEMENT_COLORS.holy;
    const power = o.power ?? 0.85;
    const pts = impactPoints(o);

    for (const pt of pts) {
      sys.spawnMagicCircle(pt, tl, {
        radius: 1.9,
        color: new Color(1.8, 1.6, 1.0),
        accent: new Color(3.4, 3.1, 2.0),
        growAt: 0,
        holdUntil: 0.9,
        spin: 0.22,
        runes: 24,
      });
      sys.spawnPillar(pt, tl, {
        at: 0.34,
        rise: 0.16,
        hold: 0.5,
        fall: 0.5,
        radius: 1.15,
        height: 8,
        core: new Color(p.core[0], p.core[1], p.core[2]),
        edge: new Color(p.mid[0], p.mid[1], p.mid[2]),
        rays: 11,
        scroll: 0.28,
      });
    }

    tl.at(0.1, () => {
      for (const pt of pts) {
        // Motes falling *into* the pillar site: builds anticipation upward.
        sys.emit({
          count: 26,
          position: pt.clone().setY(pt.y + 4.5 * sys.scale),
          shape: 'column',
          radius: 1.4,
          height: 3.0,
          speed: [1.4, 2.6],
          direction: new Vector3(0, -1, 0),
          spread: 0.2,
          drag: 0.8,
          size: [0.16, 0.04],
          life: [0.6, 0.95],
          color0: p.core,
          color1: fadeOf(p),
          sprite: [SPR.star4, SPR.spark],
          fadeIn: 0.1,
          fadeOut: 0.5,
        });
      }
    });

    tl.at(0.4, () => {
      for (const pt of pts) {
        sys.emit({
          count: 34,
          position: pt,
          shape: 'ring',
          radius: 1.1,
          speed: [1.0, 2.4],
          direction: new Vector3(0, 1, 0),
          spread: 0.22,
          drag: 1.0,
          size: [0.3, 0.05],
          life: [0.8, 1.3],
          color0: p.core,
          color1: fadeOf(p),
          sprite: SPR.star6,
          orbit: { omega: 1.6, radial: -0.3 },
          fadeIn: 0.1,
          fadeOut: 0.5,
        });
        sys.emit({
          count: 5,
          position: pt,
          shape: 'ring',
          radius: 0.2,
          speed: [2.2, 3.0],
          size: [1.0, 4.2],
          life: [0.5, 0.7],
          color0: [p.mid[0], p.mid[1], p.mid[2], 0.7],
          color1: fadeOf(p),
          sprite: SPR.ring,
          fadeIn: 0.06,
          fadeOut: 0.3,
        });
        sys.impactPunch(pt, power);
      }
      pts.forEach((pt, i) => o.onImpact?.(i, pt));
    });
    tl.hold(2.1);
  },

  // ── Dark ────────────────────────────────────────────────────────────────
  'dark-tendril': (sys, tl, o) => {
    const p = ELEMENT_COLORS.dark;
    const power = o.power ?? 0.7;
    const pts = impactPoints(o);

    sys.spawnMagicCircle(o.origin, tl, {
      radius: 1.4,
      color: new Color(0.9, 0.2, 1.4),
      accent: new Color(1.8, 0.5, 2.4),
      growAt: 0,
      holdUntil: 0.4,
      spin: -0.55,
      runes: 13,
    });

    // Tendrils reach out of the ground and grab the target.
    for (const pt of pts) {
      for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * Math.PI * 2 + 0.6;
        const from = new Vector3(
          pt.x + Math.cos(ang) * 1.5 * sys.scale,
          pt.y - 0.1 * sys.scale,
          pt.z + Math.sin(ang) * 1.5 * sys.scale,
        );
        const to = pt.clone().setY(pt.y + 1.2 * sys.scale);
        sys.spawnBolt(from, to, tl, {
          at: 0.42 + i * 0.05,
          duration: 0.55,
          width: 0.34,
          branches: 1,
          jag: 0.9,
          core: new Color(p.mid[0] * 1.6, p.mid[1] * 1.2, p.mid[2] * 1.6),
          edge: new Color(0.18, 0.02, 0.3),
        });
      }
    }

    tl.at(0.4, () => {
      for (const pt of pts) {
        sys.emit({
          count: 30,
          position: pt,
          shape: 'disc',
          radius: 1.1,
          speed: [0.6, 1.6],
          direction: new Vector3(0, 1, 0),
          spread: 0.5,
          drag: 1.4,
          size: [0.65, 0.2],
          life: [0.7, 1.2],
          color0: [p.mid[0], p.mid[1], p.mid[2], 0.85],
          color1: fadeOf(p),
          sprite: SPR.wisp,
          spin: [-2.2, 2.2],
          fadeIn: 0.12,
          fadeOut: 0.4,
        });
        // A dark effect still needs a bright accent or it vanishes into the shadows.
        sys.emit({
          count: 18,
          position: pt,
          shape: 'sphere',
          radius: 0.5,
          speed: [1.6, 4.2],
          drag: 2.6,
          size: [0.14, 0.02],
          life: [0.4, 0.7],
          color0: p.core,
          color1: fadeOf(p),
          sprite: SPR.spark,
        });
      }
    });

    tl.at(0.95, () => {
      for (const pt of pts) {
        sys.emit({
          count: 1,
          position: pt.clone().setY(pt.y + 0.7 * sys.scale),
          size: [3.2, 0.2],
          life: [0.3, 0.3],
          color0: [p.core[0], p.core[1], p.core[2], 0.95],
          color1: fadeOf(p),
          sprite: SPR.halo,
          fadeIn: 0.06,
          fadeOut: 0.4,
        });
        sys.impactPunch(pt, power);
      }
      pts.forEach((pt, i) => o.onImpact?.(i, pt));
    });
    tl.hold(1.9);
  },

  // ── Support ─────────────────────────────────────────────────────────────
  'heal-sparkle': (sys, tl, o) => {
    const pts = impactPoints(o);
    tl.at(0.0, () => {
      for (const pt of pts) {
        sys.spawnMagicCircle(pt, tl, {
          radius: 1.0,
          color: new Color(0.6, 1.6, 0.9),
          accent: new Color(1.8, 2.6, 1.6),
          growAt: 0,
          holdUntil: 0.6,
          spin: 0.4,
          runes: 10,
        });
      }
    });
    tl.at(0.14, () => {
      for (const pt of pts) {
        // Rising motes with a slight orbit: reads unmistakably as restoration.
        sys.emit({
          count: 34,
          position: pt,
          shape: 'disc',
          radius: 0.65,
          speed: [1.1, 2.1],
          direction: new Vector3(0, 1, 0),
          spread: 0.18,
          drag: 0.9,
          size: [0.22, 0.05],
          life: [0.8, 1.35],
          color0: [1.4, 3.2, 1.8, 1],
          color1: [0.3, 0.9, 0.5, 0],
          sprite: [SPR.star4, SPR.star6, SPR.spark],
          orbit: { omega: 1.4, radial: -0.18 },
          spin: [-2, 2],
          fadeIn: 0.14,
          fadeOut: 0.5,
        });
        sys.emit({
          count: 3,
          position: pt,
          shape: 'ring',
          radius: 0.2,
          speed: [1.1, 1.5],
          size: [0.7, 2.2],
          life: [0.55, 0.8],
          color0: [0.8, 2.0, 1.1, 0.6],
          color1: [0.2, 0.6, 0.3, 0],
          sprite: SPR.ring,
          fadeIn: 0.1,
          fadeOut: 0.35,
        });
      }
      pts.forEach((pt, i) => o.onImpact?.(i, pt));
    });
    tl.hold(1.7);
  },

  'buff-aura': (sys, tl, o) => {
    const pts = impactPoints(o);
    tl.at(0.0, () => {
      for (const pt of pts) {
        sys.spawnMagicCircle(pt, tl, {
          radius: 1.05,
          color: new Color(1.5, 1.2, 0.6),
          accent: new Color(2.8, 2.4, 1.4),
          growAt: 0,
          holdUntil: 0.55,
          spin: 0.6,
          runes: 18,
        });
      }
    });
    tl.at(0.1, () => {
      for (const pt of pts) {
        // Three stacked rings sweeping up the body — the classic buff read.
        for (let i = 0; i < 3; i++) {
          sys.emit({
            count: 1,
            position: pt.clone().setY(pt.y + 0.05 * sys.scale),
            velocity: undefined,
            shape: 'point',
            speed: [0, 0],
            size: [1.9, 2.5],
            life: [0.55, 0.55],
            color0: [2.2, 1.9, 1.0, 0],
            color1: [1.2, 1.0, 0.5, 0],
            sprite: SPR.ring,
            fadeIn: 0.25,
            fadeOut: 0.4,
          } as BurstSpec);
        }
        sys.emit({
          count: 26,
          position: pt,
          shape: 'ring',
          radius: 0.55,
          speed: [1.3, 2.3],
          direction: new Vector3(0, 1, 0),
          spread: 0.12,
          size: [0.2, 0.05],
          life: [0.7, 1.1],
          color0: [3.0, 2.5, 1.2, 1],
          color1: [0.8, 0.65, 0.3, 0],
          sprite: SPR.spark,
          orbit: { omega: 3.4, radial: -0.2 },
          fadeIn: 0.12,
          fadeOut: 0.45,
        });
      }
      pts.forEach((pt, i) => o.onImpact?.(i, pt));
    });
    tl.hold(1.4);
  },

  'debuff-drip': (sys, tl, o) => {
    const pts = impactPoints(o);
    tl.at(0.0, () => {
      for (const pt of pts) {
        sys.emit({
          count: 22,
          position: pt.clone().setY(pt.y + 1.6 * sys.scale),
          shape: 'disc',
          radius: 0.5,
          speed: [0.1, 0.5],
          direction: new Vector3(0, -1, 0),
          spread: 0.4,
          gravity: -3.2,
          size: [0.18, 0.1],
          life: [0.8, 1.3],
          color0: [0.5, 0.18, 0.7, 0.9],
          color1: [0.18, 0.05, 0.28, 0],
          sprite: SPR.droplet,
          additive: false,
          stretch: 1.1,
          fadeIn: 0.15,
          fadeOut: 0.55,
        });
        sys.emit({
          count: 16,
          position: pt,
          shape: 'disc',
          radius: 0.7,
          speed: [0.2, 0.6],
          size: [0.5, 1.1],
          life: [0.9, 1.5],
          color0: [0.24, 0.08, 0.32, 0.55],
          color1: [0.12, 0.03, 0.18, 0],
          sprite: SPR.smoke,
          additive: false,
          spin: [-0.6, 0.6],
          fadeIn: 0.2,
          fadeOut: 0.4,
        });
      }
      pts.forEach((pt, i) => o.onImpact?.(i, pt));
    });
    tl.hold(1.6);
  },

  // ── Physical ────────────────────────────────────────────────────────────
  'slash-arc': (sys, tl, o) => {
    const power = o.power ?? 0.6;
    const pts = impactPoints(o);
    const mid = o.target.clone().lerp(o.origin, 0.25).setY(o.target.y + 0.9 * sys.scale);

    sys.spawnSlashArc(mid, tl, { at: 0.0, duration: 0.22, radius: 1.25, arc: Math.PI * 1.2, tilt: -0.5 });

    tl.at(0.1, () => {
      for (const pt of pts) {
        sys.playHitSpark(pt.clone().setY(pt.y + 0.85 * sys.scale), power, o.element ?? 'none');
        sys.playBloodBurst(pt.clone().setY(pt.y + 0.9 * sys.scale), power);
        sys.impactPunch(pt, power);
      }
      pts.forEach((pt, i) => o.onImpact?.(i, pt));
    });
    tl.hold(0.85);
  },

  'impact-flash': (sys, tl, o) => {
    const power = o.power ?? 0.8;
    const pts = impactPoints(o);
    tl.at(0.0, () => {
      for (const pt of pts) {
        const at = pt.clone().setY(pt.y + 0.8 * sys.scale);
        sys.emit({
          count: 1,
          position: at,
          size: [0.3, 5.0],
          life: [0.18, 0.18],
          color0: [6, 5.6, 5.0, 1],
          color1: [1.2, 1.0, 0.8, 0],
          sprite: SPR.halo,
          fadeIn: 0.03,
          fadeOut: 0.12,
        });
        sys.emit({
          count: 1,
          position: at,
          size: [0.4, 3.0],
          life: [0.22, 0.22],
          color0: [5, 4.6, 4.0, 1],
          color1: [1.0, 0.9, 0.7, 0],
          sprite: SPR.star4,
          spin: [-1, 1],
          fadeIn: 0.03,
          fadeOut: 0.15,
        });
        sys.emit({
          count: 20,
          position: at,
          shape: 'sphere',
          radius: 0.1,
          speed: [4.0, 9.0],
          drag: 3.5,
          size: [0.16, 0.02],
          life: [0.16, 0.3],
          color0: [4.5, 4.2, 3.6, 1],
          color1: [0.8, 0.7, 0.5, 0],
          sprite: SPR.streak,
          stretch: 2.6,
          fadeIn: 0.03,
        });
        sys.impactPunch(pt, power);
      }
      pts.forEach((pt, i) => o.onImpact?.(i, pt));
    });
    tl.hold(0.6);
  },

  'hit-spark': (sys, tl, o) => {
    const power = o.power ?? 0.45;
    const pts = impactPoints(o);
    tl.at(0.0, () => {
      for (const pt of pts) {
        const at = pt.clone().setY(pt.y + 0.85 * sys.scale);
        sys.playHitSpark(at, power, o.element ?? 'none');
        sys.playBloodBurst(at, power * 0.7);
        sys.shake.add(0.14 + 0.2 * power);
      }
      pts.forEach((pt, i) => o.onImpact?.(i, pt));
    });
    tl.hold(0.55);
  },

  'dust-puff': (sys, tl, o) => {
    tl.at(0.0, () => {
      sys.playLandingDust(o.target, o.power ?? 0.5);
      sys.shake.add(0.1 + 0.2 * (o.power ?? 0.5));
      o.onImpact?.(0, o.target);
    });
    tl.hold(1.0);
  },

  // ── Summoning ───────────────────────────────────────────────────────────
  'summon-circle': (sys, tl, o) => {
    const p = pal(o);
    const power = o.power ?? 1.0;
    const centre = o.target;

    sys.spawnMagicCircle(centre, tl, {
      radius: 3.2,
      color: new Color(p.mid[0], p.mid[1], p.mid[2]),
      accent: new Color(p.core[0] * 0.6, p.core[1] * 0.6, p.core[2] * 0.6),
      growAt: 0,
      holdUntil: 1.55,
      spin: 0.18,
      runes: 28,
    });

    // Rune glyphs orbiting above the circle while it charges.
    tl.at(0.25, () => {
      sys.emit({
        count: 14,
        position: centre.clone().setY(centre.y + 0.5 * sys.scale),
        shape: 'ring',
        radius: 2.4,
        speed: [0.25, 0.5],
        direction: new Vector3(0, 1, 0),
        spread: 0.15,
        size: [0.62, 0.62],
        life: [1.5, 1.5],
        color0: [p.core[0] * 0.5, p.core[1] * 0.5, p.core[2] * 0.5, 0],
        color1: [p.mid[0], p.mid[1], p.mid[2], 0],
        sprite: [SPR.runeA, SPR.runeB, SPR.runeC, SPR.runeD],
        orbit: { omega: 0.9 },
        fadeIn: 0.2,
        fadeOut: 0.72,
      });
    });

    let acc = 0;
    tl.span(0.3, 1.5, (_t, ctx) => {
      acc += ctx.dt;
      if (acc < 0.05) return;
      acc = 0;
      sys.emit({
        count: 3,
        position: centre,
        shape: 'ring',
        radius: 3.0,
        speed: [1.2, 2.2],
        direction: new Vector3(0, 1, 0),
        spread: 0.2,
        drag: 0.8,
        size: [0.2, 0.04],
        life: [0.8, 1.2],
        color0: p.core,
        color1: fadeOf(p),
        sprite: [SPR.spark, SPR.star4],
        orbit: { omega: 1.8, radial: -0.35 },
        fadeIn: 0.12,
        fadeOut: 0.5,
      });
    });

    tl.at(1.55, () => {
      sys.spawnPillar(centre, tl, {
        at: 0,
        rise: 0.12,
        hold: 0.32,
        fall: 0.45,
        radius: 2.4,
        height: 11,
        core: new Color(p.core[0], p.core[1], p.core[2]),
        edge: new Color(p.mid[0], p.mid[1], p.mid[2]),
        rays: 14,
        scroll: 0.5,
      });
      sys.emit({
        count: 60,
        position: centre,
        shape: 'disc',
        radius: 2.6,
        speed: [3.0, 7.0],
        direction: new Vector3(0, 1, 0),
        spread: 0.5,
        drag: 1.4,
        size: [0.4, 0.06],
        life: [0.6, 1.1],
        color0: p.core,
        color1: fadeOf(p),
        sprite: [SPR.spark, SPR.star6],
        stretch: 0.6,
      });
      sys.emit({
        count: 6,
        position: centre,
        shape: 'ring',
        radius: 0.3,
        speed: [4.0, 6.5],
        size: [1.6, 7.0],
        life: [0.5, 0.75],
        color0: [p.core[0], p.core[1], p.core[2], 0.8],
        color1: fadeOf(p),
        sprite: SPR.ring,
        fadeIn: 0.05,
        fadeOut: 0.3,
      });
      sys.impactPunch(centre, power);
      sys.time.stop(0.09, 0.02);
      o.onImpact?.(0, centre);
    });
    tl.hold(3.0);
  },
};

// Aliases so the ability table can use either the elemental name or the shape name.
const ALIASES: Record<string, string> = {
  fire: 'fire-burst',
  ice: 'ice-shard',
  'ice-shatter': 'ice-shard',
  lightning: 'lightning-bolt',
  thunder: 'lightning-bolt',
  wind: 'wind-vortex',
  earth: 'earth-spike',
  quake: 'earth-spike',
  water: 'water-surge',
  holy: 'holy-pillar',
  dark: 'dark-tendril',
  heal: 'heal-sparkle',
  cure: 'heal-sparkle',
  buff: 'buff-aura',
  debuff: 'debuff-drip',
  slash: 'slash-arc',
  attack: 'slash-arc',
  impact: 'impact-flash',
  hit: 'hit-spark',
  dust: 'dust-puff',
  land: 'dust-puff',
  summon: 'summon-circle',
  'fire-generic': 'fire-burst',
  'ice-generic': 'ice-shard',
  'lightning-generic': 'lightning-bolt',
  'wind-generic': 'wind-vortex',
  'earth-generic': 'earth-spike',
  'water-generic': 'water-surge',
  'holy-generic': 'holy-pillar',
  'dark-generic': 'dark-tendril',
};

for (const [alias, target] of Object.entries(ALIASES)) {
  const def = EFFECTS[target];
  if (def && !EFFECTS[alias]) EFFECTS[alias] = def;
}

/** Every vfx key this system can play. Useful for a VFX gallery scene. */
export const VFX_KEYS: readonly string[] = Object.keys(EFFECTS).sort();
