// Painted-sky fog (AI-art mode) — the state and data behind the SKY_ART_FOG
// variant of the fog chunk (scene/skyfog.ts): a small direction LUT of the
// painted panorama that world materials read their fog colour from, so far
// geometry fades into exactly the painted sky behind it. Materials opt in by
// calling applySkyArtFog() in onBeforeCompile (and skyArtFogKey() in their
// program cache key); the sky layer activates it when the deploy ships
// env/sky.webp and swaps the procedural placeholder LUT for the painting's.
import * as THREE from 'three';
import { SKY } from '../palette';

/** Fog LUT layout: azimuth (turns, offset by uFogSkyMap.x) × elevation [EL_MIN, EL_MAX]. */
export const SKY_FOG_LUT_W = 64;
export const SKY_FOG_LUT_H = 32;
export const SKY_FOG_EL_MIN = -0.35;
export const SKY_FOG_EL_MAX = Math.PI / 2;

/** Elevation (rad) of LUT row coordinate t (0 = bottom row, 1 = top row). */
export function skyFogLutElevation(t: number): number {
  return SKY_FOG_EL_MIN + t * (SKY_FOG_EL_MAX - SKY_FOG_EL_MIN);
}

/** Shared uniforms of the painted-sky fog (every SKY_ART_FOG program points at these objects). */
export const skyArtFogUniforms = {
  uFogSkyTex: { value: null as THREE.Texture | null },
  /** x: azimuth offset (turns), y: −EL_MIN, z: 1 / (EL_MAX − EL_MIN), w: colour gain */
  uFogSkyMap: { value: new THREE.Vector4(0, -SKY_FOG_EL_MIN, 1 / (SKY_FOG_EL_MAX - SKY_FOG_EL_MIN), 1) },
};

let artFog = false;
let fogSun = new THREE.Vector3(-0.72, 0.5, 0.42).normalize();
let fogLut: THREE.DataTexture | null = null;
const fogMats = new Set<THREE.Material>();

/** True while the world materials use the painted-sky fog LUT. */
export function skyArtFogOn(): boolean {
  return artFog;
}

/** Program cache key suffix for materials that call applySkyArtFog. */
export function skyArtFogKey(): string {
  return artFog ? '_skyfog' : '';
}

/**
 * Material hook, called from onBeforeCompile: compiles the painted-sky fog
 * variant while it is active, and remembers the material so it recompiles
 * when the fog mode changes.
 */
export function applySkyArtFog(shader: { uniforms: Record<string, THREE.IUniform>; fragmentShader: string }, mat: THREE.Material): void {
  if (!fogMats.has(mat)) {
    fogMats.add(mat);
    // per-instance clones (character bodies) come and go during a match
    const onDispose = (): void => {
      fogMats.delete(mat);
      mat.removeEventListener('dispose', onDispose);
    };
    mat.addEventListener('dispose', onDispose);
  }
  if (!artFog) return;
  shader.uniforms.uFogSkyTex = skyArtFogUniforms.uFogSkyTex;
  shader.uniforms.uFogSkyMap = skyArtFogUniforms.uFogSkyMap;
  shader.fragmentShader = `#define SKY_ART_FOG\n${shader.fragmentShader}`;
}

/**
 * Painted-sky fog for a material with no other shader changes. The hooks read
 * `this`, so a clone that carries them over (models/weapons.ts
 * cloneKeepingDefines) registers itself rather than its source.
 */
export function useSkyArtFog(mat: THREE.Material, key: string): void {
  mat.onBeforeCompile = function (this: THREE.Material, shader) {
    applySkyArtFog(shader, this);
  };
  mat.customProgramCacheKey = () => `${key}${skyArtFogKey()}`;
}

/** Test hook: how many materials are registered for fog-mode recompiles. */
export function skyArtFogMaterialCount(): number {
  return fogMats.size;
}

function refreshFogMaterials(): void {
  for (const m of fogMats) m.needsUpdate = true;
}

/** CPU twin of the procedural skyFogColor() GLSL (linear rgb into out). */
export function proceduralSkyFogColor(d: THREE.Vector3, sun: THREE.Vector3, out: THREE.Color): THREE.Color {
  const h = Math.min(1, Math.max(-0.2, d.y));
  const t = Math.pow(Math.min(1, Math.max(0, h)), 0.55);
  const hz = new THREE.Color(SKY.horizon);
  const ze = new THREE.Color(SKY.zenith);
  const hazeC = new THREE.Color(SKY.haze);
  out.copy(hz).lerp(ze, t);
  const k = Math.min(1, Math.max(0, (h - 0.08) / (-0.12 - 0.08)));
  out.lerp(hazeC, k * k * (3 - 2 * k));
  const sd = Math.max(0, d.dot(sun));
  const g = Math.pow(sd, 6) * 0.28;
  const sc = new THREE.Color(SKY.sun);
  out.r += sc.r * g;
  out.g += sc.g * g;
  out.b += sc.b * g;
  return out;
}

/** Half-float RGBA LUT texture (linear rgb, no mipmaps: sampled without derivatives). */
export function makeSkyFogLutTexture(rgb: Float32Array): THREE.DataTexture {
  const W = SKY_FOG_LUT_W;
  const H = SKY_FOG_LUT_H;
  const data = new Uint16Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = THREE.DataUtils.toHalfFloat(rgb[i * 3]);
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(rgb[i * 3 + 1]);
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(rgb[i * 3 + 2]);
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** The procedural sky gradient baked into the LUT layout (azimuth offset 0). */
function bakeProceduralLut(sun: THREE.Vector3): THREE.DataTexture {
  const W = SKY_FOG_LUT_W;
  const H = SKY_FOG_LUT_H;
  const rgb = new Float32Array(W * H * 3);
  const d = new THREE.Vector3();
  const c = new THREE.Color();
  for (let j = 0; j < H; j++) {
    const el = skyFogLutElevation((j + 0.5) / H);
    for (let i = 0; i < W; i++) {
      // u = fract(0 − azimuth / 2π) → azimuth = −u · 2π
      const az = -((i + 0.5) / W) * Math.PI * 2;
      d.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
      proceduralSkyFogColor(d, sun, c);
      const o = (j * W + i) * 3;
      rgb[o] = c.r;
      rgb[o + 1] = c.g;
      rgb[o + 2] = c.b;
    }
  }
  return makeSkyFogLutTexture(rgb);
}

/**
 * Switch the world materials to the LUT fog (the deploy ships a painted sky).
 * The LUT starts as the procedural gradient; setSkyArtFogLut swaps in the painting.
 */
export function activateSkyArtFog(sunDir: THREE.Vector3): void {
  if (artFog) return;
  artFog = true;
  fogSun = sunDir.clone().normalize();
  fogLut?.dispose();
  fogLut = bakeProceduralLut(fogSun);
  skyArtFogUniforms.uFogSkyTex.value = fogLut;
  skyArtFogUniforms.uFogSkyMap.value.x = 0;
  skyArtFogUniforms.uFogSkyMap.value.w = 1;
  refreshFogMaterials();
}

/** The painted sky's LUT (painting u space) and the azimuth offset that aligns it with the dome. */
export function setSkyArtFogLut(tex: THREE.DataTexture, azimuthOffsetTurns: number): void {
  if (!artFog) return;
  if (fogLut && fogLut !== tex) fogLut.dispose();
  fogLut = tex;
  skyArtFogUniforms.uFogSkyTex.value = tex;
  skyArtFogUniforms.uFogSkyMap.value.x = azimuthOffsetTurns;
}

/** Colour gain of the LUT (the painted LUT is stored for exposure 1: gain = 1 / exposure). */
export function setSkyArtFogGain(gain: number): void {
  skyArtFogUniforms.uFogSkyMap.value.w = gain;
}

/**
 * CPU twin of the dome's invACES() at exposure 1: the linear colour that three's
 * ACES filmic tone mapping turns back into `rgb` (written into out[o..o+2]).
 */
export function invAces(r: number, g: number, b: number, out: Float32Array | number[], o = 0): void {
  const cl = (v: number, hi: number): number => Math.min(hi, Math.max(0, v));
  r = cl(r, 0.97);
  g = cl(g, 0.97);
  b = cl(b, 0.97);
  // inverse ACESOutputMat
  let x = cl(0.643038 * r + 0.311187 * g + 0.045775 * b, 0.97);
  let y = cl(0.059269 * r + 0.931436 * g + 0.009295 * b, 0.97);
  let z = cl(0.005962 * r + 0.063929 * g + 0.930118 * b, 0.97);
  const rrt = (v: number): number => {
    const A = 0.983729 * v - 1.0;
    const B = 0.432951 * v - 0.0245786;
    const C = 0.238081 * v + 0.000090537;
    return (-B - Math.sqrt(Math.max(B * B - 4 * A * C, 0))) / (2 * A);
  };
  x = rrt(x);
  y = rrt(y);
  z = rrt(z);
  // inverse ACESInputMat, then undo three's `color *= exposure / 0.6`
  out[o] = Math.max(0, 1.764741 * x - 0.675778 * y - 0.088963 * z) * 0.6;
  out[o + 1] = Math.max(0, -0.147028 * x + 1.160252 * y - 0.013224 * z) * 0.6;
  out[o + 2] = Math.max(0, -0.036337 * x - 0.162436 * y + 1.198773 * z) * 0.6;
}

/** Where and how the painted panorama sits on the dome (see scene/sky.ts). */
export interface PaintedSkyMapping {
  /** texture v of the painted horizon */
  horizonV: number;
  /** image heights per radian of elevation */
  vPerRad: number;
  /** width of the cross-faded seam (fraction of the image width; 0 = the image already tiles) */
  seam: number;
  /** linear colour above the painting's top edge */
  zenith: THREE.Color;
}

/**
 * Fog LUT of the painted sky (painting u space, SKY_FOG_LUT layout): the
 * panorama blurred to ~6°, mapped exactly like the dome (seam, zenith fade),
 * pre-compensated for the tone mapping at exposure 1. Pure.
 */
export function buildPaintedFogLut(preview: { px: Uint8ClampedArray | Uint8Array; w: number; h: number }, m: PaintedSkyMapping): Float32Array {
  const W = SKY_FOG_LUT_W;
  const H = SKY_FOG_LUT_H;
  const { px, w, h } = preview;
  const lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    lin[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  const acc = [0, 0, 0];
  // box-filtered lookup around (u, v) in the preview (u wraps, v clamps)
  const sample = (u: number, v: number, into: number[], k: number): void => {
    const cx = u * w;
    const cy = Math.min(h - 1, Math.max(0, v * h));
    const rx = Math.max(1, Math.round(w / W / 2));
    const ry = Math.max(1, Math.round(h * 0.02));
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let dy = -ry; dy <= ry; dy++) {
      const y = Math.min(h - 1, Math.max(0, Math.round(cy) + dy));
      for (let dx = -rx; dx <= rx; dx++) {
        const x = (((Math.round(cx) + dx) % w) + w) % w;
        const i = (y * w + x) * 4;
        r += lin[px[i]];
        g += lin[px[i + 1]];
        b += lin[px[i + 2]];
        n++;
      }
    }
    into[0] += (r / n) * k;
    into[1] += (g / n) * k;
    into[2] += (b / n) * k;
  };
  const out = new Float32Array(W * H * 3);
  const topEl = m.horizonV / m.vPerRad;
  const sstep = (a: number, b: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let j = 0; j < H; j++) {
    const el = skyFogLutElevation((j + 0.5) / H);
    const v = m.horizonV - el * m.vPerRad;
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W;
      acc[0] = acc[1] = acc[2] = 0;
      // (seam 0: the painting already wraps seamlessly — makePanoramaTileable)
      const t = m.seam > 0 ? sstep(1 - m.seam, 1, u) : 0;
      sample(u, v, acc, 1 - t);
      if (t > 0) sample(1 - u, v, acc, t);
      const z = sstep(topEl - 0.32, topEl - 0.02, el);
      const r = acc[0] + (m.zenith.r - acc[0]) * z;
      const g = acc[1] + (m.zenith.g - acc[1]) * z;
      const b = acc[2] + (m.zenith.b - acc[2]) * z;
      // linear painted colour → what the tone mapper must receive to show it as painted
      invAces(r, g, b, out, (j * W + i) * 3);
    }
  }
  return out;
}

/** Renderer teardown: back to the procedural fog (the next match re-activates it). */
export function disposeSkyArtFog(): void {
  if (artFog) refreshFogMaterials();
  artFog = false;
  fogLut?.dispose();
  fogLut = null;
  skyArtFogUniforms.uFogSkyTex.value = null;
  fogMats.clear();
}

