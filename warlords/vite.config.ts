import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

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

// `vite build --mode single` produces one self-contained HTML file (double-click to play).
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [viteSingleFile(), inlineFavicon()] : [],
  // the single-file build is exactly one file: nothing from public/ is copied next to it
  publicDir: mode === 'single' ? false : 'public',
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
  },
  server: { port: 5173 },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
}));
