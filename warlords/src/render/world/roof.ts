// Chinese curved roofs (庑殿 hip roofs / 攒尖 pyramids) with concave slopes,
// upturned corner eaves, tile-row striping, a dark underside and ridge
// ornaments. Built into a GeoBuilder in the current local frame.
import * as THREE from 'three';
import { GeoBuilder, PRIM, col, shade, trs, type ColorLike } from '../core/geo';

const _n = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();

/** Quad with automatic winding: its normal points along `outward` (dot > 0). */
export function face(
  b: GeoBuilder,
  a: THREE.Vector3,
  bb: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  color: ColorLike,
  outward: THREE.Vector3,
): void {
  _ab.subVectors(bb, a);
  _ac.subVectors(c, a);
  _n.crossVectors(_ab, _ac);
  if (_n.dot(outward) >= 0) b.quad(a, bb, c, d, color);
  else b.quad(a, d, c, bb, color);
}

/** Triangle with automatic winding. */
export function tri(b: GeoBuilder, a: THREE.Vector3, bb: THREE.Vector3, c: THREE.Vector3, color: ColorLike, outward: THREE.Vector3): void {
  _ab.subVectors(bb, a);
  _ac.subVectors(c, a);
  _n.crossVectors(_ab, _ac);
  if (_n.dot(outward) >= 0) b.tri(a, bb, c, color);
  else b.tri(a, c, bb, color);
}

export interface RoofOptions {
  /** eave overhang beyond the footprint (m) */
  overhang?: number;
  /** ridge length as a fraction of (width - depth); 0 = pyramid */
  ridge?: number;
  /** concavity exponent (1 = straight) */
  curve?: number;
  /** corner upturn height (m) */
  upturn?: number;
  /** roof thickness at the eave (m) */
  thickness?: number;
  color: ColorLike;
  underside?: ColorLike;
  ridgeColor?: ColorLike;
  /** gold finial / ridge beasts */
  ornate?: boolean;
  /** tile-row striping */
  stripes?: boolean;
  /** omit the ridge ornaments (thatch) */
  plain?: boolean;
  nu?: number;
  nv?: number;
}

/**
 * Hip roof over a w×d footprint centred at (cx, cz), eave at y0, ridge at y0+h.
 * The ridge runs along X (the longer side should be w).
 */
export function hipRoof(b: GeoBuilder, cx: number, y0: number, cz: number, w: number, d: number, h: number, o: RoofOptions): void {
  const oh = o.overhang ?? 0.6;
  const W = w + oh * 2;
  const D = d + oh * 2;
  const ridgeFrac = o.ridge ?? 0.6;
  const R = Math.max(0, (W - D) * ridgeFrac + (w > d ? 0 : 0));
  const curve = o.curve ?? 1.7;
  const up = o.upturn ?? Math.min(0.8, 0.12 * Math.min(W, D));
  const th = o.thickness ?? 0.18;
  const nu = o.nu ?? 6;
  const nv = o.nv ?? 4;
  const base = col(o.color);
  const dark = shade(o.color, 0.82);
  const under = o.underside ? col(o.underside) : shade('#4a3222', 1);
  const stripes = o.stripes !== false;
  // surface point: side s ∈ {front(-Z), back(+Z), left(-X), right(+X)}; u across [0..1], v eave→ridge [0..1]
  const pt = (side: number, u: number, v: number, lift: number): THREE.Vector3 => {
    const hv = h * Math.pow(v, curve);
    const corner = Math.pow(Math.abs(2 * u - 1), 3) * Math.pow(1 - v, 2);
    const y = y0 + hv + up * corner + lift;
    if (side === 0 || side === 1) {
      const sgn = side === 0 ? -1 : 1;
      const halfLen = (W / 2) * (1 - v) + (R / 2) * v;
      const x = -halfLen + 2 * halfLen * u;
      const z = sgn * (D / 2) * (1 - v);
      return new THREE.Vector3(cx + x, y, cz + z);
    }
    const sgn = side === 2 ? -1 : 1;
    const halfLen = (D / 2) * (1 - v);
    const z = -halfLen + 2 * halfLen * u;
    const x = sgn * ((W / 2) * (1 - v) + (R / 2) * v);
    return new THREE.Vector3(cx + x, y, cz + z);
  };
  const outward = [new THREE.Vector3(0, 1, -1), new THREE.Vector3(0, 1, 1), new THREE.Vector3(-1, 1, 0), new THREE.Vector3(1, 1, 0)];
  const underNu = Math.max(2, Math.floor(nu / 2));
  for (let side = 0; side < 4; side++) {
    const out = outward[side];
    const down = out.clone().setY(-1);
    for (let i = 0; i < nu; i++) {
      const u0 = i / nu;
      const u1 = (i + 1) / nu;
      for (let j = 0; j < nv; j++) {
        const v0 = j / nv;
        const v1 = (j + 1) / nv;
        const c = stripes && i % 2 === 1 ? dark : base;
        face(b, pt(side, u0, v0, 0), pt(side, u1, v0, 0), pt(side, u1, v1, 0), pt(side, u0, v1, 0), c, out);
      }
      // eave fascia edge
      face(b, pt(side, u0, 0, 0), pt(side, u1, 0, 0), pt(side, u1, 0, -th), pt(side, u0, 0, -th), shade(o.color, 0.6), out.clone().setY(0));
    }
    // underside follows the same curved grid (coarser across) so it never pokes through the top
    for (let i = 0; i < underNu; i++) {
      const u0 = i / underNu;
      const u1 = (i + 1) / underNu;
      for (let j = 0; j < nv; j++) {
        const v0 = j / nv;
        const v1 = (j + 1) / nv;
        face(b, pt(side, u0, v0, -th), pt(side, u1, v0, -th), pt(side, u1, v1, -th), pt(side, u0, v1, -th), under, down);
      }
    }
  }
  if (o.plain) return;
  // ridge beam + corner ridges
  const rc = o.ridgeColor ?? shade(o.color, 0.7);
  const top = y0 + h;
  if (R > 0.2) b.boxAt(cx, top + 0.1, cz, R + 0.2, 0.28, 0.28, rc);
  else b.boxAt(cx, top + 0.1, cz, 0.35, 0.3, 0.35, rc);
  // hip ridges from ridge ends to the corners
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const a = new THREE.Vector3(cx + (sx * R) / 2, top + 0.05, cz);
    const c = pt(sz < 0 ? 0 : 1, sx < 0 ? 0 : 1, 0, 0.05);
    const mid = pt(sz < 0 ? 0 : 1, sx < 0 ? 0.08 : 0.92, 0.5, 0.08);
    b.rod(a, mid, 0.09, rc, 4);
    b.rod(mid, c, 0.09, rc, 4);
    // upturned corner tip
    b.rod(c, c.clone().add(new THREE.Vector3(sx * 0.25, 0.35, sz * 0.25)), 0.07, rc, 4);
    if (o.ornate) b.add(PRIM.sphere(5, 4), trs(c.x + sx * 0.25, c.y + 0.38, c.z + sz * 0.25, 0, 0, 0, 0.09), '#d8ac4c');
  }
  // ridge-end ornaments (鸱吻)
  if (R > 0.2) {
    for (const sx of [-1, 1]) {
      const ex = cx + (sx * (R + 0.2)) / 2;
      b.add(PRIM.box(), trs(ex, top + 0.45, cz, 0, 0, sx * -0.25, 0.3, 0.7, 0.26), o.ornate ? '#d8ac4c' : rc);
      b.add(PRIM.cone(4), trs(ex + sx * 0.12, top + 0.9, cz, 0, 0, sx * 0.6, 0.1, 0.35, 0.1), o.ornate ? '#d8ac4c' : rc);
    }
  } else {
    // pyramid finial (宝顶)
    b.cylAt(cx, top, cz, 0.18, 0.35, o.ornate ? '#d8ac4c' : rc, 8);
    b.add(PRIM.sphere(8, 6), trs(cx, top + 0.55, cz, 0, 0, 0, 0.26), o.ornate ? '#d8ac4c' : rc);
  }
}


/** Simple gable-like coping roof along X on top of a wall (w×d at y0). */
export function copingRoof(b: GeoBuilder, cx: number, y0: number, cz: number, w: number, d: number, h: number, color: ColorLike): void {
  const hw = w / 2;
  const hd = d / 2;
  const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(cx + x, y, cz + z);
  face(b, v(-hw, y0, -hd), v(hw, y0, -hd), v(hw, y0 + h, 0), v(-hw, y0 + h, 0), color, new THREE.Vector3(0, 1, -1));
  face(b, v(-hw, y0, hd), v(hw, y0, hd), v(hw, y0 + h, 0), v(-hw, y0 + h, 0), shade(color, 0.9), new THREE.Vector3(0, 1, 1));
  tri(b, v(-hw, y0, -hd), v(-hw, y0, hd), v(-hw, y0 + h, 0), shade(color, 0.8), new THREE.Vector3(-1, 0, 0));
  tri(b, v(hw, y0, -hd), v(hw, y0, hd), v(hw, y0 + h, 0), shade(color, 0.8), new THREE.Vector3(1, 0, 0));
  face(b, v(-hw, y0, -hd), v(hw, y0, -hd), v(hw, y0, hd), v(-hw, y0, hd), shade(color, 0.5), new THREE.Vector3(0, -1, 0));
  b.boxAt(cx, y0 + h, cz, w, 0.08, 0.1, shade(color, 0.75));
}
