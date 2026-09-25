// Injects the UI stylesheet once per document (CSS lives in TS so the
// single-file build and the Electron app need no extra assets).
import { BASE_CSS } from './base';
import { SCREENS_CSS } from './screens';
import { HUD_CSS } from './hud';
import { ART_CSS } from './art';

const STYLE_ID = 'sgwl-ui-styles';
let grainUrl: string | null = null;

/** Procedural paper grain (tiny canvas noise → data URL), generated once. */
function makeGrain(doc: Document): string {
  if (grainUrl !== null) return grainUrl;
  grainUrl = 'none';
  try {
    const c = doc.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const g = c.getContext('2d');
    if (!g) return grainUrl;
    const img = g.createImageData(128, 128);
    let seed = 1234567;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < img.data.length; i += 4) {
      const v = rnd();
      const dark = v < 0.5;
      img.data[i] = dark ? 60 : 255;
      img.data[i + 1] = dark ? 40 : 245;
      img.data[i + 2] = dark ? 20 : 220;
      img.data[i + 3] = Math.floor(Math.abs(v - 0.5) * 2 * 26);
    }
    g.putImageData(img, 0, 0);
    grainUrl = `url("${c.toDataURL('image/png')}")`;
  } catch {
    grainUrl = 'none';
  }
  return grainUrl;
}

export function injectStyles(doc: Document = document): void {
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = BASE_CSS + SCREENS_CSS + HUD_CSS + ART_CSS;
    doc.head.appendChild(style);
  }
}

/** Apply per-root CSS variables that need runtime generation. */
export function applyRootVars(root: HTMLElement): void {
  root.style.setProperty('--grain', makeGrain(root.ownerDocument));
}
