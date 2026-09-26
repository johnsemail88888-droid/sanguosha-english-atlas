import { defineConfig } from 'vitest/config';

// Wall-clock benchmarks: run alone and one file at a time (see tests/perf).
export default defineConfig({
  test: {
    include: ['tests/perf/**/*.perf.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 180_000,
  },
});
