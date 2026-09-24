// 烽火圈 zone visuals: a tall translucent fire-red wall at the current radius
// (scrolling flame shader) and a glowing ground ring marking the next zone.
import * as THREE from 'three';
import type { MapData } from '../../core/map';
import { terrainHeight } from '../../core/map';
import type { ZoneView } from '../../core/types';
import { sharedUniforms } from '../core/materials';

const WALL_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const WALL_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPulse;
uniform vec3 uCamPos;
uniform float uRadius;
varying vec2 vUv;
varying vec3 vWorld;
float zHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float zNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(zHash(i), zHash(i + vec2(1, 0)), f.x), mix(zHash(i + vec2(0, 1)), zHash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float h = vUv.y;
  float u = vUv.x * max(40.0, uRadius * 1.6);
  float n = zNoise(vec2(u * 0.35, h * 22.0 - uTime * 1.4)) * 0.6 + zNoise(vec2(u * 1.3, h * 55.0 - uTime * 2.8)) * 0.4;
  float flames = smoothstep(0.3, 0.85, n + (0.25 - h) * 1.5);
  vec3 col = mix(vec3(0.72, 0.06, 0.03), vec3(1.7, 0.55, 0.12), flames);
  float body = (0.16 + 0.34 * flames) * (1.0 - smoothstep(0.0, 0.42, h));
  float foot = 0.5 * (1.0 - smoothstep(0.0, 0.012, h));
  // warning bands (烽火) drifting upward
  float bands = 0.85 + 0.15 * sin(h * 160.0 - uTime * 3.0);
  float a = (body * bands + foot) * (0.85 + uPulse * 0.6);
  // fade when the camera is very close so it never blinds the player
  float d = abs(length(uCamPos.xz - vWorld.xz));
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.85));
}`;

const RING_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
void main() {
  float glow = pow(1.0 - vUv.y, 2.0);
  float dash = step(0.4, fract(vUv.x * 180.0 - uTime * 0.5));
  float a = glow * (0.15 + 0.45 * dash);
  vec3 c = vec3(1.8, 1.4, 0.7);
  gl_FragColor = vec4(c * a, a);
}`;

const SEG = 256;

export class ZoneVisual {
  readonly group = new THREE.Group();
  private readonly wall: THREE.Mesh;
  private readonly wallMat: THREE.ShaderMaterial;
  private readonly ring: THREE.Mesh;
  private readonly ringGeo: THREE.BufferGeometry;
  private readonly map: MapData;
  private ringKey = '';
  private pulse = 0;
  private lastPhase = -1;

  constructor(map: MapData) {
    this.map = map;
    const g = new THREE.CylinderGeometry(1, 1, 1, 160, 1, true);
    g.translate(0, 0.5, 0);
    this.wallMat = new THREE.ShaderMaterial({
      vertexShader: WALL_VERT,
      fragmentShader: WALL_FRAG,
      uniforms: {
        uTime: sharedUniforms.uTime,
        uPulse: { value: 0 },
        uCamPos: { value: new THREE.Vector3() },
        uRadius: { value: 100 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.wall = new THREE.Mesh(g, this.wallMat);
    this.wall.frustumCulled = false;
    this.wall.renderOrder = 30;
    this.wall.name = 'zoneWall';
    this.ringGeo = new THREE.BufferGeometry();
    const pos = new Float32Array((SEG + 1) * 2 * 3);
    const uv = new Float32Array((SEG + 1) * 2 * 2);
    const idx: number[] = [];
    for (let i = 0; i <= SEG; i++) {
      uv.set([i / SEG, 0, i / SEG, 1], i * 4);
      if (i < SEG) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    this.ringGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.ringGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.ringGeo.setIndex(idx);
    this.ring = new THREE.Mesh(
      this.ringGeo,
      new THREE.ShaderMaterial({
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: RING_FRAG,
        uniforms: { uTime: sharedUniforms.uTime },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 29;
    this.ring.name = 'zoneNext';
    this.group.add(this.wall, this.ring);
    this.group.name = 'zone';
  }

  update(z: ZoneView, camPos: THREE.Vector3, dt: number): void {
    if (z.phase !== this.lastPhase) {
      if (this.lastPhase >= 0) this.pulse = 1;
      this.lastPhase = z.phase;
    }
    this.pulse = Math.max(0, this.pulse - dt * 0.5);
    const r = Math.max(0.5, z.radius);
    const visible = r < this.map.size * 0.75;
    this.wall.visible = visible;
    this.wall.position.set(z.center.x, this.map.waterLevel - 20, z.center.z);
    this.wall.scale.set(r, 160, r);
    this.wallMat.uniforms.uPulse.value = this.pulse;
    (this.wallMat.uniforms.uCamPos.value as THREE.Vector3).copy(camPos);
    this.wallMat.uniforms.uRadius.value = r;
    // next zone ring (only while it is smaller than the current zone)
    const showRing = z.targetRadius < r - 0.5 && z.targetRadius > 0.1;
    this.ring.visible = showRing;
    if (showRing) {
      const key = `${z.targetCenter.x.toFixed(1)},${z.targetCenter.z.toFixed(1)},${z.targetRadius.toFixed(1)}`;
      if (key !== this.ringKey) {
        this.ringKey = key;
        const pos = this.ringGeo.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i <= SEG; i++) {
          const a = (i / SEG) * Math.PI * 2;
          const x = z.targetCenter.x + Math.cos(a) * z.targetRadius;
          const zz = z.targetCenter.z + Math.sin(a) * z.targetRadius;
          const y = Math.max(terrainHeight(this.map, x, zz), this.map.waterLevel) + 0.05;
          pos.setXYZ(i * 2, x, y, zz);
          pos.setXYZ(i * 2 + 1, x, y + 0.7, zz);
        }
        pos.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    this.wall.geometry.dispose();
    this.wallMat.dispose();
    this.ringGeo.dispose();
    (this.ring.material as THREE.Material).dispose();
  }
}
