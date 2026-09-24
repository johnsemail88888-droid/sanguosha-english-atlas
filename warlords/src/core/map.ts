// Map data contract. Generated deterministically from a seed by
// sim/map/generate.ts on every peer (host and clients build identical maps),
// consumed by sim (collision, raycasts, nav, spawns) and render (meshes).
import type { Vec3 } from './math';

/** Visual/physical prop kinds the renderer knows how to build. */
export type PropType =
  | 'wall' // city wall segment (box). sx=length, sy=height, sz=thickness
  | 'gateTower' // 城门楼 over a gate gap
  | 'palace' // 宫殿 main hall with curved roof
  | 'house' // 民居 with tiled roof
  | 'pavilion' // 亭子 open pillars + roof (no wall collision except pillars)
  | 'watchtower' // 箭楼 tall tower with platform (climbable ramp optional)
  | 'tent' // 军帐
  | 'barricade' // 拒马 / sandbags
  | 'crateStack' // wooden crates (cover)
  | 'rock'
  | 'tree' // broadleaf
  | 'pine'
  | 'bamboo' // bamboo cluster
  | 'bridge' // walkable deck over water. sx=length along rot, sz=width
  | 'dock'
  | 'ship' // 战船 (赤壁) moored hull, walkable deck
  | 'statue'
  | 'banner' // 军旗 pole
  | 'brazier' // fire basin (light source)
  | 'ruin' // broken wall pieces
  | 'farmField' // flat decal-ish, no collision
  | 'stairs'; // ramp. sx=width, sy=rise, sz=run

export interface MapProp {
  type: PropType;
  x: number;
  y: number; // base height (terrain height at placement or deck height)
  z: number;
  rot: number; // yaw radians
  sx: number;
  sy: number;
  sz: number;
  variant: number; // 0..n style variant
  color?: string; // tint hint (kingdom colors for banners/tents)
}

/** Static collision volumes. Boxes rotate around Y only (oriented boxes). */
export type Collider =
  | { kind: 'box'; cx: number; cy: number; cz: number; hx: number; hy: number; hz: number; rot: number }
  | { kind: 'cyl'; x: number; z: number; r: number; y0: number; y1: number };

export interface MapRegion {
  id: string;
  nameZh: string;
  nameEn: string;
  center: Vec3;
  radius: number;
}

export interface NpcCamp {
  pos: Vec3;
  npcType: string; // TroopTypeDef id, e.g. 'yellowTurban'
  count: number;
  crateTier: 1 | 2 | 3;
}

export interface MapData {
  seed: number;
  nameZh: string;
  nameEn: string;
  /** world spans [-size/2, size/2] on X and Z */
  size: number;
  /** heightfield samples per side = res + 1; heights[row * (res+1) + col], row along Z */
  res: number;
  heights: Float32Array;
  waterLevel: number;
  props: MapProp[];
  colliders: Collider[];
  /** 主公 spawns here (palace); others spawn at `spawns` (shuffled) */
  lordSpawn: Vec3;
  spawns: Vec3[];
  lootSpots: Vec3[];
  crateSpots: { pos: Vec3; tier: 1 | 2 | 3 }[];
  camps: NpcCamp[];
  regions: MapRegion[];
}

/** Bilinear terrain height lookup (shared helper, both sim and render use it). */
export function terrainHeight(map: MapData, x: number, z: number): number {
  const half = map.size / 2;
  const fx = ((x + half) / map.size) * map.res;
  const fz = ((z + half) / map.size) * map.res;
  const cx = Math.max(0, Math.min(map.res - 1e-6, fx));
  const cz = Math.max(0, Math.min(map.res - 1e-6, fz));
  const ix = Math.floor(cx);
  const iz = Math.floor(cz);
  const tx = cx - ix;
  const tz = cz - iz;
  const n = map.res + 1;
  const h00 = map.heights[iz * n + ix];
  const h10 = map.heights[iz * n + ix + 1];
  const h01 = map.heights[(iz + 1) * n + ix];
  const h11 = map.heights[(iz + 1) * n + ix + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}
