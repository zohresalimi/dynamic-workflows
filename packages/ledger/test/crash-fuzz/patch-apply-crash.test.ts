/**
 * KAR-11.3 AC4 / EPIC-11-S15 — the crash-fuzz kill point inside patch
 * application.
 *
 * 06 §4.2: *"a crash mid-apply leaves either the old plan and no event, or the
 * new plan and its event. Never a torn state."* Neither half of a torn pair is
 * repairable afterwards, because the ledger is append-only: a `plan` row whose
 * event never landed is a document nobody can explain the provenance of, and an
 * event whose row never landed is a `run.plan_hash` addressing a document that
 * does not exist. There is no later write that can make either whole, so the
 * only defence is that the three statements are one transaction — and the only
 * proof of that is killing a real process inside it.
 *
 * **SIGKILL, never SIGTERM**, and the whole process **group**: SIGTERM tests the
 * shutdown handler, and durability is the only thing this suite is about.
 *
 * `vi.useFakeTimers()` is forbidden in this file: a child process is alive
 * throughout, its real I/O would never arrive, and the spec would deadlock for
 * the whole timeout (docs/14-testing-strategy.md §8). Every wait here polls a
 * real clock.
 *
 * The seed comes from `$GITHUB_RUN_ID` when CI provides one, so a failure
 * reproduces from the log; `DeFlow_CRASH_SEED=<n>` re-runs a specific one.
 *
 * Verifies: EPIC-11-S15 (first scenario) · AC4
 */
import { crashSeed, it, mulberry32, sleep, startCrashable, waitFor } from '@DeFlow/testkit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { openLedger, readRange } from '../../src/index.ts';
import { PATCH_RUN } from './support/patch-run.ts';

const WORKER = fileURLToPath(new URL('./support/patch-apply-worker.ts', import.meta.url));

const { seed, source } = crashSeed();
process.stdout.write(`patch-apply crash-fuzz seed ${seed} (from ${source})\n`);

/** Repetitions. One is a regression test; more is a fuzzer, and the kill point
 * moves inside the window on every one of them. */
const ITERATIONS = Number.parseInt(process.env.DeFlow_CRASH_FUZZ_ITERATIONS ?? '3', 10);

/** How long the transaction is held open, so the knife has somewhere to land. */
const HOLD_MS = 300;

interface Hashes {
  readonly base: string;
  readonly next: string;
  readonly doc: string;
}

interface Surviving {
  readonly integrity: unknown;
  readonly runPlanHash: string | null;
  readonly hasNextRow: boolean;
  readonly hasBaseRow: boolean;
  readonly patchedEvents: number;
}

/** What a fresh engine over the same file finds. */
function inspect(dataDir: string, hashes: Hashes): Surviving {
  const db = openLedger(dataDir);
  try {
    const doc = (hash: string): boolean =>
      db.prepare<{ doc: string }>('SELECT doc FROM plan WHERE hash = ?').get(hash) !== undefined;
    return {
      integrity: db.pragma('integrity_check'),
      runPlanHash:
        db
          .prepare<{ plan_hash: string }>('SELECT plan_hash FROM run WHERE run_id = ?')
          .get(PATCH_RUN)?.plan_hash ?? null,
      hasNextRow: doc(hashes.next),
      hasBaseRow: doc(hashes.base),
      patchedEvents: readRange(db, PATCH_RUN, 0, 500).events.filter(
        (row) => row.kind === 'plan.patched',
      ).length,
    };
  } finally {
    db.close();
  }
}

suite('EPIC-11-S15 — kill -9 inside patch application leaves no torn state', () => {
  const random = mulberry32(seed);

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    it(`iteration ${iteration + 1}: either the old plan and no event, or the new plan and its event`, async ({
      tmp,
    }) => {
      const dataDir = tmp;
      const phaseFile = join(dataDir, 'phase.txt');
      const phase = (): string => (existsSync(phaseFile) ? readFileSync(phaseFile, 'utf8') : '');

      const child = startCrashable({
        script: WORKER,
        env: {
          ...process.env,
          DeFlow_PATCH_DATA_DIR: dataDir,
          DeFlow_PATCH_PHASE: phaseFile,
          DeFlow_PATCH_HOLD_MS: String(HOLD_MS),
        },
      });

      await waitFor(() => phase() === 'inside-transaction', {
        describe: 'the worker to be inside the apply transaction',
        timeoutMs: 30_000,
      });
      // Somewhere *inside* the window rather than always on its first
      // instruction — a fuzzer that always kills at the same offset is a
      // regression test wearing a fuzzer's clothes.
      await sleep(Math.floor(random() * (HOLD_MS - 40)));

      // The assertion that this iteration tested what it says it tested: the
      // knife landed while the transaction was open, not before or after it.
      expect(phase()).toBe('inside-transaction');
      const exit = await child.sigkill();
      expect(exit.signal).toBe('SIGKILL');

      const hashes = JSON.parse(readFileSync(join(dataDir, 'hashes.json'), 'utf8')) as Hashes;
      const after = inspect(dataDir, hashes);

      expect(after.integrity).toBe('ok');
      // The base survived: whatever happened to the patch, the version that
      // actually ran is still addressable, byte for byte.
      expect(after.hasBaseRow).toBe(true);

      // The two admissible worlds, and nothing between them. Written as one
      // assertion on the triple so a half-applied state fails with all three
      // values in the message rather than with whichever happened to be
      // checked first.
      const observed = {
        row: after.hasNextRow,
        events: after.patchedEvents,
        runPlanHash: after.runPlanHash,
      };
      expect([
        { row: false, events: 0, runPlanHash: hashes.base },
        { row: true, events: 1, runPlanHash: hashes.next },
      ]).toContainEqual(observed);
    });
  }
});
