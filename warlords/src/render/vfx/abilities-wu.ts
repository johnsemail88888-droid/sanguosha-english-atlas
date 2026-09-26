// Bespoke VFX for the 吴 Wu abilities (孙权 甘宁 吕蒙 黄盖 周瑜 大乔 陆逊 孙尚香).
// The integrator calls registerWuAbilityVfx() once, after the renderer's
// built-in table (each entry replaces the generic / built-in flavour).
//
// These draw the *cast*. The sim emits the follow-up visuals itself: 火烧赤壁's
// five bombs and 诈降火船's blast are 'fire' explosion events, 弓腰姬's arrows
// are projectiles with their own blasts, and every burning field (luxun_fire,
// chibi_napalm, huochuan_fire) is a hazard entity drawn as fire. Passives that
// announce themselves with an 'ability' event (流离, 连营, 枭姬, 克己) get one too.
import * as THREE from 'three';
import { ABILITY_BY_ID } from '../../data';
import { MAP_RES, MAP_SIZE } from '../../sim/map/terrain';
import { PT, type ParticleTex } from '../core/textures';
import { registerAbilityVfx, type AbilityVfxContext, type AbilityVfxFn } from './abilities';
import { FX_COLORS } from './effects';

const C = (r: number, g: number, b: number): THREE.Color => new THREE.Color(r, g, b);

const WU_GREEN = C(0.5, 2.1, 1.0);
const JADE = C(0.4, 1.9, 1.4);
const GOLD = C(2.2, 1.6, 0.45);
const EMBER = C(2.6, 0.9, 0.2);
const NAPALM = C(2.8, 0.55, 0.12);
const WARN_RED = C(2.6, 0.35, 0.15);
const EMP = C(0.7, 1.6, 2.8);
const PETAL_PINK = C(2.3, 0.9, 1.3);
const CHARM_PINK = C(2.4, 0.55, 1.2);
const MIND_VIOLET = C(1.4, 0.6, 2.4);
const MIST = C(0.85, 0.9, 0.92);
const BLOOD = C(0.55, 0.03, 0.03);
const ROYAL_RED = C(2.4, 0.4, 0.35);

// ── helpers ─────────────────────────────────────────────────────────────────
/** Ground-level copy of a point (+ lift). */
function ground(ctx: AbilityVfxContext, p: THREE.Vector3, lift = 0.08): THREE.Vector3 {
  return new THREE.Vector3(p.x, ctx.fx.groundY(p.x, p.z) + lift, p.z);
}

/** Caster feet (view entity), falling back to the chest anchor. */
function feet(ctx: AbilityVfxContext): THREE.Vector3 | null {
  if (ctx.src) return new THREE.Vector3(ctx.src.x, ctx.src.y, ctx.src.z);
  return ctx.srcPos ? ctx.srcPos.clone().setY(ctx.srcPos.y - 1) : null;
}

/** Horizontal unit direction of the cast (aim yaw). */
function flatDir(ctx: AbilityVfxContext): THREE.Vector3 {
  const d = new THREE.Vector3(ctx.dir.x, 0, ctx.dir.z);
  if (d.lengthSq() < 1e-6) {
    const yaw = ctx.src?.yaw ?? 0;
    d.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  }
  return d.normalize();
}

const yawOf = (d: THREE.Vector3): number => Math.atan2(-d.x, -d.z);

/** Ability tunable from the data (VFX follows the numbers the sim uses). */
function p(id: string, key: string, fallback: number): number {
  const v = ABILITY_BY_ID[id]?.params[key];
  return v === undefined || !Number.isFinite(v) ? fallback : v;
}

/** The unit the cast resolved to, else the crosshair point. */
const targetOrPoint = (ctx: AbilityVfxContext): THREE.Vector3 | null => ctx.targetPos ?? ctx.point;

/** Stream of particles along a segment (charm tethers, petal swirls). */
function streamAlong(ctx: AbilityVfxContext, a: THREE.Vector3, b: THREE.Vector3, n: number, color: THREE.Color, tex: ParticleTex, size: number): void {
  const d = b.clone().sub(a);
  const len = d.length();
  if (len < 1e-3) return;
  d.divideScalar(len);
  for (let i = 0; i < n; i++) {
    const at = a.clone().addScaledVector(d, (len * (i + 0.5)) / n);
    ctx.fx.burst(at, { count: 1, tex, color, dir: d, spread: 0.25, speed: [0.5, 1.5], life: [0.5, 0.9], size: [size, size * 0.4], gravity: -0.6, spin: 4 });
  }
}

// ── 孙权 ────────────────────────────────────────────────────────────────────
/** 制衡: the hand is reshuffled — a whirl of gold cards around him, green seal ring. */
const zhiheng: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (!c) return;
  ctx.fx.burst(c, { count: 14, tex: PT.square, color: GOLD, color1: C(2.4, 2.1, 1.2), speed: [2, 4], up: 0.5, life: [0.5, 0.9], size: [0.22, 0.12], drag: 2.5, radius: 0.6, spin: 9 });
  ctx.fx.fx.ring(ground(ctx, c), { color: WU_GREEN, radius0: 0.3, radius1: 2.2, life: 0.5, inner: 0.78, alpha: 1.1 });
  ctx.fx.sparkle(c, GOLD, 10);
};

/** 坐断东南: Jiefan marksmen rally — a green standard pillar and a dust ring. */
const zuoduan: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const g = ground(ctx, f);
  ctx.fx.fx.pillar(g, WU_GREEN, 0.5, 5, 0.8, 0.8);
  ctx.fx.fx.ring(g, { color: WU_GREEN, radius0: 0.5, radius1: 4, life: 0.7, inner: 0.85 });
  ctx.fx.burst(g, { count: 12, tex: PT.dust, color: FX_COLORS.dust, speed: [3, 6], life: [0.6, 1], size: [0.5, 1.5], additive: false, alpha: 0.55, drag: 3, flat: true, radius: 1 });
};

/** 救援: a jade dome spreads over the Wu line (15 m) with rising motes. */
const jiuyuan: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const r = p('sunquan_jiuyuan', 'radius', 15);
  const g = ground(ctx, f);
  ctx.fx.fx.ring(g, { color: JADE, radius0: 1, radius1: r, life: 1.1, inner: 0.93, alpha: 1.2 });
  ctx.fx.fx.ring(g, { color: GOLD, radius0: 0.5, radius1: r * 0.55, life: 0.8, inner: 0.9, alpha: 0.8 });
  ctx.fx.fx.sphere(g, JADE, 1, r * 0.45, 0.6, 0.35);
  ctx.fx.burst(g, { count: 26, tex: PT.glow, color: JADE, color1: GOLD, speed: [0.5, 2], up: 1, life: [1, 1.8], size: [0.18, 0.05], gravity: -1.4, radius: r * 0.5, flat: true });
};

// ── 甘宁 ────────────────────────────────────────────────────────────────────
/** 奇袭: a crackling EMP bolt from his crossbow to the target, sparks and a shock ring there. */
const qixi: AbilityVfxFn = (ctx) => {
  const a = ctx.srcPos;
  const b = targetOrPoint(ctx);
  if (a && b) {
    ctx.fx.beams.lightning(a, b, EMP, 0.18, 0.3);
    ctx.fx.beams.beam(a, b, C(1.6, 2, 2.6), 0.05, 0.25, 0.9);
  }
  if (b) {
    ctx.fx.burst(b, { count: 22, tex: PT.spark, color: EMP, color1: C(2, 2, 2.6), speed: [4, 10], life: [0.2, 0.45], size: [0.06, 0.02], stretch: 0.04, gravity: 6 });
    ctx.fx.fx.sphere(b, EMP, 0.2, 1.6, 0.3, 0.8);
    ctx.fx.lights.flash(b, C(0.5, 0.8, 1.2), 10, 10, 0.2);
  }
};

/** 百骑劫营: he (and his riders) melt into river mist, bells glinting. */
const jieying: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (!c) return;
  ctx.fx.burst(c, { count: 16, tex: PT.smoke, color: MIST, speed: [0.5, 2.2], life: [0.9, 1.6], size: [0.7, 2.2], additive: false, alpha: 0.55, drag: 2, radius: 1.2 });
  ctx.fx.burst(c, { count: 8, tex: PT.star, color: GOLD, speed: [0.5, 1.5], up: 0.6, life: [0.4, 0.8], size: [0.1, 0.02], spin: 6, radius: 0.5 });
};

// ── 吕蒙 ────────────────────────────────────────────────────────────────────
/** 白衣渡江: a swirl of white robes and mist as he vanishes. */
const baiyi: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (!c) return;
  ctx.fx.burst(c, { count: 14, tex: PT.smoke, color: C(0.95, 0.96, 0.98), speed: [0.6, 2], life: [0.8, 1.4], size: [0.6, 1.9], additive: false, alpha: 0.6, drag: 2, radius: 0.6 });
  ctx.fx.fx.ring(ground(ctx, c), { color: C(1.6, 1.7, 1.7), radius0: 0.3, radius1: 2.4, life: 0.5, inner: 0.8, alpha: 0.7 });
};

/** 克己 (private: only he sees it): a faint wisp as he fades out. */
const keji: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (c) ctx.fx.burst(c, { count: 6, tex: PT.smoke, color: MIST, speed: [0.3, 1], life: [0.6, 1], size: [0.5, 1.3], additive: false, alpha: 0.35, drag: 2, radius: 0.4 });
};

/** 攻心: a violet mind-lance to the target, an ink burst where it strikes. */
const gongxin: AbilityVfxFn = (ctx) => {
  const a = ctx.srcPos;
  const b = targetOrPoint(ctx);
  if (a && b) ctx.fx.beams.beam(a, b, MIND_VIOLET, 0.07, 0.4, 0.9);
  if (b) {
    ctx.fx.inkSplash(b, 1.2);
    ctx.fx.burst(b, { count: 10, tex: PT.glow, color: MIND_VIOLET, speed: [1, 3], life: [0.3, 0.6], size: [0.15, 0.04], radius: 0.3 });
  }
};

// ── 黄盖 ────────────────────────────────────────────────────────────────────
/** 苦肉: the lash — a spray of blood-ink and embers around him. */
const kurou: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (!c) return;
  ctx.fx.burst(c, { count: 14, tex: PT.ink, color: BLOOD, color1: C(0.25, 0.01, 0.01), speed: [1.5, 4], up: 0.3, life: [0.4, 0.7], size: [0.08, 0.04], gravity: 9, additive: false, alpha: 0.95, radius: 0.3 });
  ctx.fx.burst(c, { count: 10, tex: PT.flame, color: EMBER, color1: C(0.9, 0.2, 0.04), speed: [0.5, 2], up: 0.8, life: [0.4, 0.8], size: [0.25, 0.6], gravity: -2, radius: 0.5 });
};

/** 诈降火船: the burning drone launches — a flame gout and smoke along the launch line. */
const huochuan: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (!c) return;
  const d = ctx.dir.clone().normalize();
  const muzzle = c.clone().addScaledVector(d, 0.8);
  ctx.fx.burst(muzzle, { count: 14, tex: PT.flame, color: EMBER, color1: C(0.9, 0.25, 0.05), dir: d, spread: 0.35, speed: [3, 7], life: [0.25, 0.5], size: [0.3, 0.8], drag: 3 });
  ctx.fx.burst(muzzle, { count: 8, tex: PT.smoke, color: FX_COLORS.smoke, dir: d.clone().negate(), spread: 0.5, speed: [0.5, 2], life: [0.8, 1.4], size: [0.5, 1.6], additive: false, alpha: 0.5, drag: 1.5 });
  ctx.fx.lights.flash(muzzle, C(1, 0.5, 0.2), 8, 10, 0.2);
};

// ── 周瑜 ────────────────────────────────────────────────────────────────────
/**
 * 反间: a pink tether to the charmed enemy and hearts swirling around it. No line to whoever it
 * turns on: until docs/SIM_REQUESTS.md WU-1 lands, the event's pos is the raw crosshair point,
 * not that hero (the victim's own forced fire shows whom it attacks).
 */
const fanjian: AbilityVfxFn = (ctx) => {
  const a = ctx.srcPos;
  const t = ctx.targetPos ?? ctx.point;
  if (a && t) {
    ctx.fx.beams.beam(a, t, CHARM_PINK, 0.06, 0.45, 0.9);
    streamAlong(ctx, a, t, 6, CHARM_PINK, PT.heart, 0.14);
  }
  if (!t) return;
  ctx.fx.burst(t, { count: 12, tex: PT.heart, color: CHARM_PINK, speed: [0.5, 2], up: 0.8, life: [0.8, 1.3], size: [0.22, 0.12], gravity: -1, spin: 3 });
  ctx.fx.burst(t, { count: 10, tex: PT.heart, color: C(2.6, 0.35, 0.3), speed: [1.2, 2], life: [1.2, 1.8], size: [0.14, 0.08], gravity: -0.3, drag: 1.5, spin: 6, radius: 0.7, flat: true });
};

// ── 火烧赤壁 warning decal ──────────────────────────────────────────────────
// A terrain-conforming ground mesh (the flat pooled fx discs sink into sloped or faceted
// ground) drawn with normal blending: additive red washes out on bright sand and stone.
const CHIBI_VERT = /* glsl */ `
attribute vec2 aLocal; // (along the line, across it) in metres
varying vec2 vLocal;
void main() {
  vLocal = aLocal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const CHIBI_FRAG = /* glsl */ `
uniform float uT;    // 0 → 1 over the warning
uniform float uFade; // 1 → 0 after the bombs land
uniform float uR;    // blast radius
uniform float uLen;  // line length
uniform float uN;    // bombs
varying vec2 vLocal;
void main() {
  float gap = uN > 1.0 ? uLen / (uN - 1.0) : 0.0;
  float dmin = 1e5;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= uN) break;
    float c = uN > 1.0 ? float(i) * gap : uLen * 0.5;
    dmin = min(dmin, length(vLocal - vec2(c, 0.0)));
  }
  float r = dmin / uR; // 0 at the nearest bomb, 1 at its blast edge
  if (r > 1.08) discard;
  float inside = 1.0 - smoothstep(0.95, 1.0, r);
  // scorch that deepens as the bombs fall
  float dark = inside * mix(0.42, 0.68, uT);
  // painted rim on the blast edge
  float rim = smoothstep(0.85, 0.91, r) * (1.0 - smoothstep(1.0, 1.07, r));
  // countdown ring closing in on each impact point
  float cr = mix(0.92, 0.1, uT);
  float cd = smoothstep(cr - 0.08, cr, r) * (1.0 - smoothstep(cr, cr + 0.08, r));
  // dashed centre line down the corridor
  float dash = (1.0 - smoothstep(0.16, 0.26, abs(vLocal.y))) * step(0.45, fract(vLocal.x / 1.6)) * inside;
  float red = max(rim, max(cd * 0.9, dash * 0.85));
  float pulse = 0.85 + 0.15 * sin(uT * 30.0);
  vec3 col = mix(vec3(0.05, 0.008, 0.0), vec3(0.95, 0.08, 0.025) * pulse, red);
  float a = max(dark, red * 0.95) * uFade;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}`;

interface LiveDecal {
  mesh: THREE.Mesh;
  /** the Effects it lives in (its clock decides expiry) */
  fx: AbilityVfxContext['fx'];
  until: number;
}
const liveDecals: LiveDecal[] = [];

function disposeDecal(d: LiveDecal): void {
  d.mesh.removeFromParent();
  d.mesh.geometry.dispose();
  (d.mesh.material as THREE.Material).dispose();
}

/** Drop decals that have run out (on the next cast, or right after the frame they expired in). */
function sweepDecals(): void {
  for (let i = liveDecals.length - 1; i >= 0; i--) {
    if (liveDecals[i].until > liveDecals[i].fx.time) continue;
    disposeDecal(liveDecals[i]);
    liveDecals.splice(i, 1);
  }
}

/** Terrain triangulation the decal must hug (render/scene/terrain.ts: one quad per heightfield cell). */
const TERRAIN_CELL = MAP_SIZE / MAP_RES;
const TERRAIN_ORIGIN = -MAP_SIZE / 2;

/**
 * Ground mesh along the strike line (length `len`, blast radius `r`) that never dips under the
 * terrain: its vertices sit on the heightfield grid nodes (exact), cell edge midpoints (exact:
 * heights are linear along an edge) and cell centres (the higher of the two diagonals, so
 * whichever way the renderer split the quad, the decal is on or just above it). Each cell is
 * fanned into 8 triangles around its centre, every one inside a single terrain triangle.
 */
function chibiDecal(ctx: AbilityVfxContext, from: THREE.Vector3, d: THREE.Vector3, n: number, len: number, r: number, delay: number): void {
  const fx = ctx.fx;
  sweepDecals();
  const g = (x: number, z: number): number => fx.groundY(x, z);
  const side = new THREE.Vector3(-d.z, 0, d.x);
  const pad = r + 0.6;
  const C = TERRAIN_CELL;
  const half = C / 2;
  // cells (by index) whose centre lies within reach of the strike segment
  const ex = Math.abs(d.x) * (len / 2) + pad + C;
  const ez = Math.abs(d.z) * (len / 2) + pad + C;
  const mx = from.x + d.x * (len / 2);
  const mz = from.z + d.z * (len / 2);
  const i0 = Math.floor((mx - ex - TERRAIN_ORIGIN) / C);
  const i1 = Math.ceil((mx + ex - TERRAIN_ORIGIN) / C);
  const k0 = Math.floor((mz - ez - TERRAIN_ORIGIN) / C);
  const k1 = Math.ceil((mz + ez - TERRAIN_ORIGIN) / C);
  const reach = pad + C * 0.75;
  const pos: number[] = [];
  const loc: number[] = [];
  const idx: number[] = [];
  const vid = new Map<number, number>();
  const W = (i1 - i0) * 2 + 3;
  // vertex on the half-cell lattice (a, b) = (2·cell + 0|1|2 …), created once
  const vert = (a: number, b: number, centre: boolean): number => {
    const key = (b - k0 * 2) * W + (a - i0 * 2);
    const hit = vid.get(key);
    if (hit !== undefined) return hit;
    const x = TERRAIN_ORIGIN + a * half;
    const z = TERRAIN_ORIGIN + b * half;
    let y = g(x, z);
    if (centre) {
      const h00 = g(x - half, z - half);
      const h11 = g(x + half, z + half);
      const h10 = g(x + half, z - half);
      const h01 = g(x - half, z + half);
      y = Math.max(y, (h00 + h11) / 2, (h10 + h01) / 2);
    }
    const k = pos.length / 3;
    pos.push(x, y + 0.06, z);
    loc.push((x - from.x) * d.x + (z - from.z) * d.z, (x - from.x) * side.x + (z - from.z) * side.z);
    vid.set(key, k);
    return k;
  };
  for (let i = i0; i < i1; i++) {
    for (let k = k0; k < k1; k++) {
      const cxw = TERRAIN_ORIGIN + (i + 0.5) * C;
      const czw = TERRAIN_ORIGIN + (k + 0.5) * C;
      const u = Math.min(len, Math.max(0, (cxw - from.x) * d.x + (czw - from.z) * d.z));
      if (Math.hypot(cxw - (from.x + d.x * u), czw - (from.z + d.z * u)) > reach) continue;
      const a = i * 2;
      const b = k * 2;
      const ctr = vert(a + 1, b + 1, true);
      // ring of corners / edge midpoints around the centre
      const ring = [vert(a, b, false), vert(a + 1, b, false), vert(a + 2, b, false), vert(a + 2, b + 1, false), vert(a + 2, b + 2, false), vert(a + 1, b + 2, false), vert(a, b + 2, false), vert(a, b + 1, false)];
      for (let t = 0; t < 8; t++) idx.push(ring[t], ring[(t + 1) % 8], ctr);
    }
  }
  if (idx.length === 0) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('aLocal', new THREE.BufferAttribute(new Float32Array(loc), 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const uniforms = { uT: { value: 0 }, uFade: { value: 1 }, uR: { value: r }, uLen: { value: len }, uN: { value: n } };
  const mat = new THREE.ShaderMaterial({
    vertexShader: CHIBI_VERT,
    fragmentShader: CHIBI_FRAG,
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'vfx_chibi_warning';
  mesh.renderOrder = 17; // under the pooled fx (pillars, embers) and particles
  mesh.frustumCulled = false; // animates in onBeforeRender, so it must be visited every frame
  const born = fx.time;
  const fade = 0.3;
  const live: LiveDecal = { mesh, fx, until: born + delay + fade };
  mesh.onBeforeRender = () => {
    const age = fx.time - born;
    uniforms.uT.value = Math.min(1, age / delay);
    uniforms.uFade.value = age <= delay ? 1 : Math.max(0, 1 - (age - delay) / fade);
    if (age >= delay + fade && mesh.visible) {
      mesh.visible = false;
      queueMicrotask(sweepDecals);
    }
  };
  fx.group.add(mesh);
  liveDecals.push(live);
}

/**
 * 火烧赤壁: the 1.5 s warning — the only counterplay to a 100-damage strike, so it must read
 * on bright sand and on stone alike: a scorch decal hugging the ground under all five blast
 * circles, with painted red rims, a red countdown ring closing in on each impact point and a
 * dashed red centre line; plus a flare pillar and embers on every bomb. The sim's 'fire'
 * explosions land on the marks.
 */
const chibi: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const d = flatDir(ctx);
  const n = Math.min(8, Math.max(1, Math.round(p('zhouyu_chibi', 'blasts', 5))));
  const len = p('zhouyu_chibi', 'length', 25);
  const r = p('zhouyu_chibi', 'radius', 3.5);
  const delay = Math.max(0.3, p('zhouyu_chibi', 'delay', 1.5));
  chibiDecal(ctx, f, d, n, len, r, delay);
  // his own view: no flare through his own body (the first bomb lands at his feet)
  const own = ctx.localId !== null && ctx.src?.id === ctx.localId;
  for (let i = 0; i < n; i++) {
    const at = f.clone().addScaledVector(d, n > 1 ? (i * len) / (n - 1) : len / 2);
    const g = ground(ctx, at, 0.1);
    if (!(own && i === 0)) {
      // pooled pillars fade out over their life: start hot so they still burn when the bombs land
      ctx.fx.fx.pillar(g, WARN_RED, 0.28, 6, delay, 2);
      ctx.fx.fx.pillar(g, NAPALM, 0.8, 2.5, delay, 0.7);
    }
    ctx.fx.burst(g, { count: 5, tex: PT.flame, color: EMBER, speed: [0.2, 0.8], up: 1, life: [0.6, 1.2], size: [0.15, 0.3], gravity: -1.2, radius: r * 0.6, flat: true });
  }
  ctx.fx.slash(ground(ctx, f, 0.1), yawOf(d), 3, 40, NAPALM);
};

// ── 大乔 ────────────────────────────────────────────────────────────────────
/** 国色: 乐不思蜀 thrown — a pink arc to the target, notes and petals around it. */
const guose: AbilityVfxFn = (ctx) => {
  const a = ctx.srcPos;
  const b = targetOrPoint(ctx);
  if (a && b) streamAlong(ctx, a, b, 8, PETAL_PINK, PT.petal, 0.14);
  if (!b) return;
  ctx.fx.burst(b, { count: 12, tex: PT.note, color: C(2, 1.6, 0.6), speed: [0.5, 2], up: 0.8, life: [0.9, 1.5], size: [0.24, 0.14], gravity: -1, spin: 3 });
  ctx.fx.burst(b, { count: 10, tex: PT.heart, color: PETAL_PINK, speed: [0.4, 1.6], up: 0.9, life: [0.8, 1.3], size: [0.18, 0.1], gravity: -0.8, spin: 3, radius: 0.4 });
  ctx.fx.fx.ring(ground(ctx, b), { color: PETAL_PINK, radius0: 0.3, radius1: 1.6, life: 0.7, inner: 0.7 });
};

/** 安娴: a calm pink-green circle (8 m) and drifting petals; the heals show their own motes. */
const anxian: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const r = p('daqiao_anxian', 'radius', 8);
  const g = ground(ctx, f);
  ctx.fx.fx.ring(g, { color: FX_COLORS.heal, radius0: 0.5, radius1: r, life: 0.9, inner: 0.9, alpha: 1 });
  ctx.fx.fx.ring(g, { color: PETAL_PINK, radius0: 0.3, radius1: r * 0.6, life: 0.7, inner: 0.85, alpha: 0.8 });
  ctx.fx.burst(g, { count: 22, tex: PT.petal, color: PETAL_PINK, color1: C(2, 1.6, 1.6), speed: [0.4, 1.4], up: 1, life: [1.2, 2], size: [0.14, 0.09], gravity: -0.4, drag: 0.8, spin: 5, radius: r * 0.6, flat: true });
  if (ctx.srcPos) ctx.fx.heal(ctx.srcPos, 80);
};

/** 流离: a swirl of petals whisks the bullet from her to the unit that takes it (event target). */
const liuli: AbilityVfxFn = (ctx) => {
  const a = ctx.srcPos;
  const b = ctx.targetPos ?? ctx.point;
  if (a) ctx.fx.burst(a, { count: 8, tex: PT.petal, color: PETAL_PINK, speed: [1, 3], life: [0.4, 0.8], size: [0.12, 0.06], spin: 8, radius: 0.5 });
  if (a && b && a.distanceTo(b) > 0.5) {
    ctx.fx.beams.beam(a, b, PETAL_PINK, 0.04, 0.3, 0.8);
    streamAlong(ctx, a, b, 5, PETAL_PINK, PT.petal, 0.12);
  }
};

// ── 陆逊 ────────────────────────────────────────────────────────────────────
/** 火烧连营: the camps ignite along the line, `count` × `spacing` m (the fields draw themselves). */
const huoshao: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const d = flatDir(ctx);
  const n = Math.max(1, Math.round(p('luxun_huoshao', 'count', 5)));
  const spacing = p('luxun_huoshao', 'spacing', 4);
  const r = p('luxun_huoshao', 'radius', 2.5);
  // geometry from the data alone: before WU-1 the event pos is the raw crosshair point, so
  // it cannot say where a wall stopped the line (the burning fields draw themselves anyway)
  for (let i = 0; i < n; i++) {
    const dist = spacing * (0.75 + i);
    const g = ground(ctx, f.clone().addScaledVector(d, dist), 0.1);
    ctx.fx.burst(g, { count: 8, tex: PT.flame, color: EMBER, color1: C(0.9, 0.2, 0.04), speed: [1, 3.5], up: 0.9, life: [0.4, 0.8], size: [0.4, 1.1], gravity: -2, radius: r * 0.5, flat: true });
    ctx.fx.fx.ring(g, { color: C(2.4, 0.9, 0.25), radius0: 0.3, radius1: r, life: 0.4, inner: 0.75 });
  }
};

/** 燎原: a fire nova around him — every field he owns flares wider. */
const liaoyuan: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const g = ground(ctx, f);
  ctx.fx.fx.ring(g, { color: EMBER, radius0: 0.5, radius1: 7, life: 0.6, inner: 0.8, alpha: 1.2 });
  ctx.fx.burst(g, { count: 20, tex: PT.flame, color: EMBER, color1: C(0.8, 0.15, 0.03), speed: [3, 7], up: 0.3, life: [0.35, 0.7], size: [0.4, 1], drag: 3, flat: true, radius: 0.8 });
  ctx.fx.lights.flash(g.clone().setY(g.y + 1), C(1, 0.5, 0.2), 12, 14, 0.3);
};

/** 连营: a quick ember flick at his hands as half a magazine slams in. */
const lianying: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (c) ctx.fx.burst(c, { count: 8, tex: PT.spark, color: EMBER, speed: [1.5, 4], life: [0.15, 0.35], size: [0.05, 0.02], stretch: 0.03, radius: 0.2 });
};

// ── 孙尚香 ──────────────────────────────────────────────────────────────────
/** 枭姬: a red-gold rally flare and speed lines as she bounces back. */
const xiaoji: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (!c) return;
  ctx.fx.fx.ring(ground(ctx, c), { color: ROYAL_RED, radius0: 0.4, radius1: 3, life: 0.5, inner: 0.8, alpha: 1.1 });
  ctx.fx.burst(c, { count: 12, tex: PT.star, color: GOLD, speed: [1, 3], up: 0.6, life: [0.4, 0.8], size: [0.14, 0.03], spin: 6, radius: 0.4 });
  ctx.fx.burst(c, { count: 8, tex: PT.chevron, color: ROYAL_RED, dir: ctx.dir.clone().negate(), spread: 0.3, speed: [3, 6], life: [0.25, 0.45], size: [0.25, 0.1] });
};

/** 结姻: a ribbon of hearts ties her to her husband; both glow with healing. */
const jieyin: AbilityVfxFn = (ctx) => {
  const a = ctx.srcPos;
  const b = ctx.targetPos ?? ctx.point;
  if (a && b) {
    ctx.fx.beams.beam(a, b, C(2.4, 1.2, 0.7), 0.05, 0.6, 0.8);
    streamAlong(ctx, a, b, 7, CHARM_PINK, PT.heart, 0.16);
  }
  if (a) ctx.fx.heal(a, 100);
  if (b) ctx.fx.heal(b, 100);
};

/** 弓腰姬: the bow snaps — a gold 30° fan flash in front of her. */
const gongyao: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (!c) return;
  const d = flatDir(ctx);
  const fan = p('sunshangxiang_gongyao', 'spread', 30);
  ctx.fx.slash(c.clone().setY(c.y - 0.1), yawOf(d), 5, fan, GOLD);
  ctx.fx.burst(c.clone().addScaledVector(ctx.dir, 0.7), { count: 12, tex: PT.spark, color: GOLD, dir: ctx.dir, spread: 0.3, speed: [5, 10], life: [0.15, 0.3], size: [0.05, 0.02], stretch: 0.04 });
};

const WU_VFX: Record<string, AbilityVfxFn> = {
  sunquan_zhiheng: zhiheng,
  sunquan_zuoduan: zuoduan,
  sunquan_jiuyuan: jiuyuan,
  ganning_qixi: qixi,
  ganning_jieying: jieying,
  lumeng_baiyi: baiyi,
  lumeng_keji: keji,
  lumeng_gongxin: gongxin,
  huanggai_kurou: kurou,
  huanggai_huochuan: huochuan,
  zhouyu_fanjian: fanjian,
  zhouyu_chibi: chibi,
  daqiao_guose: guose,
  daqiao_anxian: anxian,
  daqiao_liuli: liuli,
  luxun_huoshao: huoshao,
  luxun_liaoyuan: liaoyuan,
  luxun_lianying: lianying,
  sunshangxiang_xiaoji: xiaoji,
  sunshangxiang_jieyin: jieyin,
  sunshangxiang_gongyao: gongyao,
};

/** Register the bespoke Wu ability effects (idempotent; replaces built-in flavours). */
export function registerWuAbilityVfx(): void {
  for (const [id, fn] of Object.entries(WU_VFX)) registerAbilityVfx(id, fn);
}

/** Ability ids with a bespoke Wu effect (tests / dev harness). */
export const WU_VFX_IDS: readonly string[] = Object.keys(WU_VFX);
