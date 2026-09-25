// Region builders outside the city: 虎牢关, 官渡大营, 乌巢粮仓, 北邙山, 长坂坡,
// 南蛮营地, 赤壁 (bridges, docks, warships, red cliffs) and 华容道.
import type { PropType } from '../../core/map';
import type { Vec3 } from '../../core/math';
import { MapBuilder, ROT_FACE_EAST, ROT_FACE_NORTH, ROT_FACE_SOUTH, ROT_FACE_WEST, STAIR_RUN, rotFacing } from './builder';
import { dcos, dsin, HALF_PI, PI, TWO_PI } from './noise';
import { PARAPET_H, PARAPET_T, rockReach, stairStepCount } from './props';
import type { Poi } from './spots';
import { FORTRESS_Z, PASS_X, type RiverSpec, riverCenterZ, riverHalfWidth, type Terrain, WATER_LEVEL } from './terrain';

export const KINGDOM_COLORS = { wei: '#2e5fa8', shu: '#c0392b', wu: '#2e8b57', qun: '#8a8a8a' } as const;
const YELLOW = '#c9a227';
const RED_CLIFF = '#9b3a26';

// ── fixed anchors (see GAME_SPEC §9) ─────────────────────────────────────────
export const GUANDU = { x: 104, z: -6 };
export const GUANDU_YT = { x: 101, z: 6 };
export const WUCHAO = { x: 98, z: -100 };
export const BEIMANG = { x: -98, z: -100 };
export const VILLAGE = { x: -96, z: -4 };
export const CHANGBAN = { x: -104, z: 6 };
export const CHANGBAN_YT = { x: -122, z: -34 };
// kept >= 11 m (diagonal) inside the south-west rim corner so the whole camp sits on its pad
export const NANMAN = { x: -92, z: 122 };
export const HUARONG = { x: 98, z: 122 };
export const RED_CLIFFS = { x: 40, z: 124 };
export const FORTRESS = { x: PASS_X, z: FORTRESS_Z };
export const FORTRESS_WALL_H = 8;
export const FORTRESS_WALL_T = 6;
export const FORTRESS_HALF_LEN = 36;

export const BRIDGE_XS = [-71, 1, 77] as const;
export const BRIDGE_DECK_Y = WATER_LEVEL + 2.2;
export const BRIDGE_W = 6.4;
export const DOCK_Y = WATER_LEVEL + 1.25;
export const QUAY_Y = WATER_LEVEL + 0.95;
export const SHIP_DECK_Y = WATER_LEVEL + 2.05;

export interface BridgePlan {
  x: number;
  zN: number;
  zS: number;
}

export interface RiverPlan {
  bridges: BridgePlan[];
  /** north quay line (odd integer z): dock spans z in [zq-1, zq+4.6] up to the hulls of the ships moored south of it */
  zq: number;
  northDock: { x0: number; x1: number };
  /** south quay line: dock spans z in [zs-4.6, zs+1] from the hull of the ship moored north of it */
  zs: number;
  southDock: { x0: number; x1: number };
}

const oddFloor = (v: number): number => {
  const f = Math.floor(v);
  return f % 2 === 0 ? f - 1 : f;
};
const oddCeil = (v: number): number => {
  const c = Math.ceil(v);
  return c % 2 === 0 ? c + 1 : c;
};

/** Decide bridge spans + quay lines from the natural (pre-pad) terrain. */
export function planRiver(t: Terrain, river: RiverSpec): RiverPlan {
  const bridges = BRIDGE_XS.map((x) => {
    const zc = riverCenterZ(river, x);
    const need = BRIDGE_DECK_Y - 0.3;
    let zN = zc;
    while (zN > zc - 60 && Math.max(t.heightAt(x - BRIDGE_W / 2, zN), t.heightAt(x + BRIDGE_W / 2, zN)) < need) zN -= 0.5;
    let zS = zc;
    while (zS < zc + 60 && Math.max(t.heightAt(x - BRIDGE_W / 2, zS), t.heightAt(x + BRIDGE_W / 2, zS)) < need) zS += 0.5;
    return { x, zN: zN - 1.5, zS: zS + 1.5 };
  });
  let minN = Infinity;
  for (let x = 14; x <= 64; x++) minN = Math.min(minN, riverCenterZ(river, x) - riverHalfWidth(river, x));
  let maxS = -Infinity;
  for (let x = -48; x <= -20; x++) maxS = Math.max(maxS, riverCenterZ(river, x) + riverHalfWidth(river, x));
  return { bridges, zq: oddFloor(minN - 1), northDock: { x0: 16, x1: 62 }, zs: oddCeil(maxS + 1), southDock: { x0: -46, x1: -22 } };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Yaw whose front faces from (x, z) towards (tx, tz), via exact arithmetic only. */
function yawToward(x: number, z: number, tx: number, tz: number): number {
  // choose the nearest of 16 compass yaws (avoids non-deterministic atan2)
  const dx = tx - x;
  const dz = tz - z;
  let best = 0;
  let bestDot = -Infinity;
  for (let k = 0; k < 16; k++) {
    const yaw = (k * TWO_PI) / 16;
    const d = -dsin(yaw) * dx - dcos(yaw) * dz;
    if (d > bestDot) {
      bestDot = d;
      best = yaw;
    }
  }
  return best;
}

function polar(cx: number, cz: number, ang: number, r: number): { x: number; z: number } {
  return { x: cx + dcos(ang) * r, z: cz + dsin(ang) * r };
}

/**
 * Place a box-shaped decorative/cover prop only where it sits properly on the
 * terrain (relief under its footprint <= 40% of its height), trying the given
 * yaw and the yaw turned 90°, and only on cells no structure occupies.
 * Returns false (nothing placed) otherwise.
 */
function placeFitted(b: MapBuilder, type: PropType, x: number, z: number, rot: number, sx: number, sy: number, sz: number, variant: number, margin: number): boolean {
  if (!b.isUnbuilt(x, z, 0.5 * Math.max(sx, sz))) return false;
  for (const r of [rot, rot + HALF_PI]) {
    if (!b.fitsGround(x, z, sx, sy, sz, r)) continue;
    b.place(type, x, z, r, sx, sy, sz, variant, undefined, margin);
    return true;
  }
  return false;
}

/** A 黄巾 bandit camp: ragged tents + barricade ring + brazier + banner. Returns the camp centre. */
function banditCamp(b: MapBuilder, cx: number, cz: number, pois: Poi[], tag: string): Vec3 {
  const rng = b.rng;
  const a0 = rng.range(0, TWO_PI);
  for (let i = 0; i < 3; i++) {
    const a = a0 + (i * TWO_PI) / 3;
    const p = polar(cx, cz, a, 6);
    b.place('tent', p.x, p.z, yawToward(p.x, p.z, cx, cz), 3.6, 3, 4, 3, YELLOW, 0.6);
    const q = polar(cx, cz, a + PI / 3, 9);
    b.place('barricade', q.x, q.z, yawToward(q.x, q.z, cx, cz), 3.6, 1.2, 0.8, 2, undefined, 0.4);
  }
  const br = polar(cx, cz, a0 + PI / 3, 3.2);
  b.place('brazier', br.x, br.z, 0, 1, 1.2, 1, 0, undefined, 0.4);
  const bn = polar(cx, cz, a0 + PI, 3);
  b.place('banner', bn.x, bn.z, 0, 1.4, 6, 0.1, 0, YELLOW, 0.3);
  const cs = polar(cx, cz, a0 + (5 * PI) / 3, 3.5);
  b.place('crateStack', cs.x, cs.z, a0, 1.6, 1.6, 1.6, 2, undefined, 0.4);
  pois.push({ x: cx, z: cz, kind: 'crate2', tag });
  const lp = polar(cx, cz, a0 + (2 * PI) / 3 + 0.5, 7.5);
  pois.push({ x: lp.x, z: lp.z, kind: 'loot', tag });
  b.markCircle(cx, cz, 13);
  return { x: cx, y: b.ground(cx, cz), z: cz };
}

/** Timber/stone watchtower with its stair flight laid out towards -dirX. */
function towerWithStairs(b: MapBuilder, tx: number, tz: number, dirX: 1 | -1, height: number, variant: number, pois: Poi[], kind: Poi['kind'], tag: string): void {
  const y = b.groundMin(tx, tz, 6, 6, 0);
  const rot = rotFacing(dirX, 0);
  b.add({ type: 'watchtower', x: tx, y, z: tz, rot, sx: 6, sy: height, sz: 6, variant }, 1);
  const run = stairStepCount(height) * STAIR_RUN;
  b.stairs(tx - dirX * (3 + run / 2), tz, rot, 2, y, height, variant, run);
  pois.push({ x: tx, z: tz, y: y + height, kind, tag });
}

// ── 虎牢关 ──────────────────────────────────────────────────────────────────
export function buildHulao(b: MapBuilder, Y: number, pois: Poi[]): void {
  const rng = b.rng;
  const Z = FORTRESS_Z;
  const H = FORTRESS_WALL_H;
  const T = FORTRESS_WALL_T;
  const L = FORTRESS_HALF_LEN;
  const top = Y + H;
  for (const s of [-1, 1]) {
    const mid = s * (7 + L) / 2;
    const len = L - 7;
    b.add({ type: 'wall', x: mid, y: Y, z: Z, rot: ROT_FACE_NORTH, sx: len, sy: H, sz: T, variant: 0 }, 1);
    b.add({ type: 'wall', variant: 1, x: mid, y: top, z: Z - T / 2 + PARAPET_T / 2, rot: ROT_FACE_NORTH, sx: len, sy: PARAPET_H, sz: PARAPET_T }, -1);
    for (const u of [12, 24]) b.add({ type: 'banner', x: s * u, y: top + PARAPET_H, z: Z - T / 2 + PARAPET_T / 2, rot: 0, sx: 1.6, sy: 4.5, sz: 0.1, color: '#3a3a3a' }, -1);
    // stairs on the inner (south) face, climbing towards the gate
    const run = stairStepCount(H) * STAIR_RUN;
    b.stairs(s * (9 + run / 2), Z + T / 2 + 1.5, rotFacing(-s, 0), 3, Y, H, 0, run);
    pois.push({ x: s * 22, z: Z - 1, y: top, kind: s > 0 ? 'crate2' : 'loot', tag: 'hulaoWall' });
    // yard: sandbags, crates, tents, braziers
    b.add({ type: 'barricade', x: s * 6, y: Y, z: Z + 10, rot: 0, sx: 4, sy: 1.1, sz: 1, variant: 0 }, 0.4);
    b.add({ type: 'barricade', x: s * 15, y: Y, z: Z + 13, rot: s * 0.3, sx: 3.5, sy: 1.1, sz: 1, variant: 0 }, 0.4);
    b.add({ type: 'crateStack', x: s * 5.5, y: Y, z: Z + 6.5, rot: 0, sx: 1.6, sy: 1.6, sz: 1.6, variant: rng.int(0, 2) }, 0.3);
    b.add({ type: 'brazier', x: s * 5.5, y: Y, z: Z + 4, rot: 0, sx: 1, sy: 1.3, sz: 1 }, 0.3);
    b.add({ type: 'tent', x: s * 21, y: Y, z: Z + 11, rot: ROT_FACE_SOUTH, sx: 4.5, sy: 3, sz: 5.5, variant: 0, color: '#3a3a3a' }, 0.6);
    pois.push({ x: s * 12, z: Z + 11, kind: s > 0 ? 'crate1' : 'loot', tag: 'hulaoYard' });
    // outside: 拒马 and rocks in front of the gate
    b.place('barricade', s * 9, Z - 9, s * 0.25, 4, 1.2, 1, 1, undefined, 0.4);
    b.place('rock', s * 14, Z - 16 - rng.range(0, 4), rng.range(0, TWO_PI), 2.4, 1.8, 2.2, rng.int(0, 3), undefined, 0.4);
  }
  b.add({ type: 'gateTower', x: PASS_X, y: Y, z: Z, rot: ROT_FACE_NORTH, sx: 14, sy: H, sz: T, variant: 1 }, 1);
  pois.push({ x: PASS_X, z: Z + 1, y: top, kind: 'loot', tag: 'hulaoGate' });
  b.place('barricade', 0, Z - 14, 0, 4.5, 1.2, 1, 1, undefined, 0.4);
  pois.push({ x: -6, z: Z - 20, kind: 'loot', tag: 'hulaoNorth' });
  b.markRect({ x0: -30, z0: Z - 6, x1: 30, z1: Z + 16 });
}

// ── 官渡大营 ────────────────────────────────────────────────────────────────
export function buildGuandu(b: MapBuilder, pois: Poi[]): Vec3 {
  const rng = b.rng;
  const X0 = 82;
  const X1 = 126;
  const Z0 = -28;
  const Z1 = 16;
  const P = 2.6;
  const seg = (x: number, z: number, rot: number, len: number): void => {
    b.place('wall', x, z, rot, len, P, 0.6, 3, undefined, 0.6);
  };
  // palisade with gates W (towards the city), N and S
  seg((X0 + 100) / 2, Z0, ROT_FACE_NORTH, 100 - X0);
  seg((108 + X1) / 2, Z0, ROT_FACE_NORTH, X1 - 108);
  seg((X0 + 100) / 2, Z1, ROT_FACE_SOUTH, 100 - X0);
  seg((108 + X1) / 2, Z1, ROT_FACE_SOUTH, X1 - 108);
  seg(X0, (Z0 + -10) / 2, ROT_FACE_WEST, -10 - Z0);
  seg(X0, (-2 + Z1) / 2, ROT_FACE_WEST, Z1 + 2);
  seg(X1, (Z0 + Z1) / 2, ROT_FACE_EAST, Z1 - Z0);
  for (const gz of [-11, -1]) b.place('banner', X0 - 1, gz, 0, 1.6, 7, 0.1, 0, KINGDOM_COLORS.wei, 0.3);
  for (const gx of [99, 109]) {
    b.place('banner', gx, Z0 - 1, 0, 1.6, 7, 0.1, 0, KINGDOM_COLORS.wei, 0.3);
    b.place('barricade', gx - 4, Z0 - 5, 0.2, 3.5, 1.2, 1, 1, undefined, 0.4);
  }
  b.place('barricade', X0 - 6, -6, HALF_PI + 0.2, 4, 1.2, 1, 1, undefined, 0.4);
  // command tent + small tents
  b.place('tent', 106, -14, ROT_FACE_WEST, 10, 5.5, 8, 1, KINGDOM_COLORS.wei, 1);
  pois.push({ x: 99.5, z: -14, kind: 'crate2', tag: 'guanduHQ' });
  for (const x of [88, 95]) {
    b.place('tent', x, -22, ROT_FACE_SOUTH, 4.5, 3, 5.5, 0, KINGDOM_COLORS.wei, 0.8);
    pois.push({ x, z: -17.5, kind: 'crate1', tag: 'guanduTent' });
  }
  for (const z of [-5, 3]) {
    b.place('tent', 119, z, ROT_FACE_WEST, 4.5, 3, 5.5, 0, KINGDOM_COLORS.wei, 0.8);
    pois.push({ x: 114.5, z, kind: 'loot', tag: 'guanduTent' });
  }
  towerWithStairs(b, 121, -23, 1, 6, 1, pois, 'crate1', 'guanduTower');
  // 黄巾 took over the south-west corner of the camp (built before the loose
  // parade-ground props so those can keep clear of its tents and barricades)
  const camp = banditCamp(b, GUANDU_YT.x, GUANDU_YT.z, pois, 'guanduYT');
  // crate stacks + braziers across the parade ground
  for (const [x, z] of [
    [92, -9],
    [93, -2],
    [112, -6],
    [89, 1],
  ] as const) {
    const rot = rng.range(0, 1);
    const variant = rng.int(0, 2);
    if (b.isUnbuilt(x, z, 1.4)) b.place('crateStack', x, z, rot, 2.2, 1.8, 1.6, variant, undefined, 0.5);
  }
  for (const [x, z] of [
    [100, -18],
    [111, -18],
  ] as const) b.place('brazier', x, z, 0, 1, 1.3, 1, 0, undefined, 0.4);
  pois.push({ x: 95, z: -6, kind: 'loot', tag: 'guandu' });
  b.markRect({ x0: X0 - 8, z0: Z0 - 8, x1: X1 + 4, z1: Z1 + 6 });
  return camp;
}

// ── 乌巢粮仓 ────────────────────────────────────────────────────────────────
export function buildWuchao(b: MapBuilder, pois: Poi[]): void {
  const rng = b.rng;
  const { x: cx, z: cz } = WUCHAO;
  for (const dx of [-12, 0, 12]) b.place('house', cx + dx, cz - 7, ROT_FACE_SOUTH, 9, 6.5, 7, 4, undefined, 1);
  pois.push({ x: cx, z: cz - 1.5, kind: 'crate2', tag: 'wuchao' });
  pois.push({ x: cx - 12, z: cz - 1.5, kind: 'loot', tag: 'wuchao' });
  for (const [dx, dz] of [
    [-8, 5],
    [6, 4],
    [-1, 8],
    [-14, 9],
  ] as const) b.place('crateStack', cx + dx, cz + dz, rng.range(0, 1.5), 2.4, 1.8, 1.8, rng.int(0, 2), undefined, 0.5);
  for (const dx of [-12, 12]) b.place('barricade', cx + dx, cz + 13, dx > 0 ? -0.3 : 0.3, 4, 1.2, 1, 1, undefined, 0.4);
  towerWithStairs(b, cx + 15, cz + 7, 1, 6, 1, pois, 'crate1', 'wuchaoTower');
  b.place('banner', cx - 18, cz + 2, 0, 1.6, 7, 0.1, 0, YELLOW, 0.3);
  b.place('brazier', cx + 3, cz + 12, 0, 1, 1.2, 1, 0, undefined, 0.4);
  pois.push({ x: cx - 4, z: cz + 13, kind: 'loot', tag: 'wuchao' });
  b.markCircle(cx, cz, 22);
}

// ── 北邙山 ──────────────────────────────────────────────────────────────────
export function buildBeimang(b: MapBuilder, pois: Poi[]): void {
  const rng = b.rng;
  const { x: cx, z: cz } = BEIMANG;
  for (const dz of [12, 7, 2]) {
    b.place('statue', cx - 4, cz + dz, ROT_FACE_EAST, 1.2, 3.2, 1.2, 0, undefined, 0.4);
    b.place('statue', cx + 4, cz + dz, ROT_FACE_WEST, 1.2, 3.2, 1.2, 0, undefined, 0.4);
  }
  b.place('ruin', cx, cz - 4, 0, 7, 5, 1.2, 2, undefined, 0.6);
  b.place('pavilion', cx, cz - 11, ROT_FACE_SOUTH, 5, 5, 5, 0, undefined, 0.6);
  pois.push({ x: cx + 3, z: cz - 7.5, kind: 'crate2', tag: 'beimang' }); // before the stele pavilion
  pois.push({ x: cx, z: cz - 11, y: b.ground(cx, cz - 11) + 0.3, kind: 'loot', tag: 'beimang' });
  pois.push({ x: cx, z: cz + 7, kind: 'loot', tag: 'beimang' });
  for (const [dx, dz, v] of [
    [-12, 4, 0],
    [12, -7, 1],
    [-7, -18, 0],
    [14, 10, 1],
  ] as const) {
    const rot = rng.range(0, PI);
    const len = rng.range(5, 8);
    const h = rng.range(2.4, 3.6);
    placeFitted(b, 'ruin', cx + dx, cz + dz, rot, len, h, 1, v, 0.6);
    if (rng.chance(0.6)) pois.push({ x: cx + dx, z: cz + dz + 2.5, kind: rng.chance(0.4) ? 'crate1' : 'loot', tag: 'beimangRuin' });
  }
  b.markRect({ x0: cx - 8, z0: cz - 16, x1: cx + 8, z1: cz + 16 });
}

// ── 长坂坡 ──────────────────────────────────────────────────────────────────
export function buildChangban(b: MapBuilder, pois: Poi[]): Vec3 {
  const rng = b.rng;
  const { x: cx, z: cz } = VILLAGE;
  const a0 = rng.range(0, TWO_PI);
  for (let i = 0; i < 6; i++) {
    const a = a0 + (i * TWO_PI) / 6 + rng.range(-0.15, 0.15);
    const r = rng.range(10.5, 12.5);
    const p = polar(cx, cz, a, r);
    const rot = HALF_PI - a; // front faces the village square
    b.place('house', p.x, p.z, rot, rng.range(5.5, 7), rng.range(4, 5.2), rng.range(4.5, 5.5), 3, undefined, 1);
    if (rng.chance(0.75)) {
      const q = polar(cx, cz, a, r - 4.5);
      pois.push({ x: q.x, z: q.z, kind: rng.chance(0.5) ? 'crate1' : 'loot', tag: 'village' });
    }
  }
  b.place('crateStack', cx + 1.5, cz + 1, a0, 1.6, 1.6, 1.6, 2, undefined, 0.4);
  b.place('banner', cx - 2, cz - 1.5, 0, 1.4, 6, 0.1, 0, KINGDOM_COLORS.shu, 0.3);
  // farm fields (open ground: long sightlines)
  for (const [x, z, sx, sz, v] of [
    [-73, 14, 16, 22, 0],
    [-74, -24, 18, 14, 2],
    [-118, 16, 14, 18, 1],
    [-96, 24, 20, 12, 0],
    [-128, -8, 12, 16, 2],
    [-84, -44, 16, 12, 1],
  ] as const) {
    const rot = rng.range(-0.2, 0.2);
    b.add({ type: 'farmField', x, y: b.groundMin(x, z, sx, sz, rot), z, rot, sx, sy: 0.4, sz, variant: v }, -1);
    b.markObb(x, z, sx / 2 + 1, sz / 2 + 1, rot, 2);
  }
  b.markCircle(cx, cz, 15);
  return banditCamp(b, CHANGBAN_YT.x, CHANGBAN_YT.z, pois, 'changbanYT');
}

// ── 南蛮营地 ────────────────────────────────────────────────────────────────
export function buildNanman(b: MapBuilder, pois: Poi[]): Vec3 {
  const rng = b.rng;
  const { x: cx, z: cz } = NANMAN;
  const a0 = rng.range(0, TWO_PI);
  for (let i = 0; i < 4; i++) {
    const a = a0 + (i * TWO_PI) / 4;
    const p = polar(cx, cz, a, 7);
    b.place('tent', p.x, p.z, yawToward(p.x, p.z, cx, cz), 4, 3.4, 4, 2, '#7a4a2a', 0.6);
    // the camp borders the mountain rim: pull a barricade in (or drop it)
    // where the ground rises too steeply under it
    for (const rr of [11, 9.5]) {
      const q = polar(cx, cz, a + PI / 4, rr);
      if (placeFitted(b, 'barricade', q.x, q.z, yawToward(q.x, q.z, cx, cz), 4, 1.2, 1, 1, 0.4)) break;
    }
  }
  for (const s of [-1, 1]) {
    const t = polar(cx, cz, a0 + PI / 4 + (s > 0 ? 0 : PI), 3.5);
    b.place('statue', t.x, t.z, 0, 1, 3.5, 1, 3, undefined, 0.3);
    const f = polar(cx, cz, a0 + (3 * PI) / 4 + (s > 0 ? 0 : PI), 3.2);
    b.place('brazier', f.x, f.z, 0, 1, 1.2, 1, 0, undefined, 0.3);
  }
  pois.push({ x: cx, z: cz, kind: 'crate2', tag: 'nanman' });
  const lp = polar(cx, cz, a0 + PI / 2 + 0.4, 9);
  pois.push({ x: lp.x, z: lp.z, kind: 'loot', tag: 'nanman' });
  b.markCircle(cx, cz, 14);
  return { x: cx, y: b.ground(cx, cz), z: cz };
}

// ── 赤壁: bridges, docks, warships, braziers, red cliffs ───────────────────
export function buildChibi(b: MapBuilder, plan: RiverPlan, pois: Poi[]): void {
  const rng = b.rng;
  plan.bridges.forEach((br, i) => {
    const len = br.zS - br.zN;
    const zc = (br.zN + br.zS) / 2;
    const variant = i === 1 ? 0 : i === 0 ? 1 : 2;
    const pierDepth = BRIDGE_DECK_Y - (WATER_LEVEL - 1.4);
    // rot = -PI/2: local +X (span) runs south (+Z), local Z across (width along world X)
    b.add({ type: 'bridge', x: br.x, y: BRIDGE_DECK_Y, z: zc, rot: -HALF_PI, sx: len, sy: pierDepth, sz: BRIDGE_W, variant }, 0.5);
    for (const s of [-1, 1]) {
      b.place('brazier', br.x + s * (BRIDGE_W / 2 + 1.6), br.zN - 1.5, 0, 1, 1.3, 1, 0, undefined, 0.3);
      b.place('brazier', br.x + s * (BRIDGE_W / 2 + 1.6), br.zS + 1.5, 0, 1, 1.3, 1, 0, undefined, 0.3);
    }
    pois.push({ x: br.x + 5, z: br.zN - 4, kind: 'loot', tag: 'bridge' });
    pois.push({ x: br.x - 5, z: br.zS + 5, kind: 'crate1', tag: 'bridge' });
    b.markRect({ x0: br.x - 7, z0: br.zN - 10, x1: br.x + 7, z1: br.zS + 10 });
  });

  // north quay: dock + two chained Wei warships (铁索连环). The dock planks run out to the hulls
  // (flush with the hull collider box): a 1.6 m slot of water between them was a trap — a hero who
  // stepped off the planks landed on the river bed 2.4 m below the deck with the hull in front and
  // nothing to climb (G4-7). The gangplanks now rise from the dock planks onto the decks.
  const zq = plan.zq;
  const nd = plan.northDock;
  const shipZ = zq + 3 + 1.6 + 3.5;
  const hullN = shipZ - 3.5; // the ships' boarding side
  const dockZ = (zq - 1 + hullN) / 2;
  b.add({ type: 'dock', x: (nd.x0 + nd.x1) / 2, y: DOCK_Y, z: dockZ, rot: 0, sx: nd.x1 - nd.x0, sy: 3.5, sz: hullN - (zq - 1), variant: 0 }, 0.5);
  for (const [sxc, v] of [
    [29, 0],
    [51, 0],
  ] as const) {
    b.add({ type: 'ship', x: sxc, y: SHIP_DECK_Y, z: shipZ, rot: ROT_FACE_NORTH, sx: 20, sy: 3.2, sz: 7, variant: v, color: KINGDOM_COLORS.wei }, 0.5);
    b.stairs(sxc, zq + 3.8, ROT_FACE_SOUTH, 2.4, DOCK_Y, SHIP_DECK_Y - DOCK_Y, 1, 1.6);
  }
  pois.push({ x: 45, z: shipZ, y: SHIP_DECK_Y, kind: 'crate2', tag: 'flagship' });
  pois.push({ x: 23, z: shipZ, y: SHIP_DECK_Y, kind: 'loot', tag: 'warship' });
  pois.push({ x: 40, z: dockZ, y: DOCK_Y, kind: 'loot', tag: 'dock' });
  for (const x of [20, 40, 58]) b.add({ type: 'brazier', x, y: DOCK_Y, z: zq - 0.5, rot: 0, sx: 0.9, sy: 1.2, sz: 0.9 }, -1);
  for (const [x, v] of [
    [24, 0],
    [35, 2],
    [47, 1],
  ] as const) b.place('crateStack', x, zq - 4.5, 0, 2.2, 1.8, 1.6, v, undefined, 0.4);
  for (const x of [18, 32, 44, 60]) b.place('banner', x, zq - 2.5, 0, 1.6, 7, 0.1, 0, KINGDOM_COLORS.wei, 0.3);
  pois.push({ x: 30, z: zq - 5, kind: 'crate1', tag: 'quay' });
  b.markRect({ x0: nd.x0 - 4, z0: zq - 9, x1: nd.x1 + 4, z1: zq + 14 });

  // south quay: Wu dock + fire ship (the dock reaches the hull as on the north quay)
  const zs = plan.zs;
  const sd = plan.southDock;
  const wuZ = zs - 3 - 1.6 - 3;
  const hullS = wuZ + 3; // the fire ship's boarding side
  b.add({ type: 'dock', x: (sd.x0 + sd.x1) / 2, y: DOCK_Y, z: (hullS + zs + 1) / 2, rot: 0, sx: sd.x1 - sd.x0, sy: 3.5, sz: zs + 1 - hullS, variant: 1 }, 0.5);
  b.add({ type: 'ship', x: -33, y: SHIP_DECK_Y, z: wuZ, rot: ROT_FACE_SOUTH, sx: 16, sy: 3.2, sz: 6, variant: 2, color: KINGDOM_COLORS.wu }, 0.5);
  b.stairs(-33, zs - 3.8, ROT_FACE_NORTH, 2.4, DOCK_Y, SHIP_DECK_Y - DOCK_Y, 1, 1.6);
  pois.push({ x: -29, z: wuZ, y: SHIP_DECK_Y, kind: 'loot', tag: 'fireship' });
  for (const x of [-42, -26]) {
    b.place('banner', x, zs + 3, 0, 1.6, 7, 0.1, 0, KINGDOM_COLORS.wu, 0.3);
    b.place('brazier', x + 3, zs + 2.5, 0, 1, 1.3, 1, 0, undefined, 0.3);
  }
  b.place('crateStack', -30, zs + 4.5, 0, 2.2, 1.8, 1.6, 1, undefined, 0.4);
  pois.push({ x: -36, z: zs + 5, kind: 'crate1', tag: 'wuQuay' });
  b.markRect({ x0: sd.x0 - 4, z0: zs - 14, x1: sd.x1 + 4, z1: zs + 9 });

  // 赤壁 red cliffs along the south flank
  for (let i = 0; i < 14; i++) {
    const x = 8 + i * 4.6 + rng.range(-1.5, 1.5);
    const z = 121 + rng.range(-4, 9);
    const s = rng.range(3.5, 7);
    const sz = s * rng.range(0.8, 1.1);
    const rot = rng.range(0, TWO_PI);
    const sy = rng.range(3, 6.5);
    const variant = rng.int(0, 3);
    // isFree: CLEAR cells (bridge landings, roads, quays) are off limits too
    if (!b.isFree(x, z, rockReach(s, sz), 0.5)) continue;
    b.place('rock', x, z, rot, s, sy, sz, variant, RED_CLIFF, 0.6);
  }
  pois.push({ x: RED_CLIFFS.x - 8, z: RED_CLIFFS.z - 8, kind: 'crate2', tag: 'redCliffs' });
  pois.push({ x: RED_CLIFFS.x + 14, z: RED_CLIFFS.z - 9, kind: 'loot', tag: 'redCliffs' });
}

// ── 华容道 ──────────────────────────────────────────────────────────────────
export function buildHuarong(b: MapBuilder, pois: Poi[]): void {
  const rng = b.rng;
  const { x: cx, z: cz } = HUARONG;
  // a winding trail between two lines of boulders
  for (let i = -4; i <= 4; i++) {
    const t = i / 4;
    const px = cx + i * 5;
    const pz = cz + 5 * dsin(t * 2.2);
    for (const s of [-1, 1]) {
      if (rng.chance(0.25)) continue;
      const x = px + rng.range(-1, 1);
      const z = pz + s * rng.range(5, 7);
      const sx = rng.range(2.4, 4.2);
      const rot = rng.range(0, TWO_PI);
      const sy = rng.range(1.8, 3.6);
      const sz = sx * rng.range(0.8, 1.2);
      const variant = rng.int(0, 3);
      // the trail's west end meets the east bridge's south landing + road:
      // keep boulders off those (CLEAR) and off anything built (braziers)
      if (!b.isFree(x, z, rockReach(sx, sz), 0.5)) continue;
      b.place('rock', x, z, rot, sx, sy, sz, variant, undefined, 0.5);
    }
  }
  // a ruined shrine wall beside the trail, wherever the ground allows
  for (const [dx, dz] of [
    [3, 12],
    [-8, 11],
    [12, -11],
    [-4, -11],
  ] as const) if (placeFitted(b, 'ruin', cx + dx, cz + dz, 0.3, 6, 3, 1, 0, 0.6)) break;
  pois.push({ x: cx, z: cz, kind: 'crate2', tag: 'huarong' });
  pois.push({ x: cx - 15, z: cz + 1, kind: 'loot', tag: 'huarong' });
  pois.push({ x: cx + 16, z: cz - 2, kind: 'loot', tag: 'huarong' });
  b.markRect({ x0: cx - 24, z0: cz - 4, x1: cx + 24, z1: cz + 4 });
}
