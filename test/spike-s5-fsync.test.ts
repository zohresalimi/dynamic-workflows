/**
 * KAR-00.5 — the arithmetic that turns four measurements into a `synchronous=`
 * decision, and the guards that keep the decision note honest about them.
 *
 * The measuring itself is real work with real fsyncs and lives in
 * test/integration/spike-s5-native.test.ts. What is here is the part that has
 * no business being a subprocess: reading the CSV the benchmark wrote, dividing
 * the four numbers into the two ratios the Linux baseline is expressed in
 * (FULL is 20–25x more expensive per commit; batching gives ~7x), and checking
 * that the note published to the rest of the project contains the numbers that
 * were actually measured rather than the ones the architecture assumed.
 *
 * Verifies: EPIC-00-S18 (scenario 2) · AC3, AC4, AC7.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  type BenchRow,
  CSV_HEADER,
  compareShape,
  compareShapeRounds,
  formatBenchCsv,
  LINUX_BASELINE,
  median,
  parseBenchCsv,
  REQUIRED_CELLS,
  requireRow,
  unfinishedCells,
} from '../spikes/s5-native/src/analysis.ts';
import { allManifests, readText, readWorkspaceYaml } from './support/workspace.ts';

const NOTE_PATH = 'docs/spikes/S5-native-prebuilds.md';
const CSV_PATH = 'spikes/s5-native/measurements/append-throughput.csv';
const MATRIX_PATH = 'spikes/s5-native/measurements/pty-matrix.json';

const row = (
  synchronous: 'FULL' | 'NORMAL',
  mode: 'single' | 'batched',
  eventsPerSecond: number,
  fullfsync: 0 | 1 = 0,
): BenchRow => ({
  machine: 'test',
  filesystem: 'apfs',
  synchronous,
  fullfsync,
  mode,
  batchSize: mode === 'batched' ? 100 : 1,
  events: 10_000,
  elapsedMs: Math.round((10_000 / eventsPerSecond) * 1000),
  eventsPerSecond,
});

suite('the CSV is a round-trippable record, not a printout (AC3)', () => {
  it('writes a header naming every column it emits', () => {
    const text = formatBenchCsv([row('FULL', 'single', 100)]);
    expect(text.split('\n')[0]).toBe(CSV_HEADER);
  });

  it('parses back to the rows it was given', () => {
    const rows = [
      row('FULL', 'single', 137.4),
      row('FULL', 'batched', 951.2),
      row('NORMAL', 'single', 3120.5),
      row('NORMAL', 'batched', 24_811.9),
      row('FULL', 'single', 12.3, 1),
    ];
    expect(parseBenchCsv(formatBenchCsv(rows))).toEqual(rows);
  });

  it('refuses a row for a configuration that was never measured', () => {
    const rows = [row('FULL', 'single', 100)];
    expect(() => requireRow(rows, 'NORMAL', 'batched')).toThrow(/NORMAL.*batched/);
  });

  it('keeps the two fullfsync settings apart', () => {
    const rows = [row('FULL', 'single', 26_000, 0), row('FULL', 'single', 357, 1)];
    expect(requireRow(rows, 'FULL', 'single', 0).eventsPerSecond).toBe(26_000);
    expect(requireRow(rows, 'FULL', 'single', 1).eventsPerSecond).toBe(357);
  });
});

suite('the four numbers become the two baseline ratios (AC3, EPIC-00-S18)', () => {
  const rows = [
    row('FULL', 'single', 1000),
    row('FULL', 'batched', 7000),
    row('NORMAL', 'single', 22_000),
    row('NORMAL', 'batched', 44_000),
  ];

  it('prices FULL against NORMAL on the per-commit path', () => {
    expect(compareShape(rows).fullPenalty).toBe(22);
  });

  it('prices batching separately at each durability setting', () => {
    const shape = compareShape(rows);
    expect(shape.batchingGainFull).toBe(7);
    expect(shape.batchingGainNormal).toBe(2);
  });

  it('says whether the Linux shape held, rather than assuming it did', () => {
    const shape = compareShape(rows);
    expect(shape.fullPenaltyMatchesLinux).toBe(true);
    expect(shape.batchingGainMatchesLinux).toBe(true);
  });

  it('reports a shape that did not hold as not holding', () => {
    const shape = compareShape([
      row('FULL', 'single', 100),
      row('FULL', 'batched', 150),
      row('NORMAL', 'single', 22_000),
      row('NORMAL', 'batched', 44_000),
    ]);
    expect(shape.fullPenalty).toBe(220);
    expect(shape.fullPenaltyMatchesLinux).toBe(false);
    expect(shape.batchingGainMatchesLinux).toBe(false);
  });

  it('carries the Linux baseline it is comparing against', () => {
    expect(LINUX_BASELINE.fullSingle).toBe(979);
    expect(LINUX_BASELINE.normalSingle).toBe(22_982);
  });
});

suite('a shape is decided by a vote of rounds, not by one measurement (AC3)', () => {
  const quartet = (
    fullSingle: number,
    fullBatched: number,
    normalSingle: number,
    normalBatched: number,
  ): BenchRow[] => [
    row('FULL', 'single', fullSingle),
    row('FULL', 'batched', fullBatched),
    row('NORMAL', 'single', normalSingle),
    row('NORMAL', 'batched', normalBatched),
  ];

  /** A round where the machine behaved, five times over. */
  const honest = (): BenchRow[][] =>
    Array.from({ length: 5 }, () => quartet(1000, 7000, 22_000, 44_000));

  it('reports the median of the per-round ratios, not the ratio of the totals', () => {
    const shape = compareShapeRounds(honest());
    expect(shape.rounds).toBe(5);
    expect(shape.fullPenalty).toBe(22);
    expect(shape.batchingGainFull).toBe(7);
    expect(shape.batchingGainNormal).toBe(2);
  });

  it('outvotes the one round the scheduler ruined', () => {
    // The observed flake, reproduced as data: one round in which the batched
    // NORMAL measurement was descheduled hard enough to report batching as a
    // loss. Four honest rounds outvote it, where a mean would be dragged down
    // by it and a single measurement would simply be it.
    const rounds = honest();
    rounds[2] = quartet(1000, 7000, 22_000, 18_000);
    const shape = compareShapeRounds(rounds);
    expect(
      shape.perRound[2]?.batchingGainNormal,
      'the bad round is still in the record',
    ).toBeLessThan(1);
    expect(shape.batchingGainNormal).toBe(2);
  });

  it('still fails when the shape really did not hold, in most rounds', () => {
    // Three of five rounds say batching lost. That is not a spike, and the
    // median must not launder it.
    const rounds = honest();
    for (const index of [0, 1, 2]) rounds[index] = quartet(1000, 7000, 22_000, 18_000);
    expect(compareShapeRounds(rounds).batchingGainNormal).toBeLessThan(1);
  });

  it('refuses to answer when nothing was sampled', () => {
    expect(() => compareShapeRounds([])).toThrow(/no rounds/);
  });

  it('takes the middle of an even count rather than the larger half', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(() => median([])).toThrow(/no samples/);
  });
});

suite('an unanswered matrix cell is an outcome, never an omission (AC6)', () => {
  it('names the five cells the story requires', () => {
    expect(REQUIRED_CELLS.map((cell) => cell.id)).toEqual([
      'macos-arm64-node24',
      'macos-arm64-node26',
      'linux-glibc-node24',
      'linux-glibc-node26',
      'linux-musl-node24',
    ]);
  });

  it('reports a cell with no recorded outcome as unfinished', () => {
    expect(unfinishedCells([]).map((cell) => cell.id)).toEqual(
      REQUIRED_CELLS.map((cell) => cell.id),
    );
  });

  it('accepts a cell that failed, as long as it carries a recorded fallback', () => {
    const outcomes = REQUIRED_CELLS.map((cell) => ({
      id: cell.id,
      status: cell.id === 'linux-musl-node24' ? ('fail' as const) : ('pass' as const),
      fallback: cell.id === 'linux-musl-node24' ? 'no-TTY: terminal/* not advertised' : null,
    }));
    expect(unfinishedCells(outcomes)).toEqual([]);
  });

  it('rejects a failed cell whose fallback was left blank', () => {
    const outcomes = REQUIRED_CELLS.map((cell) => ({
      id: cell.id,
      status: cell.id === 'linux-musl-node24' ? ('fail' as const) : ('pass' as const),
      fallback: null,
    }));
    expect(unfinishedCells(outcomes).map((cell) => cell.id)).toEqual(['linux-musl-node24']);
  });
});

suite('the decision note carries the measured numbers (AC3, AC4)', () => {
  const note = (): string => readText(NOTE_PATH);
  const rows = (): BenchRow[] => parseBenchCsv(readText(CSV_PATH));

  it('measured all four configurations, at both fullfsync settings', () => {
    const measured = rows().map(
      (measurement) => `${measurement.synchronous}/${measurement.mode}/ff${measurement.fullfsync}`,
    );
    expect(measured.sort()).toEqual([
      'FULL/batched/ff0',
      'FULL/batched/ff1',
      'FULL/single/ff0',
      'FULL/single/ff1',
      'NORMAL/batched/ff0',
      'NORMAL/batched/ff1',
      'NORMAL/single/ff0',
      'NORMAL/single/ff1',
    ]);
  });

  it('measured 10,000 events per configuration, on a real filesystem', () => {
    for (const measurement of rows()) {
      expect(measurement.events).toBe(10_000);
      expect(measurement.filesystem).toBe('apfs');
      expect(measurement.elapsedMs).toBeGreaterThan(0);
    }
  });

  it('quotes every measured throughput in the note', () => {
    const text = note();
    for (const measurement of rows()) {
      expect(
        text,
        `${measurement.synchronous}/${measurement.mode} is missing from the note`,
      ).toContain(Math.round(measurement.eventsPerSecond).toLocaleString('en-US'));
    }
  });

  it('quotes the Linux baseline it is being compared against', () => {
    expect(note()).toContain('979');
    expect(note()).toContain('22,982');
  });

  it('names the shipped synchronous= value in a sentence that gives a reason', () => {
    const decision = /\*\*Decision: `synchronous = (FULL|NORMAL)`\*\* — ([\s\S]+?)\n\n/.exec(
      note(),
    );
    expect(decision, 'the note must state the shipped value and why').not.toBeNull();
    const reason = decision?.[2] ?? '';
    expect(reason.trimEnd().endsWith('.'), 'the reason must be a finished sentence').toBe(true);
    expect(reason.length).toBeGreaterThan(60);
  });

  it('records every matrix cell, pass or fail', () => {
    const outcomes = JSON.parse(readText(MATRIX_PATH)) as {
      cells: { id: string; status: string; fallback: string | null }[];
    };
    expect(unfinishedCells(outcomes.cells)).toEqual([]);
    for (const cell of REQUIRED_CELLS) expect(note()).toContain(cell.id);
  });
});

suite('upstream node-pty is not a dependency anywhere (AC7)', () => {
  it('no manifest in the workspace depends on the unscoped package', () => {
    for (const manifest of allManifests()) {
      const dependencies = {
        ...manifest.json.dependencies,
        ...manifest.json.devDependencies,
        ...manifest.json.optionalDependencies,
      };
      expect(Object.keys(dependencies), manifest.path).not.toContain('node-pty');
    }
  });

  it('the catalog pins the fork, not upstream', () => {
    const catalog = readWorkspaceYaml().catalog ?? {};
    expect(catalog['@lydell/node-pty']).toBe('1.2.0-beta.14');
    expect(catalog['node-pty']).toBeUndefined();
  });

  it('the note records why, naming the install script that does it', () => {
    expect(note()).toContain('node scripts/prebuild.js || node-gyp rebuild');
  });

  const note = (): string => readText(NOTE_PATH);
});
