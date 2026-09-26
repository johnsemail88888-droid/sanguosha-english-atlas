// Sky-matched fog. Distant geometry fades into the SAME colour the sky dome
// shows in that view direction (horizon haze → zenith gradient + sun glow),
// so mountains and the far plane never show a pale silhouette or a hard clip
// edge. Implemented by overriding three's fog shader chunks (installed once;
// only affects materials with fog enabled). Materials that define FOG_MAX
// (characters) clamp the fog factor to it.
//
// AI-art sky (env/sky.webp): the world materials (terrain, structures, props,
// vegetation, water) compile a SKY_ART_FOG variant that reads the fog colour
// from a small direction LUT of the painted panorama (blurred, pre-compensated
// for the tone mapping like the dome), so a peak rising into the painted sky
// fades into exactly the colour behind it instead of a pale column. Until the
// painting has decoded the LUT holds the procedural gradient (same look as
// the chunk below). Other materials keep the procedural gradient.
import * as THREE from 'three';
import { SKY } from '../palette';

let installed = false;

const lin = (hex: string): string => {
  const c = new THREE.Color(hex); // linear working space
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

/** GLSL for the sky colour in a world direction (keep in sync with scene/sky.ts). */
export function skyFogGlsl(sunDir: THREE.Vector3): string {
  const s = sunDir.clone().normalize();
  return /* glsl */ `
vec3 skyFogColor(vec3 d) {
  float h = clamp(d.y, -0.2, 1.0);
  float t = pow(clamp(h, 0.0, 1.0), 0.55);
  vec3 c = mix(${lin(SKY.horizon)}, ${lin(SKY.zenith)}, t);
  c = mix(c, ${lin(SKY.haze)}, smoothstep(0.08, -0.12, h));
  float sd = max(dot(d, vec3(${s.x.toFixed(4)}, ${s.y.toFixed(4)}, ${s.z.toFixed(4)})), 0.0);
  c += ${lin(SKY.sun)} * (pow(sd, 6.0) * 0.28);
  return c;
}`;
}

/** Replace three's fog chunks with the sky-matched version (idempotent). */
export function installSkyFog(sunDir: THREE.Vector3): void {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogView;
#endif`;
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogView = mvPosition.xyz;
#endif`;
  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogView;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  #ifdef SKY_ART_FOG
  uniform sampler2D uFogSkyTex;
  uniform vec4 uFogSkyMap;
  vec3 fogSkyColor() {
    vec3 d = normalize((vec4(vFogView, 0.0) * viewMatrix).xyz);
    float u = fract(uFogSkyMap.x - atan(d.x, d.z) * 0.15915494);
    float v = clamp((asin(clamp(d.y, -1.0, 1.0)) + uFogSkyMap.y) * uFogSkyMap.z, 0.0, 1.0);
    return texture2D(uFogSkyTex, vec2(u, v)).rgb * uFogSkyMap.w;
  }
  #else
  ${skyFogGlsl(sunDir)}
  vec3 fogSkyColor() {
    vec3 wdir = normalize((vec4(vFogView, 0.0) * viewMatrix).xyz);
    return skyFogColor(wdir);
  }
  #endif
#endif`;
  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  #ifdef FOG_MAX
    // characters: never fully swallowed by fog (a far hero must stay visible on every preset)
    fogFactor = min( fogFactor, FOG_MAX );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogSkyColor(), fogFactor );
#endif`;
}
