// Playwright config for the Mac check (.github/workflows/warlords-mac.yml, a
// macos-14 Apple-silicon runner): tests/e2e/mac-smoke.spec.ts in the two engines
// Mac players use — WebKit (Safari's engine) and Chromium (Chrome on macOS) — with
// the machine's real GPU (no SwiftShader flags). Browsers come from
// `npx playwright install --with-deps webkit chromium` on the runner.
// The spec serves the production build with `vite preview`; SGWL_E2E_CACHE=.
// makes that the `npm run build` output in dist/ (otherwise it builds its own).
import { defineConfig, devices } from '@playwright/test';

const headless = process.env.SGWL_MAC_HEADED !== '1';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /mac-smoke\.spec\.ts$/,
  outputDir: 'test-results-mac',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-mac' }]],
  use: {
    viewport: { width: 1280, height: 720 },
    actionTimeout: 60_000,
    navigationTimeout: 120_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    headless,
  },
  projects: [
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 } },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        // the full Chromium build (new headless), which draws with the GPU like Chrome does;
        // no extra switches: the audio must unlock on a click and the GPU be found as in Chrome
        channel: 'chromium',
      },
    },
  ],
});
