// Area-effect visuals for 'hazard' entities (fire fields, lightning clouds,
// traps, smoke, heal zones, arrow rain, frost fields, reflect domes, 八阵图).
// A terrain-conforming decal + continuous particle emitters (+ a few meshes).
import * as THREE from 'three';
import type { ViewEntity } from '../../core/types';
import { PT, glyphCircleTexture, whiteTexture } from '../core/textures';
import { sharedUniforms } from '../core/materials';
import { kingdomColor } from '../palette';
import type { EntityCtx } from './context';
import type { EntityView } from './objects';

type HazardStyle = 'fire' | 'cloud' | 'trapDance' | 'trapRoot' | 'trap' | 'smoke' | 'gas' | 'heal' | 'arrows' | 'frost' | 'reflect' | 'bagua' | 'generic';

export function hazardStyle(kind: string): HazardStyle {
  const k = kind.toLowerCase();
  if (k.includes('dance') || k.includes('lebu')) return 'trapDance';
  if (k.includes('root') || k.includes('bingliang')) return 'trapRoot';
  if (k.includes('trap')) return 'trap';
  if (k.includes('lightning') || k.includes('cloud') || k.includes('storm') || k.includes('thunder') || k.includes('shandian')) return 'cloud';
  if (k.includes('fire') || k.includes('napalm') || k.includes('burn') || k.includes('huo') || k.includes('flame')) return 'fire';
  if (k.includes('gas') || k.includes('poison') || k.includes('mafei')) return 'gas';
  if (k.includes('smoke')) return 'smoke';
  if (k.includes('heal') || k.includes('regen') || k.includes('rally') || k.includes('banner') || k.includes('peach')) return 'heal';
  if (k.includes('arrow') || k.includes('rain') || k.includes('luanji') || k.includes('volley')) return 'arrows';
  if (k.includes('frost') || k.includes('ice') || k.includes('freeze') || k.includes('snow')) return 'frost';
  if (k.includes('reflect') || k.includes('guicai') || k.includes('mirror')) return 'reflect';
  if (k.includes('bazhen') || k.includes('formation') || k.includes('stone') || k.includes('bagua')) return 'bagua';
  return 'generic';
}

const DECAL_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DECAL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uTime;
uniform float uAlpha;
uniform float uMode;
uniform sampler2D uMap;
varying vec2 vUv;
float dHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float dNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(dHash(i), dHash(i + vec2(1, 0)), f.x), mix(dHash(i + vec2(0, 1)), dHash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  vec3 c;
  float a;
  if (uMode < 0.5) {
    // fire: charred centre, glowing noisy embers, bright rim
    float n = dNoise(p * 6.0 + vec2(uTime * 0.3, -uTime * 0.2)) * 0.6 + dNoise(p * 15.0 - uTime) * 0.4;
    float glow = smoothstep(0.45, 0.9, n) * (1.0 - r * 0.4);
    c = mix(uColor2, uColor * (1.2 + glow * 2.0), glow);
    a = (0.55 + glow * 0.45) * (1.0 - smoothstep(0.85, 1.0, r));
  } else if (uMode < 1.5) {
    // pulsing ring + soft fill
    float pulse = 0.5 + 0.5 * sin(uTime * 3.0 - r * 6.0);
    float ring = smoothstep(0.88, 0.95, r) * (1.0 - smoothstep(0.97, 1.0, r));
    c = uColor * (0.8 + pulse * 0.6);
    a = ring * 0.95 + (0.12 + 0.12 * pulse) * (1.0 - r);
  } else if (uMode < 2.5) {
    // glyph circle (texture), slowly rotating
    float ang = uTime * 0.4;
    vec2 q = vec2(p.x * cos(ang) - p.y * sin(ang), p.x * sin(ang) + p.y * cos(ang));
    float t = texture2D(uMap, q * 0.5 + 0.5).a;
    c = uColor * (1.2 + 0.4 * sin(uTime * 4.0));
    a = t * 0.9 + (1.0 - r) * 0.08;
  } else {
    // soft shadow / tint
    c = uColor;
    a = (1.0 - smoothstep(0.3, 1.0, r)) * 0.6;
  }
  a *= uAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(c * a, a);
}`;

const RINGS = 7;
const SEGS = 40;

function makeDecalGeometry(): THREE.BufferGeometry {
  const pos = new Float32Array((RINGS * SEGS + 1) * 3);
  const uv = new Float32Array((RINGS * SEGS + 1) * 2);
  uv.set([0.5, 0.5], 0);
  const idx: number[] = [];
  for (let r = 1; r <= RINGS; r++) {
    for (let s = 0; s < SEGS; s++) {
      const i = 1 + (r - 1) * SEGS + s;
      const a = (s / SEGS) * Math.PI * 2;
      const t = r / RINGS;
      uv[i * 2] = 0.5 + Math.cos(a) * t * 0.5;
      uv[i * 2 + 1] = 0.5 + Math.sin(a) * t * 0.5;
    }
  }
  for (let s = 0; s < SEGS; s++) idx.push(0, 1 + ((s + 1) % SEGS), 1 + s);
  for (let r = 1; r < RINGS; r++) {
    for (let s = 0; s < SEGS; s++) {
      const a = 1 + (r - 1) * SEGS + s;
      const b = 1 + (r - 1) * SEGS + ((s + 1) % SEGS);
      const c = 1 + r * SEGS + s;
      const d = 1 + r * SEGS + ((s + 1) % SEGS);
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const C = (r: number, g: number, b: number): THREE.Color => new THREE.Color(r, g, b);
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const RAIN_DIR = new THREE.Vector3(0.1, -1, 0).normalize();
const ARROW_DIR = new THREE.Vector3(0.15, -1, 0.05).normalize();

export class HazardView implements EntityView {
  readonly root = new THREE.Group();
  private readonly style: HazardStyle;
  private readonly decal: THREE.Mesh;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private radius = 1;
  private readonly lastConform = new THREE.Vector3(Infinity, 0, 0);
  private acc = 0;
  private boltTimer = 1;
  private age = 0;
  private dome: THREE.Mesh | null = null;
  private stones: THREE.InstancedMesh | null = null;
  private readonly color: THREE.Color;

  constructor(e: ViewEntity) {
    this.style = hazardStyle(e.sub);
    this.geo = makeDecalGeometry();
    const k = e.kingdom ? kingdomColor(e.kingdom) : '#d8ac4c';
    const styleCol: Record<HazardStyle, [THREE.Color, THREE.Color, number]> = {
      fire: [C(2.4, 0.8, 0.15), C(0.08, 0.05, 0.04), 0],
      cloud: [C(0.05, 0.05, 0.08), C(0, 0, 0), 3],
      trapDance: [C(2.2, 0.7, 1.4), C(0, 0, 0), 2],
      trapRoot: [C(1.2, 1.6, 0.4), C(0, 0, 0), 2],
      trap: [C(2.0, 1.4, 0.5), C(0, 0, 0), 2],
      smoke: [C(0.3, 0.3, 0.3), C(0, 0, 0), 3],
      gas: [C(0.4, 0.9, 0.3), C(0, 0, 0), 1],
      heal: [C(0.4, 1.8, 0.6), C(0, 0, 0), 1],
      arrows: [C(1.8, 0.6, 0.3), C(0, 0, 0), 1],
      frost: [C(0.6, 1.3, 2.2), C(0, 0, 0), 1],
      reflect: [C(1.4, 0.6, 2.2), C(0, 0, 0), 2],
      bagua: [C(1.8, 1.4, 0.6), C(0, 0, 0), 2],
      generic: [new THREE.Color(k).multiplyScalar(1.6), C(0, 0, 0), 1],
    };
    const [c1, c2, mode] = styleCol[this.style];
    this.color = c1;
    const glyph =
      this.style === 'trapDance' ? '乐' : this.style === 'trapRoot' ? '兵' : this.style === 'trap' ? '阱' : this.style === 'reflect' ? '反' : this.style === 'bagua' ? '☯' : '';
    this.mat = new THREE.ShaderMaterial({
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      uniforms: {
        uColor: { value: c1 },
        uColor2: { value: c2 },
        uTime: sharedUniforms.uTime,
        uAlpha: { value: 1 },
        uMode: { value: mode },
        uMap: { value: glyph ? glyphCircleTexture(glyph) : whiteTexture() },
      },
      transparent: true,
      depthWrite: false,
      blending: this.style === 'fire' || this.style === 'cloud' || this.style === 'smoke' ? THREE.NormalBlending : THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    });
    if (this.style === 'fire') this.mat.blending = THREE.NormalBlending;
    this.decal = new THREE.Mesh(this.geo, this.mat);
    this.decal.frustumCulled = false;
    this.decal.renderOrder = 12;
    this.root.add(this.decal);
    if (this.style === 'reflect') {
      this.dome = new THREE.Mesh(
        new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: C(0.9, 0.4, 1.6), transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      );
      this.root.add(this.dome);
    }
    if (this.style === 'bagua') {
      const g = new THREE.CylinderGeometry(0.35, 0.5, 1.6, 6);
      g.translate(0, 0.8, 0);
      this.stones = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: '#8a857a', flatShading: true, roughness: 0.9 }), 8);
      this.stones.castShadow = true;
      this.root.add(this.stones);
    }
    this.root.name = `hazard_${e.id}_${this.style}`;
  }

  private conform(e: ViewEntity, ctx: EntityCtx): void {
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const ground = ctx.groundY(e.x, e.z);
    const onStructure = e.y - ground > 0.6;
    const r = this.radius;
    for (let i = 0; i < pos.count; i++) {
      let x = 0;
      let z = 0;
      if (i > 0) {
        const ring = Math.floor((i - 1) / SEGS) + 1;
        const s = (i - 1) % SEGS;
        const a = (s / SEGS) * Math.PI * 2;
        const t = ring / RINGS;
        x = Math.cos(a) * t * r;
        z = -Math.sin(a) * t * r;
      }
      const y = onStructure ? e.y + 0.06 : ctx.groundY(e.x + x, e.z + z) + 0.08;
      pos.setXYZ(i, e.x + x, y, e.z + z);
    }
    pos.needsUpdate = true;
    this.geo.computeBoundingSphere();
    this.lastConform.set(e.x, e.y, e.z);
    if (this.stones) {
      const m = new THREE.Matrix4();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const sx = e.x + Math.cos(a) * r * 0.92;
        const sz = e.z + Math.sin(a) * r * 0.92;
        m.makeRotationY(a).setPosition(sx, ctx.groundY(sx, sz) - 0.1, sz);
        this.stones.setMatrixAt(i, m);
      }
      this.stones.instanceMatrix.needsUpdate = true;
    }
  }

  update(e: ViewEntity, ctx: EntityCtx): void {
    const r = Math.max(0.5, e.radius ?? 3);
    this.age += ctx.dt;
    if (Math.abs(r - this.radius) > 0.05 || this.lastConform.distanceToSquared(_p.set(e.x, e.y, e.z)) > 0.25) {
      this.radius = r;
      this.conform(e, ctx);
    }
    this.mat.uniforms.uAlpha.value = Math.min(1, this.age * 3);
    if (this.dome) {
      this.dome.position.set(e.x, ctx.groundY(e.x, e.z), e.z);
      this.dome.scale.setScalar(r);
    }
    const dist = ctx.camPos.distanceTo(_p.set(e.x, e.y, e.z));
    this.root.visible = dist < 220;
    if (dist > 140) return;
    this.emit(e, ctx, r);
  }

  private emit(e: ViewEntity, ctx: EntityCtx, r: number): void {
    const fx = ctx.fx;
    const area = Math.PI * r * r;
    const dt = ctx.dt;
    const rate = (perM2: number, cap: number): number => {
      this.acc += dt * Math.min(cap, perM2 * area);
      const n = Math.floor(this.acc);
      this.acc -= n;
      return n;
    };
    const rndIn = (out: THREE.Vector3, lift = 0.1): THREE.Vector3 => {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * r;
      const x = e.x + Math.cos(a) * d;
      const z = e.z + Math.sin(a) * d;
      return out.set(x, Math.max(ctx.groundY(x, z), e.y - 0.5) + lift, z);
    };
    switch (this.style) {
      case 'fire': {
        const n = rate(1.4, 60);
        for (let i = 0; i < n; i++) {
          fx.burst(rndIn(_q, 0.2), { count: 1, tex: PT.flame, color: C(2.6, 1.1, 0.3), color1: C(0.8, 0.12, 0.02), speed: [0.4, 1.4], up: 1, life: [0.5, 1.0], size: [0.5, 1.3], gravity: -2.5, drag: 1 });
          if (Math.random() < 0.25) fx.burst(_q, { count: 1, tex: PT.smoke, color: C(0.2, 0.18, 0.17), color1: C(0.45, 0.42, 0.4), speed: [0.3, 1], up: 1, life: [1.5, 2.6], size: [0.6, 2.2], additive: false, alpha: 0.45, gravity: -1.2, drag: 0.8 });
          if (Math.random() < 0.3) fx.burst(_q, { count: 1, tex: PT.spark, color: C(2.6, 1.3, 0.4), speed: [1, 2.5], up: 1, life: [0.6, 1.2], size: [0.04, 0.02], gravity: -1.5 });
        }
        break;
      }
      case 'cloud': {
        const top = _p.set(e.x, Math.max(e.y, ctx.groundY(e.x, e.z)) + 9, e.z);
        const n = rate(0.3, 14);
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.random() * r * 0.8;
          _q.set(top.x + Math.cos(a) * d, top.y + (Math.random() - 0.5), top.z + Math.sin(a) * d);
          fx.burst(_q, { count: 1, tex: PT.smoke, color: C(0.14, 0.14, 0.18), color1: C(0.22, 0.22, 0.28), speed: [0.1, 0.4], life: [1.6, 2.4], size: [2.5, 4.5], additive: false, alpha: 0.75, drag: 1 });
        }
        this.boltTimer -= dt;
        if (this.boltTimer <= 0) {
          this.boltTimer = 0.6 + Math.random() * 1.2;
          const strike = rndIn(_q, 0);
          fx.beams.lightning(top.clone(), strike.clone(), C(0.8, 1.1, 2.8), 0.3, 0.25);
          fx.lights.flash(top, C(0.6, 0.7, 1), 12, 30, 0.2);
        }
        // rain streaks
        const rn = Math.min(20, Math.round(dt * 60 * (r / 3)));
        for (let i = 0; i < rn; i++) {
          rndIn(_q, 7 + Math.random() * 2);
          fx.burst(_q, { count: 1, tex: PT.spark, color: C(0.6, 0.7, 0.9), dir: RAIN_DIR, spread: 0.02, speed: [16, 20], life: [0.35, 0.45], size: [0.02, 0.02], alpha: 0.35, stretch: 0.02, additive: true });
        }
        break;
      }
      case 'trapDance':
      case 'trapRoot':
      case 'trap': {
        const n = rate(0.25, 6);
        for (let i = 0; i < n; i++)
          fx.burst(rndIn(_q, 0.1), { count: 1, tex: this.style === 'trapDance' ? PT.note : PT.glow, color: this.color, speed: [0.2, 0.6], up: 1, life: [0.8, 1.3], size: [0.14, 0.06], gravity: -0.8 });
        break;
      }
      case 'smoke':
      case 'gas': {
        const n = rate(0.5, 18);
        const colr = this.style === 'gas' ? C(0.42, 0.7, 0.3) : C(0.62, 0.62, 0.6);
        for (let i = 0; i < n; i++) fx.burst(rndIn(_q, 0.6), { count: 1, tex: PT.smoke, color: colr, speed: [0.2, 0.8], up: 0.6, life: [2.5, 4], size: [1.5, 3.8], additive: false, alpha: 0.7, drag: 0.6, gravity: -0.1 });
        break;
      }
      case 'heal': {
        const n = rate(0.6, 16);
        for (let i = 0; i < n; i++) fx.burst(rndIn(_q, 0.1), { count: 1, tex: i % 3 ? PT.glow : PT.petal, color: C(0.5, 1.8, 0.7), speed: [0.3, 1], up: 1, life: [1, 1.6], size: [0.12, 0.04], gravity: -1.2, spin: 3 });
        break;
      }
      case 'arrows': {
        const n = rate(1.2, 40);
        for (let i = 0; i < n; i++) {
          const g = rndIn(_q, 14);
          fx.burst(g, { count: 1, tex: PT.spark, color: C(1.1, 0.9, 0.6), dir: ARROW_DIR, spread: 0.03, speed: [26, 30], life: [0.45, 0.5], size: [0.04, 0.04], stretch: 0.03, alpha: 0.9 });
          if (Math.random() < 0.3) fx.burst(rndIn(_q, 0.1), { count: 1, tex: PT.dust, color: C(0.62, 0.54, 0.42), speed: [0.5, 1.5], up: 0.6, life: [0.4, 0.8], size: [0.3, 0.9], additive: false, alpha: 0.5, drag: 2 });
        }
        break;
      }
      case 'frost': {
        const n = rate(0.8, 24);
        for (let i = 0; i < n; i++) fx.burst(rndIn(_q, 0.1 + Math.random() * 1.5), { count: 1, tex: i % 2 ? PT.snow : PT.shard, color: C(1.3, 1.7, 2.3), speed: [0.1, 0.5], life: [0.8, 1.4], size: [0.1, 0.06], gravity: 0.4, spin: 2 });
        break;
      }
      case 'reflect':
      case 'bagua':
      case 'generic':
      default: {
        const n = rate(0.3, 10);
        for (let i = 0; i < n; i++) fx.burst(rndIn(_q, 0.1), { count: 1, tex: PT.glow, color: this.color, speed: [0.3, 0.9], up: 1, life: [0.8, 1.2], size: [0.1, 0.03], gravity: -1 });
      }
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    if (this.dome) {
      this.dome.geometry.dispose();
      (this.dome.material as THREE.Material).dispose();
    }
    if (this.stones) {
      this.stones.geometry.dispose();
      (this.stones.material as THREE.Material).dispose();
      this.stones.dispose();
    }
  }
}
