// Pooled camera-facing ribbons between two points: bullet tracers (a short
// bright segment travelling from muzzle to impact), lightning bolt segments,
// laser-ish beams. ONE instanced draw call, additive.
import * as THREE from 'three';

const VERT = /* glsl */ `
attribute vec4 iA;     // start xyz, width
attribute vec4 iB;     // end xyz, taper (0 = uniform, 1 = sharp tail)
attribute vec4 iColor; // rgb, alpha
varying vec2 vUv;
varying vec4 vColor;
varying float vTaper;
void main() {
  vUv = uv;
  vColor = iColor;
  vTaper = iB.w;
  vec4 a = viewMatrix * vec4(iA.xyz, 1.0);
  vec4 b = viewMatrix * vec4(iB.xyz, 1.0);
  // keep both ends in front of the near plane
  if (a.z > -0.12) a.xyz = mix(a.xyz, b.xyz, clamp((a.z + 0.12) / (a.z - b.z + 1e-4), 0.0, 1.0));
  if (b.z > -0.12) b.xyz = mix(b.xyz, a.xyz, clamp((b.z + 0.12) / (b.z - a.z + 1e-4), 0.0, 1.0));
  vec3 dir = b.xyz - a.xyz;
  vec3 side = normalize(cross(dir, vec3(0.0, 0.0, 1.0)) + vec3(1e-5, 0.0, 0.0));
  vec3 p = mix(a.xyz, b.xyz, uv.x) + side * position.y * iA.w;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying vec4 vColor;
varying float vTaper;
void main() {
  float across = 1.0 - abs(vUv.y - 0.5) * 2.0;
  float core = smoothstep(0.0, 1.0, across);
  float along = mix(1.0, vUv.x, vTaper);
  float a = vColor.a * core * along;
  if (a < 0.003) discard;
  vec3 c = vColor.rgb * (1.0 + core * core * 1.5);
  gl_FragColor = vec4(c * a, a);
}`;

interface Beam {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  width: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  age: number;
  life: number;
  /** tracer: segment length (m) travelling at speed; 0 = static beam that fades */
  len: number;
  speed: number;
  taper: number;
  active: boolean;
}

export class BeamSystem {
  readonly mesh: THREE.Mesh;
  private readonly beams: Beam[];
  private readonly aA: THREE.InstancedBufferAttribute;
  private readonly aB: THREE.InstancedBufferAttribute;
  private readonly aC: THREE.InstancedBufferAttribute;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private next = 0;

  constructor(capacity = 256) {
    this.beams = Array.from({ length: capacity }, () => ({
      ax: 0,
      ay: 0,
      az: 0,
      bx: 0,
      by: 0,
      bz: 0,
      width: 0.05,
      r: 1,
      g: 1,
      b: 1,
      alpha: 1,
      age: 0,
      life: 0.1,
      len: 0,
      speed: 0,
      taper: 0,
      active: false,
    }));
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0.5, 0, 0); // uv.x 0..1 along, position.y −0.5..0.5 across
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    g.setAttribute('uv', quad.getAttribute('uv'));
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', this.aA);
    g.setAttribute('iB', this.aB);
    g.setAttribute('iColor', this.aC);
    g.instanceCount = 0;
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 21;
    this.mesh.name = 'beams';
  }

  private alloc(): Beam {
    const b = this.beams[this.next];
    this.next = (this.next + 1) % this.beams.length;
    return b;
  }

  /** A travelling tracer from a to b. */
  tracer(a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color, width = 0.05, speed = 380, len = 6, alpha = 1): void {
    const t = this.alloc();
    const dist = a.distanceTo(b);
    t.ax = a.x;
    t.ay = a.y;
    t.az = a.z;
    t.bx = b.x;
    t.by = b.y;
    t.bz = b.z;
    t.width = width;
    t.r = color.r;
    t.g = color.g;
    t.b = color.b;
    t.alpha = alpha;
    t.age = 0;
    t.len = Math.min(len, dist);
    t.speed = speed;
    t.life = (dist + t.len) / speed + 0.02;
    t.taper = 1;
    t.active = true;
  }

  /** A static beam that fades over `life` seconds. */
  beam(a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color, width: number, life: number, alpha = 1): void {
    const t = this.alloc();
    t.ax = a.x;
    t.ay = a.y;
    t.az = a.z;
    t.bx = b.x;
    t.by = b.y;
    t.bz = b.z;
    t.width = width;
    t.r = color.r;
    t.g = color.g;
    t.b = color.b;
    t.alpha = alpha;
    t.age = 0;
    t.life = life;
    t.len = 0;
    t.speed = 0;
    t.taper = 0;
    t.active = true;
  }

  /** Jagged lightning bolt from top to bottom with a few branches. */
  lightning(top: THREE.Vector3, bottom: THREE.Vector3, color: THREE.Color, width = 0.35, life = 0.35, rand: () => number = Math.random): void {
    const segs = 9;
    let prev = top.clone();
    const dir = bottom.clone().sub(top);
    const len = dir.length();
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const p = top.clone().addScaledVector(dir, t);
      if (i < segs) {
        p.x += (rand() - 0.5) * len * 0.12;
        p.z += (rand() - 0.5) * len * 0.12;
      }
      this.beam(prev, p, color, width * (1.2 - t * 0.5), life);
      this.beam(prev, p, new THREE.Color(1, 1, 1), width * 0.35, life * 0.8);
      if (i > 2 && i < segs - 1 && rand() < 0.35) {
        const br = p.clone().add(new THREE.Vector3((rand() - 0.5) * len * 0.3, -len * 0.12, (rand() - 0.5) * len * 0.3));
        this.beam(p, br, color, width * 0.4, life * 0.7);
      }
      prev = p;
    }
  }

  update(dt: number): void {
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    const C = this.aC.array as Float32Array;
    let n = 0;
    for (const t of this.beams) {
      if (!t.active) continue;
      t.age += dt;
      if (t.age >= t.life) {
        t.active = false;
        continue;
      }
      let ax = t.ax;
      let ay = t.ay;
      let az = t.az;
      let bx = t.bx;
      let by = t.by;
      let bz = t.bz;
      let alpha = t.alpha;
      if (t.speed > 0) {
        const dx = t.bx - t.ax;
        const dy = t.by - t.ay;
        const dz = t.bz - t.az;
        const dist = Math.hypot(dx, dy, dz) || 1;
        const head = Math.min(dist, t.age * t.speed);
        const tail = Math.max(0, head - t.len);
        const k0 = tail / dist;
        const k1 = head / dist;
        // b = head (bright), a = tail
        ax = t.ax + dx * k0;
        ay = t.ay + dy * k0;
        az = t.az + dz * k0;
        bx = t.ax + dx * k1;
        by = t.ay + dy * k1;
        bz = t.az + dz * k1;
        if (head >= dist) alpha *= Math.max(0, 1 - (t.age * t.speed - dist) / t.len);
      } else alpha *= 1 - t.age / t.life;
      const q = n * 4;
      A[q] = ax;
      A[q + 1] = ay;
      A[q + 2] = az;
      A[q + 3] = t.width;
      B[q] = bx;
      B[q + 1] = by;
      B[q + 2] = bz;
      B[q + 3] = t.taper;
      C[q] = t.r;
      C[q + 1] = t.g;
      C[q + 2] = t.b;
      C[q + 3] = alpha;
      n++;
    }
    this.geo.instanceCount = n;
    if (n > 0) {
      for (const a of [this.aA, this.aB, this.aC]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * 4);
        a.needsUpdate = true;
      }
    }
    this.mesh.visible = n > 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
