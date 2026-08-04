/**
 * KAR-00.5 — do the two native dependencies install and load with zero
 * compilation on the machines DeFlow ships to, and what does an fsync cost on
 * APFS?
 *
 * Both halves of A1-2 were verified on 2026-08-02 on **linux-x64 only**. The
 * darwin prebuilds were demonstrably inside the better-sqlite3 tarball and were
 * never executed, and the author's laptop is a Mac; every fsync-sensitive
 * number in docs/05-durable-execution.md was measured in a Linux container,
 * likely over overlayfs, on a kernel whose `fsync()` is not APFS's.
 *
 * Nothing here is mocked. Every install is a real `npm i` into a real empty
 * directory, run with a PATH that has been reduced to a sandbox `bin/` holding
 * symlinks to `node` and `npm` and nothing else — so "no compiler was used" is
 * a property of the environment rather than a property of the log. Every
 * SQLite statement runs against a file on disk. Every pty is a real pty whose
 * device path is read out of the child by running `tty` inside it. The three
 * Linux cells are real containers.
 *
 * The arithmetic over the benchmark's four numbers, and the guards that keep
 * the decision note quoting them, are test/spike-s5-fsync.test.ts.
 *
 * Verifies: EPIC-00-S17, EPIC-00-S18 (scenario 1), EPIC-00-S19 ·
 * AC1, AC2, AC3, AC5, AC6, AC7.
 */
import { beforeAll, expect, it, describe as suite } from 'vitest';
import {
  type BenchRow,
  compareShape,
  REQUIRED_CELLS,
  requireRow,
} from '../../spikes/s5-native/src/analysis.ts';
import {
  BETTER_SQLITE3_SPEC,
  committedBench,
  dockerAvailable,
  LYDELL_PTY_SPEC,
  type ProbeReport,
  runBench,
  runProbe,
  UPSTREAM_PTY_SPEC,
} from '../../spikes/s5-native/src/harness.ts';

/** The eight prebuilt N-API binaries the 13.0.2 tarball is claimed to ship. */
const EXPECTED_PREBUILDS = [
  'darwin-arm64.node',
  'darwin-x64.node',
  'linux-arm64.node',
  'linux-x64.node',
  'linuxmusl-arm64.node',
  'linuxmusl-x64.node',
  'win32-arm64.node',
  'win32-x64.node',
];

/** Anything in an npm log that means a compiler ran, or was about to. */
const COMPILATION_MARKERS = ['gyp', 'node-gyp', 'prebuild-install', 'make: ', 'cc1plus'];

let macNode24: ProbeReport;

beforeAll(async () => {
  macNode24 = await runProbe('macos-arm64-node24');
}, 300_000);

suite('EPIC-00-S17 — install with no compiler on PATH (AC1)', () => {
  it('really has no compiler to reach for', () => {
    expect(macNode24.environment.compilersOnPath).toEqual({
      cc: null,
      'c++': null,
      clang: null,
      'clang++': null,
      gcc: null,
      'g++': null,
      make: null,
      'node-gyp': null,
    });
  });

  it('installs better-sqlite3@13.0.2 in under five seconds', () => {
    const install = installOf(macNode24, BETTER_SQLITE3_SPEC);
    expect(install.ok, install.log).toBe(true);
    expect(install.durationMs).toBeLessThan(5_000);
  });

  it('leaves no gyp, no node-gyp and no prebuild-install anywhere in the log', () => {
    const install = installOf(macNode24, BETTER_SQLITE3_SPEC);
    for (const marker of COMPILATION_MARKERS) {
      expect(install.log.toLowerCase(), `install log mentions "${marker}"`).not.toContain(marker);
    }
    expect(install.compilationMarkers).toEqual([]);
  });

  it('never fetched a prebuild over the network from a postinstall script', () => {
    const install = installOf(macNode24, BETTER_SQLITE3_SPEC);
    expect(install.installScripts).toEqual([]);
    expect(install.gypfile).toBe(false);
  });

  it('ships all eight prebuilds in the tarball', () => {
    expect(installOf(macNode24, BETTER_SQLITE3_SPEC).prebuilds).toEqual(EXPECTED_PREBUILDS);
  });
});

suite('EPIC-00-S17 — the darwin-arm64 binary executes (AC2)', () => {
  it('opens a file-backed database and answers with the pinned SQLite', () => {
    expect(macNode24.sqlite?.loaded).toBe(true);
    expect(macNode24.sqlite?.version).toBe('3.53.4');
  });

  it('loaded the darwin-arm64 prebuild, not something it built', () => {
    expect(macNode24.sqlite?.binding).toMatch(/prebuilds\/darwin-arm64\.node$/);
  });

  it('exposes loadExtension on the instance', () => {
    expect(macNode24.sqlite?.loadExtension).toBe(true);
  });

  it('takes WAL, which is the mode the ledger runs in', () => {
    expect(macNode24.sqlite?.journalMode).toBe('wal');
  });
});

suite('EPIC-00-S17 — FTS5 is compiled in and the tokenizer holds (AC2)', () => {
  it('creates the table with the tokenizer D15 needs', () => {
    expect(macNode24.sqlite?.fts5.created).toBe(true);
    expect(macNode24.sqlite?.fts5.tokenizer).toBe("unicode61 remove_diacritics 2 tokenchars '_-.'");
  });

  it('keeps snake_case, kebab-case and file.ext as single tokens', () => {
    // Two of the four rows carry snake_case_name; one each carries the others.
    expect(macNode24.sqlite?.fts5.wholeTermMatches).toEqual({
      snake_case_name: 2,
      'kebab-case-name': 1,
      'file.ext': 1,
    });
  });

  it('and therefore does not match their fragments', () => {
    // If the tokenizer fragmented, "case" would be a token of its own in two of
    // the three rows — which is the recall collapse the tokenizer clause exists
    // to prevent, and it cannot be fixed after the table is created.
    expect(macNode24.sqlite?.fts5.fragmentMatches).toEqual({ case: 0, name: 0, ext: 0 });
  });

  it('ranks with bm25 rather than returning insertion order', () => {
    // Rows 1 and 4 both carry the term; row 4 carries it three times. Insertion
    // order would be [1, 4].
    expect(macNode24.sqlite?.fts5.bm25Order).toEqual([4, 1]);
    expect(macNode24.sqlite?.fts5.bm25Ranked).toBe(true);
  });
});

suite('EPIC-00-S18 — the APFS append benchmark (AC3)', () => {
  let rows: BenchRow[];

  beforeAll(async () => {
    rows = await runBench(10_000);
  }, 900_000);

  it('measured the four configurations the story asks for, 10,000 events each', () => {
    for (const synchronous of ['FULL', 'NORMAL'] as const) {
      for (const mode of ['single', 'batched'] as const) {
        const measurement = requireRow(rows, synchronous, mode, 0);
        expect(measurement.events).toBe(10_000);
        expect(measurement.eventsPerSecond).toBeGreaterThan(0);
      }
    }
  });

  it('measured the same four again with fullfsync on, since darwin defaults it off', () => {
    // Without this half, "FULL on APFS is fast" would be recorded as good news
    // rather than as the weaker guarantee it is: macOS fsync(2) does not flush
    // the drive cache, and SQLite reaches for F_FULLFSYNC only under the pragma.
    expect(rows).toHaveLength(8);
    expect(requireRow(rows, 'FULL', 'single', 1).eventsPerSecond).toBeLessThan(
      requireRow(rows, 'FULL', 'single', 0).eventsPerSecond,
    );
  });

  it('ran on a file-backed database in WAL mode on APFS', () => {
    for (const measurement of rows) expect(measurement.filesystem).toBe('apfs');
  });

  it('costs more per commit at FULL than at NORMAL, at both fullfsync settings', () => {
    for (const fullfsync of [0, 1] as const) {
      expect(requireRow(rows, 'FULL', 'single', fullfsync).eventsPerSecond).toBeLessThan(
        requireRow(rows, 'NORMAL', 'single', fullfsync).eventsPerSecond,
      );
    }
  });

  it('gains from batching at both settings', () => {
    const shape = compareShape(rows, 0);
    expect(shape.batchingGainFull).toBeGreaterThan(1);
    expect(shape.batchingGainNormal).toBeGreaterThan(1);
  });

  it('agrees with the committed run about which configurations exist', () => {
    // Not about the numbers: throughput on a laptop moves with what else the
    // laptop is doing. What must not drift is the set of configurations the
    // note is quoting.
    const key = (measurement: BenchRow): string =>
      `${measurement.synchronous}/${measurement.mode}/ff${measurement.fullfsync}`;
    expect(committedBench().map(key).sort()).toEqual(rows.map(key).sort());
  });
});

suite('EPIC-00-S19 — a pty is allocated and echoes, on macOS (AC5)', () => {
  it('installs @lydell/node-pty with zero compilation', () => {
    const install = installOf(macNode24, LYDELL_PTY_SPEC);
    expect(install.ok, install.log).toBe(true);
    expect(install.compilationMarkers).toEqual([]);
    expect(install.installScripts).toEqual([]);
  });

  it('resolves a per-platform binary package rather than building one', () => {
    expect(macNode24.pty?.platformPackage).toBe('@lydell/node-pty-darwin-arm64');
  });

  it('allocates a real terminal device', () => {
    expect(macNode24.pty?.allocated).toBe(true);
    // macOS has no /dev/pts: its slave devices are /dev/ttysNNN. The scenario
    // says "/dev/pts"; what it means is "a real kernel pty was allocated", and
    // the honest way to ask is to run `tty` inside it.
    expect(macNode24.pty?.device).toMatch(/^\/dev\/(ttys\d+|pts\/\d+)$/);
  });

  it('echoes what is written into it', () => {
    expect(macNode24.pty?.echoed).toBe(true);
  });
});

suite('EPIC-00-S19 — Node 26 on the same machine (AC5)', () => {
  let macNode26: ProbeReport;

  beforeAll(async () => {
    macNode26 = await runProbe('macos-arm64-node26');
  }, 300_000);

  it('is a Node 26 runtime', () => {
    expect(macNode26.environment.nodeVersion).toMatch(/^v26\./);
  });

  it('installs both natives with zero compilation', () => {
    for (const spec of [BETTER_SQLITE3_SPEC, LYDELL_PTY_SPEC]) {
      const install = installOf(macNode26, spec);
      expect(install.ok, install.log).toBe(true);
      expect(install.compilationMarkers).toEqual([]);
    }
  });

  it('loads the same SQLite and allocates a pty that echoes', () => {
    expect(macNode26.sqlite?.version).toBe('3.53.4');
    expect(macNode26.pty?.allocated).toBe(true);
    expect(macNode26.pty?.echoed).toBe(true);
  });
});

/**
 * The Linux half of the matrix, stated as expectations rather than as branches.
 *
 * Two of these three cells fail, and they fail for different reasons that
 * matter in different ways, so "assert whatever happened" would have recorded
 * nothing. Writing the outcomes down as data means a future version of either
 * dependency that fixes one of them turns this spec red, which is the only
 * mechanism that will make anyone revisit the note.
 */
const LINUX_EXPECTATIONS = {
  // node:24-slim is Debian bookworm, glibc 2.36. better-sqlite3@13.0.2's
  // linux-arm64 prebuild is linked against GLIBC_2.38 and will not load.
  'linux-glibc-node24': { glibc: '2.36', sqliteLoads: false, ptyAllocates: true },
  // node:26-slim is Debian trixie, glibc 2.41.
  'linux-glibc-node26': { glibc: '2.41', sqliteLoads: true, ptyAllocates: true },
  // Alpine. better-sqlite3 ships a linuxmusl prebuild; @lydell/node-pty does not.
  'linux-musl-node24': { glibc: null, sqliteLoads: true, ptyAllocates: false },
} as const;

suite.runIf(dockerAvailable())('EPIC-00-S19 — the three Linux cells (AC5, AC6)', () => {
  const linuxCells = REQUIRED_CELLS.filter((cell) => cell.runner === 'docker');
  const reports = new Map<string, ProbeReport>();
  const reportFor = (id: string): ProbeReport => {
    const report = reports.get(id);
    if (report === undefined) throw new Error(`cell ${id} never ran`);
    return report;
  };

  beforeAll(async () => {
    for (const cell of linuxCells) reports.set(cell.id, await runProbe(cell.id));
  }, 900_000);

  for (const cell of linuxCells) {
    const expected = LINUX_EXPECTATIONS[cell.id as keyof typeof LINUX_EXPECTATIONS];

    suite(cell.id, () => {
      it('runs the Node major the cell names, against the libc and glibc it names', () => {
        const report = reportFor(cell.id);
        expect(report.environment.nodeVersion).toMatch(new RegExp(`^v${cell.nodeMajor}\\.`));
        expect(report.environment.libc).toBe(cell.libc);
        expect(report.environment.glibcVersion).toBe(expected.glibc);
      });

      it('has no compiler in the image', () => {
        const compilers = reportFor(cell.id).environment.compilersOnPath;
        expect(Object.values(compilers).filter((found) => found !== null)).toEqual([]);
      });

      it('installs both natives with zero compilation', () => {
        for (const spec of [BETTER_SQLITE3_SPEC, LYDELL_PTY_SPEC]) {
          const install = installOf(reportFor(cell.id), spec);
          expect(install.ok, install.log).toBe(true);
          expect(install.compilationMarkers).toEqual([]);
        }
      });

      it(
        expected.sqliteLoads
          ? 'loads the prebuild and answers with the pinned SQLite'
          : 'installs the prebuild and then refuses to load it, naming the glibc it wanted',
        () => {
          const sqlite = reportFor(cell.id).sqlite;
          expect(sqlite?.loaded).toBe(expected.sqliteLoads);
          if (expected.sqliteLoads) {
            expect(sqlite?.version).toBe('3.53.4');
            expect(sqlite?.binding).toMatch(
              cell.libc === 'musl' ? /linuxmusl-arm64\.node$/ : /linux-arm64\.node$/,
            );
          } else {
            expect(sqlite?.failure).toContain('GLIBC_2.38');
          }
        },
      );

      it(
        expected.ptyAllocates
          ? 'allocates a /dev/pts device that echoes'
          : 'cannot link the pty binary here, and the linker says so',
        () => {
          const pty = reportFor(cell.id).pty;
          expect(pty?.allocated).toBe(expected.ptyAllocates);
          if (expected.ptyAllocates) {
            expect(pty?.device).toMatch(/^\/dev\/pts\/\d+$/);
            expect(pty?.echoed).toBe(true);
          } else {
            // The package's own loader calls this "Cannot find module", which
            // is misleading: the file is present and is glibc-linked.
            expect(pty?.platformPackage).toBe('@lydell/node-pty-linux-arm64');
            expect(pty?.dlopenFailure).toContain('ld-linux-aarch64.so.1');
          }
        },
      );

      it('is where upstream node-pty reaches its node-gyp fallback (AC7)', () => {
        const upstream = reportFor(cell.id).upstreamPty;
        expect(upstream?.prebuildForThisPlatform).toBe(false);
        expect(upstream?.nodeGypRan).toBe(true);
        expect(upstream?.ok).toBe(false);
      });
    });
  }
});

suite.runIf(dockerAvailable())('EPIC-00-S19 — the control that isolates glibc (AC6)', () => {
  let trixie: ProbeReport;

  beforeAll(async () => {
    trixie = await runProbe('linux-glibc-trixie-node24');
  }, 300_000);

  it('is Node 24 on the same glibc node:26-slim carries', () => {
    expect(trixie.environment.nodeVersion).toMatch(/^v24\./);
    expect(trixie.environment.glibcVersion).toBe('2.41');
  });

  it('loads the same prebuild that failed on bookworm, so the variable is glibc', () => {
    // Without this cell the matrix would read "Node 24 fails on Linux", which
    // is the wrong prerequisite to write into the note and the wrong thing to
    // ask a user to change.
    expect(trixie.sqlite?.loaded).toBe(true);
    expect(trixie.sqlite?.version).toBe('3.53.4');
    expect(trixie.pty?.allocated).toBe(true);
  });
});

suite('EPIC-00-S19 — upstream node-pty carries the compile fallback (AC7)', () => {
  it('is the version the story names', () => {
    expect(UPSTREAM_PTY_SPEC).toBe('node-pty@1.1.0');
  });

  it('declares an install script whose "||" hands over to node-gyp', () => {
    expect(macNode24.upstreamPty?.installScript).toBe(
      'node scripts/prebuild.js || node-gyp rebuild',
    );
    expect(macNode24.upstreamPty?.installScripts).toEqual(['install', 'postinstall']);
  });

  it('ships prebuilts for darwin and win32 and for no Linux at all', () => {
    // This is why the story's "fails outright in a toolchain-less environment"
    // is a claim about Linux, not about the author's laptop: on darwin-arm64
    // scripts/prebuild.js finds a binary and the "||" never fires. The Linux
    // cells below are where the fallback is actually reached.
    expect(macNode24.upstreamPty?.prebuilds).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'win32-arm64',
      'win32-x64',
    ]);
  });

  it('and therefore installs on darwin without ever running node-gyp', () => {
    expect(macNode24.upstreamPty?.prebuildForThisPlatform).toBe(true);
    expect(macNode24.upstreamPty?.nodeGypRan).toBe(false);
  });
});

function installOf(report: ProbeReport, spec: string) {
  const install = report.installs.find((candidate) => candidate.spec === spec);
  if (install === undefined) throw new Error(`no install of ${spec} in ${report.cell}`);
  return install;
}
