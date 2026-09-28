// `npm run build:headless`: the server-run room (src/headless/worker.ts) as ONE
// self-contained ES module for Node — dist-headless/room-worker.mjs — that
// server/server.mjs starts as a worker_thread per room. Everything is bundled
// (the sim, the data, the net layer); only Node builtins stay imports.
// `npm run build` (the web game / desktop app) does not use this file.
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
// @ts-expect-error — a plain .mjs helper (no types)
import { compatId } from './scripts/compat-id.mjs';

const COMPAT: string = compatId();

/** dist-headless/build.json {compat}: POST /api/rooms answers 409 to a page of another build (rooms.mjs). */
function buildInfo(): Plugin {
  let outDir = 'dist-headless';
  return {
    name: 'sgwl-headless-build-info',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'build.json'), `${JSON.stringify({ compat: COMPAT })}\n`);
    },
  };
}

export default defineConfig({
  // nothing from public/ belongs next to the worker
  publicDir: false,
  // the same game-compatibility id as the web build of this tree (src/net/compat.ts)
  define: { __SGWL_COMPAT__: JSON.stringify(COMPAT) },
  plugins: [buildInfo()],
  ssr: {
    // bundle every dependency: the server has no node_modules for the worker
    noExternal: true,
    target: 'node',
  },
  build: {
    ssr: 'src/headless/worker.ts',
    outDir: 'dist-headless',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    copyPublicDir: false,
    reportCompressedSize: false,
    rolldownOptions: {
      output: {
        format: 'es',
        entryFileNames: 'room-worker.mjs',
        // one file: the lazily imported sim (hostSession's import('../sim/world')) is inlined
        // (rolldown's spelling of inlineDynamicImports: true)
        codeSplitting: false,
      },
    },
  },
});
