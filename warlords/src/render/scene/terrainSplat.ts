// Ground-use splat for the textured terrain (AI-art mode): per heightfield
// vertex, how much of it is dirt (roads, camps, city ground), stone paving
// (palace forecourts, city streets, plazas) and riverbank mud, plus a macro
// "dryness" value and the local road direction (dirt / paving textures follow
// it). Derived purely from MapData — the same data the vertex colours use
// (heights, water level, slope) plus the structures standing on the ground —
// so every peer builds identical ground. MapData has no explicit road network
// (see CROSS-AREA note in the report): roads are reconstructed from gates,
// bridges and quays; an optional `map.roads` list is honoured when present.
import type { MapData, MapProp } from '../../core/map';
import { fbm2, valueNoise2 } from '../core/noise';

/** Floats per vertex in the splat array: dirt, paving, mud, dryness. */
export const SPLAT_STRIDE = 4;
/** Floats per vertex in the flow array: road direction x, z (length = road strength). */
export const FLOW_STRIDE = 2;

export const enum GroundChannel {
  Dirt = 0,
  Paving = 1,
  Mud = 2,
}

/** Optional explicit road list (not yet in MapData; honoured when a generator provides it). */
export interface RoadPath {
  pts: { x: number; z: number }[];
  width: number;
  paved?: boolean;
}

/** A soft ground stamp: capsule (a→b, half width r) or oriented rectangle. */
export interface GroundStamp {
  kind: 'capsule' | 'rect';
  ch: GroundChannel;
  /** capsule: segment ends; rect: centre in ax/az */
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** capsule: half width; rect: half extents hx (local X) / hz (local Z) */
  r: number;
  hz: number;
  rot: number;
  /** soft edge width (m), inside the shape */
  feather: number;
  strength: number;
  /** roads write their direction into the flow field */
  road: boolean;
  // bounds (world AABB, feather included)
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function capsule(ch: GroundChannel, ax: number, az: number, bx: number, bz: number, r: number, feather: number, strength: number, road: boolean): GroundStamp {
  return {
    kind: 'capsule',
    ch,
    ax,
    az,
    bx,
    bz,
    r,
    hz: 0,
    rot: 0,
    feather,
    strength,
    road,
    minX: Math.min(ax, bx) - r,
    maxX: Math.max(ax, bx) + r,
    minZ: Math.min(az, bz) - r,
    maxZ: Math.max(az, bz) + r,
  };
}

function rect(ch: GroundChannel, cx: number, cz: number, hx: number, hz: number, rot: number, feather: number, strength: number): GroundStamp {
  const c = Math.abs(Math.cos(rot));
  const s = Math.abs(Math.sin(rot));
  const ex = hx * c + hz * s;
  const ez = hx * s + hz * c;
  return { kind: 'rect', ch, ax: cx, az: cz, bx: cx, bz: cz, r: hx, hz, rot, feather, strength, road: false, minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez };
}

const disc = (ch: GroundChannel, x: number, z: number, r: number, feather: number, strength: number): GroundStamp => capsule(ch, x, z, x, z, r, feather, strength, false);

/** World position of a prop-local point (same convention as render/world/propkit.ts). */
function local(p: MapProp, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  return { x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c };
}

const GATE_OUT = 58; // road length outside a gate (m)
const GATE_IN = 22; // and inside (towards the court)
const BRIDGE_APPROACH = 26;

/** The ground stamps a map implies (pure; exported for tests and tooling). */
export function groundStamps(map: MapData): GroundStamp[] {
  const out: GroundStamp[] = [];
  const roads = (map as MapData & { roads?: RoadPath[] }).roads;
  if (Array.isArray(roads)) {
    for (const r of roads) {
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const a = r.pts[i];
        const b = r.pts[i + 1];
        out.push(capsule(r.paved ? GroundChannel.Paving : GroundChannel.Dirt, a.x, a.z, b.x, b.z, r.width / 2, Math.min(2.5, r.width * 0.3), 1, true));
      }
    }
  }
  const city = map.regions.find((r) => r.id === 'luoyang');
  const inCity = (x: number, z: number): boolean => !!city && Math.hypot(x - city.center.x, z - city.center.z) < city.radius;
  for (const p of map.props) {
    const big = Math.max(p.sx, p.sz);
    switch (p.type) {
      case 'gateTower': {
        // the road runs through the gate passage (local Z): out of the gate (−Z) and into the court (+Z)
        const o = local(p, 0, -p.sz / 2 - GATE_OUT);
        const i = local(p, 0, p.sz / 2 + GATE_IN);
        const hw = Math.max(2.6, (p.sx - 7) / 2 + 0.6);
        out.push(capsule(GroundChannel.Dirt, o.x, o.z, i.x, i.z, hw + 1.2, 3, 1, true));
        if (inCity(p.x, p.z)) {
          // paved avenue from the gate to the city centre
          const g = local(p, 0, -p.sz / 2 - 3);
          const c = city ? { x: city.center.x, z: city.center.z } : i;
          out.push(capsule(GroundChannel.Paving, g.x, g.z, c.x, c.z, hw, 1.4, 1, true));
        }
        break;
      }
      case 'bridge': {
        // approach roads continue the deck axis (local X) on both banks
        for (const sgn of [-1, 1]) {
          const a = local(p, sgn * (p.sx / 2 - 1), 0);
          const b = local(p, sgn * (p.sx / 2 + BRIDGE_APPROACH), 0);
          out.push(capsule(GroundChannel.Dirt, a.x, a.z, b.x, b.z, p.sz / 2 + 0.8, 2.5, 1, true));
        }
        break;
      }
      case 'dock': {
        // trodden quay along the landward edge
        const land = [-1, 1]
          .map((sgn) => ({ sgn, h: sampleH(map, local(p, 0, sgn * (p.sz / 2 + 4))) }))
          .sort((a, b) => b.h - a.h)[0].sgn;
        const c = local(p, 0, land * (p.sz / 2 + 3.5));
        out.push(rect(GroundChannel.Dirt, c.x, c.z, p.sx / 2 + 2, 4, p.rot, 2.2, 0.95));
        break;
      }
      case 'palace': {
        // terrace footprint + a paved forecourt in front (local −Z)
        out.push(rect(GroundChannel.Paving, p.x, p.z, p.sx / 2 + 2.5, p.sz / 2 + 2.5, p.rot, 1.2, 1));
        const f = local(p, 0, -p.sz / 2 - 8);
        out.push(rect(GroundChannel.Paving, f.x, f.z, p.sx * 0.42, 9, p.rot, 1.5, 1));
        break;
      }
      case 'pavilion':
        out.push(rect(GroundChannel.Paving, p.x, p.z, p.sx / 2 + 1.6, p.sz / 2 + 1.6, p.rot, 1.2, 1));
        break;
      case 'statue':
        out.push(disc(GroundChannel.Paving, p.x, p.z, big * 0.6 + 1.4, 1, 0.95));
        break;
      case 'stairs': {
        const foot = local(p, 0, p.sz / 2 + 1.2);
        out.push(disc(p.variant === 1 ? GroundChannel.Dirt : GroundChannel.Paving, foot.x, foot.z, p.sx / 2 + 1.5, 1.2, 0.9));
        break;
      }
      case 'wall':
        // trodden strip along the foot of walls
        out.push(rect(GroundChannel.Dirt, p.x, p.z, p.sx / 2 + 0.6, p.sz / 2 + 1.8, p.rot, 1.4, 0.7));
        break;
      case 'house':
      case 'watchtower':
        out.push(rect(GroundChannel.Dirt, p.x, p.z, p.sx / 2 + 2.2, p.sz / 2 + 2.2, p.rot, 2.2, 0.85));
        break;
      case 'tent':
        out.push(disc(GroundChannel.Dirt, p.x, p.z, big * 0.65 + 2.6, 2.6, 0.95));
        break;
      case 'barricade':
      case 'crateStack':
        out.push(disc(GroundChannel.Dirt, p.x, p.z, big * 0.55 + 1.8, 1.8, 0.8));
        break;
      case 'brazier':
      case 'banner':
        if (!inCity(p.x, p.z)) out.push(disc(GroundChannel.Dirt, p.x, p.z, 2.4, 1.6, 0.75));
        break;
      case 'farmField':
        out.push(rect(GroundChannel.Dirt, p.x, p.z, p.sx / 2 + 1.2, p.sz / 2 + 1.2, p.rot, 1.2, 0.8));
        break;
      case 'ruin':
        out.push(rect(GroundChannel.Dirt, p.x, p.z, p.sx / 2 + 1.5, p.sz / 2 + 1.8, p.rot, 1.6, 0.6));
        break;
      default:
        break;
    }
  }
  // the city court: packed earth between the buildings (patchy: the shader breaks it up)
  if (city) out.push(disc(GroundChannel.Dirt, city.center.x, city.center.z, Math.max(10, city.radius - 10), 8, 0.62));
  for (const camp of map.camps) out.push(disc(GroundChannel.Dirt, camp.pos.x, camp.pos.z, 9, 4, 0.9));
  return out;
}

function sampleH(map: MapData, p: { x: number; z: number }): number {
  const half = map.size / 2;
  const n = map.res + 1;
  const ix = Math.round(((p.x + half) / map.size) * map.res);
  const iz = Math.round(((p.z + half) / map.size) * map.res);
  if (ix < 0 || iz < 0 || ix > map.res || iz > map.res) return -Infinity;
  return map.heights[iz * n + ix];
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Coverage (0..1) of a stamp at (x, z), and for roads the unit axis direction. */
function stampCoverage(s: GroundStamp, x: number, z: number): number {
  let d: number;
  if (s.kind === 'capsule') {
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-9 ? Math.min(1, Math.max(0, ((x - s.ax) * dx + (z - s.az) * dz) / len2)) : 0;
    const px = s.ax + dx * t - x;
    const pz = s.az + dz * t - z;
    d = s.r - Math.sqrt(px * px + pz * pz); // distance inside the edge
  } else {
    const c = Math.cos(s.rot);
    const sn = Math.sin(s.rot);
    const ox = x - s.ax;
    const oz = z - s.az;
    const lx = ox * c - oz * sn;
    const lz = ox * sn + oz * c;
    d = Math.min(s.r - Math.abs(lx), s.hz - Math.abs(lz));
  }
  if (d <= 0) return 0;
  return s.strength * smooth(0, s.feather, d);
}

/**
 * Macro dryness (0 lush … 1 dry) — the same noise the vertex colours use for
 * lush / dry grass patches, plus drier high ground.
 */
export function dryness(x: number, z: number, h: number): number {
  const n = fbm2(x * 0.02, z * 0.02, 3);
  const lush = smooth(0.35, 0.6, n);
  const dry = smooth(0.55, 0.8, n) * 0.8;
  return Math.min(1, Math.max(0, 0.45 - lush * 0.35 + dry * 0.55 + smooth(10, 22, h) * 0.35));
}

/** Riverbank mud (0..1) at height h: the wet band just above the water line and the river bed. */
export function mudAt(h: number, waterLevel: number, x: number, z: number): number {
  if (waterLevel < -50) return 0;
  const wobble = (valueNoise2(x * 0.15 + 3, z * 0.15 - 7) - 0.5) * 0.9;
  return smooth(waterLevel + 1.9 + wobble, waterLevel + 0.7, h);
}

export interface GroundSplat {
  /** (res+1)² × SPLAT_STRIDE: dirt, paving, mud, dryness */
  splat: Float32Array;
  /** (res+1)² × FLOW_STRIDE: road direction × strength */
  flow: Float32Array;
  res: number;
  size: number;
}

/** Evaluate the ground use for every heightfield vertex. Pure and deterministic. */
export function computeGroundSplat(map: MapData, stamps: GroundStamp[] = groundStamps(map)): GroundSplat {
  const n = map.res + 1;
  const cell = map.size / map.res;
  const half = map.size / 2;
  const splat = new Float32Array(n * n * SPLAT_STRIDE);
  const flow = new Float32Array(n * n * FLOW_STRIDE);
  // bucket stamps into a coarse grid so each vertex tests only nearby shapes
  const B = 16;
  const bsz = map.size / B;
  const buckets: GroundStamp[][] = Array.from({ length: B * B }, () => []);
  for (const s of stamps) {
    const i0 = Math.max(0, Math.floor((s.minX + half) / bsz));
    const i1 = Math.min(B - 1, Math.floor((s.maxX + half) / bsz));
    const j0 = Math.max(0, Math.floor((s.minZ + half) / bsz));
    const j1 = Math.min(B - 1, Math.floor((s.maxZ + half) / bsz));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * B + i].push(s);
  }
  for (let iz = 0; iz < n; iz++) {
    const z = -half + iz * cell;
    const bj = Math.min(B - 1, Math.max(0, Math.floor((z + half) / bsz)));
    for (let ix = 0; ix < n; ix++) {
      const x = -half + ix * cell;
      const bi = Math.min(B - 1, Math.max(0, Math.floor((x + half) / bsz)));
      const k = iz * n + ix;
      const h = map.heights[k];
      let dirt = 0;
      let paving = 0;
      let fx = 0;
      let fz = 0;
      let fw = 0;
      for (const s of buckets[bj * B + bi]) {
        if (x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
        const w = stampCoverage(s, x, z);
        if (w <= 0) continue;
        if (s.ch === GroundChannel.Paving) paving = Math.max(paving, w);
        else if (s.ch === GroundChannel.Dirt) dirt = Math.max(dirt, w);
        if (s.road && w > fw) {
          const dx = s.bx - s.ax;
          const dz = s.bz - s.az;
          const len = Math.hypot(dx, dz) || 1;
          fx = dx / len;
          fz = dz / len;
          fw = w;
        }
      }
      const o = k * SPLAT_STRIDE;
      splat[o] = dirt;
      splat[o + 1] = paving;
      splat[o + 2] = mudAt(h, map.waterLevel, x, z);
      splat[o + 3] = dryness(x, z, h);
      // direction is sign-free (a road has no heading): canonical half-plane
      if (fz < 0 || (fz === 0 && fx < 0)) {
        fx = -fx;
        fz = -fz;
      }
      flow[k * FLOW_STRIDE] = fx * fw;
      flow[k * FLOW_STRIDE + 1] = fz * fw;
    }
  }
  return { splat, flow, res: map.res, size: map.size };
}

/**
 * Bilinear splat lookup at a world point (dirt, paving, mud, dryness into `out`).
 * Outside the map: zeros (mud / dryness still 0).
 */
export function splatAt(g: GroundSplat, x: number, z: number, out: Float32Array | number[]): void {
  const half = g.size / 2;
  const fx = ((x + half) / g.size) * g.res;
  const fz = ((z + half) / g.size) * g.res;
  if (fx < 0 || fz < 0 || fx > g.res || fz > g.res) {
    out[0] = out[1] = out[2] = out[3] = 0;
    return;
  }
  const ix = Math.min(g.res - 1, Math.floor(fx));
  const iz = Math.min(g.res - 1, Math.floor(fz));
  const tx = fx - ix;
  const tz = fz - iz;
  const n = g.res + 1;
  const S = SPLAT_STRIDE;
  const a = (iz * n + ix) * S;
  const b = a + S;
  const c = a + n * S;
  const d = c + S;
  for (let i = 0; i < 4; i++) {
    const v = g.splat;
    out[i] = (v[a + i] * (1 - tx) + v[b + i] * tx) * (1 - tz) + (v[c + i] * (1 - tx) + v[d + i] * tx) * tz;
  }
}
