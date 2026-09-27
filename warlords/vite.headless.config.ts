// `npm run build:headless`: the server-run room (src/headless/worker.ts) as ONE
// self-contained ES module for Node — dist-headless/room-worker.mjs — that
// server/server.mjs starts as a worker_thread per room. Everything is bundled
// (the sim, the data, the net layer); only Node builtins stay imports.
// `npm run build` (the web game / desktop app) does not use this file.
import { defineConfig } from 'vite';

export default defineConfig({
  // nothing from public/ belongs next to the worker
  publicDir: false,
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
