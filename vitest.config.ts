import { configDefaults, defineConfig } from 'vitest/config';

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
          // `@DeFlow/web`'s specs live under `src/` like everybody else's and
          // are almost entirely the one set this slice must not take: they
          // mount Vue components and need a real Chromium, which the `web`
          // project below gives them. Without this they are collected here too,
          // where `document` does not exist — and the failure reads as a broken
          // component rather than as the wrong runner.
          //
          // `src/ledger/projections/**` is the deliberate exception (KAR-16.3
          // AC2). Those are plain reducers over the `Event` union with no Vue,
          // no DOM and no mount, and running them *here* rather than in a
          // browser is the whole point of the purity rule: the largest block of
          // frontend tests costs milliseconds instead of a page load. The
          // patterns are depth-explicit rather than one `packages/web/**` with
          // a carve-out, because `**` would happily swallow the `projections`
          // segment and silently take the specs back. `test/web-suite-split.test.ts`
          // is what stops a new web spec falling between the two projects.
          exclude: [
            ...configDefaults.exclude,
            'packages/web/test/**/*.test.ts',
            'packages/web/src/*.test.ts',
            'packages/web/src/*/*.test.ts',
            'packages/web/src/!(ledger)/**/*.test.ts',
            'packages/web/src/ledger/!(projections)/**/*.test.ts',
          ],
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
          // The smoke slice below owns `e2e/smoke/`. Without this exclusion it
          // would be collected here *as well*, and the one thing KAR-19.5 AC5
          // buys — a serialised slice with a stated budget — would be running
          // twice, once under a 180 s timeout that asserts nothing about cold
          // start.
          exclude: [...configDefaults.exclude, 'e2e/smoke/**'],
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

      {
        extends: true,
        test: {
          // KAR-19.5 — the live smoke slice: the built binary, a daemon in its
          // own process, a real ledger on disk, and `deflow-mock-agent` as the
          // only provider. One scenario, plus the sabotage table that proves it
          // can go red.
          //
          // Its own project rather than more e2e specs because it wants two
          // things that slice must not have: a timeout that *is* the budget
          // (KAR-19.5 AC6 — 90 s, so a regression in cold start is a red test
          // rather than a slow afternoon), and a guarantee that it runs in
          // `pnpm test` without a flag. A smoke test behind a flag reproduces
          // the exact gap this epic exists to close.
          //
          // Serialised for the same reason e2e is: it binds a port and owns a
          // data directory, so two files at once is a race by construction.
          name: 'smoke',
          environment: 'node',
          include: ['e2e/smoke/**/*.test.ts'],
          testTimeout: 90_000,
          hookTimeout: 90_000,
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
