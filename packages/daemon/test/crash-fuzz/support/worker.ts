/**
 * One daemon life, as a real process the crash-fuzz suite kills (EPIC-06-S29).
 *
 * Everything KAR-06.9 claims is exercised here as itself: the lease, the epoch
 * bump, `recover()`'s five steps, `decide()`, `durable()`'s write-ahead
 * journal, `recordNodeFailure()`'s retry ladder, and real fake-agent child
 * processes appending to a real side-effect log. The only thing this file adds
 * is the sequencing that EPIC-15 will eventually own, plus the phase markers
 * the harness aims its knife at.
 *
 * The projection is snapshotted after **every** committed event, from the first
 * iteration, because "the post-restart projection equals the pre-crash one at
 * the last durably-written seq" is not checkable any other way — and
 * retrofitting the snapshot later is painful enough that the epic says so.
 *
 * Configuration arrives in the environment so the process's own argv stays
 * empty, exactly as `bin/fake-agent.ts` does it.
 */
import { canonicalJson, type RunState, seededRandom } from '@DeFlow/core';
import { acquireLease, bumpEpoch, openLedger, readRange } from '@DeFlow/ledger';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { systemClock } from '../../../src/index.ts';
import { recover } from '../../../src/recovery.ts';
import { RECOVERY_RUN, seedRecoveryRun } from '../../integration/support/recovery-run.ts';
import { runUntilSettled } from '../../support/run-loop.ts';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

const dataDir = required('DeFlow_FUZZ_DATA_DIR');
const agent = required('DeFlow_FUZZ_AGENT');
const sideEffects = required('DeFlow_FUZZ_SIDE_EFFECTS');
const projections = required('DeFlow_FUZZ_PROJECTIONS');
const phaseFile = required('DeFlow_FUZZ_PHASE');
const seed = Number.parseInt(process.env.DeFlow_FUZZ_SEED ?? '1', 10);
const settleMs = Number.parseInt(process.env.DeFlow_FUZZ_SETTLE_MS ?? '40', 10);
const tickMs = Number.parseInt(process.env.DeFlow_FUZZ_TICK_MS ?? '10', 10);

/**
 * The fake agent's own log **is** the durable trace this agent leaves in the
 * world — the stand-in for a journalled session id. Asking the effect journal
 * instead would be asking the mechanism whether the mechanism worked.
 */
function alreadyRan(ikey: string): boolean {
  if (!existsSync(sideEffects)) return false;
  for (const line of readFileSync(sideEffects, 'utf8').split('\n')) {
    if (line === '') continue;
    try {
      if ((JSON.parse(line) as { idempotencyKey?: unknown }).idempotencyKey === ikey) return true;
    } catch {
      // A torn final line from the crash. It named no key we can trust.
    }
  }
  return false;
}

const phase = (marker: string): void => {
  // To a file rather than to stdout: the reader is a parent polling a process
  // it is about to SIGKILL, and a line still in a pipe buffer when the signal
  // lands is a line that never existed.
  writeFileSync(phaseFile, marker);
};

// ── 1. flock, 2. bump the epoch ──────────────────────────────────────────────
const lease = acquireLease(dataDir);
const db = openLedger(dataDir);
const epoch = bumpEpoch(db);
const daemonStartedAt = systemClock.now();

if (readRange(db, RECOVERY_RUN, 0, 1).events.length === 0) seedRecoveryRun(db);

phase('recovering');

// ── 3–7. rebuild, reconcile, reclaim, reap, load wakes ───────────────────────
const recovered = await recover({
  db,
  clock: systemClock,
  epoch,
  daemonStartedAt,
  random: seededRandom(seed),
  reconcile: (row) =>
    alreadyRan(row.ikey)
      ? { status: 'done' as const, result: { ikey: row.ikey } }
      : { status: 'not-started' as const },
});

appendFileSync(
  projections,
  `${JSON.stringify({ recovery: { reconciled: recovered.reconciled.length, concluded: recovered.concluded.length } })}\n`,
);

// ── 8. start the ticker ──────────────────────────────────────────────────────
const result = await runUntilSettled(
  {
    db,
    runId: RECOVERY_RUN,
    clock: systemClock,
    epoch,
    daemonStartedAt,
    random: seededRandom(seed),
    agent,
    sideEffects,
    failFirstAttempt: new Set(['document']),
    settleMs,
    tickMs,
    phase,
    budgetMs: 120_000,
    onEvent: (seq: number, state: RunState) => {
      appendFileSync(projections, `${JSON.stringify({ seq, state: canonicalJson(state) })}\n`);
    },
  },
  alreadyRan,
);

phase(`done:${result.state.status}`);

db.close();
lease.release();
