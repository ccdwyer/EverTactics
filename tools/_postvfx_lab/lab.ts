// Scratch visual harness for post.ts + vfx.ts. Deleted before hand-off.
import * as THREE from 'three';
import { PostStack } from '../../src/render/post';
import { VfxSystem, VFX_KEYS } from '../../src/render/vfx';

const SPRITE_LAYER = 3;

const params = new URLSearchParams(location.search);
const effectKey = params.get('vfx') ?? '';
const grade = params.get('grade') ?? 'dusk-plains';
const debug = params.get('debug') ?? 'off';
const disable = (params.get('off') ?? '').split(',').filter(Boolean);
const atTime = Number(params.get('t') ?? '0.4');

const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(1280, 720);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0d16);

// ── camera: tilted orthographic, 45 yaw / 30 pitch ──────────────────────────
const viewH = 14;
const aspect = 1280 / 720;
const camera = new THREE.OrthographicCamera(-viewH * aspect / 2, viewH * aspect / 2, viewH / 2, -viewH / 2, -100, 200);
const yaw = Math.PI / 4;
const pitch = THREE.MathUtils.degToRad(30);
const dist = 40;
camera.position.set(
  Math.cos(pitch) * Math.sin(yaw) * dist,
  Math.sin(pitch) * dist,
  Math.cos(pitch) * Math.cos(yaw) * dist,
);
camera.lookAt(0, 0.5, 0);
camera.updateProjectionMatrix();
camera.layers.enableAll();

// ── lighting ────────────────────────────────────────────────────────────────
const key = new THREE.DirectionalLight(0xffe9c4, 4.2);
key.position.set(8, 14, 6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
const cam = key.shadow.camera as THREE.OrthographicCamera;
cam.left = -16; cam.right = 16; cam.top = 16; cam.bottom = -16; cam.near = 0.5; cam.far = 60;
key.shadow.bias = -0.0008;
key.shadow.normalBias = 0.02;
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9dbbff, 0x2a2318, 1.5));

// ── terrain: stepped tile blocks ────────────────────────────────────────────
const N = 13;
const tileGeo = new THREE.BoxGeometry(1, 1, 1);
const surfaces = [
  new THREE.MeshStandardMaterial({ color: 0x5f7a3c, roughness: 0.95 }),
  new THREE.MeshStandardMaterial({ color: 0x6d5b40, roughness: 0.95 }),
  new THREE.MeshStandardMaterial({ color: 0x7d7d78, roughness: 0.85 }),
];
for (let x = 0; x < N; x++) {
  for (let z = 0; z < N; z++) {
    const cx = x - (N - 1) / 2;
    const cz = z - (N - 1) / 2;
    const r = Math.hypot(cx, cz);
    let h = 1;
    if (r > 4.2) h = 2;
    if (r > 6.0) h = 3;
    if (Math.abs(cx) < 1.5 && cz > 2) h = 1;
    const mat = surfaces[(x * 3 + z * 5) % 3]!;
    const m = new THREE.Mesh(tileGeo, mat);
    m.position.set(cx, h / 2 - 1, cz);
    m.scale.set(1, h, 1);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }
}

// ── sprites: real FFT sheets, billboarded, on the sprite layer ──────────────
const loader = new THREE.TextureLoader();
const spriteSheets = ['1000_Knight_Male_hd.png', '1004_Archer_Male_hd.png', '1002_Knight_Female_hd.png'];
const spritePositions = [new THREE.Vector3(-1.5, 0, 1.5), new THREE.Vector3(2, 0, 2.5), new THREE.Vector3(0.5, 0, -1)];
let spritesLoaded = 0;
spriteSheets.forEach((file, i) => {
  loader.load(`/assets/sprites/${file}`, (tex) => {
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({
      map: tex, transparent: true, alphaTest: 0.5, roughness: 1, side: THREE.DoubleSide,
    });
    // colour-key the sheet's black backdrop so we can judge real pixel-art silhouettes
    mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <alphatest_fragment>',
        'if (dot(diffuseColor.rgb, vec3(1.0)) < 0.02) discard;\n#include <alphatest_fragment>',
      );
    };
    // one 64px cell of the 8x8 sheet
    const geo = new THREE.PlaneGeometry(1.6, 1.6);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k++) {
      uv.setXY(k, uv.getX(k) / 8 + (i % 8) / 8, uv.getY(k) / 8 + 7 / 8);
    }
    uv.needsUpdate = true;
    const mesh = new THREE.Mesh(geo, mat);
    const p = spritePositions[i]!;
    mesh.position.set(p.x, 0.8, p.z);
    mesh.rotation.y = yaw;
    mesh.castShadow = true;
    mesh.layers.set(SPRITE_LAYER);
    scene.add(mesh);
    spritesLoaded++;
  });
});

// ── bright emitters so bloom has something legitimate to work with ─────────
const torchGeo = new THREE.SphereGeometry(0.12, 12, 12);
for (const p of [new THREE.Vector3(-4.5, 1.4, -4.5), new THREE.Vector3(4.5, 1.4, -3.5)]) {
  const m = new THREE.Mesh(torchGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 4.2, 1.2) }));
  m.position.copy(p);
  scene.add(m);
  const l = new THREE.PointLight(0xffb060, 6, 8);
  l.position.copy(p);
  scene.add(l);
}

// ── post + vfx ──────────────────────────────────────────────────────────────
const post = new PostStack(renderer, { spriteLayer: SPRITE_LAYER, tileSize: 1, grade });
post.setSize(1280, 720, 1);
post.settings.grain.animate = false;
post.debugView = debug as never;
for (const d of disable) post.setEffectEnabled(d as never, false);

const vfx = new VfxSystem({ tileSize: 1, seed: 0xabcdef });
vfx.attachPost(post);
vfx.addTo(scene);

let simTime = 0;
if (effectKey) {
  void vfx.play(effectKey, {
    origin: new THREE.Vector3(-1.5, 0, 1.5),
    target: new THREE.Vector3(0.5, 0, -1),
    element: (params.get('el') as never) ?? undefined,
    power: 0.9,
  });
}

const FIXED_DT = 1 / 60;
function step(): void {
  vfx.update(FIXED_DT, camera);
  post.render(scene, camera, FIXED_DT);
  simTime += FIXED_DT;
}

// Advance deterministically to the requested moment, then flag ready.
function boot(): void {
  const steps = Math.max(1, Math.round(atTime / FIXED_DT));
  for (let i = 0; i < steps; i++) step();
  (window as unknown as Record<string, unknown>).__EVERTACTICS_READY__ = true;
}

// Wait for sprite textures.
const waitStart = performance.now();
function poll(): void {
  if (spritesLoaded >= spriteSheets.length || performance.now() - waitStart > 4000) {
    boot();
    return;
  }
  requestAnimationFrame(poll);
}
poll();

(window as unknown as Record<string, unknown>).__LAB__ = { post, vfx, keys: VFX_KEYS, step };
