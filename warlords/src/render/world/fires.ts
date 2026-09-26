// Brazier fires: ONE instanced billboard mesh with a procedural flame shader
// (additive, bloom-friendly) + a small pool of real point lights that follow
// the braziers nearest to the camera (light count stays constant → no shader
// recompiles). Also used for ship lanterns / torch-like fire sources.
import * as THREE from 'three';
import { sharedUniforms } from '../core/materials';

const VERT = /* glsl */ `
attribute vec4 aFire; // xyz = base position, w = size
attribute float aPhase;
uniform float uTime;
varying vec2 vUv;
varying float vPhase;
void main() {
  vUv = uv;
  vPhase = aPhase;
  float flick = 0.85 + 0.15 * sin(uTime * 13.0 + aPhase * 7.0) + 0.08 * sin(uTime * 23.0 + aPhase);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(0.0, 1.0, 0.0);
  float s = aFire.w;
  vec3 p = aFire.xyz + camRight * position.x * s + up * (position.y + 0.5) * s * 1.7 * flick;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vPhase;
float fHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float fNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fHash(i), fHash(i + vec2(1, 0)), f.x), mix(fHash(i + vec2(0, 1)), fHash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 uv = vUv;
  float n = fNoise(vec2(uv.x * 4.0 + vPhase, uv.y * 3.0 - uTime * 3.5));
  float x = (uv.x - 0.5) * 2.0;
  float y = uv.y;
  float width = (1.0 - y) * 0.9 * (0.75 + 0.5 * n);
  float shape = 1.0 - smoothstep(width * 0.55, width, abs(x + (n - 0.5) * 0.35 * y));
  shape *= smoothstep(0.0, 0.08, y) * (1.0 - smoothstep(0.55 + n * 0.35, 1.0, y));
  float core = 1.0 - smoothstep(0.0, 0.55, abs(x) / max(width, 0.01) + y * 0.8);
  vec3 col = mix(vec3(1.6, 0.35, 0.05), vec3(2.4, 1.5, 0.45), core);
  col = mix(col, vec3(3.0, 2.6, 1.4), core * core);
  float a = clamp(shape, 0.0, 1.0);
  if (a < 0.01) discard;
  gl_FragColor = vec4(col * a, a);
}`;

export interface FireSource {
  pos: THREE.Vector3;
  size: number;
}

export class FireSystem {
  readonly mesh: THREE.Mesh | null;
  private readonly sources: FireSource[];
  private lights: THREE.PointLight[] = [];
  private readonly scene: THREE.Scene;
  private assignTimer = 0;
  private readonly assigned: number[] = [];
  private readonly geo: THREE.InstancedBufferGeometry | null;
  private readonly mat: THREE.ShaderMaterial | null;

  constructor(scene: THREE.Scene, sources: FireSource[]) {
    this.scene = scene;
    this.sources = sources;
    if (!sources.length) {
      this.mesh = null;
      this.geo = null;
      this.mat = null;
      return;
    }
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    g.setAttribute('uv', quad.getAttribute('uv'));
    const fire = new Float32Array(sources.length * 4);
    const phase = new Float32Array(sources.length);
    sources.forEach((s, i) => {
      fire.set([s.pos.x, s.pos.y, s.pos.z, s.size], i * 4);
      phase[i] = (i * 1.618) % 6.28;
    });
    g.setAttribute('aFire', new THREE.InstancedBufferAttribute(fire, 4));
    g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    g.instanceCount = sources.length;
    const box = new THREE.Box3();
    for (const s of sources) box.expandByPoint(s.pos);
    box.expandByScalar(3);
    g.boundingBox = box;
    g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTime: sharedUniforms.uTime },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = 'fires';
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = true;
    scene.add(this.mesh);
  }

  /** Number of real point lights used for the nearest fires. */
  setLightCount(n: number): void {
    for (const l of this.lights) this.scene.remove(l);
    this.lights = [];
    this.assigned.length = 0;
    const count = Math.min(n, this.sources.length);
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight('#ff8a3a', 0, 14, 1.6);
      l.castShadow = false;
      this.scene.add(l);
      this.lights.push(l);
      this.assigned.push(-1);
    }
    this.assignTimer = 0;
  }

  update(dt: number, camPos: THREE.Vector3, time: number): void {
    if (!this.lights.length) return;
    this.assignTimer -= dt;
    if (this.assignTimer <= 0) {
      this.assignTimer = 0.5;
      // pick the N nearest fires (N is tiny: partial selection)
      const best: { i: number; d: number }[] = [];
      this.sources.forEach((s, i) => {
        const d = s.pos.distanceToSquared(camPos);
        if (best.length < this.lights.length) best.push({ i, d });
        else {
          let worst = 0;
          for (let k = 1; k < best.length; k++) if (best[k].d > best[worst].d) worst = k;
          if (d < best[worst].d) best[worst] = { i, d };
        }
      });
      best.forEach((b, k) => {
        this.assigned[k] = b.i;
        this.lights[k].position.copy(this.sources[b.i].pos).add(new THREE.Vector3(0, 0.6, 0));
      });
    }
    this.lights.forEach((l, k) => {
      if (this.assigned[k] < 0) return;
      const ph = this.assigned[k] * 1.618;
      l.intensity = (6 + Math.sin(time * 11 + ph) * 1.2 + Math.sin(time * 17.3 + ph * 2) * 0.8) * this.sources[this.assigned[k]].size;
    });
  }

  dispose(): void {
    for (const l of this.lights) this.scene.remove(l);
    if (this.mesh) this.scene.remove(this.mesh);
    this.geo?.dispose();
    this.mat?.dispose();
  }
}
