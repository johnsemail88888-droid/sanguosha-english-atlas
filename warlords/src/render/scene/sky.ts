// Background layer: ink-wash gradient sky dome with sun glow + drifting brush
// clouds, and three rings of layered mountain silhouettes. Rendered in its own
// scene/camera (huge far plane) BEFORE the main scene so the main camera keeps
// a tight near/far range (good depth precision, no z-fighting).
import * as THREE from 'three';
import { SKY } from '../palette';
import { col, mixCol } from '../core/geo';
import { fbm2, valueNoise2 } from '../core/noise';
import { sharedUniforms } from '../core/materials';

export interface SkyLayer {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** direction TO the sun (normalised) */
  sunDir: THREE.Vector3;
  sync(main: THREE.PerspectiveCamera): void;
  dispose(): void;
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uTime;
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 4; i++) { s += noise(p) * a; p *= 2.07; a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -0.2, 1.0);
  // ink-wash vertical gradient: warm horizon haze -> muted blue-grey zenith
  float t = pow(clamp(h, 0.0, 1.0), 0.55);
  vec3 c = mix(uHorizon, uZenith, t);
  c = mix(c, uHaze, smoothstep(0.08, -0.12, h));
  // sun glow + disc
  float sd = max(dot(d, uSunDir), 0.0);
  c += uSunColor * (pow(sd, 6.0) * 0.28 + pow(sd, 64.0) * 0.55);
  c = mix(c, uSunColor * 1.6, smoothstep(0.9993, 0.9997, sd));
  // brush-stroke clouds: a seamless planar cloud layer, stretched along one axis
  vec2 uv = d.xz / max(d.y + 0.12, 0.04);
  uv = vec2(uv.x * 0.9 + uTime * 0.01, uv.y * 2.6);
  float n = fbm(uv * 0.55 + 7.0);
  float band = smoothstep(0.5, 0.78, n) * smoothstep(0.03, 0.2, h) * smoothstep(0.85, 0.35, h);
  vec3 cloudCol = mix(vec3(0.98, 0.94, 0.86), uSunColor, pow(sd, 3.0) * 0.6);
  c = mix(c, cloudCol, band * 0.55);
  // faint dark ink wash near the top
  c *= 1.0 - smoothstep(0.55, 1.0, h) * 0.12 * fbm(uv * 0.2 + 3.0);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Build the background sky + mountain silhouettes. */
export function createSkyLayer(mapSize: number, sunDir: THREE.Vector3): SkyLayer {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 5, 12000);

  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uZenith: { value: col(SKY.zenith).clone() },
      uHorizon: { value: col(SKY.horizon).clone() },
      uHaze: { value: col(SKY.haze).clone() },
      uSunColor: { value: col(SKY.sun).clone() },
      uSunDir: { value: sunDir.clone().normalize() },
      uTime: sharedUniforms.uTime,
    },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), skyMat);
  skyMesh.renderOrder = -10;
  skyMesh.frustumCulled = false;
  scene.add(skyMesh);

  // Mountain rings: far = pale, near = darker ink. Colours pre-blended toward haze.
  const layers: { r: number; h: number; color: string; seed: number; seg: number }[] = [
    { r: 3600, h: 520, color: SKY.mountainFar, seed: 3, seg: 220 },
    { r: 2500, h: 380, color: SKY.mountainMid, seed: 7, seg: 200 },
    { r: 1500 + mapSize * 0.5, h: 210, color: SKY.mountainNear, seed: 11, seg: 180 },
  ];
  const mtnMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
  const mountains = new THREE.Group();
  layers.forEach((L, li) => {
    const geo = mountainRing(L.r, L.h, L.seg, L.seed, L.color, li);
    const m = new THREE.Mesh(geo, mtnMat);
    m.renderOrder = -9 + li;
    m.frustumCulled = false;
    mountains.add(m);
  });
  scene.add(mountains);

  const sunDirN = sunDir.clone().normalize();
  return {
    scene,
    camera,
    sunDir: sunDirN,
    sync(main: THREE.PerspectiveCamera): void {
      camera.position.copy(main.position);
      camera.quaternion.copy(main.quaternion);
      if (camera.fov !== main.fov || camera.aspect !== main.aspect) {
        camera.fov = main.fov;
        camera.aspect = main.aspect;
        camera.updateProjectionMatrix();
      }
      skyMesh.position.copy(main.position);
    },
    dispose(): void {
      skyMesh.geometry.dispose();
      skyMat.dispose();
      mountains.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      mtnMat.dispose();
    },
  };
}

/** One ring of ridge silhouettes: a strip whose top edge follows ridged noise. */
function mountainRing(radius: number, height: number, seg: number, seed: number, color: string, layer: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const cols: number[] = [];
  const top = col(color);
  const haze = col(SKY.haze);
  const base = mixCol(top, haze, 0.75);
  const peak = mixCol(top, col('#2a2c2e'), 0.12 + layer * 0.08);
  const heightAt = (a: number): number => {
    const x = Math.cos(a) * 3 + seed;
    const z = Math.sin(a) * 3 + seed * 1.7;
    const ridge = 1 - Math.abs(valueNoise2(x * 1.3, z * 1.3) * 2 - 1);
    const n = fbm2(x * 2.4, z * 2.4, 4);
    return height * (0.25 + 0.55 * ridge * ridge + 0.45 * n);
  };
  const bottom = -height * 0.6;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const h0 = heightAt(a0);
    const h1 = heightAt(a1);
    const p = [
      [Math.cos(a0) * radius, bottom, Math.sin(a0) * radius],
      [Math.cos(a1) * radius, bottom, Math.sin(a1) * radius],
      [Math.cos(a1) * radius, h1, Math.sin(a1) * radius],
      [Math.cos(a0) * radius, h0, Math.sin(a0) * radius],
    ];
    const c0 = base;
    const cTop0 = mixCol(base, peak, Math.min(1, h0 / height));
    const cTop1 = mixCol(base, peak, Math.min(1, h1 / height));
    // two triangles, facing the centre (inside of the ring)
    const tris: [number, THREE.Color][] = [
      [0, c0],
      [2, cTop1],
      [1, c0],
      [0, c0],
      [3, cTop0],
      [2, cTop1],
    ];
    for (const [k, c] of tris) {
      pos.push(p[k][0], p[k][1], p[k][2]);
      cols.push(c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return g;
}
