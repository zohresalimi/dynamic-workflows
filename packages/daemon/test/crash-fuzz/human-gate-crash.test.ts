/**
 * KAR-13.1 AC1 — the fuzz the acceptance criterion asks for: *"a crash between
 * them is impossible to observe"* (EPIC-13-S3, fourth scenario).
 *
 * `human.requested`, `node.suspended` and the `node_wake` row are written in one
 * SQLite transaction. That claim is either true or it is a run that silently
 * never comes back, and the only way to tell the two apart is to keep killing a
 * real process around the admission and look at what is on disk afterwards.
 *
 * Two shapes of corruption are what the loop is hunting, and both are silent:
 *
 *   - a `human.requested` with **no** `node_wake` row — the operator is asked a
 *     question, nothing is waiting for the answer, and a deadline never fires;
 *   - a `node_wake` row with reason `human_gate` and **no** `human.requested` —
 *     a wait for a question nobody asked, which fires into a gate that does not
 *     exist.
 *
 * `SIGKILL` on the process **group**, never `SIGTERM`: SIGTERM tests the
 * shutdown handler and durability is the only thing this is about. The ledger is
 * a real file, because `:memory:` cannot be reopened after a simulated crash.
 * `vi.useFakeTimers()` appears nowhere: a child is alive throughout.
 *
 * The seed comes from `$GITHUB_RUN_ID` when CI provides one, so a failure
 * reproduces from the log; `DeFlow_CRASH_SEED=<n>` re-runs a specific one.
 *
 * Verifies: EPIC-13-S3 (fourth scenario) · AC1
 */
import { openLedger, readRange, readWakes } from '@DeFlow/ledger';
import { type Crashable, crashSeed, it, mulberry32, sleep, startCrashable } from '@DeFlow/testkit';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { GATE, HUMAN_RUN } from '../integration/support/human-gate-run.ts';

const WORKER = fileURLToPath(new URL('./support/fuzz-human-gate.ts', import.meta.url));

const { seed, source } = crashSeed();
process.stdout.write(`human-gate crash-fuzz seed ${seed} (from ${source})\n`);

/**
 * How many times the knife falls. The acceptance criterion names fifty, and
 * fifty is what runs: the window this is aiming at is a single SQLite
 * transaction, so one repetition would be a regression test rather than a
 * fuzzer, and a rare interleaving is exactly what it exists to find.
 */
const ITERATIONS = Number.parseInt(process.env.DeFlow_CRASH_FUZZ_ITERATIONS ?? '50', 10);

/** How long a life gets to reach the admission before the knife falls anyway. */
const REACH_BUDGET_MS = 15_000;

/**
 * How wide the knife's landing zone is once the child says it is suspending the
 * node, in milliseconds.
 *
 * Small on purpose: the window being aimed at is one SQLite transaction, and a
 * spread wide enough to be comfortable is a spread that always lands after it.
 */
const SPREAD_MS = 8;

/**
 * The blind window, in milliseconds from spawn.
 *
 * Half the iterations do not wait for a marker at all, and land uniformly
 * somewhere in a life that boots, migrates, seeds four events and admits. That
 * is what covers the *approach* to the transaction — the aimed half can only
 * ever land at or after the marker, because the parent has to observe the file
 * before it can act on it, and by then the commit has usually happened.
 */
const BLIND_WINDOW_MS = 400;

const alive: Crashable[] = [];

afterEach(async () => {
  await Promise.all(alive.splice(0).map((child) => child.sigkill()));
});

const phaseOf = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** What one killed life left on disk. */
interface Wreckage {
  readonly phase: string;
  readonly requests: number;
  readonly gateRows: number;
  readonly integrity: string;
}

async function crashOnce(dir: string, random: () => number, aimed: boolean): Promise<Wreckage> {
  const phaseFile = join(dir, 'phase.txt');
  const child = startCrashable({ script: WORKER, args: [dir, phaseFile] });
  alive.push(child);

  if (aimed) {
    const deadline = Date.now() + REACH_BUDGET_MS;
    while (!phaseOf(phaseFile).startsWith('suspend:') && Date.now() < deadline) {
      await sleep(1);
    }
    // Somewhere inside the window rather than always on its first instruction.
    await sleep(Math.floor(random() * SPREAD_MS));
  } else {
    await sleep(Math.floor(random() * BLIND_WINDOW_MS));
  }

  const phase = phaseOf(phaseFile);
  await child.sigkill();
  alive.splice(alive.indexOf(child), 1);

  const db = openLedger(dir);
  try {
    const events = readRange(db, HUMAN_RUN, 0, 500).events;
    return {
      phase,
      requests: events.filter(
        (event) =>
          event.kind === 'human.requested' && (event.payload as { node?: string }).node === GATE,
      ).length,
      gateRows: readWakes(db, HUMAN_RUN).filter(
        (row) => row.reason === 'human_gate' && row.nodeId === GATE,
      ).length,
      integrity:
        db.prepare<{ integrity_check: string }>('PRAGMA integrity_check').get()?.integrity_check ??
        'missing',
    };
  } finally {
    db.close();
  }
}

suite('EPIC-13-S3 scenario 4 — the suspend transaction cannot be caught half done', () => {
  it(`never finds a request without its row, or a row without its request (×${String(ITERATIONS)})`, {
    timeout: 240_000,
  }, async ({ tmp }) => {
    const random = mulberry32(seed);
    const wreckage: Wreckage[] = [];

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const dir = join(tmp, `life-${String(iteration)}`);
      mkdirSync(dir, { recursive: true });
      // Alternating rather than random, so every run of the suite covers both
      // the approach and the instant itself.
      const found = await crashOnce(dir, random, iteration % 2 === 1);

      // The invariant, asked of every single iteration rather than of the
      // aggregate: one bad ledger in fifty is the bug.
      expect(found.requests, `iteration ${String(iteration)} (phase ${found.phase})`).toBe(
        found.gateRows,
      );
      expect(found.requests, `iteration ${String(iteration)}`).toBeLessThanOrEqual(1);
      expect(found.integrity, `iteration ${String(iteration)}`).toBe('ok');
      wreckage.push(found);
    }

    // And the fuzz has to have actually been a fuzz. If no iteration ever
    // reached the admission, the loop above proved only that an empty ledger
    // is consistent with itself; if every one did, the knife never landed on
    // the approach and half the window went untested.
    const admitted = wreckage.filter((found) => found.requests === 1).length;
    expect(admitted, 'no iteration reached the suspension').toBeGreaterThan(0);
    expect(admitted, 'every iteration landed after the suspension').toBeLessThan(wreckage.length);
  });
});
