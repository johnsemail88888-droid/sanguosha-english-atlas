// Dev-only: a small hand-made MapData with one of every PropType (and every
// variant) laid out in a grid, plus a river, so the renderer can be checked
// without depending on the real generator. Colliders come from the sim's own
// propColliders() so pick/camera collision match.
import type { MapData, MapProp, PropType } from '../../core/map';
import { terrainHeight } from '../../core/map';
import { propColliders } from '../../sim/map/props';
import { fbm2 } from '../core/noise';

interface Spec {
  type: PropType;
  sx: number;
  sy: number;
  sz: number;
  variants: number;
  color?: string;
}

const SPECS: Spec[] = [
  { type: 'palace', sx: 26, sy: 14, sz: 18, variants: 1 },
  { type: 'gateTower', sx: 16, sy: 8, sz: 7, variants: 2 },
  { type: 'wall', sx: 16, sy: 7, sz: 5, variants: 1 },
  { type: 'wall', sx: 14, sy: 3, sz: 0.8, variants: 4 },
  { type: 'house', sx: 9, sy: 6.5, sz: 7, variants: 5 },
  { type: 'pavilion', sx: 6, sy: 6, sz: 6, variants: 2 },
  { type: 'watchtower', sx: 4, sy: 7, sz: 4, variants: 2 },
  { type: 'tent', sx: 5, sy: 3, sz: 4, variants: 4, color: '#c0392b' },
  { type: 'barricade', sx: 4, sy: 1.2, sz: 1, variants: 3 },
  { type: 'crateStack', sx: 3.4, sy: 2.4, sz: 2.2, variants: 3 },
  { type: 'rock', sx: 3, sy: 2, sz: 2.5, variants: 4 },
  { type: 'tree', sx: 6, sy: 9, sz: 6, variants: 3 },
  { type: 'pine', sx: 4, sy: 10, sz: 4, variants: 2 },
  { type: 'bamboo', sx: 3, sy: 8, sz: 3, variants: 1 },
  { type: 'statue', sx: 2.4, sy: 4.5, sz: 2.4, variants: 4 },
  { type: 'banner', sx: 1.4, sy: 6, sz: 0.2, variants: 1, color: '#2e5fa8' },
  { type: 'banner', sx: 1.4, sy: 6, sz: 0.2, variants: 1, color: '#c0392b' },
  { type: 'banner', sx: 1.4, sy: 6, sz: 0.2, variants: 1, color: '#2e8b57' },
  { type: 'brazier', sx: 1.1, sy: 1.3, sz: 1.1, variants: 1 },
  { type: 'ruin', sx: 8, sy: 4, sz: 1.2, variants: 3 },
  { type: 'farmField', sx: 14, sy: 0, sz: 10, variants: 3 },
  { type: 'stairs', sx: 3, sy: 3.2, sz: 5, variants: 2 },
];

export const SHOWCASE_SIZE = 240;
export const SHOWCASE_RES = 120;
export const SHOWCASE_WATER = 1;
/** z of the river centre line in the showcase map */
export const SHOWCASE_RIVER_Z = 70;

function heightAt(x: number, z: number): number {
  // gentle rolling ground + a river trench + a hill rim
  let h = 4 + (fbm2(x * 0.012 + 3, z * 0.012 - 7, 3) - 0.5) * 3;
  const dz = Math.abs(z - SHOWCASE_RIVER_Z);
  if (dz < 16) h = h * (dz / 16) + (SHOWCASE_WATER - 1.4) * (1 - dz / 16) + (dz > 10 ? 0 : 0);
  const edge = Math.max(Math.abs(x), Math.abs(z)) - (SHOWCASE_SIZE / 2 - 20);
  if (edge > 0) h += edge * 1.2 + (fbm2(x * 0.05, z * 0.05, 2) - 0.5) * edge * 0.8;
  return h;
}

export function buildShowcaseMap(seed = 1): MapData {
  const n = SHOWCASE_RES + 1;
  const heights = new Float32Array(n * n);
  const cell = SHOWCASE_SIZE / SHOWCASE_RES;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = heightAt(-SHOWCASE_SIZE / 2 + i * cell, -SHOWCASE_SIZE / 2 + j * cell);
  const map: MapData = {
    seed,
    nameZh: '渲染展示场',
    nameEn: 'Render Showcase',
    size: SHOWCASE_SIZE,
    res: SHOWCASE_RES,
    heights,
    waterLevel: SHOWCASE_WATER,
    props: [],
    colliders: [],
    lordSpawn: { x: 0, y: 4, z: 20 },
    spawns: [{ x: 0, y: 4, z: 20 }],
    lootSpots: [],
    crateSpots: [],
    camps: [],
    regions: [],
  };
  const props: MapProp[] = [];
  // grid of props (rows of increasing z behind the lineup area)
  let x = -95;
  let z = -30;
  let rowDepth = 0;
  for (const s of SPECS) {
    for (let v = 0; v < s.variants; v++) {
      const w = Math.max(s.sx, 3) + 5;
      if (x + w > 95) {
        x = -95;
        z -= rowDepth + 6;
        rowDepth = 0;
      }
      const px = x + w / 2;
      const pz = z;
      const y = minHeightUnder(map, px, pz, s.sx, s.sz) - (s.type === 'farmField' ? 0 : 0.2);
      props.push({ type: s.type, x: px, y, z: pz, rot: 0, sx: s.sx, sy: s.sy, sz: s.sz, variant: v, color: s.color });
      x += w;
      rowDepth = Math.max(rowDepth, s.sz);
    }
  }
  // river props: bridges (3 variants), dock, ships
  const riverY = SHOWCASE_WATER;
  const deckY = riverY + 1.6;
  [-60, -20, 20].forEach((bx, v) => props.push({ type: 'bridge', x: bx, y: deckY, z: SHOWCASE_RIVER_Z, rot: Math.PI / 2, sx: 30, sy: deckY - (SHOWCASE_WATER - 1.4), sz: 5, variant: v }));
  props.push({ type: 'dock', x: 55, y: riverY + 0.9, z: SHOWCASE_RIVER_Z - 9, rot: 0, sx: 16, sy: 3, sz: 5, variant: 0 });
  [0, 1, 2].forEach((v) =>
    props.push({ type: 'ship', x: 40 + v * 26 - 20, y: riverY + 1.2, z: SHOWCASE_RIVER_Z + 3, rot: 0, sx: 22, sy: 2.6, sz: 6, variant: v, color: v === 1 ? '#3a2a1a' : '#8a2a22' }),
  );
  // a forest patch and rocks near the lineup for vegetation shading
  for (let i = 0; i < 40; i++) {
    const a = i * 2.39996;
    const r = 8 + Math.sqrt(i) * 5;
    const px = 70 + Math.cos(a) * r * 0.6;
    const pz = 10 + Math.sin(a) * r * 0.6;
    const t: PropType = i % 5 === 0 ? 'pine' : i % 7 === 0 ? 'bamboo' : i % 3 === 0 ? 'rock' : 'tree';
    const sx = t === 'rock' ? 1.5 + (i % 3) : t === 'bamboo' ? 3 : 4 + (i % 4);
    const sy = t === 'rock' ? 1 + (i % 2) : 7 + (i % 5);
    props.push({ type: t, x: px, y: terrainHeight(map, px, pz) - 0.05, z: pz, rot: a, sx, sy, sz: sx, variant: i });
  }
  map.props = props;
  map.colliders = props.flatMap((p) => propColliders(p));
  return map;
}

function minHeightUnder(map: MapData, x: number, z: number, sx: number, sz: number): number {
  let m = Infinity;
  for (const dx of [-0.5, 0, 0.5]) for (const dz of [-0.5, 0, 0.5]) m = Math.min(m, terrainHeight(map, x + dx * sx, z + dz * sz));
  return m;
}
