// Optional AI-generated art shipped in public/assets (Higgsfield output, see
// assets-src/manifest.json + scripts/fetch-assets.mjs): hero/troop GLBs, shared
// animation clips, portraits, key art, sky and tiling textures.
//
// Everything that uses it must keep working without it — the single-file build
// (file://, no side files) and any deploy that dropped the folder fall back to the
// procedural look. Availability comes from ONE list of files, never per-file probes
// (no 404 noise in the console):
//   dev server   import.meta.glob over public/assets (no requests at all)
//   builds       assets/art-index.json, written by vite.config.ts, fetched once
// Paths are relative to the site root ('assets/portraits/liubei.webp') and are used
// as relative URLs, which works under any base (GitHub Pages /warlords/, the relay
// server, the desktop app's embedded server).

/** Dev only: files present in public/assets at transform time (never bundled into builds). */
const DEV_FILES: string[] = import.meta.env.DEV
  ? Object.keys(import.meta.glob('../../public/assets/**/*.{glb,webp,png,jpg,json}', { query: '?url', import: 'default' })).map((p) =>
      p.replace(/^.*?public\//, ''),
    )
  : [];

export const ART_INDEX_PATH = 'assets/art-index.json';

let listing: Promise<ReadonlySet<string>> | null = null;
let known: ReadonlySet<string> | null = null;
let override: Set<string> | null = null;

function canFetchSideFiles(): boolean {
  return typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && typeof fetch === 'function';
}

async function loadListing(): Promise<ReadonlySet<string>> {
  if (override) return override;
  if (import.meta.env.DEV) return new Set(DEV_FILES);
  if (!canFetchSideFiles()) return new Set();
  try {
    const r = await fetch(ART_INDEX_PATH, { cache: 'no-cache' });
    // SPA-style hosts answer unknown paths with index.html (200 text/html)
    if (!r.ok || /text\/html/i.test(r.headers.get('content-type') ?? '')) return new Set();
    const j = (await r.json()) as { files?: unknown };
    return new Set(Array.isArray(j.files) ? j.files.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Every art file this deploy ships (empty when none). Fetched once per page; start it early. */
export function assetList(): Promise<ReadonlySet<string>> {
  if (!listing) {
    listing = loadListing().then((s) => {
      known = s;
      return s;
    });
  }
  return listing;
}

/** The listing if it has already loaded, else null (for synchronous callers such as CSS backgrounds). */
export function assetListSync(): ReadonlySet<string> | null {
  return known;
}

/** True when the deploy ships this file ('assets/…'). */
export async function hasAsset(path: string): Promise<boolean> {
  return (await assetList()).has(path);
}

/** URL for a shipped file, or null when it is absent. */
export async function assetUrl(path: string): Promise<string | null> {
  return (await hasAsset(path)) ? path : null;
}

/** Synchronous variant: the URL when the listing is loaded and has the file, else null. */
export function assetUrlSync(path: string): string | null {
  return known && known.has(path) ? path : null;
}

/** Tests / tools: replace the listing (null restores the real one). */
export function setAssetListForTests(files: readonly string[] | null): void {
  override = files ? new Set(files) : null;
  listing = null;
  known = null;
}
