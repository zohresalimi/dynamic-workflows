/**
 * The read side of the ledger, as the HTTP layer is allowed to see it.
 *
 * Two rules from `docs/11-api-and-realtime.md` §5.1 are baked into the shape
 * rather than left to a comment at each call site, because both were measured
 * rather than reasoned about:
 *
 * - **Never serve a read from the write connection.** `better-sqlite3` is
 *   fully synchronous and blocks the event loop, so a tail query on the
 *   daemon's writer stalls every append behind it. `openLedgerView` therefore
 *   opens its *own* read-only connection, with the same PRAGMAs and its own
 *   `busy_timeout`.
 * - **Never hold a cursor or a read transaction open across a stream.** Every
 *   method here is one bounded statement that finishes before it returns.
 *   Holding one open while 20k rows were written produced an 82.6 MB `-wal`
 *   file that no checkpoint could truncate.
 *
 * The registry at the bottom is the same pattern, and for the same reason, as
 * `../runtime.ts`: `api.ts` is a module-level `Hono` app, `boot.ts` is what
 * owns the data directory, and neither should have to import the other. There
 * is exactly one daemon per process — the lease in `boot.ts` is what enforces
 * that — so exactly one view is the honest cardinality.
 *
 * KAR-14.1 AC8 is the first caller: `GET /api/runs/:id` reduces a run here to
 * serve its cost rollup, and `/api/stream` tails the same rows so the rollup a
 * client holds stays current without a second endpoint to poll. EPIC-15 owns
 * the rest of §6's route table and will widen this port rather than add another.
 */
import type { Calibration, Db, PlanGraph, RunId, RunState } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import {
  headSeq as ledgerHeadSeq,
  listRunIds,
  openRead,
  readPlanPatchedEvent,
  readPlanPatchProposedEvent,
  readPlanVersion,
  readRange,
  readTokenCalibration,
  replayRun,
  type StoredEvent,
} from '@DeFlow/ledger';
import { join } from 'node:path';
import { joinPlanTransition, type PlanTransition } from '../plan/plan-history.ts';

export interface LedgerView {
  /**
   * `runId`'s reduced state, or `null` when this directory holds no such run.
   *
   * Reduced on demand rather than read from a cache the daemon keeps in
   * memory: the projection is the ledger, and a served figure that came from
   * anywhere else is a figure a restart can disagree with.
   */
  runState(runId: RunId): RunState | null;
  /** Events for `runId` with `seq > afterSeq`, oldest first, at most `limit`. */
  tail(runId: RunId, afterSeq: number, limit: number): readonly StoredEvent[];
  /** The head `seq` across every run — the number §4.2's cursor is compared to. */
  headSeq(): number;
  /**
   * KAR-14.3 — what has been learned about this (provider, model), for the
   * pre-flight estimate.
   *
   * One bounded statement like everything else here, and a *read* in the
   * strictest sense: `readTokenCalibration` invents no row for a pair nobody
   * has run, it answers with the family seed and `n: 0`. A `GET` that wrote
   * would be a `GET` that wrote.
   */
  calibration(provider: string, model: string, family: string): Calibration;
  /**
   * KAR-11.5 AC3 — the plan document `runId` proposed at `version`, resolved
   * through the content-addressed `plan` table. `null` when this run never
   * proposed a version numbered that — the diff endpoint's 404.
   */
  planVersion(runId: RunId, version: number): PlanGraph | null;
  /**
   * KAR-11.5 AC3, AC5 — the `reason` and `decision` behind the patch that
   * produced `toVersion`, joined from `plan.patched` and its
   * `plan.patch.proposed`. `null` for a version with no patch behind it (v1's
   * initial compile).
   */
  planTransition(runId: RunId, toVersion: number): PlanTransition | null;
}

export interface OpenedLedgerView extends LedgerView {
  /** Closes the read-only connection. The opener owns it. */
  close(): void;
}

/** Whether the directory holds this run at all — the 404/200 decision. */
function holdsRun(db: Db, runId: RunId): boolean {
  // One indexed row is enough for the overwhelmingly common case, and it costs
  // a covering-index seek rather than the GROUP BY over the whole event table
  // that enumerating runs would.
  if (readRange(db, runId, 0, 1).events.length > 0) return true;
  // A run whose events have all been pruned, or one created but not yet
  // written to, is still a run. Rare, and the only path that pays for the scan.
  return listRunIds(db).includes(runId);
}

/** Opens a read-only view over `<dataDir>/ledger.db`. The file must exist. */
export function openLedgerView(dataDir: string): OpenedLedgerView {
  const db = openRead(join(dataDir, 'ledger.db'));
  return {
    runState: (runId) => (holdsRun(db, runId) ? replayRun(db, runId).state : null),
    tail: (runId, afterSeq, limit) => readRange(db, runId, afterSeq, limit).events,
    headSeq: () => ledgerHeadSeq(db),
    calibration: (provider, model, family) => {
      const row = readTokenCalibration(db, provider, model, family);
      return { n: row.samples, ratio: row.tokenEstimateFactor };
    },
    planVersion: (runId, version) => readPlanVersion(db, runId, version),
    planTransition: (runId, toVersion) => {
      const patched = readPlanPatchedEvent(db, runId, toVersion);
      const proposed =
        patched === null ? null : readPlanPatchProposedEvent(db, runId, patched.patchId);
      return joinPlanTransition(patched, proposed);
    },
    close: () => db.close(),
  };
}

/**
 * `runId` as a `RunId`, or `null` when the path segment is not one.
 *
 * A malformed id is a 404 and never a 500: `/api/runs/r1` is a request for a
 * run that does not exist, which is exactly what the caller needs to be told.
 */
export function asRunId(value: string): RunId | null {
  const parsed = RunIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

let view: LedgerView | null = null;

/** Called once, by boot, with the view the routes read through. */
export function setLedgerView(next: LedgerView): void {
  view = next;
}

/** Called on shutdown, so a route cannot read a closed connection. */
export function clearLedgerView(): void {
  view = null;
}

/**
 * The view, or `null` before boot has registered one — which a client can only
 * observe in a test that starts the HTTP server on its own, and which the
 * routes answer with a 503 rather than a crash.
 */
export function ledgerView(): LedgerView | null {
  return view;
}
