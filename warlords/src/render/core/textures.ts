// Canvas-drawn textures (no image files: works offline / single-file builds).
// Every factory is lazy + cached and degrades to a plain white texture when no
// 2D canvas is available (node unit tests).
import * as THREE from 'three';
import type { Kingdom } from '../../core/types';
import { KINGDOM_COLORS, KINGDOM_GLYPHS } from '../palette';
import { makeRand } from './noise';

export const CALLIGRAPHY_FONT = '"STKaiti","KaiTi","Kaiti SC","楷体","Noto Serif CJK SC","Source Han Serif SC",serif';
export const UI_FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","WenQuanYi Zen Hei",sans-serif';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface CanvasLike {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: Ctx2D;
}

/** Create a 2D canvas (DOM canvas preferred: CanvasTexture + toDataURL work everywhere). */
export function makeCanvas(w: number, h: number): CanvasLike | null {
  try {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (ctx) return { canvas: c, ctx };
    }
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      if (ctx) return { canvas: c, ctx };
    }
  } catch {
    /* no canvas support */
  }
  return null;
}

let whiteTex: THREE.DataTexture | null = null;
export function whiteTexture(): THREE.Texture {
  if (!whiteTex) {
    whiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    whiteTex.needsUpdate = true;
  }
  return whiteTex;
}

function toTexture(c: CanvasLike, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c.canvas as HTMLCanvasElement);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// ── Particle atlas ──────────────────────────────────────────────────────────
/** Cells in the 4×4 particle atlas. */
export const PT = {
  glow: 0,
  smoke: 1,
  spark: 2,
  ink: 3,
  heart: 4,
  star: 5,
  ring: 6,
  flame: 7,
  snow: 8,
  petal: 9,
  chevron: 10,
  shard: 11,
  square: 12,
  dust: 13,
  bagua: 14,
  note: 15,
} as const;
export type ParticleTex = (typeof PT)[keyof typeof PT];

let atlas: THREE.Texture | null = null;

export function particleAtlas(): THREE.Texture {
  if (atlas) return atlas;
  const S = 128;
  const c = makeCanvas(S * 4, S * 4);
  if (!c) return (atlas = whiteTexture());
  const g = c.ctx;
  const rand = makeRand(1234);
  const cell = (i: number, draw: (cx: number, cy: number, r: number) => void): void => {
    const x = (i % 4) * S;
    const y = Math.floor(i / 4) * S;
    g.save();
    g.beginPath();
    g.rect(x, y, S, S);
    g.clip();
    draw(x + S / 2, y + S / 2, S / 2);
    g.restore();
  };
  const radial = (cx: number, cy: number, r: number, stops: [number, string][]): void => {
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const [o, s] of stops) gr.addColorStop(o, s);
    g.fillStyle = gr;
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
  };
  // 0 glow
  cell(PT.glow, (cx, cy, r) =>
    radial(cx, cy, r, [
      [0, 'rgba(255,255,255,1)'],
      [0.25, 'rgba(255,255,255,0.75)'],
      [0.6, 'rgba(255,255,255,0.18)'],
      [1, 'rgba(255,255,255,0)'],
    ]),
  );
  // 1 smoke: several overlapping blobs
  cell(PT.smoke, (cx, cy, r) => {
    for (let i = 0; i < 9; i++) {
      const a = rand() * Math.PI * 2;
      const d = rand() * r * 0.35;
      const rr = r * (0.35 + rand() * 0.3);
      radial(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr, [
        [0, 'rgba(255,255,255,0.55)'],
        [0.6, 'rgba(255,255,255,0.25)'],
        [1, 'rgba(255,255,255,0)'],
      ]);
    }
  });
  // 2 spark: bright hard dot
  cell(PT.spark, (cx, cy, r) =>
    radial(cx, cy, r * 0.9, [
      [0, 'rgba(255,255,255,1)'],
      [0.35, 'rgba(255,255,255,0.9)'],
      [0.7, 'rgba(255,255,255,0.2)'],
      [1, 'rgba(255,255,255,0)'],
    ]),
  );
  // 3 ink splash: irregular blot + droplets
  cell(PT.ink, (cx, cy, r) => {
    g.fillStyle = '#fff';
    g.beginPath();
    const n = 18;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (0.38 + rand() * 0.22 + (i % 3 === 0 ? rand() * 0.25 : 0));
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.fill();
    for (let i = 0; i < 9; i++) {
      const a = rand() * Math.PI * 2;
      const d = r * (0.6 + rand() * 0.35);
      g.beginPath();
      g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.03 + rand() * 0.06), 0, Math.PI * 2);
      g.fill();
    }
  });
  // 4 heart
  cell(PT.heart, (cx, cy, r) => {
    g.fillStyle = '#fff';
    g.beginPath();
    const s = r * 0.8;
    g.moveTo(cx, cy + s * 0.75);
    g.bezierCurveTo(cx - s * 1.2, cy - s * 0.1, cx - s * 0.6, cy - s * 0.95, cx, cy - s * 0.35);
    g.bezierCurveTo(cx + s * 0.6, cy - s * 0.95, cx + s * 1.2, cy - s * 0.1, cx, cy + s * 0.75);
    g.fill();
  });
  // 5 star (5 points)
  cell(PT.star, (cx, cy, r) => {
    g.fillStyle = '#fff';
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? r * 0.85 : r * 0.36;
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
    g.fill();
  });
  // 6 ring
  cell(PT.ring, (cx, cy, r) => {
    g.strokeStyle = '#fff';
    g.lineWidth = r * 0.14;
    g.beginPath();
    g.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
    g.stroke();
  });
  // 7 flame tongue
  cell(PT.flame, (cx, cy, r) => {
    const gr = g.createRadialGradient(cx, cy + r * 0.3, 0, cx, cy + r * 0.2, r * 0.9);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.5, 'rgba(255,255,255,0.6)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(cx, cy - r * 0.95);
    g.bezierCurveTo(cx + r * 0.2, cy - r * 0.4, cx + r * 0.75, cy + r * 0.1, cx + r * 0.5, cy + r * 0.6);
    g.bezierCurveTo(cx + r * 0.3, cy + r * 0.95, cx - r * 0.3, cy + r * 0.95, cx - r * 0.5, cy + r * 0.6);
    g.bezierCurveTo(cx - r * 0.75, cy + r * 0.1, cx - r * 0.2, cy - r * 0.4, cx, cy - r * 0.95);
    g.fill();
  });
  // 8 snowflake
  cell(PT.snow, (cx, cy, r) => {
    g.strokeStyle = '#fff';
    g.lineWidth = r * 0.09;
    g.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI) / 3;
      g.beginPath();
      g.moveTo(cx - Math.cos(a) * r * 0.8, cy - Math.sin(a) * r * 0.8);
      g.lineTo(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8);
      g.stroke();
    }
    radial(cx, cy, r * 0.4, [
      [0, 'rgba(255,255,255,0.9)'],
      [1, 'rgba(255,255,255,0)'],
    ]);
  });
  // 9 petal / leaf
  cell(PT.petal, (cx, cy, r) => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.ellipse(cx, cy, r * 0.35, r * 0.75, 0.5, 0, Math.PI * 2);
    g.fill();
  });
  // 10 chevron (pointing down)
  cell(PT.chevron, (cx, cy, r) => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(cx - r * 0.8, cy - r * 0.45);
    g.lineTo(cx, cy + r * 0.35);
    g.lineTo(cx + r * 0.8, cy - r * 0.45);
    g.lineTo(cx + r * 0.8, cy - r * 0.05);
    g.lineTo(cx, cy + r * 0.75);
    g.lineTo(cx - r * 0.8, cy - r * 0.05);
    g.closePath();
    g.fill();
  });
  // 11 shard (irregular triangle)
  cell(PT.shard, (cx, cy, r) => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(cx - r * 0.2, cy - r * 0.85);
    g.lineTo(cx + r * 0.55, cy + r * 0.5);
    g.lineTo(cx - r * 0.5, cy + r * 0.7);
    g.closePath();
    g.fill();
  });
  // 12 square
  cell(PT.square, (cx, cy, r) => {
    g.fillStyle = '#fff';
    g.fillRect(cx - r * 0.55, cy - r * 0.55, r * 1.1, r * 1.1);
  });
  // 13 dust: faint noisy disc
  cell(PT.dust, (cx, cy, r) => {
    for (let i = 0; i < 14; i++) {
      const a = rand() * Math.PI * 2;
      const d = rand() * r * 0.45;
      radial(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.25 + rand() * 0.3), [
        [0, 'rgba(255,255,255,0.35)'],
        [1, 'rgba(255,255,255,0)'],
      ]);
    }
  });
  // 14 bagua trigram ring
  cell(PT.bagua, (cx, cy, r) => {
    g.strokeStyle = '#fff';
    g.lineWidth = r * 0.06;
    g.beginPath();
    g.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#fff';
    for (let i = 0; i < 8; i++) {
      g.save();
      g.translate(cx, cy);
      g.rotate((i * Math.PI) / 4);
      for (let k = 0; k < 3; k++) {
        const broken = ((i >> k) & 1) === 1;
        const y = -r * (0.45 + k * 0.1);
        if (broken) {
          g.fillRect(-r * 0.2, y, r * 0.16, r * 0.05);
          g.fillRect(r * 0.04, y, r * 0.16, r * 0.05);
        } else g.fillRect(-r * 0.2, y, r * 0.4, r * 0.05);
      }
      g.restore();
    }
  });
  // 15 music note
  cell(PT.note, (cx, cy, r) => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.ellipse(cx - r * 0.2, cy + r * 0.45, r * 0.25, r * 0.18, -0.4, 0, Math.PI * 2);
    g.fill();
    g.fillRect(cx - r * 0.0, cy - r * 0.7, r * 0.1, r * 1.15);
    g.beginPath();
    g.moveTo(cx + r * 0.1, cy - r * 0.7);
    g.quadraticCurveTo(cx + r * 0.6, cy - r * 0.45, cx + r * 0.45, cy - r * 0.05);
    g.lineTo(cx + r * 0.1, cy - r * 0.35);
    g.fill();
  });
  atlas = toTexture(c, false);
  atlas.generateMipmaps = true;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  return atlas;
}

// ── Banner cloth with a kingdom glyph ───────────────────────────────────────
const bannerCache = new Map<string, THREE.Texture>();

/** 128×256 vertical war banner: kingdom colour, dark hem, white disc with a black calligraphy glyph. */
export function bannerTexture(kingdom: Kingdom | string, glyph?: string): THREE.Texture {
  const key = `${kingdom}|${glyph ?? ''}`;
  const hit = bannerCache.get(key);
  if (hit) return hit;
  const W = 128;
  const H = 256;
  const c = makeCanvas(W, H);
  if (!c) return whiteTexture();
  const g = c.ctx;
  const k = kingdom as Kingdom;
  const base = KINGDOM_COLORS[k] ?? (kingdom.startsWith('#') ? kingdom : '#8a6d3a');
  const text = glyph ?? KINGDOM_GLYPHS[k] ?? '令';
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);
  // cloth weave shading
  const sh = g.createLinearGradient(0, 0, W, 0);
  sh.addColorStop(0, 'rgba(0,0,0,0.25)');
  sh.addColorStop(0.5, 'rgba(255,255,255,0.08)');
  sh.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = sh;
  g.fillRect(0, 0, W, H);
  // flame-tooth border (火焰边)
  g.fillStyle = '#1d1712';
  const tooth = 16;
  for (let y = 0; y < H; y += tooth) {
    g.beginPath();
    g.moveTo(W, y);
    g.lineTo(W - 12, y + tooth / 2);
    g.lineTo(W, y + tooth);
    g.fill();
  }
  g.fillRect(0, 0, W, 8);
  g.fillStyle = '#d8ac4c';
  g.fillRect(0, 8, W, 3);
  // disc + glyph
  g.fillStyle = '#f1e8d2';
  g.beginPath();
  g.arc(W / 2 - 4, H * 0.42, 42, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#d8ac4c';
  g.lineWidth = 3;
  g.stroke();
  g.fillStyle = '#16120e';
  g.font = `bold 60px ${CALLIGRAPHY_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, W / 2 - 4, H * 0.42 + 3);
  const t = toTexture(c);
  bannerCache.set(key, t);
  return t;
}

// ── Ink-wash backdrop (portraits) ───────────────────────────────────────────
/** Parchment backdrop with a kingdom-coloured ink splash and a faint giant glyph. */
export function inkBackdropCanvas(kingdom: Kingdom, size: number, seed = 7): CanvasLike | null {
  const c = makeCanvas(size, size);
  if (!c) return null;
  const g = c.ctx;
  const rand = makeRand(seed);
  const base = KINGDOM_COLORS[kingdom] ?? '#8a6d3a';
  g.fillStyle = '#e9dcc0';
  g.fillRect(0, 0, size, size);
  // ink blooms
  for (let i = 0; i < 26; i++) {
    const x = size * (0.2 + rand() * 0.9);
    const y = size * (0.05 + rand() * 0.9);
    const r = size * (0.12 + rand() * 0.3);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, hexA(base, 0.35 + rand() * 0.2));
    gr.addColorStop(1, hexA(base, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, size, size);
  }
  // dark brush sweep
  g.save();
  g.globalAlpha = 0.55;
  g.fillStyle = '#1c1a18';
  g.beginPath();
  g.moveTo(size * 0.05, size * 0.95);
  g.quadraticCurveTo(size * 0.5, size * 0.55, size * 1.05, size * 0.7);
  g.lineTo(size * 1.05, size * 1.05);
  g.lineTo(size * 0.05, size * 1.05);
  g.fill();
  g.restore();
  // giant faint glyph
  g.fillStyle = hexA('#1c1a18', 0.14);
  g.font = `bold ${Math.round(size * 0.8)}px ${CALLIGRAPHY_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(KINGDOM_GLYPHS[kingdom] ?? '', size * 0.62, size * 0.46);
  // vignette
  const v = g.createRadialGradient(size / 2, size / 2, size * 0.3, size / 2, size / 2, size * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(20,12,6,0.55)');
  g.fillStyle = v;
  g.fillRect(0, 0, size, size);
  return c;
}

export function inkBackdropTexture(kingdom: Kingdom, size = 512): THREE.Texture {
  const c = inkBackdropCanvas(kingdom, size);
  return c ? toTexture(c) : whiteTexture();
}

// ── Item / loot cards ───────────────────────────────────────────────────────
const cardCache = new Map<string, THREE.Texture>();

/** A small 三国杀-style card face (parchment, coloured frame, big glyph). */
export function cardTexture(glyph: string, color: string, frame: string): THREE.Texture {
  const key = `${glyph}|${color}|${frame}`;
  const hit = cardCache.get(key);
  if (hit) return hit;
  const W = 96;
  const H = 128;
  const c = makeCanvas(W, H);
  if (!c) return whiteTexture();
  const g = c.ctx;
  g.fillStyle = frame;
  roundRect(g, 0, 0, W, H, 10);
  g.fill();
  g.fillStyle = '#f0e4c6';
  roundRect(g, 6, 6, W - 12, H - 12, 7);
  g.fill();
  g.strokeStyle = hexA(color, 0.8);
  g.lineWidth = 2;
  roundRect(g, 11, 11, W - 22, H - 22, 5);
  g.stroke();
  g.fillStyle = color;
  g.font = `bold 56px ${CALLIGRAPHY_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(glyph.slice(0, 1), W / 2, H / 2 + 2);
  const t = toTexture(c);
  cardCache.set(key, t);
  return t;
}

// ── Trap glyph circle (ground decal) ────────────────────────────────────────
const glyphCircleCache = new Map<string, THREE.Texture>();

/** Magic-circle decal: double ring, bagua ticks and a central glyph. White on transparent (tinted by material). */
export function glyphCircleTexture(glyph: string): THREE.Texture {
  const hit = glyphCircleCache.get(glyph);
  if (hit) return hit;
  const S = 256;
  const c = makeCanvas(S, S);
  if (!c) return whiteTexture();
  const g = c.ctx;
  const cx = S / 2;
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(cx, cx, S * 0.46, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 3;
  g.beginPath();
  g.arc(cx, cx, S * 0.38, 0, Math.PI * 2);
  g.stroke();
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.save();
    g.translate(cx + Math.cos(a) * S * 0.42, cx + Math.sin(a) * S * 0.42);
    g.rotate(a);
    g.fillRect(-2, -6, 4, 12);
    g.restore();
  }
  g.font = `bold ${Math.round(S * 0.42)}px ${CALLIGRAPHY_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(glyph, cx, cx + 6);
  const t = toTexture(c, false);
  glyphCircleCache.set(glyph, t);
  return t;
}

// ── helpers ─────────────────────────────────────────────────────────────────
/** '#rrggbb' (or '#rgb') + alpha → css rgba() string (sRGB, no colour management). */
export function hexA(hex: string, a: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function roundRect(g: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

export { toTexture as canvasToTexture };
