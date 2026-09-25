// DOM side of the painted card / icon art (cardArt.ts): identity cards, item /
// armor / mount emblems, ability icons, weapon renders.
//
// Every piece of art is one `<span class="sg-art {shape}"><img></span>` whose size
// comes from the caller's CSS, so nothing moves when the file arrives. Round emblems
// are masked by the span (their files have white corners outside the ink circle);
// weapon renders have their black backdrop cut out on a canvas once per file.
//
// Nothing is requested unless the deploy's art listing names the file (no 404s);
// without it every caller keeps its glyph / seal — the procedural look. A listed
// file that fails to load is dropped for the rest of the page and its host falls
// back the same way.
import { assetList, assetListSync } from '../game/assets';
import type { RoleId } from '../core/types';
import { abilityIconPath, cutoutAlpha, cutoutFloor, cutoutGain, gearArt, roleCardPath, shippedPath, type ArtRef, type ArtShape } from './cardArt';
import { h } from './dom';
import { roleName } from './i18n';
import { roleColor } from './theme';

/** listed art that failed to load: the procedural look from then on */
const broken = new Set<string>();

/** The URL of `path` when this deploy ships it (null when it does not, or the listing is still loading). */
export function artUrl(path: string | null | undefined): string | null {
  return shippedPath(assetListSync(), path, broken);
}

/** The art listing has loaded (artUrl() answers for good). */
export function artKnown(): boolean {
  return assetListSync() !== null;
}

export function whenArtKnown(): Promise<unknown> {
  return assetList();
}

function markBroken(path: string): void {
  if (!broken.has(path)) console.warn('[ui] art failed to load', path);
  broken.add(path);
}

// ── weapon cut-outs ──────────────────────────────────────────────────────────

export interface Cutout {
  url: string;
  /** false: the canvas step failed — the raw file is used with a lighten blend instead */
  cut: boolean;
}

const cutouts = new Map<string, Promise<Cutout | null>>();

/** Turn a render's black backdrop into transparency (cardArt.ts cutoutAlpha / cutoutGain). */
function cutOut(img: HTMLImageElement): Promise<string> {
  const w = img.naturalWidth;
  const hgt = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g || !w || !hgt) return Promise.reject(new Error('no canvas'));
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, w, hgt);
  const px = data.data;
  const border: number[] = [];
  const edge = Math.max(2, Math.round(Math.min(w, hgt) * 0.025));
  for (let y = 0; y < hgt; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (x >= edge && y >= edge && x < w - edge && y < hgt - edge) continue;
      const i = (y * w + x) * 4;
      border.push(Math.max(px[i], px[i + 1], px[i + 2]));
    }
  }
  const floor = cutoutFloor(border);
  for (let i = 0; i < px.length; i += 4) {
    const m = Math.max(px[i], px[i + 1], px[i + 2]);
    const a = cutoutAlpha(m, floor);
    px[i + 3] = Math.round(a * 255);
    if (a > 0 && a < 1) {
      const k = cutoutGain(m, floor);
      px[i] = Math.min(255, px[i] * k);
      px[i + 1] = Math.min(255, px[i + 1] * k);
      px[i + 2] = Math.min(255, px[i + 2] * k);
    }
  }
  g.putImageData(data, 0, 0);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(URL.createObjectURL(b)) : reject(new Error('toBlob failed'))), 'image/png'));
}

/** Cut-outs run one at a time in idle time (a few ms of pixel work each), never back to back in one frame. */
let cutQueue: Promise<unknown> = Promise.resolve();

function idle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 250 });
    else setTimeout(resolve, 16);
  });
}

/** The render with its black cut out (cached per file; null when the file does not load). */
export function weaponCutout(path: string): Promise<Cutout | null> {
  let p = cutouts.get(path);
  if (!p) {
    // the download / decode starts now (in parallel); only the pixel work waits its turn
    const img = new Image();
    img.decoding = 'async';
    img.src = path;
    const decoded = img.decode().then(
      () => true,
      () => false,
    );
    const job = async (): Promise<Cutout | null> => {
      if (!(await decoded)) {
        markBroken(path);
        return null;
      }
      await idle();
      return cutOut(img).then(
        (url) => ({ url, cut: true }),
        () => ({ url: path, cut: false }),
      );
    };
    p = cutQueue.then(job, job);
    cutQueue = p;
    cutouts.set(path, p);
  }
  return p;
}

/** Start the cut-outs of weapons that are about to be shown (the match's signature weapons), in idle time. */
export function prewarmWeapons(ids: readonly (string | null | undefined)[]): void {
  for (const id of ids) {
    const ref = gearArt(id);
    if (ref?.shape === 'weapon' && artUrl(ref.path)) void weaponCutout(ref.path);
  }
}

// ── art elements ─────────────────────────────────────────────────────────────

export interface ArtElOpts {
  /** extra classes on the span */
  cls?: string;
  /** long lists (97 ability icons, the 玩法说明 tables): the browser loads the file when scrolled near (weapon cut-outs queue in idle time anyway) */
  lazy?: boolean;
  /** the file did not load: the caller puts its procedural look back */
  onFail?: () => void;
}

/** `<span class="sg-art {shape}"><img></span>` for a shipped file (callers check artUrl() first). */
export function artEl(ref: ArtRef, opts: ArtElOpts = {}): HTMLElement {
  const img = h('img', { alt: '', draggable: false });
  img.decoding = 'async';
  if (opts.lazy) img.loading = 'lazy';
  const el = h('span', { class: `sg-art ${ref.shape}${opts.cls ? ` ${opts.cls}` : ''}`, aria: { hidden: 'true' } }, img);
  const fail = (): void => {
    markBroken(ref.path);
    el.remove();
    opts.onFail?.();
  };
  if (ref.shape === 'weapon') {
    void weaponCutout(ref.path).then((c) => {
      if (!c) {
        el.remove();
        opts.onFail?.();
        return;
      }
      if (!c.cut) el.classList.add('blend');
      img.src = c.url;
    });
  } else {
    img.addEventListener('error', fail, { once: true });
    img.src = ref.path;
  }
  return el;
}

interface Shown {
  path: string;
  el: HTMLElement;
}

const hosted = new WeakMap<HTMLElement, Shown>();
/** what a host asked for while the listing was still loading */
const wanted = new WeakMap<HTMLElement, { ref: ArtRef | null; opts: SetArtOpts }>();

export interface SetArtOpts extends ArtElOpts {
  /** insert the art as the host's first child (under its overlays: cooldown sweep, numbers) */
  first?: boolean;
}

/**
 * Show `ref` inside `host` (the host gets the class `art-on`, which its CSS uses to
 * hide the glyph under the art), or take the art out again (null / not shipped).
 * Idempotent — the HUD calls it whenever a slot's content may have changed.
 * Returns whether the art is shown now.
 */
export function setArt(host: HTMLElement, ref: ArtRef | null, opts: SetArtOpts = {}): boolean {
  const cur = hosted.get(host);
  if (!artKnown() && ref) {
    // decide once the listing is in (only if the host still wants the same file then)
    const first = !wanted.has(host);
    wanted.set(host, { ref, opts });
    if (first) {
      void whenArtKnown().then(() => {
        const w = wanted.get(host);
        wanted.delete(host);
        if (w) setArt(host, w.ref, w.opts);
      });
    }
    return false;
  }
  if (wanted.has(host)) wanted.set(host, { ref, opts });
  const path = ref ? artUrl(ref.path) : null;
  if (cur && cur.path === path) return true;
  if (cur) {
    cur.el.remove();
    hosted.delete(host);
  }
  if (!ref || !path) {
    host.classList.remove('art-on');
    return false;
  }
  const el = artEl(ref, {
    ...opts,
    onFail: () => {
      if (hosted.get(host)?.el === el) {
        hosted.delete(host);
        host.classList.remove('art-on');
      }
      opts.onFail?.();
    },
  });
  hosted.set(host, { path, el });
  if (opts.first) host.prepend(el);
  else host.appendChild(el);
  host.classList.add('art-on');
  return true;
}

/**
 * The art version of an element when its file ships, else the plain one. While the
 * listing is still loading the plain element is returned and swapped for the art
 * version once it is known; a file that fails to load swaps the plain one back.
 */
export function artOr(ref: ArtRef | null, withArt: (art: HTMLElement) => HTMLElement, plain: () => HTMLElement, opts: ArtElOpts = {}): HTMLElement {
  if (!ref) return plain();
  const make = (): HTMLElement => {
    let out: HTMLElement | null = null;
    const art = artEl(ref, {
      ...opts,
      onFail: () => {
        out?.replaceWith(plain());
        opts.onFail?.();
      },
    });
    out = withArt(art);
    return out;
  };
  if (artUrl(ref.path)) return make();
  if (artKnown()) return plain();
  const p = plain();
  void whenArtKnown().then(() => {
    if (artUrl(ref.path) && p.parentNode) p.replaceWith(make());
  });
  return p;
}

// ── shared builders ──────────────────────────────────────────────────────────

export function abilityArt(abilityId: string): ArtRef {
  return { path: abilityIconPath(abilityId), shape: 'disc' };
}

export function roleArt(role: RoleId): ArtRef {
  return { path: roleCardPath(role), shape: 'card' };
}

/**
 * A small painted identity card (a role reminder beside the role's name) when the
 * art ships, else `plain()` (the role seal — today's look). Sized by the caller's CSS.
 */
export function roleCardBadge(role: RoleId, plain: () => HTMLElement, cls = ''): HTMLElement {
  return artOr(
    roleArt(role),
    (art) => {
      const el = h('span', { class: `sg-rcard${cls ? ` ${cls}` : ''}`, title: roleName(role) }, art);
      el.style.setProperty('--rc', roleColor(role));
      return el;
    },
    plain,
  );
}

/**
 * The emblem / render of a card, armor, mount or weapon as a standalone icon (loot
 * popups, prompts, kill feed): null when it has no shipped art — callers then show
 * nothing extra, as before.
 */
export function gearIcon(id: string | null | undefined, cls = '', lazy = false): HTMLElement | null {
  const ref = gearArt(id);
  if (!ref || !artUrl(ref.path)) return null;
  return artEl(ref, { cls, lazy });
}

/** Same for an ability icon (kill feed ability kills). */
export function abilityIcon(abilityId: string, cls = '', lazy = false): HTMLElement | null {
  const ref = abilityArt(abilityId);
  return artUrl(ref.path) ? artEl(ref, { cls, lazy }) : null;
}

export type { ArtRef, ArtShape };
