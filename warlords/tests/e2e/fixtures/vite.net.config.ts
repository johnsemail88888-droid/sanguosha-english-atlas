// Vite dev server for the NET e2e fixture page (port 5182). peerjs is
// pre-bundled up front so the lazy import in peerTransport never triggers a
// dependency re-optimization reload in the middle of a test, and file watching
// is off so edits elsewhere in the tree cannot reload the page mid-test.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export default defineConfig({
  root,
  logLevel: 'error',
  clearScreen: false,
  // other engineers edit src/ while tests run: no watcher / HMR full-reloads mid-test
  server: { port: 5182, strictPort: true, host: '127.0.0.1', hmr: false, watch: null },
  optimizeDeps: {
    entries: ['tests/e2e/fixtures/net.html'],
    include: ['peerjs'],
  },
});
