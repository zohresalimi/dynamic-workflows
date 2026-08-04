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
    ],
  },
});
