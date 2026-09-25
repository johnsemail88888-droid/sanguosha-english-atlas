// Procedural geometry toolkit: a triangle accumulator (GeoBuilder) that merges
// transformed primitives into ONE non-indexed BufferGeometry with per-vertex
// colours (and optional rigid skin bone indices / an extra scalar channel).
// Everything static in the world and every character is built with this, so a
// whole building or a whole hero is a single draw call.
import * as THREE from 'three';

export type ColorLike = THREE.ColorRepresentation | THREE.Color;

const colorCache = new Map<string | number, THREE.Color>();

/** Cached THREE.Color (linear working space) for an sRGB hex / css colour. Do not mutate. */
export function col(c: ColorLike): THREE.Color {
  if (c instanceof THREE.Color) return c;
  const key = typeof c === 'number' ? c : String(c);
  let v = colorCache.get(key);
  if (!v) {
    v = new THREE.Color(c as THREE.ColorRepresentation);
    colorCache.set(key, v);
  }
  return v;
}

/** Mix two colours (returns a new Color). */
export function mixCol(a: ColorLike, b: ColorLike, t: number): THREE.Color {
  return col(a).clone().lerp(col(b), t);
}

/** Scale a colour's brightness (returns a new Color). */
export function shade(c: ColorLike, k: number): THREE.Color {
  return col(c).clone().multiplyScalar(k);
}

// ── Primitive templates (unit sized, cached) ────────────────────────────────
const primCache = new Map<string, THREE.BufferGeometry>();

function prim(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = primCache.get(key);
  if (!g) {
    g = make();
    const ng = g.index ? g.toNonIndexed() : g;
    if (ng !== g) g.dispose();
    ng.deleteAttribute('uv');
    ng.computeVertexNormals();
    g = ng;
    primCache.set(key, g);
  }
  return g;
}

export const PRIM = {
  /** 1×1×1 box centred at origin. */
  box: (): THREE.BufferGeometry => prim('box', () => new THREE.BoxGeometry(1, 1, 1)),
  /** unit cylinder (radius 1, height 1, centred) with `seg` sides; top radius ratio `top`. */
  cyl: (seg = 8, top = 1, open = false): THREE.BufferGeometry =>
    prim(`cyl${seg}_${top}_${open}`, () => new THREE.CylinderGeometry(top, 1, 1, seg, 1, open)),
  /** unit cone (radius 1, height 1, centred, apex +Y). */
  cone: (seg = 8): THREE.BufferGeometry => prim(`cone${seg}`, () => new THREE.ConeGeometry(1, 1, seg)),
  /** unit sphere (radius 1). */
  sphere: (w = 8, h = 6): THREE.BufferGeometry => prim(`sph${w}_${h}`, () => new THREE.SphereGeometry(1, w, h)),
  /** upper hemisphere (radius 1). */
  dome: (w = 10, h = 4): THREE.BufferGeometry =>
    prim(`dome${w}_${h}`, () => new THREE.SphereGeometry(1, w, h, 0, Math.PI * 2, 0, Math.PI / 2)),
  /** unit icosahedron. */
  ico: (detail = 0): THREE.BufferGeometry => prim(`ico${detail}`, () => new THREE.IcosahedronGeometry(1, detail)),
  /** unit octahedron. */
  octa: (): THREE.BufferGeometry => prim('octa', () => new THREE.OctahedronGeometry(1, 0)),
  /** torus: ring radius 1, tube radius `tube`. */
  torus: (tube = 0.2, rseg = 6, tseg = 12, arc = Math.PI * 2): THREE.BufferGeometry =>
    prim(`tor${tube}_${rseg}_${tseg}_${arc.toFixed(3)}`, () => new THREE.TorusGeometry(1, tube, rseg, tseg, arc)),
  /** triangular prism: triangle in XY (base y=-0.5 from x=-0.5..0.5, apex (0,0.5)), extruded along Z (depth 1). */
  prism: (): THREE.BufferGeometry =>
    prim('prism', () => {
      const s = new THREE.Shape();
      s.moveTo(-0.5, -0.5);
      s.lineTo(0.5, -0.5);
      s.lineTo(0, 0.5);
      s.lineTo(-0.5, -0.5);
      const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
      g.translate(0, 0, -0.5);
      return g;
    }),
  /** wedge / ramp: rises from y=-0.5 at z=+0.5 to y=+0.5 at z=-0.5 (slope faces +Z/up). */
  wedge: (): THREE.BufferGeometry =>
    prim('wedge', () => {
      const s = new THREE.Shape();
      s.moveTo(-0.5, -0.5);
      s.lineTo(0.5, -0.5);
      s.lineTo(-0.5, 0.5);
      s.lineTo(-0.5, -0.5);
      const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
      g.translate(0, 0, -0.5);
      // shape is in XY with the slope going from (+x,bottom) to (-x,top); rotate so run is along Z
      g.rotateY(-Math.PI / 2);
      return g;
    }),
  /** flat quad in XY (1×1), facing +Z, double-sided when built twice. */
  quad: (): THREE.BufferGeometry => prim('quad', () => new THREE.PlaneGeometry(1, 1)),
};

// ── Matrix helpers ──────────────────────────────────────────────────────────
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

/**
 * Compose a TRS matrix (Euler order YXZ: yaw first, then pitch, then roll).
 * Returns a shared temp matrix — consume immediately (GeoBuilder.add copies).
 */
export function trs(
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return _m.compose(_p, _q, _s);
}

/** Matrix orienting local +Y along the segment a→b (for limbs, poles, ropes), with given radius scale. */
export function segmentMatrix(a: THREE.Vector3, b: THREE.Vector3, rx: number, rz = rx): THREE.Matrix4 {
  const dir = _p.subVectors(b, a);
  const len = dir.length();
  if (len < 1e-6) return trs(a.x, a.y, a.z, 0, 0, 0, rx, 1e-4, rz);
  dir.divideScalar(len);
  _q.setFromUnitVectors(UP, dir);
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  _s.set(rx, len, rz);
  return _m.compose(mid, _q, _s);
}
const UP = new THREE.Vector3(0, 1, 0);

// ── GeoBuilder ──────────────────────────────────────────────────────────────
class FloatBuf {
  a: Float32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Float32Array(cap);
  }
  ensure(extra: number): void {
    if (this.n + extra <= this.a.length) return;
    let cap = this.a.length * 2;
    while (cap < this.n + extra) cap *= 2;
    const b = new Float32Array(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  view(): Float32Array {
    return this.a.slice(0, this.n);
  }
}

export interface GeoBuilderOptions {
  /** write rigid skinning attributes (skinIndex/skinWeight) using `bone` */
  skinned?: boolean;
  /** write an extra float attribute named `extraName` using `extra` */
  extraName?: string;
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _mm = new THREE.Matrix4();
const FLIP_ORDER = [0, 2, 1] as const;

/**
 * Triangle soup accumulator with a transform stack. All `add*` helpers take a
 * matrix in the current local frame (see `push`). Output is non-indexed so
 * flat-shaded low-poly faces stay crisp.
 */
export class GeoBuilder {
  private pos = new FloatBuf(3 * 1024);
  private nrm = new FloatBuf(3 * 1024);
  private clr = new FloatBuf(3 * 1024);
  private skin: FloatBuf | null;
  private ext: FloatBuf | null;
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  /** current bone index for skinned output */
  bone = 0;
  /** current extra channel value */
  extra = 0;
  readonly extraName: string | null;

  constructor(opts: GeoBuilderOptions = {}) {
    this.skin = opts.skinned ? new FloatBuf(1024) : null;
    this.ext = opts.extraName ? new FloatBuf(1024) : null;
    this.extraName = opts.extraName ?? null;
  }

  get vertexCount(): number {
    return this.pos.n / 3;
  }

  /** Push a local frame (multiplied onto the current one). */
  push(m: THREE.Matrix4): this {
    const top = this.stack[this.stack.length - 1];
    this.stack.push(new THREE.Matrix4().multiplyMatrices(top, m));
    return this;
  }

  pop(): this {
    if (this.stack.length > 1) this.stack.pop();
    return this;
  }

  /** The current local frame (read-only: do not mutate). */
  get frame(): THREE.Matrix4 {
    return this.stack[this.stack.length - 1];
  }

  /** Append a (non-indexed, normal-bearing) template geometry transformed by m. */
  add(src: THREE.BufferGeometry, m: THREE.Matrix4, color: ColorLike): this {
    const c = col(color);
    return this.addWith(src, m, () => c);
  }

  /** Append with a per-vertex colour function receiving the LOCAL template position. */
  addWith(
    src: THREE.BufferGeometry,
    m: THREE.Matrix4,
    colorAt: (x: number, y: number, z: number, index: number) => THREE.Color,
  ): this {
    const P = src.getAttribute('position') as THREE.BufferAttribute;
    const N = src.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const count = P.count;
    const world = _mm.multiplyMatrices(this.stack[this.stack.length - 1], m);
    _nm.getNormalMatrix(world);
    const flip = world.determinant() < 0;
    this.pos.ensure(count * 3);
    this.nrm.ensure(count * 3);
    this.clr.ensure(count * 3);
    this.skin?.ensure(count);
    this.ext?.ensure(count);
    const pa = this.pos.a;
    const na = this.nrm.a;
    const ca = this.clr.a;
    // mirrored transforms flip the winding: swap vertices 1 and 2 of each triangle
    for (let i = 0; i < count; i++) {
      const j = flip ? i - (i % 3) + FLIP_ORDER[i % 3] : i;
      const lx = P.getX(j);
      const ly = P.getY(j);
      const lz = P.getZ(j);
      _v.set(lx, ly, lz).applyMatrix4(world);
      const o = this.pos.n;
      pa[o] = _v.x;
      pa[o + 1] = _v.y;
      pa[o + 2] = _v.z;
      if (N) _n.set(N.getX(j), N.getY(j), N.getZ(j)).applyMatrix3(_nm).normalize();
      else _n.set(0, 1, 0);
      na[o] = _n.x;
      na[o + 1] = _n.y;
      na[o + 2] = _n.z;
      const cc = colorAt(lx, ly, lz, j);
      ca[o] = cc.r;
      ca[o + 1] = cc.g;
      ca[o + 2] = cc.b;
      this.pos.n += 3;
      this.nrm.n += 3;
      this.clr.n += 3;
      if (this.skin) this.skin.a[this.skin.n++] = this.bone;
      if (this.ext) this.ext.a[this.ext.n++] = this.extra;
    }
    return this;
  }

  /** Raw triangle in the current frame (counter-clockwise = front). */
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: ColorLike): this {
    const top = this.stack[this.stack.length - 1];
    const A = a.clone().applyMatrix4(top);
    const B = b.clone().applyMatrix4(top);
    const C = c.clone().applyMatrix4(top);
    const n = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A)).normalize();
    const cc = col(color);
    this.pos.ensure(9);
    this.nrm.ensure(9);
    this.clr.ensure(9);
    this.skin?.ensure(3);
    this.ext?.ensure(3);
    for (const v of [A, B, C]) {
      const o = this.pos.n;
      this.pos.a[o] = v.x;
      this.pos.a[o + 1] = v.y;
      this.pos.a[o + 2] = v.z;
      this.nrm.a[o] = n.x;
      this.nrm.a[o + 1] = n.y;
      this.nrm.a[o + 2] = n.z;
      this.clr.a[o] = cc.r;
      this.clr.a[o + 1] = cc.g;
      this.clr.a[o + 2] = cc.b;
      this.pos.n += 3;
      this.nrm.n += 3;
      this.clr.n += 3;
      if (this.skin) this.skin.a[this.skin.n++] = this.bone;
      if (this.ext) this.ext.a[this.ext.n++] = this.extra;
    }
    return this;
  }

  /** Quad a-b-c-d (counter-clockwise). */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: ColorLike, doubleSided = false): this {
    this.tri(a, b, c, color).tri(a, c, d, color);
    if (doubleSided) this.tri(a, c, b, color).tri(a, d, c, color);
    return this;
  }

  // Convenience primitives (all centred on the matrix origin unless noted).
  box(m: THREE.Matrix4, color: ColorLike): this {
    return this.add(PRIM.box(), m, color);
  }

  /** Axis-aligned box from its size + centre (in the current frame). */
  boxAt(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: ColorLike, ry = 0): this {
    return this.add(PRIM.box(), trs(x, y, z, 0, ry, 0, sx, sy, sz), color);
  }

  /** Vertical cylinder standing on (x, y0, z). */
  cylAt(x: number, y0: number, z: number, r: number, h: number, color: ColorLike, seg = 8, top = 1): this {
    return this.add(PRIM.cyl(seg, top), trs(x, y0 + h / 2, z, 0, 0, 0, r, h, r), color);
  }

  /** Cylinder between two points. */
  rod(a: THREE.Vector3, b: THREE.Vector3, r: number, color: ColorLike, seg = 6, top = 1): this {
    return this.add(PRIM.cyl(seg, top), segmentMatrix(a, b, r), color);
  }

  /** Append another builder's output (already in world space of that builder) transformed by m. */
  merge(other: GeoBuilder, m?: THREE.Matrix4): this {
    const g = other.build();
    this.addRaw(g, m ?? new THREE.Matrix4());
    g.dispose();
    return this;
  }

  /** Append a built geometry that already carries a colour attribute. */
  addRaw(g: THREE.BufferGeometry, m: THREE.Matrix4): this {
    const ng = g.index ? g.toNonIndexed() : g;
    const cAttr = ng.getAttribute('color') as THREE.BufferAttribute | undefined;
    const tmp = new THREE.Color(1, 1, 1);
    this.addWith(ng, m, (_x, _y, _z, i) => (cAttr ? tmp.setRGB(cAttr.getX(i), cAttr.getY(i), cAttr.getZ(i)) : tmp));
    if (ng !== g) ng.dispose();
    return this;
  }

  isEmpty(): boolean {
    return this.pos.n === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.view(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.view(), 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.clr.view(), 3));
    if (this.skin) {
      const n = this.skin.n;
      const idx = new Uint16Array(n * 4);
      const w = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        idx[i * 4] = this.skin.a[i];
        w[i * 4] = 1;
      }
      g.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
    }
    if (this.ext && this.extraName) g.setAttribute(this.extraName, new THREE.BufferAttribute(this.ext.view(), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Lathe helper: revolve a profile (radius, y) pairs around Y into a template geometry. */
export function latheGeo(profile: [number, number][], seg = 10): THREE.BufferGeometry {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0001, r), y));
  const g = new THREE.LatheGeometry(pts, seg);
  const ng = g.toNonIndexed();
  g.dispose();
  ng.deleteAttribute('uv');
  ng.computeVertexNormals();
  return ng;
}

/** Extrude a 2D polygon (XY) by depth along Z (centred) into a template geometry. */
export function extrudeGeo(points: [number, number][], depth: number, bevel = 0): THREE.BufferGeometry {
  const s = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(s, {
    depth,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 1,
  });
  g.translate(0, 0, -depth / 2);
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng !== g) g.dispose();
  ng.deleteAttribute('uv');
  ng.computeVertexNormals();
  return ng;
}
