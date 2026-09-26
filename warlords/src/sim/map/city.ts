// 洛阳宫城 — the walled palace city at the map centre.
import type { Vec3 } from '../../core/math';
import { footprintRect, MapBuilder, type Rect, rectsOverlap, rotFacing, ROT_FACE_EAST, ROT_FACE_NORTH, ROT_FACE_SOUTH, ROT_FACE_WEST, STAIR_RUN } from './builder';
import { dcos, dsin, HALF_PI, PI } from './noise';
import { PARAPET_H, PARAPET_T, stairStepCount } from './props';
import type { Poi } from './spots';

export const CITY_WALL_C = 38; // wall centre-line distance from the city centre
export const CITY_WALL_T = 5;
export const CITY_WALL_H = 6;
export const CITY_INNER = CITY_WALL_C - CITY_WALL_T / 2; // 35.5
export const CITY_OUTER = CITY_WALL_C + CITY_WALL_T / 2; // 40.5
export const CITY_GATE_SX = 14; // gate tower length (8 m passage)
export const CITY_TOWER_H = 6.8;
const TOWER_C = 31;
const TOWER_S = 6;

const SIDES = [
  { rot: ROT_FACE_NORTH }, // north wall, outside faces -Z
  { rot: ROT_FACE_SOUTH },
  { rot: HALF_PI }, // west wall, outside faces -X
  { rot: -HALF_PI }, // east
] as const;

/** Unit vectors of a multiple-of-90° rotation, exact. */
function frame(rot: number): { ax: number; az: number; ox: number; oz: number } {
  const c = Math.round(dcos(rot));
  const s = Math.round(dsin(rot));
  // local +X (along-wall axis) and local -Z (front / outward)
  return { ax: c, az: -s, ox: -s, oz: -c };
}

export interface CityResult {
  lordSpawn: Vec3;
  y: number;
}

export function buildCity(b: MapBuilder, Y: number, pois: Poi[]): CityResult {
  const rng = b.rng;
  const H = CITY_WALL_H;
  const T = CITY_WALL_T;
  const C = CITY_WALL_C;
  const gh = CITY_GATE_SX / 2;
  const wallTop = Y + H;

  // ── walls, parapets, gate towers, wall stairs ───────────────────────────
  for (const side of SIDES) {
    const f = frame(side.rot);
    for (const [a, c] of [
      [-CITY_OUTER, -gh],
      [gh, CITY_OUTER],
    ]) {
      const mid = (a + c) / 2;
      const len = c - a;
      b.add({ type: 'wall', x: f.ox * C + f.ax * mid, y: Y, z: f.oz * C + f.az * mid, rot: side.rot, sx: len, sy: H, sz: T }, 1);
      const po = C + T / 2 - PARAPET_T / 2;
      b.add(
        { type: 'wall', variant: 1, x: f.ox * po + f.ax * mid, y: wallTop, z: f.oz * po + f.az * mid, rot: side.rot, sx: len, sy: PARAPET_H, sz: PARAPET_T },
        -1,
      );
      // banners along the parapet line + loot on the wall top walkway
      for (const u of [0.3, 0.75]) {
        const t = a + (c - a) * u;
        b.add({ type: 'banner', x: f.ox * po + f.ax * t, y: wallTop + PARAPET_H, z: f.oz * po + f.az * t, rot: side.rot, sx: 1.4, sy: 4, sz: 0.1, color: '#c0392b' }, -1);
      }
      const lt = a + (c - a) * 0.55;
      pois.push({ x: f.ox * (C - 1) + f.ax * lt, z: f.oz * (C - 1) + f.az * lt, y: wallTop, kind: 'loot', tag: 'cityWall' });
    }
    b.add({ type: 'gateTower', x: f.ox * C, y: Y, z: f.oz * C, rot: side.rot, sx: CITY_GATE_SX, sy: H, sz: T, variant: 0 }, 1);
    pois.push({ x: f.ox * (C - 1), z: f.oz * (C - 1), y: wallTop, kind: 'loot', tag: 'gateTop' });
    // stairs against the inner face, climbing towards the gate
    const run = stairStepCount(H) * STAIR_RUN;
    const along = 9 + run / 2;
    const inset = CITY_INNER - 1.5;
    b.stairs(f.ox * inset + f.ax * along, f.oz * inset + f.az * along, rotFacing(-f.ax, -f.az), 3, Y, H, 0, run);
    // braziers outside each gate
    for (const s of [-1, 1]) {
      const px = f.ox * (CITY_OUTER + 3) + f.ax * s * 6;
      const pz = f.oz * (CITY_OUTER + 3) + f.az * s * 6;
      b.place('brazier', px, pz, 0, 1, 1.3, 1, 0, undefined, 0.5);
    }
  }

  // ── corner watchtowers (箭楼) with stairs ────────────────────────────────
  const towerRun = stairStepCount(CITY_TOWER_H) * STAIR_RUN;
  let ti = 0;
  for (const sxs of [-1, 1])
    for (const szs of [-1, 1]) {
      const tx = sxs * TOWER_C;
      const tz = szs * TOWER_C;
      const rot = rotFacing(sxs, 0); // stairs lie towards the city axis, climbing outwards
      b.add({ type: 'watchtower', x: tx, y: Y, z: tz, rot, sx: TOWER_S, sy: CITY_TOWER_H, sz: TOWER_S, variant: 0 }, 1);
      const scx = tx - sxs * (TOWER_S / 2 + towerRun / 2);
      b.stairs(scx, tz, rot, 2, Y, CITY_TOWER_H, 0, towerRun);
      pois.push({ x: tx, z: tz, y: Y + CITY_TOWER_H, kind: ti === 1 ? 'crate2' : ti === 2 ? 'crate1' : 'loot', tag: 'cityTower' });
      ti++;
    }

  // ── palace, plaza, side halls, garden ───────────────────────────────────
  b.add({ type: 'palace', x: 0, y: Y, z: -16, rot: PI, sx: 30, sy: 14, sz: 16, variant: 0 }, 1);
  b.stairs(0, -7.25, ROT_FACE_NORTH, 10, Y, 1.2, 0, 1.5);
  // on the terrace before the hall doors, between the bronze cauldrons (±9, -9.6)
  pois.push({ x: 5, z: -9, y: Y + 1.2, kind: 'crate2', tag: 'palace' });
  pois.push({ x: -5, z: -9, y: Y + 1.2, kind: 'loot', tag: 'palace' });
  for (const s of [-1, 1]) {
    b.add({ type: 'statue', variant: 1, x: s * 6.8, y: Y, z: -5.8, rot: PI, sx: 1.4, sy: 2.4, sz: 2 }, 0.5);
    b.add({ type: 'brazier', x: s * 13, y: Y, z: -6, rot: 0, sx: 1, sy: 1.3, sz: 1 }, 0.5);
    b.add({ type: 'brazier', x: s * 13, y: Y, z: 6.5, rot: 0, sx: 1, sy: 1.3, sz: 1 }, 0.5);
    b.add({ type: 'banner', x: s * 10.5, y: Y, z: -6.4, rot: 0, sx: 1.4, sy: 7, sz: 0.1, color: '#c9a227' }, 0.3);
    // side halls facing the palace axis
    b.add({ type: 'house', variant: 2, x: s * 24, y: Y, z: -17, rot: s > 0 ? HALF_PI : -HALF_PI, sx: 14, sy: 8, sz: 8 }, 1);
    pois.push({ x: s * 24, z: -7.5, kind: 'loot', tag: 'sideHall' });
    // garden behind the palace (clear of the gate stairs at z < -32.5)
    b.add({ type: 'pavilion', x: s * 14, y: Y, z: -27.5, rot: PI, sx: 4.4, sy: 4.8, sz: 4.4 }, 0.5);
    pois.push({ x: s * 14, z: -27.5, y: Y + 0.3, kind: s > 0 ? 'crate1' : 'loot', tag: 'garden' });
    b.add({ type: 'tree', x: s * 6.5, y: Y, z: -31, rot: rng.range(0, 6.28), sx: 5, sy: 7, sz: 5, variant: 1 }, 0.5);
    b.add({ type: 'tree', x: s * 21, y: Y, z: -27, rot: rng.range(0, 6.28), sx: 4.5, sy: 6.5, sz: 4.5, variant: 1 }, 0.5);
    b.add({ type: 'rock', x: s * 4.5, y: Y, z: -27, rot: rng.range(0, 6.28), sx: 1.6, sy: 1.4, sz: 1.4, variant: 2 }, 0.5);
  }
  b.add({ type: 'statue', variant: 2, x: 0, y: Y, z: 4, rot: 0, sx: 2.6, sy: 2.4, sz: 2.6 }, 0.8);
  pois.push({ x: 14, z: 0.5, kind: 'loot', tag: 'plaza' });
  pois.push({ x: -14, z: 0.5, kind: 'loot', tag: 'plaza' });

  // ── houses packed into street blocks (south half; mirrored west/east) ──
  // Blocks are bounded by the avenues (|x|,|z| < 5.5), the plaza, the N-S lanes
  // at |x| = 18.5, the ring corridor (|v| > 32.5) and the corner towers/stairs.
  // Each row is either one house spanning the block (facing N or S; neighbours
  // face each other across the alley they share) or two narrower shops back to
  // back, facing the lanes on either side of the block (E / W).
  const subBlocks: Rect[] = [rs(6, 8.8, 16.25, 31.4), rs(20.75, 6, 31.4, TOWER_C - TOWER_S / 2 - 0.8)];
  const reserved: Rect[] = [
    rs(31.5, 8.5, 40, 17.5), // E wall stairs
    rs(-17.5, 31.5, -8.5, 40), // S wall stairs
  ];
  for (const sxs of [-1, 1])
    for (const szs of [-1, 1]) {
      const tx = sxs * TOWER_C;
      const tz = szs * TOWER_C;
      const m = 0.6;
      reserved.push(rs(tx - TOWER_S / 2 - m, tz - TOWER_S / 2 - m, tx + TOWER_S / 2 + m, tz + TOWER_S / 2 + m));
      // the tower's stair flight plus 1.5 m of free ground before its bottom step
      reserved.push(rs(tx - sxs * (TOWER_S / 2), tz - 1 - m, tx - sxs * (TOWER_S / 2 + towerRun + 1.5), tz + 1 + m));
    }
  const HOUSE_GAP = 1.2; // between back-to-back shops (clears both eave overhangs)
  for (const s of [1, -1]) {
    for (const sb of subBlocks) {
      const blk = s > 0 ? sb : rs(-sb.x1, sb.z0, -sb.x0, sb.z1);
      const bw = blk.x1 - blk.x0;
      let z = blk.z0 + rng.range(0, 0.8);
      for (let i = 0; ; i++) {
        const room = blk.z1 - z;
        if (room < 4.2) break;
        const d = Math.min(room, rng.range(4.6, 6.4));
        const zc = z + d / 2;
        // alleys >= 3.4 m: a 2 m nav-grid line always fits with agent clearance
        z += d + rng.range(3.4, 3.9);
        const houses: { x: number; rot: number; sx: number; sz: number; row: boolean }[] = [];
        if (rng.chance(0.35)) {
          const depth = (bw - HOUSE_GAP) / 2;
          houses.push({ x: blk.x0 + depth / 2, rot: ROT_FACE_WEST, sx: d, sz: depth, row: false });
          houses.push({ x: blk.x1 - depth / 2, rot: ROT_FACE_EAST, sx: d, sz: depth, row: false });
        } else {
          const w = Math.min(9.6, bw - rng.range(0.4, 1.6));
          const x = (blk.x0 + blk.x1) / 2 + rng.range(-1, 1) * ((bw - w) / 2);
          houses.push({ x, rot: i % 2 === 0 ? ROT_FACE_SOUTH : ROT_FACE_NORTH, sx: w, sz: d, row: true });
        }
        for (const h of houses) {
          if (reserved.some((q) => rectsOverlap(footprintRect(h.x, zc, h.sx, h.sz, h.rot), q))) continue;
          // never open a row house's door straight onto a stair flight or a
          // tower base: turn it around (it has an alley or street on both sides)
          if (h.row && reserved.some((q) => rectsOverlap(doorApron(h.x, zc, h.sz, h.rot), q))) h.rot = h.rot === ROT_FACE_SOUTH ? ROT_FACE_NORTH : ROT_FACE_SOUTH;
          const tall = rng.chance(0.25);
          const variant = tall ? 2 : rng.chance(0.3) ? 1 : 0;
          const sy = tall ? rng.range(7.5, 8.5) : rng.range(4.4, 6.2);
          b.add({ type: 'house', variant, x: h.x, y: Y, z: zc, rot: h.rot, sx: h.sx, sy, sz: h.sz }, 1);
          // loot / crate by the front door
          const fx = -dsin(h.rot);
          const fz = -dcos(h.rot);
          if (rng.chance(0.6)) pois.push({ x: h.x + fx * (h.sz / 2 + 1.3), z: zc + fz * (h.sz / 2 + 1.3), kind: rng.chance(0.4) ? 'crate1' : 'loot', tag: 'cityHouse' });
        }
      }
    }
  }

  // ── street cover: crates, sandbags, trees along the avenues ─────────────
  for (const s of [-1, 1]) {
    for (const zz of [14, 28]) {
      b.add({ type: 'crateStack', variant: rng.int(0, 2), x: s * 4, y: Y, z: zz, rot: 0, sx: 1.6, sy: 1.6, sz: 1.6 }, 0.3);
      b.add({ type: 'tree', variant: 1, x: -s * 4.2, y: Y, z: zz + 5, rot: rng.range(0, 6.28), sx: 4, sy: 6, sz: 4 }, 0.3);
    }
    for (const xx of [22, 30]) {
      b.add({ type: 'crateStack', variant: rng.int(0, 2), x: s * xx, y: Y, z: 4, rot: 0, sx: 1.6, sy: 1.6, sz: 1.6 }, 0.3);
      b.add({ type: 'barricade', variant: 0, x: s * (xx - 4), y: Y, z: -3.6, rot: 0, sx: 3.2, sy: 1.1, sz: 0.9 }, 0.3);
    }
    b.add({ type: 'barricade', variant: 0, x: s * 1.8, y: Y, z: 24, rot: 0, sx: 2.6, sy: 1.1, sz: 0.9 }, 0.3);
    // corridors east/west of the side halls
    b.add({ type: 'crateStack', variant: 1, x: s * 31.5, y: Y, z: -21, rot: HALF_PI, sx: 2.4, sy: 1.8, sz: 1.6 }, 0.3);
    b.add({ type: 'tree', variant: 1, x: s * 32, y: Y, z: -12, rot: rng.range(0, 6.28), sx: 4, sy: 6, sz: 4 }, 0.3);
    pois.push({ x: s * 31.5, z: -16, kind: 'loot', tag: 'corridor' });
    pois.push({ x: s * 2.5, z: 32, kind: 'loot', tag: 'avenue' });
    pois.push({ x: s * 25, z: 2.5, kind: 'loot', tag: 'avenue' });
  }

  // no scatter anywhere inside the city
  b.markRect({ x0: -CITY_OUTER - 3, z0: -CITY_OUTER - 3, x1: CITY_OUTER + 3, z1: CITY_OUTER + 3 });
  return { lordSpawn: { x: 0, y: Y, z: -2 }, y: Y };
}

/** The 3 m × 3 m patch of ground in front of a house door (house centre x, z; depth sz). */
function doorApron(x: number, z: number, sz: number, rot: number): Rect {
  const fx = -dsin(rot);
  const fz = -dcos(rot);
  const d = sz / 2 + 1.5;
  return footprintRect(x + fx * d, z + fz * d, 3, 3, 0);
}

function rs(xa: number, za: number, xb: number, zb: number): Rect {
  return { x0: Math.min(xa, xb), z0: Math.min(za, zb), x1: Math.max(xa, xb), z1: Math.max(za, zb) };
}
