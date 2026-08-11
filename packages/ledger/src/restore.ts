/**
 * KAR-16.5 — restoring a recorded run into a ledger of its own
 * (docs/03-local-development.md §6.2).
 *
 * `DeFlow replay` serves the **normal** `/api/*` routes, and every one of them
 * reads SQLite. So a fixture is made servable by being restored into a real
 * `ledger.db` rather than by teaching the HTTP layer to read NDJSON: the UI
 * cannot tell a replay from a live run *because there is no difference* — the
 * daemon it is talking to is a daemon, reading a ledger, over the same read
 * port and the same serving loop.
 *
 * ## Why this is not a third writer
 *
 * `./append.ts` opens by saying there will never be a third function that
 * writes, and it means it: `seq` is an event's identity *outside* the database
 * (an SSE frame id, a checkpoint's `last_seq`, a browser tab's cursor), so a
 * writer that can choose `seq` is a writer that can make a cursor lie. This
 * function is allowed to choose `seq` under one condition, checked with the
 * write lock held: **every recorded `seq` must be strictly ahead of the
 * ledger's head.** It can extend a ledger; it can never edit one, and it can
 * never write into a hole a client has already scrolled past. Playback uses
 * that to commit a recording in slices — each slice ahead of the last — which
 * is how a fixture reaches a browser over time rather than all at once.
 *
 * ## The holes are the point
 *
 * The recorded `seq` is preserved exactly, gaps included. `seq` is one global
 * `AUTOINCREMENT` shared by every run in a data directory, so one run's cursor
 * walks a strided subsequence of it (docs/11-api-and-realtime.md §4.2), and the
 * `crash-resume-seq-gap` fixture — 4, 5, 7, 8, 11 — exists precisely so a
 * client that treats a hole as data loss is caught. A restore that renumbered
 * would destroy the only fixture that can catch it.
 *
 * ## The plan table
 *
 * The `event` export is complete for every read path in the API except one: the
 * content-addressed `plan` table, which `GET /api/runs/:id/plans/:version`
 * resolves through. The document is carried inline on `plan.proposed`, so
 * restoring it is a **re-file of the same bytes under the same address** — the
 * hash is recomputed and must match, exactly as `persistPlanVersion` does it,
 * so a change to the hasher fails the restore instead of quietly filing a
 * document under an address that no longer addresses it.
 */
import {
  canonicalJson,
  type Db,
  type DbStatement,
  EventEnvelopeSchema,
  type PlanGraph,
  type RunId,
} from '@DeFlow/core';
import { committing } from './notify.ts';
import { sealRecordedPlan, storeRecordedPlanDoc } from './plans.ts';

/** One recorded envelope, as a fixture file carries it. */
export type RecordedEvent = {
  readonly seq: number;
  readonly runId: RunId;
  readonly ts: number;
  readonly kind: string;
  readonly v: number;
  readonly epoch: number;
  readonly nodeId?: string;
  readonly attempt?: number;
  readonly ikey?: string;
  readonly payload: unknown;
};

/** A restore aimed at or below a ledger's head. */
export class SeqNotAhead extends Error {
  constructor(seq: number, head: number) {
    super(
      `recorded seq ${seq} is not ahead of this ledger's head (${head}), so nothing was ` +
        'restored. Restoring chooses `seq` explicitly and may therefore only ever *extend* a ' +
        'ledger: writing at or below the head would rewrite history under a client whose ' +
        'cursor is already past it, and `event` is append-only precisely so that cannot ' +
        'happen. Replay a recording into a data directory of its own.',
    );
    this.name = 'SeqNotAhead';
  }
}

/** An envelope the restore boundary refused. Nothing at all was written. */
export class InvalidRecordedEvent extends Error {
  readonly index: number;

  constructor(index: number, issues: readonly string[]) {
    super(
      `recorded event ${index} is not a valid envelope, so none of the recording was restored: ` +
        `${issues.join('; ')}. Fixtures are exports of a real ledger — rebuild this one from the ` +
        'script its README names rather than editing the file.',
    );
    this.name = 'InvalidRecordedEvent';
    this.index = index;
  }
}

export interface RestoredLedger {
  readonly restored: number;
  /** The highest `seq` written — the head the fully-played fixture reaches. */
  readonly headSeq: number;
  readonly runIds: readonly RunId[];
}

const INSERT_RECORDED = `INSERT INTO event (seq, run_id, ts, kind, v, epoch, node_id, attempt, ikey, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const HEAD_SEQ = 'SELECT max(seq) AS head FROM event';

/** The plan document a `plan.proposed` carries inline, when it carries one. */
function planDocOf(event: RecordedEvent): PlanGraph | null {
  if (event.kind !== 'plan.proposed') return null;
  const payload = event.payload as { readonly graph?: unknown } | null;
  const graph = payload?.graph;
  if (graph === null || typeof graph !== 'object') return null;
  return graph as PlanGraph;
}

/**
 * Restores `events` into `db`, preserving every recorded `seq`.
 *
 * Async because the plan documents are re-addressed by the production hasher
 * before anything is written: hashing is the one part of this that cannot
 * happen inside SQLite's write transaction, and doing it first means a
 * recording with a document that no longer addresses its own hash leaves no
 * residue at all.
 */
export async function restoreRecordedEvents(
  db: Db,
  events: readonly RecordedEvent[],
): Promise<RestoredLedger> {
  const validated = events.map((event, index) => {
    const parsed = EventEnvelopeSchema.safeParse(event);
    if (!parsed.success) {
      throw new InvalidRecordedEvent(
        index,
        parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
      );
    }
    return parsed.data as RecordedEvent;
  });

  // Re-address every carried plan document before the transaction opens, and
  // through `./plans.ts` — the one module allowed to write that table
  // (KAR-11.2 AC9). `sealRecordedPlan` throws `PlanHashMismatch` if a recorded
  // document no longer addresses the hash the event filed it under.
  const plans: { hash: string; runId: string; createdAt: number; doc: string }[] = [];
  for (const event of validated) {
    const graph = planDocOf(event);
    if (graph === null) continue;
    plans.push({
      hash: graph.planHash,
      runId: event.runId,
      createdAt: event.ts,
      doc: await sealRecordedPlan(graph),
    });
  }

  const runIds: RunId[] = [];
  const seen = new Set<string>();
  for (const event of validated) {
    if (seen.has(event.runId)) continue;
    seen.add(event.runId);
    runIds.push(event.runId);
  }

  // `committing` rather than `db.transaction`: the SSE loop parks on the
  // post-commit signal, and a restore that did not fire it would leave an
  // already-open stream waiting for its own fallback tick (./notify.ts).
  committing(db, () => {
    // Read inside the transaction, so the write lock is already held and no
    // other connection can move the head between this check and the inserts.
    const held: DbStatement<{ head: number | null }> = db.prepare(HEAD_SEQ);
    const head = held.get()?.head ?? 0;
    const first = validated[0];
    if (first !== undefined && first.seq <= head) throw new SeqNotAhead(first.seq, head);

    const insert = db.prepare(INSERT_RECORDED);
    for (const event of validated) {
      insert.run(
        event.seq,
        event.runId,
        event.ts,
        event.kind,
        event.v,
        event.epoch,
        event.nodeId ?? null,
        event.attempt ?? null,
        event.ikey ?? null,
        canonicalJson(event.payload),
      );
    }

    for (const plan of plans) storeRecordedPlanDoc(db, plan);
  });

  return {
    restored: validated.length,
    headSeq: validated.at(-1)?.seq ?? 0,
    runIds,
  };
}
