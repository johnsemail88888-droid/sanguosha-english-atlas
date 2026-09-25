// AI-art world: texture-set planning, sky analysis, structure surface packing,
// terrain ground-use splat and prop-model fitting (all pure logic; the GPU side
// is covered by the screenshot QA).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { MapData, MapProp } from '../../../src/core/map';
import { generateMap } from '../../../src/sim/map/generate';
import {
  GROUND_LAYERS,
  MUD_FALLBACK_TINT,
  STRUCT_LAYERS,
  findSun,
  groundPlanUsable,
  planLayers,
  SKY_RAD_PER_IMAGE,
  setSkySunElevation,
  skyHorizonV,
  structPlanUsable,
  texFile,
  texSizesFor,
} from '../../../src/render/core/worldArt';
import { SURF, SURF_YAW_LO, SURF_YAW_SPAN, packSurf, structureMaterial, unpackSurf } from '../../../src/render/core/structureMaterial';
import {
  FLOW_STRIDE,
  GroundChannel,
  SPLAT_STRIDE,
  computeGroundSplat,
  dryness,
  groundStamps,
  mudAt,
  splatAt,
} from '../../../src/render/scene/terrainSplat';
import {
  GLB_PROP_TYPES,
  fitPropMatrix,
  fullyReplacedTypes,
  glbPropKind,
  normaliseGeometry,
  PropLodCell,
  propLodPlan,
  propTint,
  clothMasks,
  clothRecolour,
  setPropModelLoaderForTests,
  type GltfLoaderLike,
  type PropModel,
} from '../../../src/render/world/propModels';
import { buildPropGeometry, buildWorld } from '../../../src/render/world/world';
import { disposeWorldArt, setWorldArtPossibleForTests, worldTexturesSettled } from '../../../src/render/core/worldArt';
import { terrainMaterial } from '../../../src/render/scene/terrain';
import { buildTerrain } from '../../../src/render/scene/terrain';
import { setAssetListForTests, assetList } from '../../../src/game/assets';
import {
  SKY_FOG_EL_MAX,
  SKY_FOG_EL_MIN,
  SKY_FOG_LUT_H,
  SKY_FOG_LUT_W,
  activateSkyArtFog,
  applySkyArtFog,
  buildPaintedFogLut,
  disposeSkyArtFog,
  invAces,
  proceduralSkyFogColor,
  skyArtFogKey,
  skyArtFogOn,
  skyArtFogUniforms,
} from '../../../src/render/core/skyArtFog';
import { SKY } from '../../../src/render/palette';

const all = (names: readonly string[]): Set<string> => new Set(names.map(texFile));

describe('world art: texture plans', () => {
  it('uses each layer file when shipped', () => {
    const plan = planLayers(GROUND_LAYERS, all(GROUND_LAYERS));
    expect(plan.map((l) => l.file)).toEqual(GROUND_LAYERS.map(texFile));
    expect(plan.every((l) => l.tint.every((t) => t === 1))).toBe(true);
    expect(groundPlanUsable(plan)).toBe(true);
  });

  it('stands tinted dirt in for missing mud', () => {
    const files = all(GROUND_LAYERS.filter((n) => n !== 'mud'));
    const mud = planLayers(GROUND_LAYERS, files).find((l) => l.name === 'mud')!;
    expect(mud.file).toBe(texFile('dirt'));
    expect(mud.tint).toEqual(MUD_FALLBACK_TINT);
    expect(MUD_FALLBACK_TINT.every((t) => t < 1)).toBe(true);
  });

  it('keeps the procedural ground without grass / dirt / cliff', () => {
    expect(groundPlanUsable(planLayers(GROUND_LAYERS, new Set()))).toBe(false);
    expect(groundPlanUsable(planLayers(GROUND_LAYERS, all(['grass', 'dirt', 'paving'])))).toBe(false);
    expect(groundPlanUsable(planLayers(GROUND_LAYERS, all(['grass', 'dirt', 'cliff'])))).toBe(true);
    // paving missing → that layer is simply absent
    const p = planLayers(GROUND_LAYERS, all(['grass', 'dirt', 'cliff']));
    expect(p.find((l) => l.name === 'paving')!.file).toBeNull();
  });

  it('loads structure textures when any layer exists', () => {
    expect(structPlanUsable(planLayers(STRUCT_LAYERS, new Set()))).toBe(false);
    expect(structPlanUsable(planLayers(STRUCT_LAYERS, all(['brick'])))).toBe(true);
  });

  it('sizes textures per quality tier (low is smallest)', () => {
    const lo = texSizesFor('low');
    const md = texSizesFor('medium');
    const hi = texSizesFor('high');
    for (const k of ['ground', 'struct', 'sky'] as const) {
      expect(lo[k]).toBeLessThanOrEqual(md[k]);
      expect(md[k]).toBeLessThanOrEqual(hi[k]);
    }
    // texture memory (RGBA8 + mips ≈ 4/3): ground + structures stay small on every tier
    const mb = (s: ReturnType<typeof texSizesFor>): number =>
      ((s.ground * s.ground * GROUND_LAYERS.length + s.struct * s.struct * STRUCT_LAYERS.length) * 4 * 4) / 3 / 2 ** 20;
    expect(mb(hi)).toBeLessThan(40);
    expect(mb(lo)).toBeLessThan(10);
  });
});

describe('world art: sky analysis', () => {
  it('finds a bright painted sun', () => {
    const w = 64;
    const h = 32;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < px.length; i += 4) {
      px[i] = 90;
      px[i + 1] = 110;
      px[i + 2] = 150;
      px[i + 3] = 255;
    }
    for (let y = 18; y < 21; y++)
      for (let x = 50; x < 53; x++) {
        const i = (y * w + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = 255;
      }
    const s = findSun(px, w, h)!;
    expect(s.u).toBeCloseTo(51.5 / 64, 3);
    expect(s.v).toBeCloseTo(19.5 / 32, 3);
  });

  it('gives up on a flat or overexposed image', () => {
    const w = 16;
    const h = 8;
    const dim = new Uint8ClampedArray(w * h * 4).fill(120);
    expect(findSun(dim, w, h)).toBeNull();
    const white = new Uint8ClampedArray(w * h * 4).fill(255);
    expect(findSun(white, w, h)).toBeNull();
  });

  it('puts the horizon below the painted sun by the light elevation (capped)', () => {
    setSkySunElevation(0.2);
    expect(skyHorizonV(0.6)).toBeCloseTo(0.6 + 0.2 / SKY_RAD_PER_IMAGE, 5);
    // a high key light does not drag the painted ranges up into the sky
    setSkySunElevation(0.54);
    const capped = skyHorizonV(0.56);
    expect(capped).toBeLessThan(0.56 + 0.54 / SKY_RAD_PER_IMAGE);
    expect((capped - 0.56) * SKY_RAD_PER_IMAGE).toBeLessThanOrEqual(0.35);
    // clamped to the painted part of the image
    expect(skyHorizonV(0.99)).toBeLessThanOrEqual(0.88);
    expect(skyHorizonV(0.0)).toBeGreaterThanOrEqual(0.62);
    setSkySunElevation(Math.asin(0.5144));
  });
});

describe('world art: structure surfaces', () => {
  /** The structure material's GLSL after its onBeforeCompile hook (three's chunks as placeholders). */
  const compiled = (): { vertexShader: string; fragmentShader: string } => {
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n#include <worldpos_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main() {\n#include <color_fragment>\n}',
    };
    const m = structureMaterial();
    m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    return shader;
  };
  // the shader's decode of an interpolated aSurf value (mirrors the GLSL)
  const decodeYaw = (v: number): number => {
    const sid = Math.floor(v);
    const f = Math.min(SURF_YAW_LO + SURF_YAW_SPAN, Math.max(SURF_YAW_LO, v - sid));
    return ((f - SURF_YAW_LO) / SURF_YAW_SPAN) * Math.PI * 2;
  };

  it('keeps a whole-turn yaw away from the fraction wrap (no mosaic from interpolation noise)', () => {
    for (const id of [SURF.brick, SURF.roof, SURF.planks, SURF.paving, SURF.woodV]) {
      for (const yaw of [0, Math.PI * 2, -Math.PI * 2, Math.PI * 4, -Math.PI / 2 + Math.PI / 2]) {
        const v = packSurf(id, yaw);
        const f = v - Math.floor(v);
        expect(f).toBeGreaterThan(0.01);
        expect(f).toBeLessThan(0.99);
        // a varying a hair below / above the vertex value decodes to the same id and yaw
        for (const eps of [-2e-5, 0, 2e-5]) {
          expect(Math.floor(v + eps)).toBe(id);
          expect(decodeYaw(v + eps)).toBeLessThan(1e-3);
        }
      }
    }
    const glsl = compiled().fragmentShader;
    expect(glsl).not.toMatch(/fract\(\s*vSurf/);
    expect(glsl).toContain('float sid = floor(vSurf);');
    expect(glsl).toContain(`clamp(vSurf - sid, ${SURF_YAW_LO.toFixed(3)}`);
  });

  it('roof shells go to the double-sided builder with their roof-tile surface (textured and camera-safe)', () => {
    const map = generateMap(20260924);
    const count = (g: THREE.BufferGeometry, id: number): number => {
      const a = g.getAttribute('aSurf');
      let n = 0;
      for (let i = 0; i < a.count; i++) if (Math.floor(a.getX(i)) === id) n++;
      return n;
    };
    // a tiled city house: the tiles are in the (double-sided) shell, tagged as roof tiles
    const house = map.props.find((p) => p.type === 'house' && (p.variant === 0 || p.variant === 1))!;
    expect(house).toBeDefined();
    const g = buildPropGeometry(house, map)!;
    expect(count(g.cloth, SURF.roof)).toBeGreaterThan(0);
    expect(count(g.opaque, SURF.roof)).toBe(0);
    // the rest of the shell (underside) and the ornaments stay plain; walls keep their own surfaces
    expect(count(g.cloth, SURF.plain)).toBeGreaterThan(0);
    for (const x of [g.opaque, g.cloth, g.glow]) x.dispose();
    // a thatch roof: shell in the double-sided builder but plain (no roof tiles on straw)
    const thatch: MapProp = { type: 'house', variant: 3, x: 0, y: 0, z: 0, sx: 6.33, sy: 4.04, sz: 4.94, rot: -5.621 };
    const t = buildPropGeometry(thatch, map)!;
    expect(count(t.cloth, SURF.roof)).toBe(0);
    expect(t.cloth.getAttribute('position').count).toBeGreaterThan(0);
    for (const x of [t.opaque, t.cloth, t.glow]) x.dispose();
  });

  it('drops the procedural brick courses once the brick texture draws the mortar', () => {
    const vs = compiled().vertexShader;
    expect(vs).toContain('transformed = vec3(0.0)');
    expect(vs).toContain('uStructHas[0] > 0.5');
    const map = generateMap(20260924);
    const wall = map.props.find((p) => p.type === 'wall' && p.variant === 0 && p.sy > 3);
    expect(wall).toBeDefined();
    const g = buildPropGeometry(wall!, map)!;
    const a = g.opaque.getAttribute('aSurf');
    let courses = 0;
    let brick = 0;
    for (let i = 0; i < a.count; i++) {
      const id = Math.floor(a.getX(i));
      if (id === SURF.procDetail) courses++;
      if (id === SURF.brick) brick++;
    }
    expect(courses).toBeGreaterThan(0);
    expect(brick).toBeGreaterThan(0);
    g.opaque.dispose();
    g.cloth.dispose();
    g.glow.dispose();
  });

  it('packs surface id + yaw into one float', () => {
    expect(packSurf(SURF.plain, 1.2)).toBe(0);
    for (const id of [SURF.brick, SURF.plaster, SURF.roof, SURF.planks, SURF.paving, SURF.stone, SURF.woodV]) {
      for (const yaw of [0, 0.7, Math.PI, -2.1, 9.5]) {
        const u = unpackSurf(packSurf(id, yaw));
        expect(u.id).toBe(id);
        const d = Math.abs(((u.yaw - yaw) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        expect(Math.min(d, Math.PI * 2 - d)).toBeLessThan(1e-4);
      }
    }
  });
});

describe('world art: terrain ground-use splat', () => {
  const map = generateMap(20260924);
  const splat = computeGroundSplat(map);
  const n = map.res + 1;
  const at = (x: number, z: number): number[] => {
    const out = [0, 0, 0, 0];
    splatAt(splat, x, z, out);
    return out;
  };

  it('is deterministic and bounded', () => {
    expect(splat.splat.length).toBe(n * n * SPLAT_STRIDE);
    expect(splat.flow.length).toBe(n * n * FLOW_STRIDE);
    for (let i = 0; i < splat.splat.length; i++) {
      const v = splat.splat[i];
      expect(v >= 0 && v <= 1).toBe(true);
    }
    for (let i = 0; i < splat.flow.length; i += 2) expect(Math.hypot(splat.flow[i], splat.flow[i + 1])).toBeLessThanOrEqual(1 + 1e-5);
    const again = computeGroundSplat(map);
    expect(Buffer.from(again.splat.buffer).equals(Buffer.from(splat.splat.buffer))).toBe(true);
  });

  it('paves the palace forecourt and puts dirt roads through gates', () => {
    const palace = map.props.find((p) => p.type === 'palace');
    expect(palace).toBeDefined();
    expect(at(palace!.x, palace!.z)[GroundChannel.Paving]).toBeGreaterThan(0.9);
    const gates = map.props.filter((p) => p.type === 'gateTower');
    expect(gates.length).toBeGreaterThan(0);
    for (const g of gates) {
      // 12 m outside the gate, on the passage axis (local −Z)
      const c = Math.cos(g.rot);
      const s = Math.sin(g.rot);
      const lz = -g.sz / 2 - 12;
      const x = g.x + lz * s;
      const z = g.z + lz * c;
      const v = at(x, z);
      expect(Math.max(v[GroundChannel.Dirt], v[GroundChannel.Paving]), `gate at ${g.x},${g.z}`).toBeGreaterThan(0.7);
    }
  });

  it('writes road directions along the road axis', () => {
    const stamps = groundStamps(map).filter((s) => s.road && s.kind === 'capsule' && Math.hypot(s.bx - s.ax, s.bz - s.az) > 20);
    expect(stamps.length).toBeGreaterThan(0);
    let checked = 0;
    for (const s of stamps.slice(0, 6)) {
      const mx = (s.ax + s.bx) / 2;
      const mz = (s.az + s.bz) / 2;
      const ix = Math.round(((mx + map.size / 2) / map.size) * map.res);
      const iz = Math.round(((mz + map.size / 2) / map.size) * map.res);
      const k = (iz * n + ix) * FLOW_STRIDE;
      const fx = splat.flow[k];
      const fz = splat.flow[k + 1];
      const len = Math.hypot(fx, fz);
      if (len < 0.5) continue; // another road crossing wins here
      const dx = (s.bx - s.ax) / Math.hypot(s.bx - s.ax, s.bz - s.az);
      const dz = (s.bz - s.az) / Math.hypot(s.bx - s.ax, s.bz - s.az);
      if (Math.abs((fx / len) * dx + (fz / len) * dz) < 0.95) continue; // crossing road
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('muddies river banks, not dry land', () => {
    const wl = map.waterLevel;
    expect(mudAt(wl + 0.3, wl, 10, 10)).toBeGreaterThan(0.6);
    expect(mudAt(wl + 4, wl, 10, 10)).toBe(0);
    expect(mudAt(5, -100, 0, 0)).toBe(0);
  });

  it('dryness stays in 0..1 and rises on high ground', () => {
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < 200; i++) {
      const x = (i * 37) % 400;
      const z = (i * 91) % 400;
      const a = dryness(x, z, 0);
      const b = dryness(x, z, 30);
      expect(a >= 0 && a <= 1 && b >= 0 && b <= 1).toBe(true);
      lo += a;
      hi += b;
    }
    expect(hi).toBeGreaterThan(lo);
  });

  it('splatAt interpolates the vertex grid and is zero outside the map', () => {
    const cell = map.size / map.res;
    const x0 = -map.size / 2 + 40 * cell;
    const z0 = -map.size / 2 + 50 * cell;
    const k = (50 * n + 40) * SPLAT_STRIDE;
    expect(at(x0, z0)[3]).toBeCloseTo(splat.splat[k + 3], 5);
    expect(at(map.size, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('world art: prop models', () => {
  const prop = (type: MapProp['type'], variant = 0, extra: Partial<MapProp> = {}): MapProp => ({ type, x: 12, y: 3, z: -7, rot: 0.6, sx: 4, sy: 6, sz: 3, variant, ...extra });

  it('maps prop types / variants to shipped models', () => {
    expect(glbPropKind(prop('tree'))).toBe('tree');
    expect(glbPropKind(prop('tent', 2))).toBeNull(); // Nanman cone tent keeps its shape
    expect(glbPropKind(prop('tent', 0))).toBe('tent');
    expect(glbPropKind(prop('barricade', 1))).toBe('barricade');
    expect(glbPropKind(prop('barricade', 0))).toBeNull();
    expect(glbPropKind(prop('statue', 1))).toBe('statue');
    expect(glbPropKind(prop('wall'))).toBeNull();
    for (const k of GLB_PROP_TYPES) expect(k.length).toBeGreaterThan(0);
    expect([...fullyReplacedTypes(new Set(['tree', 'tent', 'rock']))].sort()).toEqual(['rock', 'tree']);
  });

  // a normalised model: unit height, pivot at the base centre
  const box = (w: number, h: number, d: number): { w: number; h: number; d: number } => ({ w, h, d });
  const corners = (b: { w: number; h: number; d: number }): THREE.Vector3[] => {
    const out: THREE.Vector3[] = [];
    for (const x of [-b.w / 2, b.w / 2]) for (const y of [0, b.h]) for (const z of [-b.d / 2, b.d / 2]) out.push(new THREE.Vector3(x, y, z));
    return out;
  };

  it('fits man-made props inside their footprint (rotated with the prop)', () => {
    const m = new THREE.Matrix4();
    for (const kind of ['crateStack', 'tent', 'barricade', 'brazier'] as const) {
      const p = prop(kind === 'tent' ? 'tent' : kind, kind === 'barricade' ? 1 : 0);
      const b = box(0.8, 1, 0.5);
      fitPropMatrix(kind, p, b, m);
      // back into the prop's frame
      const inv = new THREE.Matrix4().makeRotationY(-p.rot).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
      const bb = new THREE.Box3();
      for (const c of corners(b)) bb.expandByPoint(c.applyMatrix4(m).applyMatrix4(inv));
      const slack = kind === 'tent' ? 1.3 : 1.08; // the tent's guy ropes reach past the footprint (its body ≈ 0.75 of it), jitter is ±6 %
      const fw = kind === 'brazier' ? p.sx : Math.max(p.sx, p.sz);
      expect(bb.max.x - bb.min.x, kind).toBeLessThanOrEqual(fw * slack + 1e-6);
      expect(bb.max.z - bb.min.z, kind).toBeLessThanOrEqual(fw * slack + 1e-6);
      expect(bb.max.y, kind).toBeLessThanOrEqual(p.sy * 1.07 + 1e-6);
      expect(bb.min.y, kind).toBeGreaterThan(-p.sy * 0.1);
      // centred on the prop
      expect(Math.abs((bb.max.x + bb.min.x) / 2)).toBeLessThan(0.05 * p.sx + 1e-6);
    }
  });

  it('stands a tree trunk on its collider and keeps plausible proportions', () => {
    const m = new THREE.Matrix4();
    const p = prop('tree', 0, { sx: 5, sy: 8, sz: 0 });
    // a very narrow model: vertical stretch is capped instead of making a pole
    const b = box(0.3, 1, 0.3);
    fitPropMatrix('tree', p, b, m);
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    m.decompose(pos, q, s);
    expect(pos.x).toBeCloseTo(p.x, 6);
    expect(pos.z).toBeCloseTo(p.z, 6);
    expect(pos.y).toBeLessThanOrEqual(p.y);
    expect(s.y / Math.sqrt(s.x * s.z)).toBeLessThanOrEqual(1.35 * 1.0001);
    // deterministic per position
    const m2 = fitPropMatrix('tree', { ...p }, b, new THREE.Matrix4());
    expect(m2.equals(m)).toBe(true);
  });

  it('turns a model 90° when that matches the footprint better', () => {
    const m = new THREE.Matrix4();
    const p = prop('crateStack', 0, { rot: 0, sx: 2, sz: 6 });
    fitPropMatrix('crateStack', p, box(3, 1, 1), m); // long along X, footprint long along Z
    const s = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    // after the turn the model's X spans the footprint's Z (6 m): scale ≈ 2 not ≈ 0.67
    expect(s.x).toBeGreaterThan(1.5);
  });

  it('normalises a model: base at 0, unit height, trunk-foot pivot', () => {
    const g = new THREE.BufferGeometry();
    // a "tree": trunk foot around (2, 0, 1), canopy offset to +x
    const pts = [
      [1.9, 0, 0.9], [2.1, 0, 0.9], [2.0, 0, 1.1],
      [2.0, 2, 1.0], [4.0, 3, 1.0], [0.5, 4, 1.0],
    ];
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
    g.setIndex([0, 1, 2, 3, 4, 5]);
    const world = new THREE.Matrix4().makeTranslation(0, 10, 0).multiply(new THREE.Matrix4().makeScale(2, 2, 2));
    const { geometry, bounds } = normaliseGeometry(g, world, true);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.y).toBeCloseTo(0, 5);
    expect(bounds.h).toBeCloseTo(1, 5);
    // the trunk foot (x≈2, z≈1 before) is at the origin now
    const p = geometry.getAttribute('position');
    const footX = (p.getX(0) + p.getX(1) + p.getX(2)) / 3;
    const footZ = (p.getZ(0) + p.getZ(1) + p.getZ(2)) / 3;
    expect(Math.abs(footX)).toBeLessThan(1e-5);
    expect(Math.abs(footZ)).toBeLessThan(1e-5);
    // width measured around the pivot: the farthest canopy point decides
    expect(bounds.w).toBeGreaterThan(0.4);
  });

  it('recolours the painted tent: canvas → camp colour, crimson frame → a shade of it, wood kept', () => {
    // texel clusters of the shipped tent painting (sRGB bytes)
    const srgb = (r: number, g: number, b: number): THREE.Color => new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    const disp = (c: THREE.Color): [number, number, number] => [Math.sqrt(c.r), Math.sqrt(c.g), Math.sqrt(c.b)];
    const canvas = [srgb(208, 208, 208), srgb(208, 176, 176), srgb(176, 176, 176), srgb(240, 208, 208)];
    const frame = [srgb(112, 16, 48), srgb(144, 16, 48), srgb(144, 48, 80)];
    const wood = [srgb(112, 80, 48), srgb(80, 80, 48), srgb(80, 48, 16)];
    for (const c of canvas) expect(clothMasks(...disp(c)).canvas, c.getHexString()).toBeGreaterThan(0.8);
    for (const c of frame) {
      const m = clothMasks(...disp(c));
      expect(m.frame, c.getHexString()).toBeGreaterThan(0.8);
      expect(m.canvas).toBeLessThan(0.2);
    }
    for (const c of wood) {
      const m = clothMasks(...disp(c));
      expect(m.frame + m.canvas, c.getHexString()).toBeLessThan(0.15);
    }
    const wei = new THREE.Color();
    propTint('tent', prop('tent', 0, { color: '#2e5fa8' }), wei);
    const out = new THREE.Color();
    for (const c of canvas) {
      clothRecolour(c, wei, out);
      expect(out.b).toBeGreaterThan(out.r * 3); // Wei blue, not a pale tint of the painting
    }
    for (const c of frame) {
      clothRecolour(c, wei, out);
      expect(out.b).toBeGreaterThan(out.r); // no Shu-red trim in a Wei camp
      expect(out.b).toBeLessThan(clothRecolour(canvas[0], wei, new THREE.Color()).b); // darker than the cloth
    }
    for (const c of wood) {
      clothRecolour(c, wei, out);
      expect(Math.abs(out.r - c.r) + Math.abs(out.g - c.g) + Math.abs(out.b - c.b)).toBeLessThan(0.03);
    }
    // a dark camp (虎牢 '#3a3a3a') stays dark, its frame lighter than the cloth so the shape reads
    const dark = new THREE.Color();
    propTint('tent', prop('tent', 0, { color: '#3a3a3a' }), dark);
    const cl = clothRecolour(canvas[0], dark, new THREE.Color());
    const fr = clothRecolour(frame[0], dark, new THREE.Color());
    expect(cl.r + cl.g + cl.b).toBeLessThan(0.3);
    expect(fr.r + fr.g + fr.b).toBeGreaterThan(cl.r + cl.g + cl.b);
    // no camp colour: the painting as shipped
    const white = new THREE.Color();
    propTint('tent', prop('tent', 0), white);
    clothRecolour(frame[1], white, out);
    expect(out.equals(frame[1])).toBe(true);
  });

  it('tints tents by kingdom cloth and leaves plain props neutral-ish', () => {
    const c = new THREE.Color();
    propTint('tent', prop('tent', 0, { color: '#c0392b' }), c);
    expect(c.r).toBeGreaterThan(c.b);
    propTint('statue', prop('statue', 1), c);
    expect(Math.abs(c.r - c.g)).toBeLessThan(1e-6);
    expect(c.r).toBeGreaterThan(0.85);
    expect(c.r).toBeLessThan(1.15);
  });

  it('splits a LOD cell between near and far meshes as the camera moves', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const lod = geometry.clone();
    const model: PropModel = {
      kind: 'tree',
      geometry,
      lod,
      lodDistance: 50,
      material: new THREE.MeshStandardMaterial(),
      bounds: { w: 1, h: 1, d: 1 },
      dispose: () => undefined,
    };
    // a row of trees along X, 10 m apart: x = 0, 10, …, 90
    const list = Array.from({ length: 10 }, (_, i) => prop('tree', 0, { x: i * 10, z: 0, sx: 4, sy: 6, sz: 0 }));
    const cell = new PropLodCell(model, lod, list);
    const cam = new THREE.PerspectiveCamera();
    const at = (x: number, z: number): void => {
      cam.position.set(x, 20, z);
      cam.updateMatrixWorld(true);
      cell.update(cam);
    };
    at(0, 0);
    // |x| < 50 → near: 0, 10, 20, 30, 40
    expect(cell.near.count).toBe(5);
    expect(cell.far.count).toBe(5);
    expect(cell.near.visible && cell.far.visible).toBe(true);
    // the near mesh holds exactly the near instances' transforms
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let i = 0; i < cell.near.count; i++) {
      cell.near.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      expect(Math.abs(p.x)).toBeLessThan(50);
    }
    // a small move is ignored (no re-split, no upload)
    const v = cell.near.instanceMatrix.version;
    at(1, 0);
    expect(cell.near.instanceMatrix.version).toBe(v);
    // far away: everything far, the near mesh hidden
    at(1000, 0);
    expect(cell.near.count).toBe(0);
    expect(cell.near.visible).toBe(false);
    expect(cell.far.count).toBe(10);
    // right in the middle of the row: everything near
    at(45, 0);
    expect(cell.near.count).toBe(10);
    expect(cell.far.visible).toBe(false);
    cell.dispose();
  });

  it('plans a cheaper far LOD for dense kinds', () => {
    const plan = propLodPlan('tree', 5000);
    expect(plan).not.toBeNull();
    expect(plan!.ratio).toBeLessThan(0.5);
    expect(plan!.distance).toBeGreaterThan(30);
    expect(propLodPlan('statue', 5000)).toBeNull();
    expect(propLodPlan('tree', 300)).toBeNull(); // already cheap
  });
});

describe('world art: fallback without files', () => {
  afterEach(() => setAssetListForTests(null));

  it('builds the procedural world when nothing is shipped', async () => {
    setAssetListForTests([]);
    await assetList();
    const map = generateMap(20260924);
    const w = buildWorld(map);
    await w.artReady;
    expect(w.stats.failed).toBe(0);
    let aSurf = 0;
    w.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry.getAttribute('aSurf')) aSurf++;
    });
    // opaque chunks carry the surface channel either way (cheap, ignored by the plain material)
    expect(aSurf).toBeGreaterThan(0);
    w.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !Array.isArray(m.material)) expect((m.material as THREE.Material).name).not.toBe('structure');
    });
    w.dispose();
    const t = buildTerrain(map);
    t.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) expect(m.geometry.getAttribute('aSplat')).toBeUndefined();
    });
    t.dispose();
  });
});

// The art paths of buildWorld / buildTerrain with world art forced on (node has
// no image decoding, so worldArtPossible() is overridden) and prop models served
// by a stub loader: swap meshes, retirement of the procedural stand-ins, the
// per-kind fallback when a model fails, structure / terrain material switches.
describe('world art: art paths (models and textures listed)', () => {
  const PROP_FILES = GLB_PROP_TYPES.map((t) => `assets/models/props/${t}.glb`);
  /** a stub GLB: one textured-less mesh, a finely tessellated blob for plants / rocks (LOD path) */
  const stubLoader = (fail: ReadonlySet<string>): GltfLoaderLike => ({
    async loadAsync(url: string) {
      const kind = url.replace(/^.*\//, '').replace('.glb', '');
      if (fail.has(kind)) throw new Error(`stub: ${kind} missing`);
      const dense = kind === 'tree' || kind === 'rock';
      const geo = dense ? new THREE.SphereGeometry(1, 64, 32) : new THREE.BoxGeometry(2, 1, 1.5);
      const scene = new THREE.Group();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
      mesh.position.set(0.1, 0.5, 0);
      scene.add(mesh);
      return { scene };
    },
  });
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setWorldArtPossibleForTests(true);
    // texture decoding has no fetch target in node: every file fails (and warns)
    vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    setWorldArtPossibleForTests(null);
    setPropModelLoaderForTests(null);
    setAssetListForTests(null);
    disposeWorldArt();
    vi.unstubAllGlobals();
    warn.mockRestore();
  });

  const meshNames = (g: THREE.Object3D): string[] => {
    const out: string[] = [];
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) out.push(o.name);
    });
    return out;
  };

  it('instances the models and retires the procedural stand-ins, keeping those whose model failed', async () => {
    setAssetListForTests(PROP_FILES);
    await assetList();
    setPropModelLoaderForTests(stubLoader(new Set(['barricade'])));
    const map = generateMap(20260924);
    const w = buildWorld(map);
    // before the models arrive: swappable props sit in per-kind swap meshes, drawn procedurally
    const before = meshNames(w.group);
    expect(before.some((n) => n.startsWith('chunk_swap_tent_'))).toBe(true);
    expect(before.some((n) => n.startsWith('chunk_swap_barricade_'))).toBe(true);
    expect(before.some((n) => n.startsWith('nature_'))).toBe(true);
    const tentGeos: THREE.BufferGeometry[] = [];
    w.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.name.startsWith('chunk_swap_tent_')) tentGeos.push((o as THREE.Mesh).geometry);
    });
    const disposed = new Set<THREE.BufferGeometry>();
    for (const g of tentGeos) g.addEventListener('dispose', () => disposed.add(g));
    const instancedBefore = w.stats.instanced;
    await w.artReady;
    const after = meshNames(w.group);
    // the tent stand-ins are gone (and their geometry freed), the barricade ones stay
    expect(after.some((n) => n.startsWith('chunk_swap_tent_'))).toBe(false);
    expect(disposed.size).toBe(tentGeos.length);
    expect(after.some((n) => n.startsWith('chunk_swap_barricade_'))).toBe(true);
    // models are drawn: instanced meshes per kind, LOD cells for the dense kinds
    const models = w.group.getObjectByName('propModels');
    expect(models).toBeDefined();
    const kinds = new Set<string>();
    let lodCells = 0;
    models!.traverse((o) => {
      const m = /^prop_([a-zA-Z]+)_/.exec(o.name);
      if (m) kinds.add(m[1]);
      if (o instanceof PropLodCell) lodCells++;
    });
    expect(kinds.has('tent')).toBe(true);
    expect(kinds.has('tree')).toBe(true);
    expect(kinds.has('barricade')).toBe(false);
    expect(lodCells).toBeGreaterThan(0);
    // trees / rocks left the procedural nature meshes
    expect(w.stats.instanced).not.toBe(instancedBefore);
    expect(w.stats.failed).toBe(0);
    w.dispose();
  });

  it('keeps every procedural stand-in when no model loads', async () => {
    setAssetListForTests(PROP_FILES);
    await assetList();
    setPropModelLoaderForTests(stubLoader(new Set(GLB_PROP_TYPES)));
    const map = generateMap(20260924);
    const w = buildWorld(map);
    const before = meshNames(w.group).filter((n) => n.startsWith('chunk_swap_') || n.startsWith('nature_')).sort();
    expect(before.length).toBeGreaterThan(0);
    await w.artReady;
    const after = meshNames(w.group).filter((n) => n.startsWith('chunk_swap_') || n.startsWith('nature_')).sort();
    expect(after).toEqual(before);
    expect(w.group.getObjectByName('propModels')).toBeUndefined();
    w.dispose();
  });

  it('switches structures and terrain to their textured materials when the textures are listed', async () => {
    const tex = ['grass', 'dirt', 'cliff', 'paving', 'mud', 'brick', 'plaster', 'rooftiles', 'planks'].map(texFile);
    setAssetListForTests(tex);
    await assetList();
    const map = generateMap(20260924);
    const w = buildWorld(map);
    const mats = new Set<string>();
    w.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.name.endsWith('_opaque')) mats.add((m.material as THREE.Material).name);
    });
    expect(mats).toEqual(new Set(['structure']));
    // the double-sided cloth chunks hold the roof shells (camera occluders, G3-2): the
    // textured double-sided variant keeps their tiles textured and their faces unculled
    const cloth = new Set<string>();
    w.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.name.startsWith('chunk_') && m.name.endsWith('_cloth')) {
        cloth.add((m.material as THREE.Material).name);
        expect((m.material as THREE.Material).side).toBe(THREE.DoubleSide);
        expect(m.geometry.getAttribute('aSurf')).toBeDefined();
      }
    });
    expect(cloth).toEqual(new Set(['structureDouble']));
    // and the camera occluders the roofs registered are still there
    expect(w.cameraOccluders.length).toBeGreaterThan(0);
    const t = buildTerrain(map);
    let splat = 0;
    t.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry.getAttribute('aSplat') && m.geometry.getAttribute('aFlow')) splat++;
    });
    expect(splat).toBe(t.group.children.length); // every chunk + the skirt
    expect(terrainMaterial().defines?.WORLD_TEX).toBeDefined();
    await worldTexturesSettled(); // (every decode fails here: the sets fall back to "no layer")
    t.dispose();
    expect(terrainMaterial().defines?.WORLD_TEX).toBeUndefined();
    w.dispose();
  });
});

describe('world art: painted-sky fog', () => {
  // three's ACESFilmicToneMapping (exposure 1)
  const aces = (c: number[]): number[] => {
    const v = c.map((x) => x / 0.6);
    const i = [
      0.59719 * v[0] + 0.35458 * v[1] + 0.04823 * v[2],
      0.076 * v[0] + 0.90834 * v[1] + 0.01566 * v[2],
      0.0284 * v[0] + 0.13383 * v[1] + 0.83777 * v[2],
    ];
    const r = i.map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081));
    return [
      1.60475 * r[0] - 0.53108 * r[1] - 0.07367 * r[2],
      -0.10208 * r[0] + 1.10813 * r[1] - 0.00605 * r[2],
      -0.00327 * r[0] - 0.07276 * r[1] + 1.07602 * r[2],
    ].map((x) => Math.min(1, Math.max(0, x)));
  };

  it('invAces is the inverse of the tone mapper', () => {
    for (const c of [[0.2, 0.3, 0.5], [0.8, 0.6, 0.3], [0.05, 0.06, 0.1], [0.9, 0.9, 0.85]]) {
      const inv = [0, 0, 0];
      invAces(c[0], c[1], c[2], inv);
      const back = aces(inv);
      for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(c[k], 2);
    }
  });

  it('builds a finite LUT that follows the painting and fades to its zenith', () => {
    // a 32×16 "painting": blue top half, orange bottom half
    const w = 32;
    const h = 16;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const top = y < h / 2;
        px[i] = top ? 40 : 230;
        px[i + 1] = top ? 80 : 150;
        px[i + 2] = top ? 200 : 60;
        px[i + 3] = 255;
      }
    const zenith = new THREE.Color(0.02, 0.05, 0.2);
    const lut = buildPaintedFogLut({ px, w, h }, { horizonV: 0.8, vPerRad: 1 / SKY_RAD_PER_IMAGE, seam: 0.07, zenith });
    expect(lut.length).toBe(SKY_FOG_LUT_W * SKY_FOG_LUT_H * 3);
    expect(lut.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
    const texel = (i: number, j: number): number[] => Array.from(lut.subarray((j * SKY_FOG_LUT_W + i) * 3, (j * SKY_FOG_LUT_W + i) * 3 + 3));
    // near the horizon (row of elevation ≈ 5°): warm; high up: blue, and the top row ≈ the inverted zenith
    const rowAt = (el: number): number => Math.round(((el - SKY_FOG_EL_MIN) / (SKY_FOG_EL_MAX - SKY_FOG_EL_MIN)) * SKY_FOG_LUT_H - 0.5);
    const low = texel(10, rowAt(0.08));
    const high = texel(10, rowAt(0.9));
    expect(low[0]).toBeGreaterThan(low[2]);
    expect(high[2]).toBeGreaterThan(high[0]);
    const top = texel(10, SKY_FOG_LUT_H - 1);
    const zInv = [0, 0, 0];
    invAces(zenith.r, zenith.g, zenith.b, zInv);
    for (let k = 0; k < 3; k++) expect(top[k]).toBeCloseTo(zInv[k], 3);
  });

  it('matches the procedural gradient CPU twin at the horizon and zenith', () => {
    const sun = new THREE.Vector3(-0.72, 0.5, 0.42).normalize();
    const c = new THREE.Color();
    proceduralSkyFogColor(new THREE.Vector3(0, 1, 0), sun, c);
    const z = new THREE.Color(SKY.zenith);
    // straight up: zenith colour plus a little sun glow
    expect(c.b).toBeGreaterThanOrEqual(z.b - 1e-6);
    proceduralSkyFogColor(new THREE.Vector3(1, -0.3, 0).normalize(), sun, c);
    const hz = new THREE.Color(SKY.haze);
    expect(c.r).toBeCloseTo(hz.r, 2);
  });

  it('compiles the LUT fog only while active and recompiles registered materials', () => {
    const mat = new THREE.MeshStandardMaterial();
    const shader = { uniforms: {} as Record<string, THREE.IUniform>, fragmentShader: 'void main() {}' };
    applySkyArtFog(shader, mat);
    expect(shader.fragmentShader).not.toContain('SKY_ART_FOG');
    expect(skyArtFogKey()).toBe('');
    const v = mat.version;
    activateSkyArtFog(new THREE.Vector3(-0.72, 0.5, 0.42));
    expect(skyArtFogOn()).toBe(true);
    expect(mat.version).toBeGreaterThan(v); // needsUpdate
    expect(skyArtFogKey()).not.toBe('');
    const s2 = { uniforms: {} as Record<string, THREE.IUniform>, fragmentShader: 'void main() {}' };
    applySkyArtFog(s2, mat);
    expect(s2.fragmentShader.startsWith('#define SKY_ART_FOG')).toBe(true);
    expect(s2.uniforms.uFogSkyTex).toBe(skyArtFogUniforms.uFogSkyTex);
    expect(skyArtFogUniforms.uFogSkyTex.value).not.toBeNull();
    disposeSkyArtFog();
    expect(skyArtFogOn()).toBe(false);
    expect(skyArtFogUniforms.uFogSkyTex.value).toBeNull();
  });
});
