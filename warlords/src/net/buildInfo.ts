// dist/sgwl-build.json: what the desktop app's main process knows of the page it bundles —
// the page's game-compatibility id (src/net/compat.ts) and the official server this build
// talks to (src/net/official.ts officialFrom, with the build's VITE_OFFICIAL_* overrides: the
// very value the page gets). Written by the vite config (multi-file builds only; the single-file
// build is one file) and read by electron/page.cjs, which asks that server which build it runs
// before the window loads and shows the page whose build matches. A build made with
// VITE_OFFICIAL_WEB='' / VITE_OFFICIAL_RELAY='' (tests, CI) names no official page: the app
// built from it never loads a remote page.
// Build-time only (no imports: the vite config loads it as is); the page never imports it.

/** The file's name in dist/ (electron/page.cjs BUILD_FILE). */
export const BUILD_INFO_FILE = 'sgwl-build.json';

export interface BuildInfo {
  /** the bundled page's game-compatibility id */
  compat: string;
  /** the commit it was built from, when the build knows it (CI: GITHUB_SHA) */
  sha: string | null;
  /** the official server of this build ('' = none: the app never loads a remote page) */
  official: { web: string; relay: string };
}

/**
 * This build's info. `official`: officialFrom(OFFICIAL_SERVER, the build's env) — null when the
 * build has none. `sha`: the commit, if known.
 */
export function buildInfo(compat: string, official: { web: string; relay: string } | null, sha?: string | null): BuildInfo {
  return { compat, sha: sha || null, official: { web: official?.relay ? official.web : '', relay: official?.relay ?? '' } };
}
