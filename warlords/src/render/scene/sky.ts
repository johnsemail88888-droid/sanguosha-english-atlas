// Background layer: ink-wash gradient sky dome with sun glow + drifting brush
// clouds, and three rings of layered mountain silhouettes. Rendered in its own
// scene/camera (huge far plane) BEFORE the main scene so the main camera keeps
// a tight near/far range (good depth precision, no z-fighting).
//
// AI-art mode (env/sky.webp shipped): the dome shows the painted panorama
// instead — wrapped once around 360° and squeezed to 80° of elevation (see
// SKY_RAD_PER_IMAGE), turned so the painted sun sits in the scene light's
// azimuth (and as high as the painting allows), its edges matched at load so it
// wraps without a seam (worldArt makePanoramaTileable), the top blended into the painting's zenith
// colour (no pole pinch) and the horizon into the sky-matched fog colour so
// distant terrain melts into it. The painting is pre-compensated for the ACES
// tone mapping so it reads as painted. The mountain rings take its horizon tint.
import * as THREE from 'three';
import { SKY } from '../palette';
import { col, mixCol } from '../core/geo';
import { fbm2, valueNoise2 } from '../core/noise';
import { sharedUniforms } from '../core/materials';
import { SKY_FILE, SKY_RAD_PER_IMAGE, requestSkyArt, setSkySunElevation, withWorldArtListing } from '../core/worldArt';
import {
  activateSkyArtFog,
  buildPaintedFogLut,
  disposeSkyArtFog,
  makeSkyFogLutTexture,
  setSkyArtFogGain,
  setSkyArtFogLut,
  skyArtFogUniforms,
} from '../core/skyArtFog';

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

const SKY_ART_PARS = /* glsl */ `
#ifdef SKY_ART
uniform sampler2D uSkyTex;
uniform vec2 uSunUV;
uniform float uSunAz;
uniform float uVPerRad;
uniform float uHorizonV;
uniform vec3 uArtZenith;
uniform float uExposure;
uniform sampler2D uFogSkyTex;
uniform vec4 uFogSkyMap;
// inverse of three's ACESFilmicToneMapping (what the OutputPass applies), so
// the painting comes out of the tone mapper as painted
vec3 invRRT(vec3 y) {
  vec3 A = 0.983729 * y - 1.0;
  vec3 B = 0.4329510 * y - 0.0245786;
  vec3 C = 0.238081 * y + 0.000090537;
  return (-B - sqrt(max(B * B - 4.0 * A * C, 0.0))) / (2.0 * A);
}
vec3 invACES(vec3 c) {
  // inverses of three's ACESInputMat / ACESOutputMat (precomputed: no per-pixel matrix inversion)
  const mat3 INV_IN = mat3(vec3(1.764741, -0.147028, -0.036337), vec3(-0.675778, 1.160252, -0.162436), vec3(-0.088963, -0.013224, 1.198773));
  const mat3 INV_OUT = mat3(vec3(0.643038, 0.059269, 0.005962), vec3(0.311187, 0.931436, 0.063929), vec3(0.045775, 0.009295, 0.930118));
  c = clamp(c, 0.0, 0.97);
  c = clamp(INV_OUT * c, 0.0, 0.97);
  c = invRRT(c);
  c = max(INV_IN * c, 0.0);
  return c * 0.6 / uExposure;
}
#endif`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uTime;
varying vec3 vDir;
${'${SKY_ART_PARS}'}

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
#ifdef SKY_ART
  {
    // azimuth: two branch cuts, keep the derivative without the wrap jump
    float a = atan(d.x, d.z) / 6.2831853;
    float b = fract(a + 1.0);
    vec2 dA = vec2(dFdx(a), dFdy(a));
    vec2 dB = vec2(dFdx(b), dFdy(b));
    vec2 du = -(dot(dA, dA) < dot(dB, dB) ? dA : dB);
    float u = fract(uSunUV.x + uSunAz / 6.2831853 - a); // turning right = azimuth decreasing = u increasing
    float el = asin(clamp(d.y, -1.0, 1.0));
    float v = uHorizonV - el * uVPerRad;
    vec2 dv = -vec2(dFdx(el), dFdy(el)) * uVPerRad;
    // texture space is v-down: flipY is on for canvas textures, so sample at 1 - v. The
    // painting was made tileable at load (makePanoramaTileable), so the repeat wrap at
    // u = 0 / 1 is seamless — also under bilinear / mip filtering
    vec3 c = textureGrad(uSkyTex, vec2(u, 1.0 - v), vec2(du.x, -dv.x), vec2(du.y, -dv.y)).rgb;
    // above the painting's top edge: its zenith colour (no clamp streaks, no pinch at the pole)
    float topEl = uHorizonV / uVPerRad;
    c = mix(c, uArtZenith, smoothstep(topEl - 0.32, topEl - 0.02, el));
    c = invACES(c);
    // horizon: melt into the sky-matched fog colour the far terrain fades to (the fog LUT of this painting)
    vec3 fogC = texture2D(uFogSkyTex, vec2(fract(uFogSkyMap.x - a), clamp((el + uFogSkyMap.y) * uFogSkyMap.z, 0.0, 1.0))).rgb * uFogSkyMap.w;
    c = mix(c, fogC, smoothstep(0.09, -0.04, d.y) * 0.85);
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }
#endif
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
  const sunN = sunDir.clone().normalize();

  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG.replace('${SKY_ART_PARS}', SKY_ART_PARS),
    uniforms: {
      uZenith: { value: col(SKY.zenith).clone() },
      uHorizon: { value: col(SKY.horizon).clone() },
      uHaze: { value: col(SKY.haze).clone() },
      uSunColor: { value: col(SKY.sun).clone() },
      uSunDir: { value: sunN.clone() },
      uTime: sharedUniforms.uTime,
      uSkyTex: { value: null as THREE.Texture | null },
      uSunUV: { value: new THREE.Vector2(0.81, 0.56) },
      uSunAz: { value: Math.atan2(sunN.x, sunN.z) },
      uVPerRad: { value: 1 / SKY_RAD_PER_IMAGE },
      uHorizonV: { value: 0.76 },
      uArtZenith: { value: new THREE.Color(0.05, 0.1, 0.25) },
      uExposure: { value: 1.15 },
      uFogSkyTex: skyArtFogUniforms.uFogSkyTex,
      uFogSkyMap: skyArtFogUniforms.uFogSkyMap,
    },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(5000, 48, 24), skyMat);
  skyMesh.renderOrder = -10;
  skyMesh.frustumCulled = false;
  // the painted sky is pre-compensated for the renderer's tone mapping exposure
  let paintedFog = false;
  skyMesh.onBeforeRender = (r) => {
    const exposure = r.toneMapping === THREE.ACESFilmicToneMapping ? r.toneMappingExposure : 0.6;
    skyMat.uniforms.uExposure.value = exposure;
    // the painted fog LUT is stored for exposure 1, like the dome's invACES()
    if (paintedFog) setSkyArtFogGain(1 / exposure);
  };
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

  // AI-art panorama (callback only when shipped + decoded)
  let disposed = false;
  setSkySunElevation(Math.asin(Math.min(1, Math.max(-1, sunDirN.y))));
  // the deploy ships a painting: world materials compile the LUT fog right away
  // (procedural gradient in the LUT until the painting has decoded)
  withWorldArtListing((files) => {
    if (!disposed && files.has(SKY_FILE)) activateSkyArtFog(sunDirN);
  });
  requestSkyArt((art) => {
    if (disposed) return;
    const u = skyMat.uniforms;
    u.uSkyTex.value = art.tex;
    u.uSunUV.value.set(art.sunU, art.sunV);
    u.uHorizonV.value = art.horizonV;
    u.uArtZenith.value.copy(art.zenith);
    activateSkyArtFog(sunDirN);
    const lut = buildPaintedFogLut(art.preview, { horizonV: art.horizonV, vPerRad: 1 / SKY_RAD_PER_IMAGE, seam: 0, zenith: art.zenith });
    setSkyArtFogLut(makeSkyFogLutTexture(lut), art.sunU + u.uSunAz.value / (Math.PI * 2));
    paintedFog = true;
    skyMat.defines = { ...skyMat.defines, SKY_ART: '' };
    skyMat.needsUpdate = true;
    // distant ridges pick up the painting's horizon haze
    mtnMat.color.copy(art.horizon).multiplyScalar(1 / Math.max(0.05, (art.horizon.r + art.horizon.g + art.horizon.b) / 3)).lerp(new THREE.Color(1, 1, 1), 0.55);
  });
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
      disposed = true;
      disposeSkyArtFog();
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
