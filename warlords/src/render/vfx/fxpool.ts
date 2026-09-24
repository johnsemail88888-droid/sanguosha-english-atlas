// Pooled one-shot meshes: expanding ground rings, glow discs, melee slash
// arcs, shockwave spheres, light pillars — plus a fixed pool of flash lights.
import * as THREE from 'three';

const DISC_VERT = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DISC_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uInner;   // ring inner radius fraction (0 = filled disc)
uniform float uSoft;
uniform float uArc;     // half-angle (rad); >= 3.1 = full circle
uniform float uTime;
varying vec2 vLocal;
void main() {
  float r = length(vLocal);
  if (r > 1.0) discard;
  float band = smoothstep(uInner - uSoft, uInner, r) * (1.0 - smoothstep(1.0 - uSoft, 1.0, r));
  if (uInner <= 0.0) band = 1.0 - smoothstep(1.0 - uSoft, 1.0, r);
  float ang = atan(vLocal.x, vLocal.y); // 0 along local +Y (forward)
  float arcMask = uArc >= 3.1 ? 1.0 : 1.0 - smoothstep(uArc - 0.12, uArc, abs(ang));
  // slash streaks for arcs
  float streak = uArc >= 3.1 ? 1.0 : 0.6 + 0.4 * sin(r * 40.0 - uTime * 30.0);
  float a = band * arcMask * uAlpha * streak;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * a, a);
}`;

const SPHERE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
  float a = f * uAlpha;
  gl_FragColor = vec4(uColor * a, a);
}`;

const SPHERE_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalMatrix * normal;
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const PILLAR_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  float a = uAlpha * (1.0 - vUv.y) * (0.5 + 0.5 * sin(vUv.x * 6.2831 * 3.0));
  a *= smoothstep(0.0, 0.05, vUv.y);
  gl_FragColor = vec4(uColor * a, a);
}`;
const PILLAR_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

type Kind = 'disc' | 'sphere' | 'pillar';

interface Fx {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  kind: Kind;
  active: boolean;
  age: number;
  life: number;
  r0: number;
  r1: number;
  a0: number;
  a1: number;
  h: number;
  inner0: number;
  inner1: number;
}

export interface RingOptions {
  color: THREE.Color;
  radius0?: number;
  radius1: number;
  life: number;
  alpha?: number;
  alphaEnd?: number;
  /** ring band inner fraction (0 = disc) */
  inner?: number;
  innerEnd?: number;
  soft?: number;
  /** half-angle for arcs (rad) */
  arc?: number;
  /** yaw for arcs (forward = local +Y rotated) */
  yaw?: number;
  additive?: boolean;
}

export class FxPool {
  readonly group = new THREE.Group();
  private readonly pool: Fx[] = [];
  private readonly discGeo = new THREE.CircleGeometry(1, 48);
  private readonly sphereGeo = new THREE.IcosahedronGeometry(1, 2);
  private readonly pillarGeo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
  private time = 0;

  constructor() {
    this.group.name = 'fxpool';
    this.pillarGeo.translate(0, 0.5, 0);
  }

  private get(kind: Kind): Fx {
    for (const f of this.pool) if (!f.active && f.kind === kind) return f;
    let mat: THREE.ShaderMaterial;
    let mesh: THREE.Mesh;
    const common = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
    if (kind === 'disc') {
      mat = new THREE.ShaderMaterial({
        vertexShader: DISC_VERT,
        fragmentShader: DISC_FRAG,
        uniforms: {
          uColor: { value: new THREE.Color() },
          uAlpha: { value: 1 },
          uInner: { value: 0.8 },
          uSoft: { value: 0.1 },
          uArc: { value: 10 },
          uTime: { value: 0 },
        },
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        ...common,
      });
      mesh = new THREE.Mesh(this.discGeo, mat);
    } else if (kind === 'sphere') {
      mat = new THREE.ShaderMaterial({
        vertexShader: SPHERE_VERT,
        fragmentShader: SPHERE_FRAG,
        uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 1 } },
        ...common,
      });
      mesh = new THREE.Mesh(this.sphereGeo, mat);
    } else {
      mat = new THREE.ShaderMaterial({
        vertexShader: PILLAR_VERT,
        fragmentShader: PILLAR_FRAG,
        uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 1 } },
        side: THREE.DoubleSide,
        ...common,
      });
      mesh = new THREE.Mesh(this.pillarGeo, mat);
    }
    mesh.frustumCulled = false;
    mesh.renderOrder = 18;
    const f: Fx = { mesh, mat, kind, active: false, age: 0, life: 1, r0: 0, r1: 1, a0: 1, a1: 0, h: 1, inner0: 0, inner1: 0 };
    this.pool.push(f);
    this.group.add(mesh);
    return f;
  }

  /** Flat ring / disc / slash arc lying on the ground at pos. */
  ring(pos: THREE.Vector3, o: RingOptions): void {
    const f = this.get('disc');
    f.active = true;
    f.age = 0;
    f.life = o.life;
    f.r0 = o.radius0 ?? 0.1;
    f.r1 = o.radius1;
    f.a0 = o.alpha ?? 1;
    f.a1 = o.alphaEnd ?? 0;
    f.inner0 = o.inner ?? 0.82;
    f.inner1 = o.innerEnd ?? f.inner0;
    f.mesh.position.copy(pos);
    // lay flat (local +Y → world forward), then yaw about world Y (order YXZ = Ry·Rx)
    f.mesh.rotation.set(-Math.PI / 2, o.yaw ?? 0, 0, 'YXZ');
    const u = f.mat.uniforms;
    (u.uColor.value as THREE.Color).copy(o.color);
    u.uSoft.value = o.soft ?? 0.12;
    u.uArc.value = o.arc ?? 10;
    f.mat.blending = o.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending;
    f.mesh.visible = true;
    this.apply(f);
  }

  /** Expanding fresnel shockwave sphere. */
  sphere(pos: THREE.Vector3, color: THREE.Color, r0: number, r1: number, life: number, alpha = 1): void {
    const f = this.get('sphere');
    f.active = true;
    f.age = 0;
    f.life = life;
    f.r0 = r0;
    f.r1 = r1;
    f.a0 = alpha;
    f.a1 = 0;
    f.mesh.position.copy(pos);
    (f.mat.uniforms.uColor.value as THREE.Color).copy(color);
    f.mesh.visible = true;
    this.apply(f);
  }

  /** Vertical light pillar (revive, loot drops, pickups). */
  pillar(pos: THREE.Vector3, color: THREE.Color, radius: number, height: number, life: number, alpha = 1): void {
    const f = this.get('pillar');
    f.active = true;
    f.age = 0;
    f.life = life;
    f.r0 = radius;
    f.r1 = radius * 0.4;
    f.h = height;
    f.a0 = alpha;
    f.a1 = 0;
    f.mesh.position.copy(pos);
    (f.mat.uniforms.uColor.value as THREE.Color).copy(color);
    f.mesh.visible = true;
    this.apply(f);
  }

  private apply(f: Fx): void {
    const t = Math.min(1, f.age / f.life);
    const e = 1 - (1 - t) * (1 - t); // ease-out
    const r = f.r0 + (f.r1 - f.r0) * e;
    const a = f.a0 + (f.a1 - f.a0) * t;
    if (f.kind === 'disc') {
      f.mesh.scale.set(r, r, r);
      f.mat.uniforms.uAlpha.value = a;
      f.mat.uniforms.uInner.value = f.inner0 + (f.inner1 - f.inner0) * t;
      f.mat.uniforms.uTime.value = this.time;
    } else if (f.kind === 'sphere') {
      f.mesh.scale.setScalar(r);
      f.mat.uniforms.uAlpha.value = a;
    } else {
      f.mesh.scale.set(r, f.h * (0.3 + 0.7 * e), r);
      f.mat.uniforms.uAlpha.value = a;
    }
  }

  update(dt: number): void {
    this.time += dt;
    for (const f of this.pool) {
      if (!f.active) continue;
      f.age += dt;
      if (f.age >= f.life) {
        f.active = false;
        f.mesh.visible = false;
        continue;
      }
      this.apply(f);
    }
  }

  dispose(): void {
    for (const f of this.pool) f.mat.dispose();
    this.discGeo.dispose();
    this.sphereGeo.dispose();
    this.pillarGeo.dispose();
  }
}

/** Fixed-size pool of flash point lights (count only changes on quality change). */
export class LightPool {
  private lights: { light: THREE.PointLight; age: number; life: number; peak: number }[] = [];
  private readonly scene: THREE.Scene;
  private next = 0;

  constructor(scene: THREE.Scene, count: number) {
    this.scene = scene;
    this.setCount(count);
  }

  setCount(count: number): void {
    for (const l of this.lights) this.scene.remove(l.light);
    this.lights = [];
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight('#ffffff', 0, 20, 1.8);
      light.castShadow = false;
      this.scene.add(light);
      this.lights.push({ light, age: 0, life: 0, peak: 0 });
    }
    this.next = 0;
  }

  flash(pos: THREE.Vector3, color: THREE.Color, intensity: number, distance: number, life: number): void {
    if (!this.lights.length) return;
    // prefer a free light, else the one closest to finishing
    let pick = -1;
    for (let i = 0; i < this.lights.length; i++) if (this.lights[i].age >= this.lights[i].life) pick = i;
    if (pick < 0) {
      pick = this.next;
      this.next = (this.next + 1) % this.lights.length;
    }
    const l = this.lights[pick];
    l.light.position.copy(pos);
    l.light.color.copy(color);
    l.light.distance = distance;
    l.age = 0;
    l.life = life;
    l.peak = intensity;
    l.light.intensity = intensity;
  }

  update(dt: number): void {
    for (const l of this.lights) {
      if (l.age >= l.life) {
        l.light.intensity = 0;
        continue;
      }
      l.age += dt;
      const t = Math.min(1, l.age / l.life);
      l.light.intensity = l.peak * (1 - t) * (1 - t);
    }
  }

  dispose(): void {
    for (const l of this.lights) this.scene.remove(l.light);
    this.lights = [];
  }
}
