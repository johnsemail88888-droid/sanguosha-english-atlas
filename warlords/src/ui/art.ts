// Painted art for the UI (optional AI-generated files in public/assets, see
// src/game/assets.ts): which file to show where, and how to crop a hero
// portrait for each place it appears. Pure logic (no DOM) so it is unit-tested;
// widgets.ts (PortraitCache) and keyart.ts do the DOM side.
//
// Every caller must keep working without the art: the single-file build ships
// none and must look exactly like the procedural game.
import type { Kingdom } from '../core/types';

/** Portrait files are 3:4 (576×768) painted hero cards, head in the upper third. */
export const PORTRAIT_ASPECT = 3 / 4;
/** Title / main-menu key art (1920×1072, calm dark area upper-centre for the logo). */
export const TITLE_ART = 'assets/ui/title.webp';

export function portraitArtPath(heroId: string): string {
  return `assets/portraits/${heroId}.webp`;
}

const LOADING_KINGDOMS: ReadonlySet<Kingdom> = new Set<Kingdom>(['shu', 'wei', 'wu', 'qun']);

/** Match-loading art for the local hero's kingdom, best first; always ends with the title key art. */
export function loadingArtCandidates(kingdom: Kingdom | null | undefined): string[] {
  return kingdom && LOADING_KINGDOMS.has(kingdom) ? [`assets/ui/loading_${kingdom}.webp`, TITLE_ART] : [TITLE_ART];
}

/** The first candidate this deploy ships (null when none does or the listing is not known yet). */
export function firstShipped(files: ReadonlySet<string> | null, candidates: readonly string[]): string | null {
  if (!files) return null;
  for (const c of candidates) if (files.has(c)) return c;
  return null;
}

// ── portrait focus ───────────────────────────────────────────────────────────

/**
 * Where the face is in a portrait: centre of the face (x, y as 0..1 of the image
 * width / height) and the head height (s, fraction of the image height, from the
 * top of the hair / helmet to the chin). Measured by eye on the painted files.
 */
export interface PortraitFocus {
  x: number;
  y: number;
  s: number;
}

export const DEFAULT_FOCUS: PortraitFocus = { x: 0.5, y: 0.15, s: 0.14 };

export const PORTRAIT_FOCUS: Readonly<Record<string, PortraitFocus>> = {
  // 蜀
  liubei: { x: 0.5, y: 0.145, s: 0.13 },
  guanyu: { x: 0.5, y: 0.14, s: 0.16 },
  zhangfei: { x: 0.52, y: 0.2, s: 0.16 },
  zhugeliang: { x: 0.53, y: 0.195, s: 0.15 },
  zhaoyun: { x: 0.45, y: 0.165, s: 0.1 },
  machao: { x: 0.47, y: 0.14, s: 0.095 },
  huangyueying: { x: 0.45, y: 0.18, s: 0.14 },
  huangzhong: { x: 0.445, y: 0.195, s: 0.13 },
  // 魏
  caocao: { x: 0.5, y: 0.125, s: 0.115 },
  simayi: { x: 0.535, y: 0.215, s: 0.15 },
  xiahoudun: { x: 0.5, y: 0.15, s: 0.16 },
  zhangliao: { x: 0.515, y: 0.2, s: 0.13 },
  xuchu: { x: 0.5, y: 0.155, s: 0.12 },
  guojia: { x: 0.47, y: 0.15, s: 0.14 },
  zhenji: { x: 0.52, y: 0.155, s: 0.1 },
  xiahouyuan: { x: 0.4, y: 0.175, s: 0.115 },
  // 吴
  sunquan: { x: 0.5, y: 0.175, s: 0.15 },
  ganning: { x: 0.5, y: 0.14, s: 0.13 },
  lumeng: { x: 0.44, y: 0.16, s: 0.12 },
  huanggai: { x: 0.57, y: 0.155, s: 0.14 },
  zhouyu: { x: 0.47, y: 0.17, s: 0.1 },
  daqiao: { x: 0.46, y: 0.15, s: 0.13 },
  luxun: { x: 0.5, y: 0.12, s: 0.11 },
  sunshangxiang: { x: 0.47, y: 0.14, s: 0.1 },
  // 群
  huatuo: { x: 0.52, y: 0.145, s: 0.13 },
  lubu: { x: 0.47, y: 0.27, s: 0.1 },
  diaochan: { x: 0.46, y: 0.16, s: 0.13 },
  zhangjiao: { x: 0.5, y: 0.335, s: 0.11 },
  yuanshao: { x: 0.47, y: 0.235, s: 0.09 },
  menghuo: { x: 0.48, y: 0.21, s: 0.12 },
};

export function portraitFocus(heroId: string): PortraitFocus {
  return PORTRAIT_FOCUS[heroId] ?? DEFAULT_FOCUS;
}

// ── crops ────────────────────────────────────────────────────────────────────

/**
 * How one kind of frame shows a portrait. The frame has a fixed aspect; the
 * image is zoomed so the head is `head` of the frame height (never below
 * "cover", never above `maxZoom`), then moved so the face centre lands on
 * (ax, ay) of the frame as far as the image edges allow.
 */
export interface CropSpec {
  /** frame width / height */
  aspect: number;
  /** wanted head height as a fraction of the frame height (0 = plain cover) */
  head: number;
  ax: number;
  ay: number;
  maxZoom: number;
}

export type PortraitCrop = 'card' | 'thumb' | 'face' | 'bust' | 'full';

export const CROPS: Readonly<Record<PortraitCrop, CropSpec>> = {
  /** 5:7 hero card: upper body, head fully visible below the badge row */
  card: { aspect: 5 / 7, head: 0.16, ax: 0.5, ay: 0.3, maxZoom: 1.55 },
  /** tiny 5:7 thumbnail (hero-select pick strip): head and shoulders */
  thumb: { aspect: 5 / 7, head: 0.3, ax: 0.5, ay: 0.36, maxZoom: 2.4 },
  /** round / square avatar: the face */
  face: { aspect: 1, head: 0.56, ax: 0.5, ay: 0.47, maxZoom: 3.4 },
  /** 2:1 splash (hero detail header): head and shoulders */
  bust: { aspect: 2, head: 0.36, ax: 0.5, ay: 0.42, maxZoom: 1.8 },
  /** the whole painting in a 3:4 frame */
  full: { aspect: 3 / 4, head: 0, ax: 0.5, ay: 0.5, maxZoom: 1 },
};

/** Image box inside the frame, in % of the frame width (w, l) and height (h, t). */
export interface CropBox {
  w: number;
  h: number;
  l: number;
  t: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const r2 = (v: number): number => Math.round(v * 100) / 100;

export function cropBox(spec: CropSpec, focus: PortraitFocus, imgAspect = PORTRAIT_ASPECT): CropBox {
  const c = spec.aspect;
  // zoom = image width / frame width; the image height in frame heights is zoom·c/imgAspect
  const cover = Math.max(1, imgAspect / c);
  const want = spec.head > 0 && focus.s > 0 ? (spec.head * imgAspect) / (focus.s * c) : cover;
  const zoom = Math.max(cover, Math.min(Math.max(cover, spec.maxZoom), want));
  const hh = (zoom * c) / imgAspect;
  const l = clamp(spec.ax - focus.x * zoom, 1 - zoom, 0);
  const t = clamp(spec.ay - focus.y * hh, 1 - hh, 0);
  return { w: r2(zoom * 100), h: r2(hh * 100), l: r2(l * 100), t: r2(t * 100) };
}

/** Inline style for the <img> of a crop (absolute box; object-fit keeps odd-sized files undistorted). */
export function cropStyle(box: CropBox): string {
  return `width:${box.w}%;height:${box.h}%;left:${box.l}%;top:${box.t}%`;
}

export function portraitCropStyle(heroId: string, crop: PortraitCrop): string {
  return cropStyle(cropBox(CROPS[crop], portraitFocus(heroId)));
}
