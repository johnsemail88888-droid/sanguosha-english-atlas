// Full-bleed painted backdrops (title, menu screens, match loading): the first
// candidate this deploy ships, decoded off the main thread, then faded in.
// Without art (single-file build, missing files) nothing is added and the caller
// keeps its procedural look — `onResolve(null)` tells it so.
import { assetList, assetListSync } from '../game/assets';
import { firstShipped } from './art';
import { h } from './dom';

export interface ArtBackdrop {
  readonly el: HTMLElement;
  /** the art shown, null when none ships / it failed to load, undefined while still pending */
  readonly url: string | null | undefined;
  dispose(): void;
}

export interface ArtBackdropOpts {
  /** extra classes on the backdrop element */
  cls?: string;
  /** slow ken-burns drift (CSS; off with prefers-reduced-motion) */
  drift?: boolean;
  /** called once, never synchronously: the art URL once it is decoded and shown, or null when there is none */
  onResolve?: (url: string | null) => void;
}

export function artBackdrop(candidates: readonly string[], opts: ArtBackdropOpts = {}): ArtBackdrop {
  const el = h('div', { class: `sg-art-bg${opts.drift ? ' kb' : ''}${opts.cls ? ` ${opts.cls}` : ''}`, aria: { hidden: 'true' } });
  let disposed = false;
  let url: string | null | undefined;
  let raf = 0;
  const finish = (u: string | null): void => {
    if (url !== undefined || disposed) return;
    url = u;
    opts.onResolve?.(u);
  };
  const show = (path: string | null): void => {
    if (disposed) return;
    if (!path) {
      // async like the success path: callers may still be initialising when this runs
      void Promise.resolve().then(() => finish(null));
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.alt = '';
    img.draggable = false;
    img.src = path;
    img.decode().then(
      () => {
        if (disposed) return;
        el.appendChild(img);
        // next frame, so the opacity transition runs from 0
        raf = requestAnimationFrame(() => el.classList.add('on'));
        finish(path);
      },
      () => finish(null),
    );
  };
  const known = assetListSync();
  if (known) show(firstShipped(known, candidates));
  else void assetList().then((files) => show(firstShipped(files, candidates)));
  return {
    el,
    get url() {
      return url;
    },
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(raf);
    },
  };
}
