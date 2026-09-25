// Animated stylised water at MapData.waterLevel. Only cells near/below the
// water level get geometry; per-vertex depth drives colour, shore foam and
// transparency.
import * as THREE from 'three';
import type { MapData } from '../../core/map';
import { NATURE, SKY } from '../palette';
import { col } from '../core/geo';
import { sharedUniforms } from '../core/materials';
import { requestSkyArt } from '../core/worldArt';

const VERT = /* glsl */ `
attribute float aDepth;
uniform float uTime;
varying float vDepth;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vDepth = aDepth;
  vec3 p = position;
  p.y += sin(p.x * 0.35 + uTime * 1.3) * 0.05 + cos(p.z * 0.3 + uTime * 1.1) * 0.05;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSky;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
varying float vDepth;
varying vec3 vWorld;
#include <fog_pars_fragment>

float wHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float wNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  vec2 uv = vWorld.xz;
  // procedural normal from scrolling wave noise
  float t = uTime;
  vec2 flow = vec2(t * 0.35, t * 0.08);
  float e = 0.25;
  float h0 = wNoise(uv * 0.45 + flow) + 0.5 * wNoise(uv * 1.3 - flow * 1.7);
  float hx = wNoise((uv + vec2(e, 0.0)) * 0.45 + flow) + 0.5 * wNoise((uv + vec2(e, 0.0)) * 1.3 - flow * 1.7);
  float hz = wNoise((uv + vec2(0.0, e)) * 0.45 + flow) + 0.5 * wNoise((uv + vec2(0.0, e)) * 1.3 - flow * 1.7);
  vec3 n = normalize(vec3((h0 - hx) * 1.6, 1.0, (h0 - hz) * 1.6));
  vec3 viewDir = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
  float depthT = clamp(vDepth / 3.5, 0.0, 1.0);
  vec3 c = mix(uShallow, uDeep, depthT);
  c = mix(c, uSky, fres * 0.55);
  vec3 h = normalize(uSunDir + viewDir);
  float spec = pow(max(dot(n, h), 0.0), 140.0);
  c += uSunColor * spec * 1.4;
  // shore foam
  float foam = smoothstep(0.55, 0.0, vDepth) * (0.55 + 0.45 * sin(vDepth * 18.0 - t * 2.2 + wNoise(uv * 2.0) * 4.0));
  c = mix(c, vec3(0.95, 0.93, 0.86), clamp(foam, 0.0, 1.0) * 0.75);
  float alpha = mix(0.55, 0.92, smoothstep(0.0, 2.0, vDepth));
  alpha = max(alpha, foam * 0.8);
  gl_FragColor = vec4(c, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export interface WaterMesh {
  mesh: THREE.Mesh | null;
  dispose(): void;
}

export function buildWater(map: MapData, sunDir: THREE.Vector3): WaterMesh {
  const n = map.res + 1;
  const cell = map.size / map.res;
  const half = map.size / 2;
  const wl = map.waterLevel;
  const H = map.heights;
  const step = map.res > 160 ? 2 : 1;
  const hAt = (ix: number, iz: number): number => H[Math.min(map.res, iz) * n + Math.min(map.res, ix)];
  const pos: number[] = [];
  const depth: number[] = [];
  let any = false;
  for (let iz = 0; iz < map.res; iz += step) {
    for (let ix = 0; ix < map.res; ix += step) {
      const i1 = Math.min(map.res, ix + step);
      const z1 = Math.min(map.res, iz + step);
      const hs = [hAt(ix, iz), hAt(i1, iz), hAt(ix, z1), hAt(i1, z1)];
      if (Math.min(...hs) > wl + 0.05) continue;
      any = true;
      const x0 = -half + ix * cell;
      const xx = -half + i1 * cell;
      const zz0 = -half + iz * cell;
      const zz = -half + z1 * cell;
      const quad: [number, number, number][] = [
        [x0, zz0, hs[0]],
        [x0, zz, hs[2]],
        [xx, zz0, hs[1]],
        [xx, zz0, hs[1]],
        [x0, zz, hs[2]],
        [xx, zz, hs[3]],
      ];
      for (const [x, z, h] of quad) {
        pos.push(x, wl, z);
        depth.push(wl - h);
      }
    }
  }
  if (!any) return { mesh: null, dispose: () => undefined };
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
  g.computeBoundingSphere();
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uShallow: { value: col(NATURE.water).clone() },
        uDeep: { value: col(NATURE.waterDeep).clone() },
        uSky: { value: col(SKY.horizon).clone() },
        uSunColor: { value: col(SKY.sun).clone() },
        uSunDir: { value: sunDir.clone().normalize() },
      },
    ]),
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  mat.uniforms.uTime = sharedUniforms.uTime;
  // AI-art sky: reflect the painted sky's horizon haze (mixed with a touch of its zenith blue)
  let disposed = false;
  requestSkyArt((art) => {
    if (disposed) return;
    (mat.uniforms.uSky.value as THREE.Color).copy(art.horizon).lerp(art.zenith, 0.25);
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'water';
  mesh.renderOrder = 2;
  mesh.receiveShadow = false;
  return {
    mesh,
    dispose(): void {
      disposed = true;
      g.dispose();
      mat.dispose();
    },
  };
}
