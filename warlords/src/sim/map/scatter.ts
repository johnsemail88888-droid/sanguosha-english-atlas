// Cover scatter: groves, rock outcrops, ruins, bamboo, crate caches placed on a
// jittered grid so that cover is never far away, while ~1/5 of the cells stay
// empty (plus fields/roads) to keep 40–80 m sightlines. Also decorates the rim.
import type { PropType } from '../../core/map';
import { MapBuilder } from './builder';
import { rockReach } from './props';
import { dcos, dsin, TWO_PI } from './noise';
import type { Poi } from './spots';
import { MAP_HALF, RIM_START, rimDistance, WATER_LEVEL } from './terrain';

type Biome = 'north' | 'west' | 'bamboo' | 'south' | 'east' | 'plain';

function biomeAt(x: number, z: number): Biome {
  if ((x < -96 && z > 28 && z < 70) || (x > -76 && x < -48 && z > 34 && z < 66)) return 'bamboo';
  if (z < -62) return 'north';
  if (z > 66) return 'south';
  if (x < -58) return 'west';
  if (x > 58) return 'east';
  return 'plain';
}

interface Item {
  type: PropType;
  r: number; // occupancy radius
  sx: number;
  sy: number;
  sz: number;
  variant: number;
  color?: string;
}

function tree(b: MapBuilder, kind: 'tree' | 'pine'): Item {
  const rng = b.rng;
  if (kind === 'pine') {
    const h = rng.range(7, 12);
    return { type: 'pine', r: 1.2, sx: h * rng.range(0.38, 0.48), sy: h, sz: 0, variant: rng.int(0, 2) };
  }
  const h = rng.range(5.5, 9);
  return { type: 'tree', r: 1.4, sx: h * rng.range(0.6, 0.8), sy: h, sz: 0, variant: rng.int(0, 2) };
}

function rock(b: MapBuilder, big: boolean): Item {
  const rng = b.rng;
  const s = big ? rng.range(2.2, 4.2) : rng.range(0.9, 2);
  const sy = big ? rng.range(1.5, 3.2) : rng.range(0.5, 1.4);
  const sz = s * rng.range(0.75, 1.15);
  return { type: 'rock', r: rockReach(s, sz), sx: s, sy, sz, variant: rng.int(0, 3) };
}

function clusterItems(b: MapBuilder, biome: Biome): Item[] {
  const rng = b.rng;
  const items: Item[] = [];
  const kind = rng.next();
  const treeKind = (): 'tree' | 'pine' => (biome === 'north' ? (rng.chance(0.8) ? 'pine' : 'tree') : biome === 'east' ? (rng.chance(0.4) ? 'pine' : 'tree') : rng.chance(0.15) ? 'pine' : 'tree');
  if (biome === 'bamboo') {
    const n = rng.int(5, 9);
    for (let i = 0; i < n; i++) {
      const d = rng.range(2.2, 3.6);
      items.push({ type: 'bamboo', r: d * 0.45, sx: d, sy: rng.range(7, 10.5), sz: d, variant: rng.int(0, 2) });
    }
    if (rng.chance(0.4)) items.push(rock(b, false));
    return items;
  }
  if (kind < 0.3) {
    // grove
    const n = rng.int(3, 6);
    for (let i = 0; i < n; i++) items.push(tree(b, treeKind()));
    if (rng.chance(0.5)) items.push(rock(b, false));
  } else if (kind < 0.55) {
    // rock outcrop
    items.push(rock(b, true));
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) items.push(rock(b, rng.chance(0.3)));
    if (rng.chance(0.4)) items.push(tree(b, treeKind()));
  } else if (kind < 0.67) {
    // ruin
    const len = rng.range(4.5, 8);
    items.push({ type: 'ruin', r: len * 0.55, sx: len, sy: rng.range(2.2, 3.6), sz: rng.range(0.8, 1.2), variant: rng.int(0, 2) });
    if (rng.chance(0.6)) items.push({ type: 'crateStack', r: 1.3, sx: 1.6, sy: 1.6, sz: 1.6, variant: rng.int(0, 2) });
    if (rng.chance(0.5)) items.push(rock(b, false));
    if (rng.chance(0.4)) items.push(tree(b, treeKind()));
  } else if (kind < 0.84) {
    // lone tree + rock
    items.push(tree(b, treeKind()));
    items.push(rock(b, rng.chance(0.5)));
    if (biome === 'west' && rng.chance(0.5)) {
      const d = rng.range(2.2, 3.2);
      items.push({ type: 'bamboo', r: d * 0.45, sx: d, sy: rng.range(6, 9), sz: d, variant: 0 });
    }
  } else if (kind < 0.9) {
    // abandoned supply cache
    items.push({ type: 'crateStack', r: 1.6, sx: 2.2, sy: 1.8, sz: 1.6, variant: rng.int(0, 2) });
    items.push({ type: 'barricade', r: 2, sx: 3.5, sy: 1.1, sz: 0.9, variant: rng.int(0, 2) });
    if (rng.chance(0.5)) items.push({ type: 'banner', r: 0.4, sx: 1.4, sy: 5, sz: 0.1, variant: 0, color: '#8a8a8a' });
  }
  // else: empty cell (open ground)
  return items;
}

/**
 * Fill open terrain with cover clusters. Cells are skipped where the occupancy
 * grid is not free, in water, on steep slopes or on the rim.
 */
export function scatterCover(b: MapBuilder, pois: Poi[]): void {
  const rng = b.rng;
  const SP = 16;
  const lim = RIM_START - 3;
  for (let gz = -MAP_HALF + SP / 2; gz < MAP_HALF; gz += SP) {
    for (let gx = -MAP_HALF + SP / 2; gx < MAP_HALF; gx += SP) {
      const cx = gx + rng.range(-5, 5);
      const cz = gz + rng.range(-5, 5);
      const biome = biomeAt(cx, cz);
      const items = clusterItems(b, biome);
      if (items.length === 0) continue;
      if (rimDistance(cx, cz) > lim) continue;
      if (!b.isFree(cx, cz, 2)) continue;
      if (b.ground(cx, cz) < WATER_LEVEL + 0.6) continue;
      const spread = biome === 'bamboo' ? 7.5 : 6.5;
      let placed = 0;
      for (const it of items) {
        for (let tries = 0; tries < 10; tries++) {
          const a = rng.range(0, TWO_PI);
          const d = placed === 0 ? rng.range(0, 1.5) : rng.range(1.5, spread);
          const x = cx + dcos(a) * d;
          const z = cz + dsin(a) * d;
          if (rimDistance(x, z) > lim || !b.isFree(x, z, it.r, 0.3)) continue;
          if (b.ground(x, z) < WATER_LEVEL + 0.4 || b.slope(x, z) > 1.0) continue;
          const rot = rng.range(0, TWO_PI);
          // box-shaped cover must sit on ground that is nearly level across its
          // footprint (it takes y = lowest ground, so the uphill end gets buried)
          if (!isRound(it.type) && (b.slope(x, z) > 0.5 || !b.fitsGround(x, z, it.sx, it.sy, it.sz, rot, BOX_MAX_RELIEF))) continue;
          placeItem(b, it, x, z, rot);
          placed++;
          break;
        }
      }
      if (placed > 0 && rng.chance(0.5)) {
        // a pickup tucked behind this cover
        const a = rng.range(0, TWO_PI);
        const x = cx + dcos(a) * rng.range(3, 6);
        const z = cz + dsin(a) * rng.range(3, 6);
        pois.push({ x, z, kind: rng.chance(0.5) ? 'crate1' : 'loot', tag: `cover-${biome}` });
      }
    }
  }
}

/** Max terrain relief under a box-shaped scatter item, as a fraction of its height. */
const BOX_MAX_RELIEF = 0.4;

/** Items that stand on a point (trunk, pole, blob) rather than a flat footprint. */
function isRound(type: PropType): boolean {
  return type === 'tree' || type === 'pine' || type === 'bamboo' || type === 'rock' || type === 'banner';
}

function placeItem(b: MapBuilder, it: Item, x: number, z: number, rot: number): void {
  const round = isRound(it.type);
  const sz = it.type === 'tree' || it.type === 'pine' ? it.sx : it.sz;
  const y = round ? b.ground(x, z) - (it.type === 'rock' ? 0.25 : 0.05) : b.groundMin(x, z, it.sx, sz, rot) - 0.05;
  const p = { type: it.type, x, y, z, rot, sx: it.sx, sy: it.sy, sz, variant: it.variant } as const;
  b.add(it.color ? { ...p, color: it.color } : p, -1);
  b.markCircle(x, z, it.r + 0.4, 1);
}

/** Dense bamboo groves of 长坂坡 (placed before the generic scatter). */
export function plantBamboo(b: MapBuilder, pois: Poi[]): void {
  const rng = b.rng;
  const SP = 6;
  const zones = [
    { x0: -138, z0: 30, x1: -94, z1: 68 },
    { x0: -74, z0: 36, x1: -50, z1: 62 },
  ];
  for (const zn of zones) {
    for (let gz = zn.z0 + SP / 2; gz < zn.z1; gz += SP)
      for (let gx = zn.x0 + SP / 2; gx < zn.x1; gx += SP) {
        // noise-shaped clearings keep paths and small glades through the forest
        if (b.terrain.noise.noise(gx / 18 + 40, gz / 18 - 11) > 0.28 || !rng.chance(0.78)) continue;
        const x = gx + rng.range(-2.2, 2.2);
        const z = gz + rng.range(-2.2, 2.2);
        const d = rng.range(2.4, 3.8);
        if (rimDistance(x, z) > RIM_START - 3 || !b.isFree(x, z, d * 0.45, 0.3)) continue;
        if (b.ground(x, z) < WATER_LEVEL + 0.5 || b.slope(x, z) > 1.0) continue;
        placeItem(b, { type: 'bamboo', r: d * 0.45, sx: d, sy: rng.range(7.5, 11), sz: d, variant: rng.int(0, 2) }, x, z, rng.range(0, TWO_PI));
        if (rng.chance(0.07)) pois.push({ x: x + rng.range(-3, 3), z: z + rng.range(-3, 3), kind: rng.chance(0.5) ? 'crate1' : 'loot', tag: 'bamboo' });
      }
  }
}

/** Decorative pines on the mountain rim (unreachable; scenery). */
export function decorateRim(b: MapBuilder): void {
  const rng = b.rng;
  const SP = 11;
  for (let gz = -MAP_HALF + SP / 2; gz < MAP_HALF; gz += SP)
    for (let gx = -MAP_HALF + SP / 2; gx < MAP_HALF; gx += SP) {
      const x = gx + rng.range(-4, 4);
      const z = gz + rng.range(-4, 4);
      const e = rimDistance(x, z);
      if (e < RIM_START + 1 || e > MAP_HALF - 3 || !rng.chance(0.55)) continue;
      if (!b.isUnbuilt(x, z, 0.8)) continue; // camps/trails reaching into the rim
      const h = rng.range(8, 14);
      b.add({ type: 'pine', x, y: b.ground(x, z) - 0.1, z, rot: rng.range(0, TWO_PI), sx: h * 0.42, sy: h, sz: h * 0.42, variant: rng.int(0, 2) }, -1);
    }
}
