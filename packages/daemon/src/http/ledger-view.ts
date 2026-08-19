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
import type {
  Calibration,
  ContextPacketRecord,
  Db,
  FactId,
  PlanGraph,
  QueuedPatch,
  RunId,
  RunState,
  TaintedRead,
  TaskSpec,
} from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import type {
  EventPage,
  FactConsumerRow,
  IoChunkPage,
  IoChunkSelector,
  NodeTiming,
  PlanPatchRow,
  PlanVersionRow,
  ProviderCapabilityRow,
  ProviderSettingRecord,
  RunOrigin,
  RunSnapshot,
  SnapshotSeq,
  StoredFact,
} from '@DeFlow/ledger';
import {
  headSeq as ledgerHeadSeq,
  runHeadSeq as ledgerRunHeadSeq,
  listPlanPatches,
  listPlanVersions,
  listProviderSettings,
  listRunIds,
  openRead,
  pendingPatchApprovals,
  readContextPacket,
  readEventTs,
  readFactConsumers,
  readFacts,
  readGateVerdicts,
  readGlobalRange,
  readIoChunks,
  readIoChunkTail,
  readLatestSpecAmendment,
  readNodeTiming,
  readPlanPatchedEvent,
  readPlanPatchProposedEvent,
  readPlanVersion,
  readProviderCapabilities,
  readRange,
  readRunCreatedSpec,
  readRunOrigin,
  readTaintedNodes,
  readTokenCalibration,
  replayRun,
  type StoredEvent,
  snapshotRunAt,
} from '@DeFlow/ledger';
import { join } from 'node:path';
import { joinPlanTransition, type PlanTransition } from '../plan/plan-history.ts';

export interface LedgerView {
  /**
   * The data directory this view reads — `ledger.db` and, beside it, the
   * content-addressed blob store `GET /api/artifacts/:sha` serves from.
   *
   * On the read port rather than fetched from the write ports, because the
   * blobs are part of what "the read side of the ledger" means: an artifact
   * endpoint that needed the write connection registered would be down for
   * exactly as long as the write path is.
   */
  readonly dataDir: string;
  /**
   * `runId`'s reduced state, or `null` when this directory holds no such run.
   *
   * Reduced on demand rather than read from a cache the daemon keeps in
   * memory: the projection is the ledger, and a served figure that came from
   * anywhere else is a figure a restart can disagree with.
   */
  runState(runId: RunId): RunState | null;
  /**
   * KAR-15.7 — the reduced state at `seq`: the greatest committed `seq` for
   * `runId` at or below the request, or the run's head for `'head'` and for a
   * request past it. `seq` is echoed on the result because `seq` has gaps and
   * a caller cannot otherwise tell which one it got.
   *
   * Reduced from `event` alone, through the same `reduce()` every other read
   * path uses — never a second projection, and never `io_chunk`.
   */
  runSnapshotAt(runId: RunId, seq: SnapshotSeq): RunSnapshot;
  /** Events for `runId` with `seq > afterSeq`, oldest first, at most `limit`. */
  tail(runId: RunId, afterSeq: number, limit: number): readonly StoredEvent[];
  /**
   * KAR-15.4 AC4 — the same window, plus whether another one follows it.
   *
   * `tail` for the stream and this for the hydrate endpoint, because the two
   * want different things from the same query: the drain loops until a batch
   * comes back empty and does not care, while a paging client needs `more`
   * *now* so it can stop looping and open the stream at the cursor. It costs no
   * second query — `readRange` asks for one row beyond the window and discards
   * it — so this is the same read with its answer kept rather than dropped.
   */
  tailPage(runId: RunId, afterSeq: number, limit: number): EventPage;
  /** The highest `seq` this ledger holds for `runId`; 0 when it holds none. */
  runHeadSeq(runId: RunId): number;
  /**
   * KAR-13.2 AC5 — the `runs=*` topic: events of `kinds` from **every** run
   * with `seq > afterSeq`. Filtered in SQL, so an idle tab pays for the four
   * lifecycle kinds it asked for rather than for the firehose it did not.
   */
  globalTail(afterSeq: number, kinds: readonly string[], limit: number): readonly StoredEvent[];
  /** Every run this directory holds — the approval queue's own iteration. */
  runIds(): readonly RunId[];
  /** The `ts` of one event, for the *age* an approval-queue row carries. */
  eventTs(seq: number): number | null;
  /** KAR-11.4 — the patches this run is waiting on a human about. */
  patches(runId: RunId): readonly QueuedPatch[];
  /** KAR-09.8 — the nodes that read a fact which has since been invalidated. */
  taints(runId: RunId): readonly TaintedRead[];
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
  /**
   * KAR-15.6 AC1 — the scrubber's version rail: every version this run
   * proposed, in order, at most `limit` of them.
   */
  planVersions(runId: RunId, limit: number): readonly PlanVersionRow[];
  /**
   * KAR-17.2 AC1 — every patch this run *proposed*, and what became of each.
   *
   * The half of the scrubber's rail `planVersions` structurally cannot answer:
   * a refused patch produces no version, so it has no tick, and *"the proposal
   * is recorded even when it was refused"* would be a property of the ledger no
   * client could read.
   */
  planPatches(runId: RunId, limit: number): readonly PlanPatchRow[];
  /** KAR-15.6 AC3 — when a node first started and last stopped. */
  nodeTiming(runId: RunId, nodeId: string): NodeTiming;
  /** KAR-15.6 AC3 — the packet manifest one node attempt was built with. */
  contextPacket(runId: RunId, nodeId: string, attempt: number): ContextPacketRecord | null;
  /** KAR-15.6 AC4 — one forward page of a node attempt's output. */
  ioPage(selector: IoChunkSelector, afterSeq: number, limit: number): IoChunkPage;
  /** KAR-15.6 AC4 — the **last** `limit` chunks, read off the end of the index. */
  ioTail(selector: IoChunkSelector, limit: number): IoChunkPage;
  /** KAR-15.6 AC5 — every fact of one run, invalidated ones included. */
  facts(runId: RunId): readonly StoredFact[];
  /** KAR-15.6 AC5 — every node with a `fact.read` for `factId`, and no writer. */
  factConsumers(factId: FactId, limit: number): readonly FactConsumerRow[];
  /**
   * KAR-15.6 AC6 — the run's original `TaskSpec` and the latest amended
   * document, which the caller seals to get the contract now in force.
   */
  runSpec(runId: RunId): { readonly created: TaskSpec | null; readonly amended: unknown };
  /**
   * KAR-15.6 AC3, AC8 — the capability rows this data directory holds for a
   * provider, newest probe first.
   */
  providerCapabilities(provider: string): readonly ProviderCapabilityRow[];
  /**
   * KAR-25.3 AC3 — every runtime this data directory has an explicit
   * enable/disable setting for (`provider_setting`, migration 0018). A
   * provider absent from this list has never been toggled and reads as
   * enabled everywhere this is consulted (`GET /providers`'s own reducer).
   */
  providerSettings(): readonly ProviderSettingRecord[];
  /**
   * KAR-15.6 AC6 — the verdict *documents* this run's gates produced, which
   * the acceptance board reduces. `RunState.gateVerdicts` carries the ladder's
   * view of the same verdicts and not the documents.
   */
  gateVerdictDocuments(runId: RunId, limit: number): readonly unknown[];
  /**
   * KAR-15.6 AC6 — the repository and commit `run.created` recorded, which the
   * cumulative diff is measured from.
   */
  runOrigin(runId: RunId): RunOrigin | null;
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
    dataDir,
    runState: (runId) => (holdsRun(db, runId) ? replayRun(db, runId).state : null),
    runSnapshotAt: (runId, seq) => snapshotRunAt(db, runId, seq),
    tail: (runId, afterSeq, limit) => readRange(db, runId, afterSeq, limit).events,
    tailPage: (runId, afterSeq, limit) => readRange(db, runId, afterSeq, limit),
    runHeadSeq: (runId) => ledgerRunHeadSeq(db, runId),
    globalTail: (afterSeq, kinds, limit) => readGlobalRange(db, afterSeq, kinds, limit).events,
    runIds: () => listRunIds(db),
    eventTs: (seq) => readEventTs(db, seq),
    patches: (runId) => pendingPatchApprovals(db, runId),
    taints: (runId) => readTaintedNodes(db, runId),
    headSeq: () => ledgerHeadSeq(db),
    calibration: (provider, model, family) => {
      const row = readTokenCalibration(db, provider, model, family);
      return { n: row.samples, ratio: row.tokenEstimateFactor };
    },
    planVersion: (runId, version) => readPlanVersion(db, runId, version),
    planVersions: (runId, limit) => listPlanVersions(db, runId, limit),
    planPatches: (runId, limit) => listPlanPatches(db, runId, limit),
    nodeTiming: (runId, nodeId) => readNodeTiming(db, runId, nodeId),
    contextPacket: (runId, nodeId, attempt) => readContextPacket(db, runId, nodeId, attempt),
    ioPage: (selector, afterSeq, limit) => readIoChunks(db, selector, afterSeq, limit),
    ioTail: (selector, limit) => readIoChunkTail(db, selector, limit),
    facts: (runId) => readFacts(db, runId),
    factConsumers: (factId, limit) => readFactConsumers(db, factId, limit),
    runSpec: (runId) => ({
      created: readRunCreatedSpec(db, runId),
      amended: readLatestSpecAmendment(db, runId),
    }),
    providerCapabilities: (provider) => readProviderCapabilities(db, provider),
    providerSettings: () => listProviderSettings(db),
    gateVerdictDocuments: (runId, limit) => readGateVerdicts(db, runId, limit),
    runOrigin: (runId) => readRunOrigin(db, runId),
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
