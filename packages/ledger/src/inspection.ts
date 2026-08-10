/**
 * KAR-15.6 — the two point reads the inspection surfaces need that nothing
 * else had asked for yet: the packet manifest of one node attempt, and the
 * `TaskSpec` a run is currently judged against.
 *
 * Both are *named* reads rather than cursor windows — `seq = (SELECT max(seq)
 * … )` over one node attempt, one run — which is the shape
 * `../test/append-only.test.ts` exempts for the same reason it exempts
 * `count(*)`: the result is one row and no cursor is left open over the rest
 * of the log. A fold would answer both and would replay a nine-hour run to do
 * it, which is the difference between an inspector panel that opens and one
 * that hangs.
 */
import type { ContextPacketRecord, Db, TaskSpec } from '@DeFlow/core';

interface PayloadRow {
  readonly payload: string;
}

/**
 * The **last** `context.built` for `(runId, nodeId, attempt)`.
 *
 * Last rather than first: a compaction boundary rebuilds the packet mid-turn
 * (KAR-09.6), and the manifest the inspector must show is the one the agent
 * was last given — showing the pre-compaction packet would explain a prompt
 * that no longer exists.
 */
const SELECT_CONTEXT_BUILT_SQL = `
  SELECT payload FROM event
  WHERE seq = (
    SELECT max(seq) FROM event
    WHERE run_id = ? AND node_id = ? AND attempt = ? AND kind = 'context.built'
  )
`;

export function readContextPacket(
  db: Db,
  runId: string,
  nodeId: string,
  attempt: number,
): ContextPacketRecord | null {
  const row = db.prepare<PayloadRow>(SELECT_CONTEXT_BUILT_SQL).get(runId, nodeId, attempt);
  if (row === undefined) return null;
  const payload = JSON.parse(row.payload) as { readonly packet?: ContextPacketRecord };
  return payload.packet ?? null;
}

/**
 * The `TaskSpec` in `run.created`, which is the run's original contract.
 *
 * A mid-run edit does **not** overwrite it — `spec.amended` carries the
 * amended *draft* and the sealed spec is `sealTaskSpec(document)`, so a caller
 * that needs the spec now in force seals the latest amendment itself
 * (`readLatestSpecAmendment`). Keeping the two apart here is the same
 * discipline KAR-10.3 AC5 states for the ledger: *"nothing is overwritten by
 * this event"*, and a reader that conflated them would lose the ability to say
 * which contract a verdict was judged against.
 */
const SELECT_RUN_CREATED_SQL = `
  SELECT payload FROM event
  WHERE seq = (
    SELECT min(seq) FROM event WHERE run_id = ? AND kind = 'run.created'
  )
`;

export function readRunCreatedSpec(db: Db, runId: string): TaskSpec | null {
  const row = db.prepare<PayloadRow>(SELECT_RUN_CREATED_SQL).get(runId);
  if (row === undefined) return null;
  const payload = JSON.parse(row.payload) as { readonly spec?: TaskSpec };
  return payload.spec ?? null;
}

/** Where and at what commit a run was created — `run.created`'s provenance. */
export interface RunOrigin {
  readonly cwd: string;
  readonly head: string;
  readonly branch: string;
}

/**
 * KAR-15.6 AC6 — the repository and the commit the run started from.
 *
 * `RunState` carries `repoRoot` and not the commit, because the commit is
 * provenance rather than a scheduling input and `decide()` has no use for it.
 * The cumulative diff does: *"what has this run done in total"* is measured
 * from the commit it began at, and measuring from `HEAD` instead would silently
 * answer the narrower question — what is uncommitted right now — with the
 * broader one's name.
 */
export function readRunOrigin(db: Db, runId: string): RunOrigin | null {
  const row = db.prepare<PayloadRow>(SELECT_RUN_CREATED_SQL).get(runId);
  if (row === undefined) return null;
  const payload = JSON.parse(row.payload) as {
    readonly cwd?: string;
    readonly repo?: { readonly head?: string; readonly branch?: string };
  };
  if (payload.cwd === undefined || payload.repo?.head === undefined) return null;
  return { cwd: payload.cwd, head: payload.repo.head, branch: payload.repo.branch ?? '' };
}

/**
 * The framed document of the most recent `spec.amended`, or `null`.
 *
 * Typed `unknown` rather than `unknown | null` because the union collapses:
 * the `null` is still the value returned when this run has no amendment, and
 * `currentSpec` in the daemon branches on it.
 */
const SELECT_SPEC_AMENDED_SQL = `
  SELECT payload FROM event
  WHERE seq = (
    SELECT max(seq) FROM event WHERE run_id = ? AND kind = 'spec.amended'
  )
`;

export function readLatestSpecAmendment(db: Db, runId: string): unknown {
  const row = db.prepare<PayloadRow>(SELECT_SPEC_AMENDED_SQL).get(runId);
  if (row === undefined) return null;
  const payload = JSON.parse(row.payload) as { readonly document?: unknown };
  return payload.document ?? null;
}

/**
 * KAR-15.6 AC6 — the verdict documents this run's gates produced, oldest
 * first, at most `limit`.
 *
 * `RunState.gateVerdicts` is the *ladder's* view of a verdict — the outcome,
 * the summary and the findings it decides admission on — and the acceptance
 * board needs the document, because a board row is decided by the verdict's
 * `criteria` entries and by the `specHash` it was judged against. Rather than
 * widen the projection (and grow `run.state_json` by a full verdict per gate
 * for every run), the board reads the events.
 *
 * A `run_id = ? AND seq > ?` cursor window with a `LIMIT`, which is the one
 * shape `../test/append-only.test.ts` admits for a non-aggregate read of
 * `event`.
 */
const SELECT_GATE_VERDICTS_SQL = `
  SELECT payload FROM event
  WHERE run_id = ? AND seq > ? AND kind = 'gate.evaluated'
  ORDER BY seq
  LIMIT ?
`;

export function readGateVerdicts(db: Db, runId: string, limit: number): unknown[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`readGateVerdicts: limit must be an integer >= 1, got ${limit}`);
  }
  return db
    .prepare<PayloadRow>(SELECT_GATE_VERDICTS_SQL)
    .all(runId, 0, limit)
    .flatMap((row) => {
      const payload = JSON.parse(row.payload) as { readonly verdict?: unknown };
      return payload.verdict === undefined ? [] : [payload.verdict];
    });
}
