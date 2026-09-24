// Pooled CPU-simulated particles drawn as ONE instanced quad mesh per blend
// mode. Fixed capacity (no allocations after construction); oldest particles
// are recycled when the pool is full. Quads can billboard (with rotation) or
// stretch along their velocity (sparks, tracer debris, rain).
import * as THREE from 'three';
import { particleAtlas, type ParticleTex } from '../core/textures';

const VERT = /* glsl */ `
attribute vec4 iPos;    // xyz, size
attribute vec4 iColor;  // rgb, alpha
attribute vec4 iVel;    // xyz velocity, stretch factor
attribute vec2 iMisc;   // atlas cell, rotation
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  vColor = iColor;
  float cell = iMisc.x;
  vec2 cellUv = vec2(mod(cell, 4.0), 3.0 - floor(cell / 4.0)) * 0.25;
  vUv = cellUv + uv * 0.25;
  vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0);
  float size = iPos.w;
  vec2 corner = position.xy;
  vec2 off;
  if (iVel.w > 0.0) {
    vec3 vv = (viewMatrix * vec4(iVel.xyz, 0.0)).xyz;
    float speed = length(vv.xy);
    vec2 d = speed > 1e-4 ? vv.xy / speed : vec2(1.0, 0.0);
    vec2 n = vec2(-d.y, d.x);
    off = d * corner.x * (size + speed * iVel.w) + n * corner.y * size;
  } else {
    float c = cos(iMisc.y);
    float s = sin(iMisc.y);
    off = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c) * size;
  }
  mv.xy += off;
  vec4 mvPosition = mv;
  gl_Position = projectionMatrix * mv;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uAdditive;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(uAtlas, vUv);
  float a = t.a * vColor.a;
  if (a < 0.004) discard;
  vec3 c = vColor.rgb * t.rgb;
  #ifdef USE_FOG
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    if (uAdditive > 0.5) { a *= 1.0 - fogFactor; }
    else { c = mix(c, fogSkyColor(), fogFactor); }
  #endif
  gl_FragColor = vec4(c, a);
}`;

/** Mutable spawn descriptor (reuse one instance to avoid garbage). */
export class ParticleSpawn {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  life = 1;
  size0 = 0.3;
  size1 = 0.6;
  r0 = 1;
  g0 = 1;
  b0 = 1;
  r1 = 1;
  g1 = 1;
  b1 = 1;
  a0 = 1;
  a1 = 0;
  gravity = 0;
  drag = 0;
  tex: ParticleTex = 0;
  rot = 0;
  spin = 0;
  stretch = 0;

  color(c: THREE.Color, c1: THREE.Color = c): this {
    this.r0 = c.r;
    this.g0 = c.g;
    this.b0 = c.b;
    this.r1 = c1.r;
    this.g1 = c1.g;
    this.b1 = c1.b;
    return this;
  }

  reset(): this {
    this.vx = this.vy = this.vz = 0;
    this.life = 1;
    this.size0 = 0.3;
    this.size1 = 0.6;
    this.r0 = this.g0 = this.b0 = this.r1 = this.g1 = this.b1 = 1;
    this.a0 = 1;
    this.a1 = 0;
    this.gravity = 0;
    this.drag = 0;
    this.tex = 0;
    this.rot = 0;
    this.spin = 0;
    this.stretch = 0;
    return this;
  }
}

const F = 20; // floats per particle in the CPU state
// layout: 0 x 1 y 2 z 3 vx 4 vy 5 vz 6 age 7 life 8 s0 9 s1 10 r0 11 g0 12 b0 13 r1 14 g1 15 b1 16 a0 17 a1 18 grav 19 drag
// extra arrays: tex, rot, spin, stretch

export class ParticleSystem {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private readonly st: Float32Array;
  private readonly tex: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly stretch: Float32Array;
  private readonly alive: Uint8Array;
  private next = 0;
  private count = 0;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aCol: THREE.InstancedBufferAttribute;
  private readonly aVel: THREE.InstancedBufferAttribute;
  private readonly aMisc: THREE.InstancedBufferAttribute;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  /** 0..1 budget multiplier (quality) */
  budget = 1;

  constructor(capacity: number, additive: boolean) {
    this.capacity = capacity;
    this.st = new Float32Array(capacity * F);
    this.tex = new Float32Array(capacity);
    this.rot = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.stretch = new Float32Array(capacity);
    this.alive = new Uint8Array(capacity);
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    g.setAttribute('uv', quad.getAttribute('uv'));
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aMisc = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    for (const a of [this.aPos, this.aCol, this.aVel, this.aMisc]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iColor', this.aCol);
    g.setAttribute('iVel', this.aVel);
    g.setAttribute('iMisc', this.aMisc);
    g.instanceCount = 0;
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uAtlas: { value: null }, uAdditive: { value: additive ? 1 : 0 } },
      ]),
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    this.mat.uniforms.uAtlas.value = particleAtlas();
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 20 : 15;
    this.mesh.name = additive ? 'particles_add' : 'particles_alpha';
  }

  get liveCount(): number {
    return this.count;
  }

  /** Spawn one particle (recycles the oldest slot when full). Returns false when dropped by budget. */
  spawn(s: ParticleSpawn): boolean {
    if (this.budget < 1 && Math.random() > this.budget) return false;
    let i = this.next;
    // find a free slot quickly (ring buffer; overwrite if the ring is full)
    for (let k = 0; k < 8 && this.alive[i]; k++) i = (i + 1) % this.capacity;
    this.next = (i + 1) % this.capacity;
    const o = i * F;
    const st = this.st;
    st[o] = s.x;
    st[o + 1] = s.y;
    st[o + 2] = s.z;
    st[o + 3] = s.vx;
    st[o + 4] = s.vy;
    st[o + 5] = s.vz;
    st[o + 6] = 0;
    st[o + 7] = Math.max(0.01, s.life);
    st[o + 8] = s.size0;
    st[o + 9] = s.size1;
    st[o + 10] = s.r0;
    st[o + 11] = s.g0;
    st[o + 12] = s.b0;
    st[o + 13] = s.r1;
    st[o + 14] = s.g1;
    st[o + 15] = s.b1;
    st[o + 16] = s.a0;
    st[o + 17] = s.a1;
    st[o + 18] = s.gravity;
    st[o + 19] = s.drag;
    this.tex[i] = s.tex;
    this.rot[i] = s.rot;
    this.spin[i] = s.spin;
    this.stretch[i] = s.stretch;
    this.alive[i] = 1;
    return true;
  }

  update(dt: number): void {
    const st = this.st;
    const P = this.aPos.array as Float32Array;
    const C = this.aCol.array as Float32Array;
    const Vv = this.aVel.array as Float32Array;
    const M = this.aMisc.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const o = i * F;
      const age = st[o + 6] + dt;
      const life = st[o + 7];
      if (age >= life) {
        this.alive[i] = 0;
        continue;
      }
      st[o + 6] = age;
      const drag = st[o + 19];
      if (drag > 0) {
        const k = Math.max(0, 1 - drag * dt);
        st[o + 3] *= k;
        st[o + 4] *= k;
        st[o + 5] *= k;
      }
      st[o + 4] -= st[o + 18] * dt;
      st[o] += st[o + 3] * dt;
      st[o + 1] += st[o + 4] * dt;
      st[o + 2] += st[o + 5] * dt;
      this.rot[i] += this.spin[i] * dt;
      const t = age / life;
      const q = n * 4;
      P[q] = st[o];
      P[q + 1] = st[o + 1];
      P[q + 2] = st[o + 2];
      P[q + 3] = st[o + 8] + (st[o + 9] - st[o + 8]) * t;
      C[q] = st[o + 10] + (st[o + 13] - st[o + 10]) * t;
      C[q + 1] = st[o + 11] + (st[o + 14] - st[o + 11]) * t;
      C[q + 2] = st[o + 12] + (st[o + 15] - st[o + 12]) * t;
      // alpha: quick fade-in then interpolate
      const fadeIn = Math.min(1, t * 12);
      C[q + 3] = (st[o + 16] + (st[o + 17] - st[o + 16]) * t) * fadeIn;
      Vv[q] = st[o + 3];
      Vv[q + 1] = st[o + 4];
      Vv[q + 2] = st[o + 5];
      Vv[q + 3] = this.stretch[i];
      M[n * 2] = this.tex[i];
      M[n * 2 + 1] = this.rot[i];
      n++;
    }
    this.count = n;
    this.geo.instanceCount = n;
    if (n > 0) {
      for (const a of [this.aPos, this.aCol, this.aVel]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * 4);
        a.needsUpdate = true;
      }
      this.aMisc.clearUpdateRanges();
      this.aMisc.addUpdateRange(0, n * 2);
      this.aMisc.needsUpdate = true;
    }
    this.mesh.visible = n > 0;
  }

  clear(): void {
    this.alive.fill(0);
    this.count = 0;
    this.geo.instanceCount = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
