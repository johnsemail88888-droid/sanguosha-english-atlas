// Playwright global setup: one production build of the game (multi-file dist +
// the single-file offline HTML) shared by every tests/e2e/game*.spec.ts.
// Built into node_modules/.cache/sgwl-e2e/ so it never races other people's
// `npm run build` output in dist/. SGWL_E2E_SKIP_BUILD=1 reuses the last build.
import { buildGame } from './game-fixture';

export default async function globalSetup(): Promise<void> {
  if (process.env.SGWL_E2E_SKIP_BUILD === '1') return;
  const t0 = Date.now();
  buildGame('dist');
  buildGame('single');
  console.log(`[e2e] production builds ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
