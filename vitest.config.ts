import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Some tests start real child processes (tsx, git), which take a moment each.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
      reporter: ['text', 'text-summary', 'json-summary'],
      // Floor just under the measured baseline (94.9 / 81.6 / 100 / 95.9): a regression guard.
      thresholds: { statements: 90, branches: 75, functions: 95, lines: 90 },
    },
  },
});
