// High-level effect helpers on top of the pooled primitives. This is the API
// ability VFX (registerAbilityVfx) program against.
import * as THREE from 'three';
import type { EntityId, Kingdom } from '../../core/types';
import { PT, type ParticleTex } from '../core/textures';
import { ParticleSpawn, ParticleSystem } from './particles';
import { BeamSystem } from './beams';
import { FxPool, LightPool } from './fxpool';
import { KINGDOM_COLORS } from '../palette';

export interface BurstOptions {
  count: number;
  tex?: ParticleTex;
  color: THREE.Color;
  color1?: THREE.Color;
  /** initial speed range */
  speed?: [number, number];
  /** 0 = isotropic, 1 = strictly upward hemisphere bias */
  up?: number;
  /** preferred direction (normalised) + cone spread (0..1) */
  dir?: THREE.Vector3;
  spread?: number;
  life?: [number, number];
  size?: [number, number];
  gravity?: number;
  drag?: number;
  additive?: boolean;
  alpha?: number;
  alphaEnd?: number;
  stretch?: number;
  /** spawn within this radius around pos */
  radius?: number;
  /** flatten the spawn disc to the ground plane */
  flat?: boolean;
  spin?: number;
}

export type ShotClass = 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'dmr' | 'sniper' | 'lmg' | 'launcher' | 'flamer' | 'bow' | 'crossbow' | 'melee' | 'tesla' | 'ice' | 'fire';

const C = (r: number, g: number, b: number): THREE.Color => new THREE.Color(r, g, b);

export const FX_COLORS = {
  tracer: C(1.6, 1.15, 0.55),
  tracerSniper: C(2.2, 2.0, 1.5),
  tesla: C(0.6, 1.1, 2.6),
  ice: C(0.7, 1.4, 2.2),
  fire: C(2.4, 0.9, 0.25),
  muzzle: C(2.6, 1.6, 0.6),
  spark: C(2.2, 1.5, 0.6),
  ink: C(0.42, 0.02, 0.02),
  inkDark: C(0.12, 0.01, 0.01),
  smoke: C(0.32, 0.3, 0.28),
  smokeLight: C(0.62, 0.6, 0.56),
  dust: C(0.62, 0.54, 0.42),
  heal: C(0.5, 1.9, 0.7),
  gold: C(2.0, 1.5, 0.5),
  holy: C(2.2, 1.9, 1.0),
  thunder: C(0.8, 1.2, 2.8),
  poison: C(0.45, 0.8, 0.25),
  white: C(1, 1, 1),
};

export class Effects {
  readonly add: ParticleSystem;
  readonly alpha: ParticleSystem;
  readonly beams: BeamSystem;
  readonly fx: FxPool;
  readonly lights: LightPool;
  readonly group = new THREE.Group();
  /** scratch spawn descriptor (reset before use) */
  readonly sp = new ParticleSpawn();
  time = 0;
  /** hooks provided by the renderer */
  entityPos: (id: EntityId | undefined, out: THREE.Vector3, heightFrac?: number) => boolean = () => false;
  entityKingdom: (id: EntityId | undefined) => Kingdom | undefined = () => undefined;
  groundY: (x: number, z: number) => number = () => 0;
  shakeAt: (pos: THREE.Vector3, intensity: number, radius: number) => void = () => undefined;
  private readonly _v = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();

  constructor(scene: THREE.Scene, vfxLights: number) {
    this.add = new ParticleSystem(4096, true);
    this.alpha = new ParticleSystem(3072, false);
    this.beams = new BeamSystem(320);
    this.fx = new FxPool();
    this.lights = new LightPool(scene, vfxLights);
    this.group.name = 'vfx';
    this.group.add(this.alpha.mesh, this.add.mesh, this.beams.mesh, this.fx.group);
  }

  setBudget(particles: number, lights: number): void {
    this.add.budget = particles;
    this.alpha.budget = particles;
    this.lights.setCount(lights);
  }

  update(dt: number): void {
    this.time += dt;
    this.add.update(dt);
    this.alpha.update(dt);
    this.beams.update(dt);
    this.fx.update(dt);
    this.lights.update(dt);
  }

  kingdomColor(k: Kingdom | undefined, boost = 1.6): THREE.Color {
    return new THREE.Color(k ? KINGDOM_COLORS[k] : '#d8ac4c').multiplyScalar(boost);
  }

  /** Generic particle burst. */
  burst(pos: THREE.Vector3, o: BurstOptions): void {
    const sys = o.additive === false ? this.alpha : this.add;
    const s = this.sp;
    const [v0, v1] = o.speed ?? [1, 3];
    const [l0, l1] = o.life ?? [0.4, 0.8];
    const [s0, s1] = o.size ?? [0.2, 0.6];
    const c1 = o.color1 ?? o.color;
    for (let i = 0; i < o.count; i++) {
      s.reset();
      // spawn offset
      const rr = (o.radius ?? 0) * Math.sqrt(Math.random());
      const ang = Math.random() * Math.PI * 2;
      s.x = pos.x + Math.cos(ang) * rr;
      s.z = pos.z + Math.sin(ang) * rr;
      s.y = pos.y + (o.flat ? 0 : (Math.random() - 0.5) * (o.radius ?? 0) * 0.5);
      // velocity
      const d = this._d;
      if (o.dir) {
        const sp = o.spread ?? 0.3;
        d.set(o.dir.x + (Math.random() - 0.5) * 2 * sp, o.dir.y + (Math.random() - 0.5) * 2 * sp, o.dir.z + (Math.random() - 0.5) * 2 * sp).normalize();
      } else {
        d.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
        const up = o.up ?? 0;
        d.y = d.y * (1 - up) + Math.abs(d.y) * up + up * 0.6;
        d.normalize();
      }
      const speed = v0 + Math.random() * (v1 - v0);
      s.vx = d.x * speed;
      s.vy = d.y * speed;
      s.vz = d.z * speed;
      s.life = l0 + Math.random() * (l1 - l0);
      s.size0 = s0 * (0.7 + Math.random() * 0.6);
      s.size1 = s1 * (0.7 + Math.random() * 0.6);
      s.color(o.color, c1);
      s.a0 = o.alpha ?? 1;
      s.a1 = o.alphaEnd ?? 0;
      s.gravity = o.gravity ?? 0;
      s.drag = o.drag ?? 0;
      s.tex = o.tex ?? PT.glow;
      s.rot = Math.random() * Math.PI * 2;
      s.spin = (Math.random() - 0.5) * (o.spin ?? 2);
      s.stretch = o.stretch ?? 0;
      sys.spawn(s);
    }
  }

  // ── weapons ────────────────────────────────────────────────────────────────
  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, cls: ShotClass, withLight: boolean): void {
    if (cls === 'melee' || cls === 'bow' || cls === 'crossbow') return;
    const big = cls === 'shotgun' || cls === 'sniper' || cls === 'launcher' || cls === 'lmg';
    const col = cls === 'tesla' ? FX_COLORS.tesla : cls === 'ice' ? FX_COLORS.ice : FX_COLORS.muzzle;
    if (cls === 'flamer' || cls === 'fire') {
      this.burst(pos, { count: 6, tex: PT.flame, color: FX_COLORS.fire, color1: C(0.8, 0.15, 0.02), dir, spread: 0.12, speed: [10, 16], life: [0.25, 0.45], size: [0.25, 1.2], drag: 2 });
      this.burst(pos, { count: 2, tex: PT.smoke, color: FX_COLORS.smoke, dir, spread: 0.2, speed: [4, 7], life: [0.6, 1.0], size: [0.4, 1.4], additive: false, alpha: 0.35, drag: 1.5, gravity: -1 });
      if (withLight) this.lights.flash(pos, C(1, 0.5, 0.15), 5, 10, 0.12);
      return;
    }
    const s = this.sp.reset();
    s.x = pos.x;
    s.y = pos.y;
    s.z = pos.z;
    s.life = 0.06;
    s.size0 = big ? 0.55 : 0.32;
    s.size1 = big ? 0.3 : 0.18;
    s.color(col);
    s.a0 = 1;
    s.a1 = 0.2;
    s.tex = PT.star;
    s.rot = Math.random() * 3;
    this.add.spawn(s);
    this.burst(pos, { count: big ? 5 : 3, tex: PT.flame, color: col, dir, spread: 0.08, speed: [2, 5], life: [0.04, 0.08], size: [big ? 0.3 : 0.18, big ? 0.5 : 0.3], stretch: 0.05 });
    this.burst(pos, { count: 1, tex: PT.smoke, color: FX_COLORS.smokeLight, dir, spread: 0.3, speed: [0.5, 1.5], life: [0.4, 0.7], size: [0.15, 0.5], additive: false, alpha: 0.25, gravity: -0.6 });
    if (withLight) this.lights.flash(pos, cls === 'tesla' ? C(0.4, 0.6, 1) : C(1, 0.7, 0.35), big ? 5 : 3, 9, 0.06);
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, cls: ShotClass): void {
    switch (cls) {
      case 'melee':
      case 'launcher':
      case 'flamer':
      case 'fire':
        if (cls === 'fire' || cls === 'flamer') {
          const d = this._d.subVectors(to, from);
          const len = d.length();
          d.normalize();
          const n = Math.min(10, Math.ceil(len / 1.5));
          for (let i = 0; i < n; i++) {
            const p = this._v.copy(from).addScaledVector(d, (i / n) * len);
            this.burst(p, { count: 1, tex: PT.flame, color: FX_COLORS.fire, color1: C(0.7, 0.1, 0), dir: d, spread: 0.2, speed: [6, 10], life: [0.25, 0.4], size: [0.4, 1.1], drag: 3 });
          }
        }
        return;
      case 'tesla': {
        // jagged arc along the shot
        const d = this._d.subVectors(to, from);
        const len = d.length();
        const segs = Math.max(3, Math.min(10, Math.round(len / 3)));
        let prev = from.clone();
        for (let i = 1; i <= segs; i++) {
          const p = from.clone().addScaledVector(d, i / segs);
          if (i < segs) p.add(new THREE.Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8));
          this.beams.beam(prev, p, FX_COLORS.tesla, 0.12, 0.12);
          prev = p;
        }
        return;
      }
      case 'bow':
      case 'crossbow':
        this.beams.tracer(from, to, C(0.9, 0.85, 0.7), 0.025, 160, 2.5, 0.6);
        return;
      case 'sniper':
        this.beams.tracer(from, to, FX_COLORS.tracerSniper, 0.08, 520, 14);
        this.beams.beam(from, to, C(0.7, 0.65, 0.55), 0.03, 0.35, 0.35);
        return;
      case 'ice':
        this.beams.tracer(from, to, FX_COLORS.ice, 0.06, 300, 6);
        return;
      case 'shotgun':
        this.beams.tracer(from, to, FX_COLORS.tracer, 0.025, 300, 3, 0.8);
        return;
      default:
        this.beams.tracer(from, to, FX_COLORS.tracer, cls === 'lmg' ? 0.055 : 0.04, 380, 6);
    }
  }

  /** Bullet impact on world geometry. */
  impact(pos: THREE.Vector3, normal: THREE.Vector3 | null, cls: ShotClass): void {
    const n = normal ?? this._d.set(0, 1, 0);
    if (cls === 'tesla') {
      this.burst(pos, { count: 6, tex: PT.spark, color: FX_COLORS.tesla, dir: n, spread: 0.8, speed: [3, 8], life: [0.1, 0.25], size: [0.04, 0.02], stretch: 0.03 });
      return;
    }
    if (cls === 'ice') {
      this.burst(pos, { count: 5, tex: PT.shard, color: FX_COLORS.ice, dir: n, spread: 0.7, speed: [2, 5], life: [0.3, 0.6], size: [0.12, 0.05], gravity: 9 });
      return;
    }
    this.burst(pos, { count: 5, tex: PT.spark, color: FX_COLORS.spark, dir: n, spread: 0.7, speed: [4, 10], life: [0.08, 0.2], size: [0.03, 0.015], gravity: 12, stretch: 0.025 });
    this.burst(pos, { count: 2, tex: PT.dust, color: FX_COLORS.dust, dir: n, spread: 0.5, speed: [0.5, 1.5], life: [0.5, 0.9], size: [0.2, 0.6], additive: false, alpha: 0.55, drag: 2, gravity: 0.5 });
  }

  /** Stylised red-ink hit splash (on characters). */
  inkSplash(pos: THREE.Vector3, amount = 1, dir?: THREE.Vector3): void {
    const n = Math.round(3 + amount * 4);
    this.burst(pos, { count: 1, tex: PT.ink, color: FX_COLORS.ink, color1: FX_COLORS.inkDark, speed: [0, 0.2], life: [0.35, 0.5], size: [0.25 * (0.7 + amount * 0.4), 0.7 * (0.7 + amount * 0.4)], additive: false, alpha: 0.95, alphaEnd: 0, spin: 1 });
    this.burst(pos, { count: n, tex: PT.ink, color: FX_COLORS.ink, color1: FX_COLORS.inkDark, dir: dir ?? undefined, spread: 0.6, up: 0.4, speed: [1.5, 4.5], life: [0.35, 0.6], size: [0.07, 0.03], gravity: 9, additive: false, alpha: 0.95, alphaEnd: 0.4 });
  }

  // ── explosions ─────────────────────────────────────────────────────────────
  explosion(pos: THREE.Vector3, radius: number, kind: string): void {
    const r = Math.max(0.8, radius);
    const k = Math.min(3, r / 3);
    const ground = this._v.set(pos.x, Math.max(pos.y, this.groundY(pos.x, pos.z)) + 0.1, pos.z).clone();
    switch (kind) {
      case 'thunder':
      case 'lightning': {
        const top = pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, 28, (Math.random() - 0.5) * 3));
        this.beams.lightning(top, pos, FX_COLORS.thunder, 0.45, 0.4);
        this.burst(pos, { count: Math.round(22 * k), tex: PT.spark, color: FX_COLORS.thunder, color1: C(1, 1, 2), speed: [6, 16], up: 0.4, life: [0.15, 0.4], size: [0.06, 0.02], stretch: 0.04, gravity: 6 });
        this.burst(pos, { count: 1, tex: PT.glow, color: C(1.5, 1.8, 3.5), speed: [0, 0], life: [0.12, 0.16], size: [r * 1.4, r * 2.2] });
        this.fx.ring(ground, { color: FX_COLORS.thunder, radius0: 0.3, radius1: r * 1.2, life: 0.45, inner: 0.85, alpha: 1.2 });
        this.burst(ground, { count: Math.round(6 * k), tex: PT.smoke, color: C(0.25, 0.26, 0.3), speed: [0.5, 2], up: 0.7, life: [0.8, 1.5], size: [0.6, 2], additive: false, alpha: 0.5, gravity: -0.4, drag: 1 });
        this.lights.flash(pos.clone().setY(pos.y + 2), C(0.6, 0.75, 1), 30, 30, 0.25);
        this.shakeAt(pos, 0.35 * k + 0.2, r);
        return;
      }
      case 'ice':
      case 'frost': {
        this.burst(pos, { count: Math.round(18 * k), tex: PT.shard, color: FX_COLORS.ice, color1: C(0.9, 1, 1.2), speed: [4, 11], up: 0.3, life: [0.4, 0.9], size: [0.2, 0.08], gravity: 10, spin: 8 });
        this.burst(pos, { count: Math.round(10 * k), tex: PT.snow, color: C(1.4, 1.7, 2), speed: [1, 3], life: [0.8, 1.6], size: [0.15, 0.1], gravity: 0.6, drag: 1.5 });
        this.burst(pos, { count: Math.round(6 * k), tex: PT.smoke, color: C(0.75, 0.88, 0.95), speed: [1, 3], life: [0.8, 1.4], size: [0.8, 2.2], additive: false, alpha: 0.5, drag: 2 });
        this.fx.ring(ground, { color: FX_COLORS.ice, radius0: 0.3, radius1: r, life: 0.6, inner: 0.7 });
        this.fx.sphere(pos, C(0.5, 0.9, 1.4), 0.3, r, 0.35, 0.8);
        this.lights.flash(pos, C(0.5, 0.8, 1), 12, 18, 0.25);
        this.shakeAt(pos, 0.2 * k, r);
        return;
      }
      case 'holy':
      case 'heal': {
        this.fx.pillar(ground, FX_COLORS.holy, r * 0.5, 10, 0.8, 0.9);
        this.fx.ring(ground, { color: FX_COLORS.gold, radius0: 0.3, radius1: r, life: 0.7, inner: 0.8 });
        this.burst(pos, { count: Math.round(20 * k), tex: PT.petal, color: C(2, 1.6, 0.8), speed: [1, 4], up: 0.7, life: [0.8, 1.4], size: [0.12, 0.08], gravity: -0.5, drag: 1, spin: 4 });
        this.lights.flash(pos, C(1, 0.85, 0.5), 10, 16, 0.4);
        return;
      }
      case 'poison':
      case 'gas':
      case 'smoke': {
        const col = kind === 'smoke' ? FX_COLORS.smokeLight : FX_COLORS.poison;
        this.burst(pos, { count: Math.round(16 * k), tex: PT.smoke, color: col, speed: [1, 3.5], up: 0.3, life: [1.5, 2.8], size: [0.8, 3.2], additive: false, alpha: 0.6, drag: 1.2, gravity: -0.2, radius: r * 0.3 });
        return;
      }
      case 'emp': {
        // 过河拆桥: electric pulse that strips gear — no fire, blue-white arcs
        const col = C(0.9, 1.4, 2.8);
        this.fx.ring(ground, { color: col, radius0: 0.3, radius1: r * 1.3, life: 0.5, inner: 0.9, alpha: 1.3 });
        this.fx.ring(ground, { color: C(2, 2, 2.4), radius0: 0.2, radius1: r * 0.8, life: 0.35, inner: 0.94, alpha: 1 });
        this.fx.sphere(pos, col, 0.3, r, 0.3, 0.7);
        this.burst(pos, { count: Math.round(26 * k + 6), tex: PT.spark, color: col, color1: C(2, 2, 2.4), speed: [5, 13], up: 0.3, life: [0.15, 0.4], size: [0.05, 0.02], stretch: 0.05, gravity: 4 });
        for (let i = 0; i < 3; i++) {
          const a = Math.random() * Math.PI * 2;
          const tip = pos.clone().add(new THREE.Vector3(Math.cos(a) * r, 0.4 + Math.random(), Math.sin(a) * r));
          this.beams.lightning(pos.clone().setY(pos.y + 0.6), tip, col, 0.12, 0.22);
        }
        this.lights.flash(pos, C(0.55, 0.75, 1.2), 14, r * 5 + 6, 0.2);
        this.shakeAt(pos, 0.15, r);
        return;
      }
      case 'shockwave': {
        // shouts / slams without fire: dust ring + air ripple
        this.fx.ring(ground, { color: C(1.6, 1.3, 0.9), radius0: 0.4, radius1: r * 1.2, life: 0.45, inner: 0.86, alpha: 0.9 });
        this.fx.sphere(pos, C(1.1, 1.0, 0.85), 0.3, r, 0.3, 0.45);
        this.burst(ground, { count: Math.round(12 * k + 4), tex: PT.dust, color: FX_COLORS.dust, speed: [4, 10], life: [0.5, 1.0], size: [0.5, 1.8], additive: false, alpha: 0.6, drag: 3, flat: true, radius: r * 0.3 });
        this.shakeAt(pos, 0.25 * k + 0.1, r);
        return;
      }
      case 'ink': {
        this.inkSplash(pos, 3);
        this.fx.ring(ground, { color: C(0.15, 0.02, 0.02), radius0: 0.3, radius1: r, life: 0.6, inner: 0.6, additive: false, alpha: 0.8 });
        return;
      }
      default: {
        // fire / frag / rocket / grenade
        const frag = kind === 'frag' || kind === 'grenade';
        this.burst(pos, { count: 1, tex: PT.glow, color: C(3, 2.2, 1.2), speed: [0, 0], life: [0.1, 0.14], size: [r * 1.6, r * 2.6] });
        if (!frag || Math.random() < 1) {
          this.burst(pos, { count: Math.round((frag ? 8 : 16) * k + 4), tex: PT.flame, color: C(2.8, 1.5, 0.4), color1: C(0.9, 0.2, 0.04), speed: [2, 6 * Math.sqrt(k)], up: 0.35, life: [0.35, 0.7], size: [0.5 * k + 0.3, 1.3 * k + 0.6], drag: 3, gravity: -2, radius: r * 0.25, spin: 3 });
        }
        this.burst(pos, { count: Math.round(10 * k + 3), tex: PT.smoke, color: C(0.26, 0.24, 0.22), color1: C(0.5, 0.47, 0.44), speed: [1, 3.5], up: 0.55, life: [1.6, 3.2], size: [0.8 * k + 0.4, 3 * k + 1], additive: false, alpha: 0.7, drag: 1.2, gravity: -0.8, radius: r * 0.3, spin: 0.8 });
        this.burst(pos, { count: Math.round((frag ? 30 : 18) * k + 6), tex: PT.spark, color: FX_COLORS.spark, speed: [8, 20], up: 0.4, life: [0.25, 0.6], size: [0.06, 0.03], gravity: 14, stretch: 0.03 });
        this.burst(pos, { count: Math.round(8 * k), tex: PT.square, color: C(0.18, 0.15, 0.12), speed: [5, 12], up: 0.7, life: [0.8, 1.4], size: [0.12, 0.1], gravity: 18, additive: false, spin: 10 });
        this.fx.ring(ground, { color: C(1.8, 1.0, 0.4), radius0: 0.4, radius1: r * 1.4, life: 0.45, inner: 0.82, alpha: 0.9 });
        this.fx.sphere(pos, C(1.4, 0.8, 0.35), 0.4, r * 1.2, 0.25, 0.9);
        this.burst(ground, { count: Math.round(8 * k), tex: PT.dust, color: FX_COLORS.dust, speed: [4, 9], life: [0.6, 1.1], size: [0.5, 1.8], additive: false, alpha: 0.6, drag: 3, flat: true, radius: r * 0.3 });
        this.lights.flash(pos.clone().setY(pos.y + 0.8), C(1, 0.55, 0.2), 25 * k + 8, r * 6 + 8, 0.35);
        this.shakeAt(pos, 0.3 * k + 0.25, r);
      }
    }
  }

  /** Green rising heal motes + soft ring. */
  heal(pos: THREE.Vector3, amount: number): void {
    const k = Math.min(2, 0.5 + amount / 100);
    this.burst(pos, { count: Math.round(10 * k), tex: PT.glow, color: FX_COLORS.heal, speed: [0.4, 1.4], up: 1, life: [0.8, 1.4], size: [0.12, 0.05], gravity: -1.5, radius: 0.4 });
    this.burst(pos, { count: Math.round(3 * k), tex: PT.petal, color: C(1.4, 0.7, 0.8), speed: [0.4, 1.2], up: 1, life: [1, 1.6], size: [0.1, 0.07], gravity: -0.8, spin: 5, radius: 0.4 });
    const g = pos.clone();
    g.y = this.groundY(pos.x, pos.z) + 0.08;
    this.fx.ring(g, { color: FX_COLORS.heal, radius0: 0.4, radius1: 1.3, life: 0.6, inner: 0.75, alpha: 0.8 });
  }

  /** Generic kingdom-coloured ability flourish (ring + motes). */
  genericAbility(pos: THREE.Vector3, color: THREE.Color, radius = 3): void {
    const g = pos.clone();
    g.y = this.groundY(pos.x, pos.z) + 0.08;
    this.fx.ring(g, { color, radius0: 0.3, radius1: radius, life: 0.6, inner: 0.8, alpha: 1.1 });
    this.fx.ring(g, { color: C(2, 1.6, 0.8), radius0: 0.2, radius1: radius * 0.6, life: 0.45, inner: 0.9, alpha: 0.7 });
    this.burst(pos, { count: 16, tex: PT.glow, color, color1: C(2, 1.7, 1), speed: [1, 4], up: 0.8, life: [0.5, 1.0], size: [0.15, 0.04], gravity: -1, radius: radius * 0.4 });
    this.burst(pos, { count: 1, tex: PT.bagua, color, speed: [0, 0], life: [0.5, 0.6], size: [radius * 0.6, radius * 1.2], alpha: 0.9, spin: 2 });
  }

  /** Coloured sparkle (pickups, item use). */
  sparkle(pos: THREE.Vector3, color: THREE.Color, n = 10): void {
    this.burst(pos, { count: n, tex: PT.star, color, speed: [0.5, 2], up: 0.6, life: [0.4, 0.8], size: [0.12, 0.02], gravity: -0.5, spin: 6, radius: 0.3 });
  }

  /** Melee slash arc on the ground plane at chest height. */
  slash(pos: THREE.Vector3, yaw: number, range: number, arcDeg: number, color: THREE.Color): void {
    this.fx.ring(pos, { color, radius0: range * 0.35, radius1: range, life: 0.22, inner: 0.55, innerEnd: 0.8, arc: (arcDeg * Math.PI) / 360, yaw, alpha: 1.2, soft: 0.2 });
  }

  dispose(): void {
    this.add.dispose();
    this.alpha.dispose();
    this.beams.dispose();
    this.fx.dispose();
    this.lights.dispose();
  }
}
