import { defineConfig } from 'vitest/config';

// vitest.workspace.ts and defineWorkspace were REMOVED in Vitest 4. Any tutorial
// showing them is pre-3.2 and will not run — and the failure is not a clean
// error: the config is simply ignored, and you get a plausible-looking run over
// the wrong set of files. A single root config with test.projects is the only
// supported shape (docs/14-testing-strategy.md §2).
export default defineConfig({
  test: {
    // Registers the normalising snapshot serializer, before any snapshot in the
    // run is written or read. Nothing else belongs in it.
    setupFiles: ['./test/setup.ts'],

    projects: [
      {
        extends: true,
        test: {
          // Pure logic: reducers, projections, patch application, packet
          // rendering, permission policy, path scoping. Default timeout, run on
          // every save.
          //
          // `pool` is stated rather than left to the default on purpose:
          // Vitest 4 changed the default pool to 'forks', so the threads this
          // slice wants — nothing here spawns a child, and threads are what
          // keep it at about a second — are no longer what you get by omission.
          name: 'unit',
          environment: 'node',
          pool: 'threads',
          include: ['packages/*/src/**/*.test.ts', 'packages/*/test/*.test.ts', 'test/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          // Real tmpdirs, real git, real file-backed SQLite, fake agent
          // binaries on PATH. pool: 'forks' is not a preference — worker
          // threads share a process, so one spec that leaks a child process or
          // an fd poisons its neighbours in ways that are miserable to
          // diagnose.
          name: 'integration',
          environment: 'node',
          include: ['packages/*/test/integration/**/*.test.ts', 'test/integration/**/*.test.ts'],
          testTimeout: 30_000,
          pool: 'forks',
        },
      },
      {
        extends: true,
        test: {
          // A real DeFlowd on an ephemeral port, cross-process. Serialised on
          // top of forks because these specs
          // bind ports and mutate a shared data directory,
          // so running two files at once is a race by construction.
          //
          // A nested poolOptions.forks.singleFork is how that used to be
          // spelled, and it is the second removed-in-Vitest-4 API this file has
          // to route around: poolOptions is gone and its contents are top-level
          // options now. It does not fail — it warns and is ignored,
          // and the specs go back to running in parallel. fileParallelism:
          // false plus maxWorkers: 1 is the same guarantee, spelled for 4.
          name: 'e2e',
          environment: 'node',
          include: ['e2e/**/*.test.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
        },
      },

      {
        extends: true,
        test: {
          // KAR-03.8's crash-fuzz suite: SIGKILL a real scripted run mid-flight,
          // restart it over the same .DeFlow/ directory, and assert that no
          // effect ran twice, that the ledger reduces to the pre-crash
          // projection, that integrity_check is ok and that the run never
          // wedges.
          //
          // Its own slice rather than more integration specs because it wants
          // things the integration slice must not have: many randomised
          // repetitions, minutes rather than seconds, and DeFlow_KEEP_TMP=1 in
          // CI so a failing ledger can be uploaded and opened. Serialised for
          // the same reason e2e is — every iteration owns a data directory and
          // a process group, and two at once is a race by construction.
          name: 'crash-fuzz',
          environment: 'node',
          include: ['packages/*/test/crash-fuzz/**/*.test.ts'],
          testTimeout: 300_000,
          hookTimeout: 300_000,
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
        },
      },

      // Vue components in a real Chromium. It lives in its own file because
      // browser mode brings its own plugin stack; docs/14-testing-strategy.md
      // §13 records why jsdom and happy-dom cannot serve the visualization
      // surface — they return 0 from getBBox(), stub getContext('2d') and
      // report zero element sizes, so they lie rather than fail.
      'packages/web/vitest.config.ts',
    ],
  },
});
