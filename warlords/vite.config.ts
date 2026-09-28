import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
// @ts-expect-error — a plain .mjs helper (no types)
import { compatId } from './scripts/compat-id.mjs';
import { BUILD_INFO_FILE, buildInfo } from './src/net/buildInfo.ts';
import { OFFICIAL_SERVER, officialFrom } from './src/net/official.ts';

/**
 * `--mode single`: the page icon lives in public/ (not processed by Vite), so
 * inline it as a data: URL — the offline HTML is copied around on its own.
 */
function inlineFavicon(): Plugin {
  return {
    name: 'sgwl-inline-favicon',
    apply: 'build',
    transformIndexHtml(html) {
      const png = readFileSync(fileURLToPath(new URL('./public/favicon.png', import.meta.url)));
      const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
      return html.replace(/href="\.?\/favicon\.png"/g, `href="${dataUrl}"`);
    },
  };
}

/**
 * Multi-file builds: `assets/art-index.json` lists every optional art file in
 * public/assets (AI-generated models, clips, portraits, textures) so the game
 * fetches one listing instead of probing each file (src/game/assets.ts).
 */
function artIndex(): Plugin {
  return {
    name: 'sgwl-art-index',
    apply: 'build',
    generateBundle() {
      const pub = fileURLToPath(new URL('./public/', import.meta.url));
      const files: string[] = [];
      const walk = (dir: string): void => {
        let names: string[] = [];
        try {
          names = readdirSync(dir);
        } catch {
          return;
        }
        for (const n of names) {
          const full = join(dir, n);
          if (statSync(full).isDirectory()) walk(full);
          else if (/\.(glb|webp|png|jpg|json)$/i.test(n)) files.push(relative(pub, full).split(sep).join('/'));
        }
      };
      walk(join(pub, 'assets'));
      files.sort();
      this.emitFile({ type: 'asset', fileName: 'assets/art-index.json', source: `${JSON.stringify({ files })}\n` });
    },
  };
}

/**
 * Multi-file builds: `sgwl-build.json` — this build's game-compatibility id and official server
 * (src/net/buildInfo.ts), for the desktop app: it shows the page whose build matches the official
 * server's (electron/page.cjs). The official server comes from the same env the page gets
 * (VITE_OFFICIAL_* — .env files, then the environment): a build without one names none, and the
 * app built from it never loads a remote page.
 */
function buildInfoFile(mode: string): Plugin {
  return {
    name: 'sgwl-build-info',
    apply: 'build',
    generateBundle() {
      // (what import.meta.env holds in the page → the page's own officialServer())
      const official = officialFrom(OFFICIAL_SERVER, loadEnv(mode, process.cwd(), 'VITE_'));
      const info = buildInfo(COMPAT, official, process.env.SGWL_GIT_SHA || process.env.GITHUB_SHA);
      this.emitFile({ type: 'asset', fileName: BUILD_INFO_FILE, source: `${JSON.stringify(info)}\n` });
    },
  };
}

/** The game-compatibility id a server-run room checks (scripts/compat-id.mjs, src/net/compat.ts). */
const COMPAT: string = compatId();

// `vite build --mode single` produces one self-contained HTML file (double-click to play).
export default defineConfig(({ mode }) => ({
  base: './',
  define: { __SGWL_COMPAT__: JSON.stringify(COMPAT) },
  plugins: mode === 'single' ? [viteSingleFile(), inlineFavicon()] : [artIndex(), buildInfoFile(mode)],
  // the single-file build is exactly one file: nothing from public/ is copied next to it
  publicDir: mode === 'single' ? false : 'public',
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
  },
  server: { port: 5173 },
  // dev: the AI-art loaders are imported lazily; pre-bundle them so the first
  // load does not answer 504 "Outdated Optimize Dep" and reload the page
  optimizeDeps: {
    include: [
      'three/addons/loaders/GLTFLoader.js',
      'three/addons/libs/meshopt_decoder.module.js',
      'three/addons/libs/meshopt_simplifier.module.js',
      'three/addons/utils/SkeletonUtils.js',
    ],
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // the shipped build talks to the owner's Mac mini (src/net/official.ts); tests never do
    env: { VITE_OFFICIAL_RELAY: '', VITE_OFFICIAL_WEB: '' },
  },
}));
