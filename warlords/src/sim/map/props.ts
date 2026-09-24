// Prop geometry conventions + the ONE function that turns a MapProp into its
// collision volumes. The full per-type documentation lives in the big comment
// at the top of ./generate.ts; the numbers below are the single source of truth
// for both the simulation (colliders) and the renderer (mesh proportions), so the
// renderer should import these constants/helpers instead of re-deriving them.
//
// Frame (all props):
//   (x, z)  footprint centre in world space.
//   y       base height (bottom of the prop) — EXCEPT bridge / dock / ship, where
//           y is the walkable DECK TOP.
//   rot     yaw in radians, identical to three.js `mesh.rotation.y = rot`.
//           local +X -> world ( cos rot, 0, -sin rot)   (= rightFromYaw(rot))
//           local +Z -> world ( sin rot, 0,  cos rot)   (= -forwardFromYaw(rot))
//           "front" of every prop is local -Z (= forwardFromYaw(rot)): doors,
//           the outside face of walls, the direction stairs climb towards.
//   sx/sy/sz full extents along local X / Y / Z.
import type { Collider, MapProp, PropType } from '../../core/map';
import { dcos, dsin } from './noise';

/** Max rise of one stair step (m). Physics must step up at least this much. */
export const STAIR_MAX_RISE = 0.4;

// gateTower
export const GATE_PIER = 3; // solid pier length on each side of the passage
export const GATE_LINTEL = 1.2; // thickness of the deck over the passage
export const GATE_HALL_H = 3.4; // pillar height of the hall on top
export const GATE_ROOF_H = 1.4; // roof slab thickness (collider); visual roof may rise higher
export const GATE_PILLAR_INSET = 0.3; // hall pillars stand on the deck edges (front ones on the parapet line)
// walls / parapets
export const PARAPET_H = 1.2;
export const PARAPET_T = 0.6;
// palace
export const PALACE_BASE = 1.2;
// pavilion
export const PAVILION_RAIL_TOP = 0.75; // bench railing top above the prop base
// watchtower
export const WT_PARAPET_H = 1.1;
export const WT_PARAPET_T = 0.35;
export const WT_GAP = 2.2; // opening in the back (+Z) parapet where the stairs arrive
export const WT_POST_H = 2.7;
export const WT_ROOF_T = 0.7;
// bridge
export const BRIDGE_DECK_T = 0.6;
export const BRIDGE_RAIL_H = 1.0;
export const BRIDGE_RAIL_T = 0.2;
export const BRIDGE_PIER_SPACING = 8;
// dock
export const DOCK_DECK_T = 0.5;
// ship
export const SHIP_BULWARK_H = 1.0;
export const SHIP_BULWARK_T = 0.3;
export const SHIP_GANG_GAP = 3.2; // opening in the front (-Z) bulwark, centred at local x = 0
export const SHIP_CABIN_H = 2.8;

/** Prop types that never block movement or bullets. */
export const NON_SOLID: ReadonlySet<PropType> = new Set<PropType>(['farmField']);

/** Number of steps of a stair flight with total rise `sy`. */
export function stairStepCount(sy: number): number {
  return Math.max(1, Math.ceil(sy / STAIR_MAX_RISE - 1e-6));
}

/** Local (lx, lz) of a prop -> world (x, z). */
export function propLocalToWorld(p: MapProp, lx: number, lz: number): { x: number; z: number } {
  const c = dcos(p.rot);
  const s = dsin(p.rot);
  return { x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c };
}

/** World (x, z) -> prop local (lx, lz). */
export function worldToPropLocal(p: MapProp, x: number, z: number): { lx: number; lz: number } {
  const c = dcos(p.rot);
  const s = dsin(p.rot);
  const dx = x - p.x;
  const dz = z - p.z;
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}

/** Trunk radius used by tree/pine colliders (and the renderer's trunk mesh). */
export function trunkRadius(sy: number): number {
  return Math.min(0.5, Math.max(0.18, 0.045 * sy));
}

// house (walls + concave hip roof, see houseRoofTiers)
export const HOUSE_WALL_FRAC = 0.58; // eave height / ridge height
// rock
export const ROCK_MIN_SOLID_H = 0.6; // pebbles lower than this have no collider
const ROCK_BODY_TOP = 0.72; // lower body up to this fraction of sy
const ROCK_TOP = 0.9; // rounded cap up to this fraction of sy (v1 slab: ROCK_SLAB_TOP)
const ROCK_SLAB_TOP = 0.95;

/**
 * Horizontal reach (m) of a rock's collider from its centre, for any rotation:
 * use it for occupancy / spacing checks against rocks.
 */
export function rockReach(sx: number, sz: number): number {
  return 0.5 * Math.max(sx, sz);
}

/** Roof collider tier boundaries, as fractions of the roof height (eave -> ridge). */
const ROOF_TIER_CUTS = [0, 0.15, 0.35, 0.6, 1] as const;
/** (cut[i] + 0.4·(cut[i+1] - cut[i]))^(1/curve) for curve 1.6 / 1.05. */
const ROOF_INSET_TILE = [0.1723, 0.3991, 0.6071, 0.8424] as const;
const ROOF_INSET_THATCH = [0.0686, 0.2467, 0.4674, 0.77] as const;

/**
 * Tiers of a house roof collider: the hip roof drawn by the renderer rises from
 * the eave (y + HOUSE_WALL_FRAC·sy) to the ridge (y + sy); its surface at
 * height fraction f of the roof (0 eave, 1 ridge) is inset from the eave line
 * by (1 - f^(1/curve)) of the eave half-extent, with eave overhang `overhang`
 * and a ridge of length ridgeFrac·(W - D) along local X (0 = pyramid when
 * sz >= sx). Each tier is a box [y0, y1] with half extents (hx, hz), clamped to
 * the wall footprint (the overhanging eaves have no collider).
 */
export function houseRoofTiers(p: MapProp): { hx: number; hz: number; y0: number; y1: number }[] {
  const { sx, sy, sz, y } = p;
  const wallH = HOUSE_WALL_FRAC * sy;
  const roofH = sy - wallH;
  const thatch = p.variant === 3;
  const ridgeFrac = thatch ? 0.8 : 0.75;
  const overhang = p.variant === 4 ? 0.9 : 0.6;
  // f^(1/curve) at f = 40% up each tier, precomputed so that no transcendental
  // (engine-dependent) function is evaluated: curve 1.6 tiles, 1.05 thatch
  const insets = thatch ? ROOF_INSET_THATCH : ROOF_INSET_TILE;
  const W = sx + 2 * overhang;
  const D = sz + 2 * overhang;
  const R = Math.max(0, (W - D) * ridgeFrac);
  const out: { hx: number; hz: number; y0: number; y1: number }[] = [];
  for (let i = 0; i + 1 < ROOF_TIER_CUTS.length; i++) {
    const v = insets[i];
    const hz = Math.min(sz / 2, (D / 2) * (1 - v));
    const hx = Math.min(sx / 2, (W / 2) * (1 - v) + (R / 2) * v);
    out.push({ hx, hz, y0: y + wallH + ROOF_TIER_CUTS[i] * roofH, y1: y + wallH + ROOF_TIER_CUTS[i + 1] * roofH });
  }
  return out;
}


/** Stair steps as local boxes: step i spans lz in [z0, z1], height [0, top]. */
export function stairSteps(p: MapProp): { z0: number; z1: number; top: number }[] {
  const n = stairStepCount(p.sy);
  const rise = p.sy / n;
  const run = p.sz / n;
  const out: { z0: number; z1: number; top: number }[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ z0: p.sz / 2 - (i + 1) * run, z1: p.sz / 2 - i * run, top: (i + 1) * rise });
  }
  return out;
}

/** Pillar positions (local x, z) of a pavilion. */
export function pavilionPillars(p: MapProp): { lx: number; lz: number }[] {
  const xs = p.sx > 7 ? [-(p.sx / 2 - 0.35), 0, p.sx / 2 - 0.35] : [-(p.sx / 2 - 0.35), p.sx / 2 - 0.35];
  const zs = p.sz > 7 ? [-(p.sz / 2 - 0.35), 0, p.sz / 2 - 0.35] : [-(p.sz / 2 - 0.35), p.sz / 2 - 0.35];
  const out: { lx: number; lz: number }[] = [];
  for (const lx of xs) for (const lz of zs) if (lx !== 0 || lz !== 0) out.push({ lx, lz });
  return out;
}

/** Bridge pier local x positions. */
export function bridgePiers(p: MapProp): number[] {
  const out: number[] = [];
  const lim = p.sx / 2 - BRIDGE_PIER_SPACING;
  for (let k = -20; k <= 20; k++) {
    const lx = k * BRIDGE_PIER_SPACING;
    if (Math.abs(lx) <= lim) out.push(lx);
  }
  return out;
}

class ColliderSink {
  readonly out: Collider[] = [];
  private readonly c: number;
  private readonly s: number;

  constructor(private readonly p: MapProp) {
    this.c = dcos(p.rot);
    this.s = dsin(p.rot);
  }

  /** Box in prop-local coordinates: centre (lx, lz), y range [y0, y1] (absolute), full sizes wx/wz. */
  box(lx: number, lz: number, wx: number, wz: number, y0: number, y1: number): void {
    if (wx <= 0 || wz <= 0 || y1 <= y0) return;
    const { p, c, s } = this;
    this.out.push({
      kind: 'box',
      cx: p.x + lx * c + lz * s,
      cy: (y0 + y1) / 2,
      cz: p.z - lx * s + lz * c,
      hx: wx / 2,
      hy: (y1 - y0) / 2,
      hz: wz / 2,
      rot: p.rot,
    });
  }

  cyl(lx: number, lz: number, r: number, y0: number, y1: number): void {
    if (r <= 0 || y1 <= y0) return;
    const { p, c, s } = this;
    this.out.push({ kind: 'cyl', x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c, r, y0, y1 });
  }
}

/**
 * Collision volumes of a prop, in world space. Deterministic (uses dsin/dcos).
 * Every solid prop's colliders cover its visual footprint; see generate.ts.
 */
export function propColliders(p: MapProp): Collider[] {
  const k = new ColliderSink(p);
  const { sx, sy, sz, y } = p;
  switch (p.type) {
    case 'wall':
    case 'barricade':
      k.box(0, 0, sx, sz, y, y + sy);
      break;
    case 'gateTower': {
      const passage = Math.max(0, sx - 2 * GATE_PIER);
      const top = y + sy;
      k.box(-(sx / 2 - GATE_PIER / 2), 0, GATE_PIER, sz, y, top);
      k.box(sx / 2 - GATE_PIER / 2, 0, GATE_PIER, sz, y, top);
      k.box(0, 0, passage, sz, top - GATE_LINTEL, top);
      k.box(0, -(sz / 2 - PARAPET_T / 2), sx, PARAPET_T, top, top + PARAPET_H);
      const px = sx / 2 - GATE_PILLAR_INSET;
      const pz = sz / 2 - GATE_PILLAR_INSET;
      for (const lx of [-px, px]) for (const lz of [-pz, pz]) k.cyl(lx, lz, 0.3, top, top + GATE_HALL_H);
      k.box(0, 0, sx + 1.6, sz + 1.6, top + GATE_HALL_H, top + GATE_HALL_H + GATE_ROOF_H);
      break;
    }
    case 'palace': {
      const base = y + PALACE_BASE;
      const hallH = 0.4 * (sy - PALACE_BASE);
      k.box(0, 0, sx, sz, y, base);
      k.box(0, 0, 0.7 * sx, 0.55 * sz, base, base + hallH);
      k.box(0, 0, 0.84 * sx, 0.8 * sz, base + hallH, base + hallH + 1);
      k.box(0, 0, 0.6 * sx, 0.45 * sz, base + hallH + 1, y + sy);
      const cz = -(0.275 * sz + 1.3);
      for (let i = 0; i < 6; i++) k.cyl(-0.3 * sx + i * 0.12 * sx, cz, 0.35, base, base + hallH);
      // bronze cauldrons (鼎) on the terrace, either side of the front stairs
      for (const lx of [-0.3 * sx, 0.3 * sx]) k.cyl(lx, -sz / 2 + 1.6, 0.6, base, base + 1.2);
      break;
    }
    case 'house': {
      const wallH = HOUSE_WALL_FRAC * sy;
      if (p.variant === 2) {
        // two-storey: ground floor + lower part of the mid eave roof, then the
        // upper floor inset to 90%
        const f1 = y + 0.52 * wallH + 0.25;
        k.box(0, 0, sx, sz, y, f1);
        k.box(0, 0, 0.9 * sx, 0.9 * sz, f1, y + wallH);
      } else {
        k.box(0, 0, sx, sz, y, y + wallH);
      }
      for (const t of houseRoofTiers(p)) k.box(0, 0, 2 * t.hx, 2 * t.hz, t.y0, t.y1);
      break;
    }
    case 'pavilion': {
      const pillarTop = y + 0.3 + 0.55 * sy;
      k.box(0, 0, sx, sz, y, y + 0.3);
      for (const pp of pavilionPillars(p)) k.cyl(pp.lx, pp.lz, 0.22, y, pillarTop);
      // 美人靠 bench railings: back side full width, both sides from 0.6·bz forward to the back;
      // the front (-Z) stays open
      const bx = sx / 2 - 0.35;
      const bz = sz / 2 - 0.35;
      const rTop = y + PAVILION_RAIL_TOP;
      k.box(0, bz - 0.075, 2 * bx, 0.25, y + 0.3, rTop);
      k.box(-bx + 0.075, bz * 0.2, 0.25, bz * 1.6, y + 0.3, rTop);
      k.box(bx - 0.075, bz * 0.2, 0.25, bz * 1.6, y + 0.3, rTop);
      // stone table in the middle
      k.cyl(0, 0, 0.55, y + 0.3, y + 0.98);
      k.box(0, 0, sx + 1, sz + 1, pillarTop, y + sy);
      break;
    }
    case 'watchtower': {
      const top = y + sy;
      const pt = WT_PARAPET_T;
      k.box(0, 0, sx, sz, y, top);
      k.box(0, -(sz / 2 - pt / 2), sx, pt, top, top + WT_PARAPET_H);
      k.box(-(sx / 2 - pt / 2), 0, pt, sz, top, top + WT_PARAPET_H);
      k.box(sx / 2 - pt / 2, 0, pt, sz, top, top + WT_PARAPET_H);
      const seg = (sx - WT_GAP) / 2;
      k.box(-(sx / 2 - seg / 2), sz / 2 - pt / 2, seg, pt, top, top + WT_PARAPET_H);
      k.box(sx / 2 - seg / 2, sz / 2 - pt / 2, seg, pt, top, top + WT_PARAPET_H);
      for (const lx of [-(sx / 2 - 0.18), sx / 2 - 0.18])
        for (const lz of [-(sz / 2 - 0.18), sz / 2 - 0.18]) k.cyl(lx, lz, 0.18, top, top + WT_POST_H);
      k.box(0, 0, sx + 1.2, sz + 1.2, top + WT_POST_H, top + WT_POST_H + WT_ROOF_T);
      break;
    }
    case 'tent':
      k.box(0, 0, sx, sz, y, y + 0.7 * sy);
      break;
    case 'crateStack':
      if (p.variant === 1) {
        k.box(0, 0, sx, sz, y, y + sy / 2);
        k.box(-sx / 4, 0, sx / 2, sz, y + sy / 2, y + sy);
      } else if (p.variant === 2) {
        k.box(0, 0, sx, sz, y, y + sy / 2);
        k.box(0, 0, sx / 2, sz / 2, y + sy / 2, y + sy);
      } else {
        k.box(0, 0, sx, sz, y, y + sy);
      }
      break;
    case 'rock': {
      if (sy < ROCK_MIN_SOLID_H) break;
      // The boulder mesh is a rounded blob whose horizontal section is close to
      // an ellipse with semi-axes 0.47·sx × 0.47·sz, widest at ~0.4·sy and
      // tapering to a cap (v1 slab: flat top). Body (y-0.3 .. y+0.72sy): a
      // cylinder on the short semi-axis plus, for rocks elongated > 1.15:1, two
      // boxes along the long axis (0.94a × 0.47c and 0.72a × 0.78c half
      // extents, a/c = long/short semi-axis) whose corners stay within ~5% of
      // the ellipse. Cap (up to y+0.9sy; v1 y+0.95sy): cylinder of radius
      // 0.3·sqrt(sx·sz) (v1: the body shape at 0.45).
      const body = y + ROCK_BODY_TOP * sy;
      const slab = p.variant % 4 === 1;
      const top = y + (slab ? ROCK_SLAB_TOP : ROCK_TOP) * sy;
      const ellipse = (scale: number, y0: number, y1: number): void => {
        const a = scale * sx;
        const c = scale * sz;
        k.cyl(0, 0, Math.min(a, c), y0, y1);
        if (a > 1.15 * c) {
          k.box(0, 0, 2 * 0.94 * a, 2 * 0.47 * c, y0, y1);
          k.box(0, 0, 2 * 0.72 * a, 2 * 0.78 * c, y0, y1);
        } else if (c > 1.15 * a) {
          k.box(0, 0, 2 * 0.47 * a, 2 * 0.94 * c, y0, y1);
          k.box(0, 0, 2 * 0.78 * a, 2 * 0.72 * c, y0, y1);
        }
      };
      ellipse(0.47, y - 0.3, body);
      if (slab) ellipse(0.45, body, top);
      else k.cyl(0, 0, 0.3 * Math.sqrt(sx * sz), body, top);
      break;
    }
    case 'tree':
      k.cyl(0, 0, trunkRadius(sy), y, y + 0.55 * sy);
      break;
    case 'pine':
      k.cyl(0, 0, trunkRadius(sy), y, y + 0.6 * sy);
      break;
    case 'bamboo':
      k.cyl(0, 0, 0.3 * Math.min(sx, sz), y, y + sy);
      break;
    case 'bridge': {
      k.box(0, 0, sx, sz, y - BRIDGE_DECK_T, y);
      const rz = sz / 2 - BRIDGE_RAIL_T / 2;
      k.box(0, -rz, sx - 2, BRIDGE_RAIL_T, y, y + BRIDGE_RAIL_H);
      k.box(0, rz, sx - 2, BRIDGE_RAIL_T, y, y + BRIDGE_RAIL_H);
      for (const lx of bridgePiers(p)) k.box(lx, 0, 1.2, sz - 0.4, y - sy, y - BRIDGE_DECK_T);
      break;
    }
    case 'dock':
      k.box(0, 0, sx, sz, y - DOCK_DECK_T, y);
      break;
    case 'ship': {
      const bt = SHIP_BULWARK_T;
      const bh = SHIP_BULWARK_H;
      k.box(0, 0, sx, sz, y - sy, y);
      k.box(0, sz / 2 - bt / 2, sx, bt, y, y + bh);
      const seg = (sx - SHIP_GANG_GAP) / 2;
      k.box(-(sx / 2 - seg / 2), -(sz / 2 - bt / 2), seg, bt, y, y + bh);
      k.box(sx / 2 - seg / 2, -(sz / 2 - bt / 2), seg, bt, y, y + bh);
      k.box(-(sx / 2 - bt / 2), 0, bt, sz - 2 * bt, y, y + bh);
      k.box(sx / 2 - bt / 2, 0, bt, sz - 2 * bt, y, y + bh);
      k.box(0.31 * sx, 0, 0.26 * sx, sz - 2.4, y, y + SHIP_CABIN_H);
      k.cyl(-0.1 * sx, 0, 0.28, y, y + 0.55 * sx);
      break;
    }
    case 'statue': {
      const plinth = y + 0.22 * sy;
      k.box(0, 0, sx, sz, y, plinth);
      k.cyl(0, 0, 0.3 * Math.min(sx, sz), plinth, y + sy);
      break;
    }
    case 'banner':
      k.cyl(0, 0, 0.12, y, y + sy);
      break;
    case 'brazier':
      k.cyl(0, 0, 0.5 * sx, y, y + sy);
      break;
    case 'ruin':
      if (p.variant === 2) {
        k.box(-(sx / 2 - 0.125 * sx), 0, 0.25 * sx, sz, y, y + sy);
        k.box(sx / 2 - 0.125 * sx, 0, 0.25 * sx, sz, y, y + sy);
      } else {
        const m = p.variant === 1 ? -1 : 1; // v1 mirrors v0 along local X
        k.box(m * -0.2 * sx, 0, 0.6 * sx, sz, y, y + sy);
        k.box(m * 0.3 * sx, 0, 0.4 * sx, sz, y, y + 0.5 * sy);
      }
      break;
    case 'stairs':
      for (const st of stairSteps(p)) k.box(0, (st.z0 + st.z1) / 2, sx, st.z1 - st.z0, y, y + st.top);
      break;
    case 'farmField':
      break;
  }
  return k.out;
}
