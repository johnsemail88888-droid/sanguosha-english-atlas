// War banners (军旗): every banner cloth on the map is merged into ONE mesh with
// a shared glyph atlas (魏 蜀 吴 群 黄 蛮 汉 令) and a vertex-shader wind wave.
import * as THREE from 'three';
import { applySkyArtFog, skyArtFogKey } from '../core/skyArtFog';
import type { MapProp } from '../../core/map';
import { KINGDOM_COLORS } from '../palette';
import { makeCanvas, CALLIGRAPHY_FONT, whiteTexture } from '../core/textures';
import { sharedUniforms } from '../core/materials';

interface AtlasEntry {
  glyph: string;
  color: string;
}

export const BANNER_ATLAS: AtlasEntry[] = [
  { glyph: '魏', color: KINGDOM_COLORS.wei },
  { glyph: '蜀', color: KINGDOM_COLORS.shu },
  { glyph: '吴', color: KINGDOM_COLORS.wu },
  { glyph: '群', color: KINGDOM_COLORS.qun },
  { glyph: '黄', color: '#d9b22a' },
  { glyph: '蛮', color: '#7a4a22' },
  { glyph: '汉', color: '#b3261e' },
  { glyph: '令', color: '#8a6d3a' },
];

const hexToRgb = (h: string): [number, number, number] => {
  const n = parseInt(h.replace('#', '').slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Atlas cell whose colour is nearest to the prop's colour hint. */
export function bannerCell(color: string | undefined): number {
  if (!color) return 7;
  const [r, g, b] = hexToRgb(color);
  let best = 7;
  let bd = Infinity;
  BANNER_ATLAS.forEach((e, i) => {
    const [er, eg, eb] = hexToRgb(e.color);
    const d = (r - er) ** 2 + (g - eg) ** 2 + (b - eb) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

let atlasTex: THREE.Texture | null = null;
function bannerAtlas(): THREE.Texture {
  if (atlasTex) return atlasTex;
  const W = 128;
  const H = 256;
  const c = makeCanvas(W * BANNER_ATLAS.length, H);
  if (!c) return (atlasTex = whiteTexture());
  const g = c.ctx;
  BANNER_ATLAS.forEach((e, i) => {
    const x = i * W;
    g.fillStyle = e.color;
    g.fillRect(x, 0, W, H);
    const sh = g.createLinearGradient(x, 0, x + W, 0);
    sh.addColorStop(0, 'rgba(0,0,0,0.18)');
    sh.addColorStop(0.4, 'rgba(255,255,255,0.06)');
    sh.addColorStop(1, 'rgba(0,0,0,0.22)');
    g.fillStyle = sh;
    g.fillRect(x, 0, W, H);
    // flame-tooth border on the free edge and bottom
    g.fillStyle = '#1d1712';
    for (let y = 0; y < H; y += 16) {
      g.beginPath();
      g.moveTo(x + W, y);
      g.lineTo(x + W - 14, y + 8);
      g.lineTo(x + W, y + 16);
      g.fill();
    }
    for (let xx = 0; xx < W; xx += 16) {
      g.beginPath();
      g.moveTo(x + xx, H);
      g.lineTo(x + xx + 8, H - 14);
      g.lineTo(x + xx + 16, H);
      g.fill();
    }
    g.fillRect(x, 0, 10, H);
    g.fillStyle = '#d8ac4c';
    g.fillRect(x + 10, 0, 3, H);
    g.fillStyle = '#f1e8d2';
    g.beginPath();
    g.arc(x + W / 2, H * 0.4, 40, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#d8ac4c';
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = '#16120e';
    g.font = `bold 58px ${CALLIGRAPHY_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(e.glyph, x + W / 2, H * 0.4 + 3);
  });
  const t = new THREE.CanvasTexture(c.canvas as HTMLCanvasElement);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  atlasTex = t;
  return t;
}

export interface BannerMesh {
  mesh: THREE.Mesh | null;
  dispose(): void;
}

/** Merge all banner cloths (prop.type === 'banner') into one waving mesh. */
export function buildBanners(props: readonly MapProp[]): BannerMesh {
  const banners = props.filter((p) => p.type === 'banner');
  if (!banners.length) return { mesh: null, dispose: () => undefined };
  const NU = 6;
  const NV = 8;
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const wave: number[] = []; // u (0 at pole → 1 free edge), phase
  const idx: number[] = [];
  const cells = BANNER_ATLAS.length;
  for (const p of banners) {
    const cell = bannerCell(p.color);
    const w = Math.max(0.6, p.sx);
    const h = Math.min(p.sy * 0.5, w * 1.5);
    const c = Math.cos(p.rot);
    const s = Math.sin(p.rot);
    const phase = (p.x * 0.37 + p.z * 0.21) % 6.28;
    const top = p.y + p.sy - 0.12;
    const base = pos.length / 3;
    for (let j = 0; j <= NV; j++) {
      for (let i = 0; i <= NU; i++) {
        const u = i / NU;
        const v = j / NV;
        const lx = 0.08 + u * w;
        const ly = -v * h;
        pos.push(p.x + lx * c, top + ly, p.z - lx * s);
        nrm.push(s, 0, c);
        uv.push((cell + u) / cells, 1 - v);
        wave.push(u, phase);
      }
    }
    for (let j = 0; j < NV; j++) {
      for (let i = 0; i < NU; i++) {
        const a = base + j * (NU + 1) + i;
        const b = a + 1;
        const d = a + NU + 1;
        const e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aWave', new THREE.Float32BufferAttribute(wave, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ map: bannerAtlas(), side: THREE.DoubleSide, roughness: 0.9 });
  mat.onBeforeCompile = (shader) => {
    applySkyArtFog(shader, mat);
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute vec2 aWave;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  float u = aWave.x;
  float w = sin(uTime * 3.1 - u * 5.0 + aWave.y) * 0.28 + sin(uTime * 5.3 - u * 9.0 + aWave.y * 1.7) * 0.08;
  transformed += normal * w * u;
  transformed.y -= u * u * 0.12;
}`,
      );
  };
  mat.customProgramCacheKey = () => `banner_wave${skyArtFogKey()}`;
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'banners';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return {
    mesh,
    dispose(): void {
      g.dispose();
      mat.dispose();
    },
  };
}
