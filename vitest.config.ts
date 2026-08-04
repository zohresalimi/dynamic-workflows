import { defineConfig } from 'vitest/config';

// vitest.workspace.ts and defineWorkspace were REMOVED in Vitest 4. A single
// root config with test.projects is the only supported shape.
// KAR-01.4 adds the e2e and web (browser-mode) slices and the shared setup file.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'packages/*/test/*.test.ts',
            'test/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: [
            'packages/*/test/integration/**/*.test.ts',
            'test/integration/**/*.test.ts',
          ],
          testTimeout: 30_000,
          pool: 'forks',
        },
      },
      {
        extends: true,
        test: {
          // KAR-01.3 needs a slice that can boot the real `pnpm dev` script.
          // KAR-01.4 owns the finished shape of this project (browser mode,
          // shared fixtures); this is the minimum it needs to exist as.
          name: 'e2e',
          environment: 'node',
          include: ['e2e/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          pool: 'forks',
          fileParallelism: false,
        },
      },
    ],
  },
});
