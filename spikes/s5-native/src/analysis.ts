/**
 * KAR-00.5 — the part of the spike that is arithmetic rather than measurement.
 *
 * Reading a CSV, dividing four throughputs into the two ratios the Linux
 * baseline is stated in, and deciding whether a matrix cell has actually been
 * answered are all pure functions over data, so they are tested as pure
 * functions over data (test/spike-s5-fsync.test.ts) and never as a side effect
 * of a benchmark that takes a minute to run.
 *
 * Nothing here talks to a process, a database or a disk.
 */

export type Synchronous = 'FULL' | 'NORMAL';
export type AppendMode = 'single' | 'batched';

export interface BenchRow {
  readonly machine: string;
  readonly filesystem: string;
  readonly synchronous: Synchronous;
  /**
   * darwin only ever issues `fcntl(F_FULLFSYNC)` under `PRAGMA fullfsync = 1`,
   * and that pragma is **off** by default. At 0, `synchronous = FULL` on macOS
   * is a weaker promise than the Linux `FULL` the baseline was measured under —
   * which is why it is a column rather than a footnote.
   */
  readonly fullfsync: 0 | 1;
  readonly mode: AppendMode;
  readonly batchSize: number;
  readonly events: number;
  readonly elapsedMs: number;
  readonly eventsPerSecond: number;
}

export const CSV_HEADER =
  'machine,filesystem,synchronous,fullfsync,mode,batch_size,events,elapsed_ms,events_per_second';

/** docs/05-durable-execution.md §9.7, measured 2026-08-02 in a Linux container. */
export const LINUX_BASELINE = {
  fullSingle: 979,
  normalSingle: 22_982,
  /** "FULL is 20–25x more expensive per commit" — §9.7's closing caveat. */
  fullPenaltyBand: [20, 25] as const,
  /** "batching gives ~7x" — same caveat. */
  batchingGain: 7,
} as const;

export function formatBenchCsv(rows: readonly BenchRow[]): string {
  const lines = rows.map((row) =>
    [
      row.machine,
      row.filesystem,
      row.synchronous,
      row.fullfsync,
      row.mode,
      row.batchSize,
      row.events,
      row.elapsedMs,
      row.eventsPerSecond,
    ].join(','),
  );
  return `${CSV_HEADER}\n${lines.join('\n')}\n`;
}

export function parseBenchCsv(text: string): BenchRow[] {
  const [header, ...lines] = text.trim().split('\n');
  if (header !== CSV_HEADER) throw new Error(`unexpected CSV header: ${header}`);
  return lines
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [
        machine,
        filesystem,
        synchronous,
        fullfsync,
        mode,
        batchSize,
        events,
        elapsedMs,
        rate,
      ] = line.split(',');
      return {
        machine: machine ?? '',
        filesystem: filesystem ?? '',
        synchronous: synchronous as Synchronous,
        fullfsync: Number(fullfsync) === 1 ? 1 : 0,
        mode: mode as AppendMode,
        batchSize: Number(batchSize),
        events: Number(events),
        elapsedMs: Number(elapsedMs),
        eventsPerSecond: Number(rate),
      };
    });
}

export function requireRow(
  rows: readonly BenchRow[],
  synchronous: Synchronous,
  mode: AppendMode,
  fullfsync: 0 | 1 = 0,
): BenchRow {
  const found = rows.find(
    (row) => row.synchronous === synchronous && row.mode === mode && row.fullfsync === fullfsync,
  );
  if (found === undefined) {
    throw new Error(
      `no measurement for synchronous=${synchronous} mode=${mode} fullfsync=${fullfsync}. ` +
        'A configuration that was not measured is not a configuration that is fine.',
    );
  }
  return found;
}

export interface ShapeComparison {
  readonly fullfsync: 0 | 1;
  /** How much more each commit costs at FULL than at NORMAL, one transaction per event. */
  readonly fullPenalty: number;
  readonly batchingGainFull: number;
  readonly batchingGainNormal: number;
  readonly fullPenaltyMatchesLinux: boolean;
  readonly batchingGainMatchesLinux: boolean;
}

const round = (value: number): number => Number(value.toFixed(2));

export function compareShape(rows: readonly BenchRow[], fullfsync: 0 | 1 = 0): ShapeComparison {
  const fullSingle = requireRow(rows, 'FULL', 'single', fullfsync).eventsPerSecond;
  const fullBatched = requireRow(rows, 'FULL', 'batched', fullfsync).eventsPerSecond;
  const normalSingle = requireRow(rows, 'NORMAL', 'single', fullfsync).eventsPerSecond;
  const normalBatched = requireRow(rows, 'NORMAL', 'batched', fullfsync).eventsPerSecond;

  const fullPenalty = round(normalSingle / fullSingle);
  const batchingGainFull = round(fullBatched / fullSingle);
  const batchingGainNormal = round(normalBatched / normalSingle);
  const [low, high] = LINUX_BASELINE.fullPenaltyBand;

  return {
    fullfsync,
    fullPenalty,
    batchingGainFull,
    batchingGainNormal,
    fullPenaltyMatchesLinux: fullPenalty >= low && fullPenalty <= high,
    batchingGainMatchesLinux: batchingGainFull >= LINUX_BASELINE.batchingGain,
  };
}

/**
 * The same three ratios as `compareShape`, taken one round at a time and then
 * reduced by median rather than computed once over aggregated numbers.
 *
 * The distinction is the whole point. A ratio of two throughputs measured
 * minutes apart is a claim about two different moments, and on a busy machine
 * those moments differ by more than the effect being measured — at 10,000
 * events the batched configurations finish in about ten milliseconds, and ten
 * milliseconds beside a saturated test suite is scheduler noise with a
 * benchmark wrapped around it. `batchingGainNormal` has been observed at 0.82
 * that way, reporting batching as a loss.
 *
 * So each round measures all four configurations back to back, each round
 * yields its own three ratios from numbers taken seconds apart, and the median
 * across rounds discards the round that met a spike. Never a ratio of sums: one
 * pathological round would move a sum, and it cannot move a median.
 */
export interface ShapeRounds {
  readonly fullfsync: 0 | 1;
  readonly rounds: number;
  readonly fullPenalty: number;
  readonly batchingGainFull: number;
  readonly batchingGainNormal: number;
  /** Every round's ratios, so a failure can print what it actually saw. */
  readonly perRound: readonly ShapeComparison[];
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('no samples to take a median of');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function compareShapeRounds(
  rounds: readonly (readonly BenchRow[])[],
  fullfsync: 0 | 1 = 0,
): ShapeRounds {
  if (rounds.length === 0) {
    throw new Error('no rounds were measured. A shape nobody sampled is not a shape that held.');
  }
  const perRound = rounds.map((rows) => compareShape(rows, fullfsync));
  return {
    fullfsync,
    rounds: rounds.length,
    fullPenalty: round(median(perRound.map((shape) => shape.fullPenalty))),
    batchingGainFull: round(median(perRound.map((shape) => shape.batchingGainFull))),
    batchingGainNormal: round(median(perRound.map((shape) => shape.batchingGainNormal))),
    perRound,
  };
}

export interface MatrixCell {
  readonly id: string;
  readonly platform: string;
  readonly libc: 'darwin' | 'glibc' | 'musl';
  readonly nodeMajor: 24 | 26;
  readonly runner: 'local' | 'docker';
  /** The container image for a docker cell; null for a local one. */
  readonly image: string | null;
}

/** The five cells AC5 names, in the order it names them. */
export const REQUIRED_CELLS: readonly MatrixCell[] = [
  {
    id: 'macos-arm64-node24',
    platform: 'macOS Apple Silicon',
    libc: 'darwin',
    nodeMajor: 24,
    runner: 'local',
    image: null,
  },
  {
    id: 'macos-arm64-node26',
    platform: 'macOS Apple Silicon',
    libc: 'darwin',
    nodeMajor: 26,
    runner: 'local',
    image: null,
  },
  {
    id: 'linux-glibc-node24',
    platform: 'Linux glibc',
    libc: 'glibc',
    nodeMajor: 24,
    runner: 'docker',
    image: 'node:24-slim',
  },
  {
    id: 'linux-glibc-node26',
    platform: 'Linux glibc',
    libc: 'glibc',
    nodeMajor: 26,
    runner: 'docker',
    image: 'node:26-slim',
  },
  {
    id: 'linux-musl-node24',
    platform: 'Linux musl',
    libc: 'musl',
    nodeMajor: 24,
    runner: 'docker',
    image: 'node:24-alpine',
  },
];

/**
 * Not part of AC5's matrix — a control.
 *
 * `node:24-slim` is Debian **bookworm** (glibc 2.36) and `node:26-slim` is
 * Debian **trixie** (glibc 2.41), so a difference between those two cells has
 * two candidate causes and the matrix alone cannot say which. This cell holds
 * the Node major at 24 and moves the distribution to trixie, which leaves one
 * variable.
 */
export const CONTROL_CELLS: readonly MatrixCell[] = [
  {
    id: 'linux-glibc-trixie-node24',
    platform: 'Linux glibc (Debian trixie)',
    libc: 'glibc',
    nodeMajor: 24,
    runner: 'docker',
    image: 'node:24-trixie-slim',
  },
];

export const ALL_CELLS: readonly MatrixCell[] = [...REQUIRED_CELLS, ...CONTROL_CELLS];

export function cellById(id: string): MatrixCell {
  const cell = ALL_CELLS.find((candidate) => candidate.id === id);
  if (cell === undefined) throw new Error(`unknown matrix cell "${id}"`);
  return cell;
}

export interface CellOutcome {
  readonly id: string;
  readonly status: 'pass' | 'fail';
  /**
   * What a failing cell becomes: a documented prerequisite or a no-TTY
   * fallback. AC6 exists because "probably fine" is the failure mode this
   * field makes impossible.
   */
  readonly fallback: string | null;
}

/**
 * Cells that have not been answered: never run, or run, failed, and left
 * without a recorded fallback. A failure with a fallback is a finished cell.
 */
export function unfinishedCells(outcomes: readonly CellOutcome[]): MatrixCell[] {
  return REQUIRED_CELLS.filter((cell) => {
    const outcome = outcomes.find((candidate) => candidate.id === cell.id);
    if (outcome === undefined) return true;
    return outcome.status === 'fail' && (outcome.fallback ?? '').trim() === '';
  });
}
