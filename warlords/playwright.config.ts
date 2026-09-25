// Playwright config for `npm run e2e` (every spec in tests/e2e/).
//
// Headless Chromium lives at /opt/pw-browsers/chromium (Playwright 1.56.1 is
// pinned to match); WebGL runs on SwiftShader, which is slow — timeouts are
// generous and specs run one at a time. Each spec starts (and stops) its own
// servers on its own ports:
//   render 5181 · net 5182 + relay 8791 · ui 5183 · audio 5184
//   game*  5186–5189 (vite preview of a production build) + relay 8792
// The game specs share one production build made by the global setup
// (tests/e2e/fixtures/global-setup.ts → node_modules/.cache/sgwl-e2e/);
// SGWL_E2E_SKIP_BUILD=1 reuses the previous build.
import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './tests/e2e/fixtures/global-setup.ts',
  outputDir: 'test-results',
  // one browser at a time: software WebGL saturates the CPU
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    viewport: { width: 1280, height: 720 },
    actionTimeout: 60_000,
    navigationTimeout: 120_000,
    screenshot: 'only-on-failure',
    trace: 'off',
    launchOptions: {
      ...(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {}),
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
    },
  },
});
