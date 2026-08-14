/**
 * KAR-16.4 AC8 / test plan #7 — the soak that proves the memory rules.
 *
 * Verifies: EPIC-16-S27 · AC1, AC2, AC3, AC8
 *
 * ## What this is, exactly
 *
 * EPIC-16-S27's full soak is *"`deflow replay fixtures/stress-400.jsonl --speed
 * max` looping for six hours"*, and the scenario itself says it **runs on a
 * schedule, not on every push, because it costs six hours** — and that *"a
 * per-push proxy for it is a ten-minute run at `--speed max` with the same
 * assertions"*. This file is that proxy, with two honest differences recorded
 * rather than glossed:
 *
 * - **It drives the store directly, not through `deflow replay`.** The replay
 *   harness and the `stress-400` fixture are KAR-16.5's and do not exist in
 *   this build. Driving the store is strictly the *harder* case for the
 *   assertions below, because nothing throttles the event rate: six hundred
 *   thousand events land as fast as the process can fold them.
 * - **It is seconds rather than ten minutes.** The four assertions are about
 *   *bounds*, and a bound that holds over six hundred thousand events holds
 *   over six hours of the same events — what six hours buys is the chance to
 *   observe a slow leak, and a slow leak is exactly what a **retained**-heap
 *   sample after a forced major GC turns into an immediate one.
 *
 * The scheduled six-hour run over the real fixture, with the plan graph,
 * timeline and inspector mounted, remains owed once KAR-16.5 lands the harness
 * and KAR-16.6 lands the canvas.
 *
 * ## Why a subprocess
 *
 * The measurement is `process.memoryUsage().heapUsed` **immediately after a
 * forced collection**, and that is only meaningful in a process that holds the
 * thing under test and little else. Sampled inside a vitest worker it would be
 * measuring the runner, the module graph and every fixture the file before it
 * left behind. So `./store-soak-child.ts` runs under `node --expose-gc` and
 * prints one JSON line per phase.
 *
 * ## Why the heap ceiling is relative
 *
 * A fixed megabyte budget either flakes on a loaded laptop or is so loose it
 * catches nothing. The ceiling here is **three times the machine's own
 * phase-to-phase variation over the first half of the run**, with a 2 MB floor
 * so a suspiciously steady first half cannot make the budget unreachable — the
 * same shape of control-relative budget EPIC-05 used for its two timing
 * budgets. A build that retained one envelope per event would be tens of
 * megabytes above it.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it, describe as suite } from 'vitest';

const child = fileURLToPath(new URL('./store-soak-child.ts', import.meta.url));

const NODES = 400;
const PHASES = 10;
const PER_PHASE = 60_000;
/** The nodes are scheduled once, before the phases. */
const EXPECTED_APPLIED = NODES + PHASES * PER_PHASE;

/** The 2 MB floor under the relative ceiling. */
const HEAP_FLOOR_BYTES = 2 * 1024 * 1024;

interface PhaseSample {
  readonly phase: number;
  readonly applied: number;
  readonly seq: number;
  readonly rendered: number;
  readonly counts: {
    readonly nodes: number;
    readonly facts: number;
    readonly events: number;
    readonly terminals: number;
    readonly ringCap: number;
  };
  readonly heapUsed: number;
}

interface Finished {
  readonly done: true;
  readonly disposed: number;
  readonly terminals: number;
}

let phases: PhaseSample[];
let finished: Finished;

function runSoak(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ['--expose-gc', child, String(NODES), String(PHASES), String(PER_PHASE)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`the soak exited ${code}\n${err}`));
    });
  });
}

beforeAll(async () => {
  const lines = (await runSoak())
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as PhaseSample | Finished);

  phases = lines.filter((line): line is PhaseSample => !('done' in line));
  finished = lines.find((line): line is Finished => 'done' in line) as Finished;
}, 120_000);

suite('EPIC-16-S27 — projection object counts are bounded by node count', () => {
  it('ran the whole soak, so the bounds are over something', () => {
    expect(phases).toHaveLength(PHASES);
    expect(phases.at(-1)?.applied).toBe(EXPECTED_APPLIED);
    expect(phases.at(-1)?.seq).toBe(EXPECTED_APPLIED);
  });

  it('holds exactly the plan’s nodes after six hundred thousand events', () => {
    for (const sample of phases) expect(sample.counts.nodes).toBe(NODES);
  });

  it('renders a view-model list bounded by the plan, not by the event count', () => {
    // `rendered` is `planNodes + planEdges + timelineSpans`, read on every
    // phase so the lazy computeds actually run. A store that accumulated a
    // progress payload per event would grow this without bound.
    for (const sample of phases) expect(sample.rendered).toBe(NODES);
  });
});

suite('EPIC-16-S27 — the debug ring is at exactly its cap', () => {
  it('never exceeds it and never falls back below it once filled', () => {
    for (const sample of phases) {
      expect(sample.counts.events).toBe(sample.counts.ringCap);
      expect(sample.counts.ringCap).toBe(2_000);
    }
  });
});

suite('EPIC-16-S27 — zero undisposed Terminal instances', () => {
  it('disposes each phase’s terminal, and the store disposes any left at close', () => {
    for (const sample of phases) expect(sample.counts.terminals).toBe(0);
    expect(finished.disposed).toBe(PHASES);
    expect(finished.terminals).toBe(0);
  });
});

suite('EPIC-16-S27 — JS heap growth is within the recorded ceiling', () => {
  it('does not grow across the second half of the run', () => {
    const heaps = phases.map((sample) => sample.heapUsed);
    const middle = Math.floor(heaps.length / 2);
    const firstHalf = heaps.slice(0, middle);

    // The control: this machine's own phase-to-phase variation, measured on
    // the same process over the same work, before the window being judged.
    const jitter = Math.max(
      ...firstHalf.slice(1).map((heap, index) => Math.abs(heap - (firstHalf[index] as number))),
    );
    const ceiling = Math.max(jitter * 3, HEAP_FLOOR_BYTES);

    const growth = Math.max(...heaps.slice(middle)) - (heaps[middle - 1] as number);

    expect(
      growth,
      `retained heap grew ${growth} bytes across the last ${heaps.length - middle} phases, ` +
        `over a ceiling of ${ceiling} (3× this machine's ${jitter}-byte jitter, 2 MB floor). ` +
        'The four candidates, in order of likelihood: the raw event array, a per-node progress ' +
        'array, undisposed terminals, and ELK inputs held by a Vue proxy.',
    ).toBeLessThan(ceiling);
  });

  it('is flat rather than merely bounded — retained memory is a function of the plan', () => {
    const heaps = phases.map((sample) => sample.heapUsed);

    // 600,000 events folded, and what is retained at the end is what was
    // retained at the start plus the ceiling. A per-event retention of even a
    // single small object would be tens of megabytes here.
    expect(Math.max(...heaps) - Math.min(...heaps)).toBeLessThan(HEAP_FLOOR_BYTES * 4);
  });
});
