/**
 * KAR-09.8 — the blackboard: `fact` and `fact_edges` as a materialised view of
 * the `fact.*` events, and the only module in the workspace that writes them
 * (docs/08-context-and-memory.md §8, docs/04-domain-model.md §5).
 *
 * > If the blackboard ever becomes independently mutable, NF9 and NF10 are both
 * > gone — this is the constraint, not a preference.
 *
 * Everything below follows from that one sentence.
 *
 * **There is no setter.** `writeFact`, `resolveDeclaredReads` and
 * `invalidateFact` all do the same two things in the same order: append an
 * event, then apply that event to the tables through `projectFactEvent` — the
 * same function `rebuildBlackboard` calls when it replays from seq 0. A live
 * write and a replayed write therefore cannot disagree, because they are the
 * same code path reached from two directions. `test/blackboard-projection-only.
 * test.ts` greps the workspace for the helper that would break this, because
 * that helper arrives disguised as a fan-out optimisation and looks reasonable
 * in review.
 *
 * The seam that follows from that: a component which appends a `fact.*` event
 * by some *other* route owes the stored event to `projectFactEvent`, or the
 * tables are behind the ledger until the next `rebuildBlackboard`. One such
 * route exists today — the MCP `read_fact` tool (KAR-05.6) appends `fact.read`
 * through the async `LedgerSink` port rather than a `Db` — and it is wired up
 * when `boot` gives that host a real `FactStore` (`readFactByKey` below).
 * Being behind is recoverable by construction; being a second source of truth
 * would not be.
 *
 * **Taint is derived, never stored.** A `fact.invalidated` event marks the fact
 * row with the seq that invalidated it; *which* nodes are tainted is then one
 * indexed query — `direction = 'read' AND event_seq < invalidated_by` — asked
 * fresh on every read. Storing the answer instead would make a rebuild produce
 * a different list than the live run did the moment a node reads the fact after
 * the invalidation (EPIC-09-S44), which is precisely the case the rule exists
 * for. The `taints` array on the event is a record of what was true when it was
 * appended, not the projection's input.
 *
 * **Nothing here re-runs anything.** `readTaintedNodes` produces approval-queue
 * items (F8.3, KAR-13.2's `tainted` kind) and that is the whole response to an
 * invalidation. Auto-re-running is how a system loops forever for reasons no
 * human can reconstruct, and it interacts badly with F4.6's budget ceilings.
 *
 * **No `spillTo`.** A fact whose event payload exceeds the inline ceiling is
 * refused at the append boundary rather than spilled into the blob store: a
 * spilled payload is a `BlobRef` in the row, and a rebuild reading that row
 * back could not reconstruct the fact from the ledger alone. Refusing keeps
 * "droppable and rebuildable" true without qualification.
 */
import type {
  AcceptFactError,
  Db,
  EventSeq,
  Fact,
  FactId,
  FactSchemaRegistry,
  NodeId,
  ReadDecl,
  RunId,
} from '@DeFlow/core';
import { acceptFact, canonicalJson, EVENT_SCHEMAS, parseEvent, satisfies } from '@DeFlow/core';
import { appendEvents, type EventDraft } from './append.ts';
import { drainEvents } from './drain.ts';
import { listRunIds } from './open-and-replay.ts';

/* -------------------------------------------------------------------------- *
 * The schema
 * -------------------------------------------------------------------------- */

/**
 * The projection's DDL, as live code.
 *
 * Migration 0011 holds a frozen copy of exactly these statements — a shipped
 * migration is never edited, so it cannot import this constant, and this
 * constant cannot be the migration. `test/integration/blackboard-rebuild.test.
 * ts` compares `sqlite_master` after a migration against `sqlite_master` after
 * a rebuild, which is what keeps the two the same shape. If the shape ever has
 * to change, ship migration 0012 *and* update this: a projection that can only
 * be rebuilt into a different table than it came from is not a projection.
 *
 * `fact_edges` carries the four columns docs/08-context-and-memory.md §8.1
 * documents, plus `run_id`. The extra column is not a second home for
 * anything — it is copied from the event envelope like every other column here
 * — and without it the memory graph of one run would have to join every edge
 * back through `fact` to find out whose it was, on a `node_id` that is only
 * unique within a run.
 */
export const BLACKBOARD_SCHEMA: readonly string[] = [
  `CREATE TABLE fact (
        fact_id            TEXT    NOT NULL PRIMARY KEY,
        run_id             TEXT    NOT NULL,
        key                TEXT    NOT NULL,
        kind               TEXT    NOT NULL,
        schema_id          TEXT    NOT NULL,
        value              TEXT    NOT NULL,
        by_node            TEXT    NOT NULL,
        by_provider        TEXT    NOT NULL,
        by_model           TEXT    NOT NULL,
        from_evidence      TEXT    NOT NULL,
        at_event           INTEGER NOT NULL,
        at                 TEXT    NOT NULL,
        confidence         TEXT    NOT NULL CHECK (confidence IN ('asserted','verified','speculative')),
        supersedes         TEXT,
        invalidated_by     INTEGER,
        invalidated_reason TEXT,
        written_seq        INTEGER NOT NULL
      ) STRICT`,
  'CREATE INDEX fact_by_run_key ON fact(run_id, key, at_event)',
  `CREATE TABLE fact_edges (
        fact_id   TEXT    NOT NULL,
        run_id    TEXT    NOT NULL,
        node_id   TEXT    NOT NULL,
        direction TEXT    NOT NULL CHECK (direction IN ('read','write')),
        event_seq INTEGER NOT NULL
      ) STRICT`,
  'CREATE INDEX fact_edges_by_fact ON fact_edges(fact_id, event_seq)',
  'CREATE INDEX fact_edges_by_node ON fact_edges(node_id, event_seq)',
];

/** Creates the two tables and their three indexes. @see BLACKBOARD_SCHEMA */
export function createBlackboardTables(db: Db): void {
  for (const statement of BLACKBOARD_SCHEMA) db.exec(statement);
}

/* -------------------------------------------------------------------------- *
 * Rows, as callers read them
 * -------------------------------------------------------------------------- */

/** One fact, with the two things the row knows and the `Fact` does not. */
export interface StoredFact {
  readonly runId: RunId;
  /**
   * The `seq` of the `fact.written` event that put it here — what a context
   * segment records as its `sourceEvent`, so "this fact entered this packet
   * because node X wrote it at seq N" stays a field lookup (F6.2).
   */
  readonly writtenSeq: EventSeq;
  /** Why it was invalidated, or `null`. `fact.invalidatedBy` carries when. */
  readonly invalidatedReason: string | null;
  readonly fact: Fact;
}

export type FactEdgeDirection = 'read' | 'write';

/** One edge of F10.4's memory graph. */
export interface FactEdgeRow {
  readonly runId: RunId;
  readonly factId: FactId;
  readonly node: NodeId;
  readonly direction: FactEdgeDirection;
  readonly eventSeq: EventSeq;
}

/**
 * One approval-queue item (F8.3): a node that consumed a fact which has since
 * been invalidated.
 *
 * `kind` is KAR-13.2's queue vocabulary and `seq` is the event that created the
 * item, so the row deep-links to the invalidation rather than to the node —
 * NF10's requirement that every queue row be traceable to its event.
 */
export interface TaintedNode {
  readonly kind: 'tainted';
  readonly runId: RunId;
  readonly node: NodeId;
  readonly taint: 'stale-input';
  readonly factId: FactId;
  readonly key: string;
  readonly reason: string;
  /** The `fact.invalidated` event's seq — the item's creating event. */
  readonly seq: EventSeq;
  /** When this node read the fact. Always strictly less than `seq`. */
  readonly readAtSeq: EventSeq;
}

/* -------------------------------------------------------------------------- *
 * The projection
 * -------------------------------------------------------------------------- */

export const FACT_EVENT_KINDS = ['fact.written', 'fact.read', 'fact.invalidated'] as const;

export type FactEventKind = (typeof FACT_EVENT_KINDS)[number];

export function isFactEventKind(kind: string): kind is FactEventKind {
  return (FACT_EVENT_KINDS as readonly string[]).includes(kind);
}

/** The three events this projection folds, at the shape it needs them. */
interface FactEventBase {
  readonly seq: EventSeq;
  readonly runId: RunId;
}

type FactEvent =
  | (FactEventBase & { readonly kind: 'fact.written'; readonly payload: { readonly fact: Fact } })
  | (FactEventBase & {
      readonly kind: 'fact.read';
      readonly payload: { readonly factId: FactId; readonly key: string; readonly by: NodeId };
    })
  | (FactEventBase & {
      readonly kind: 'fact.invalidated';
      readonly payload: {
        readonly factId: FactId;
        readonly by: NodeId;
        readonly reason: string;
        readonly taints: readonly NodeId[];
      };
    });

const INSERT_FACT = `INSERT INTO fact (
    fact_id, run_id, key, kind, schema_id, value,
    by_node, by_provider, by_model, from_evidence, at_event, at, confidence,
    supersedes, invalidated_by, invalidated_reason, written_seq
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (fact_id) DO NOTHING`;

const INSERT_EDGE = `INSERT INTO fact_edges (fact_id, run_id, node_id, direction, event_seq)
  VALUES (?, ?, ?, ?, ?)`;

/**
 * `AND invalidated_by IS NULL`: the first invalidation is the one that counts.
 * A second `fact.invalidated` for a fact already invalidated changes nothing —
 * moving the seq forward would un-taint every node that read it in between,
 * which is the opposite of what a second report of the same staleness means.
 */
const MARK_INVALIDATED = `UPDATE fact
     SET invalidated_by = ?, invalidated_reason = ?
   WHERE fact_id = ? AND invalidated_by IS NULL`;

/**
 * Folds one `fact.*` event into the tables.
 *
 * The whole of the write path, reached identically from a live append and from
 * a replay. `ON CONFLICT DO NOTHING` on the fact row is the immutability rule
 * as SQL: a fact is never edited, and a correction is a *new* fact whose
 * `supersedes` names the old one (§5.1).
 */
export function projectFactEvent(db: Db, event: FactEvent): void {
  switch (event.kind) {
    case 'fact.written': {
      const { fact } = event.payload;
      const { provenance } = fact;
      db.prepare(INSERT_FACT).run(
        fact.id,
        event.runId,
        fact.key,
        fact.kind,
        fact.schemaId,
        // `?? null` rather than a throw: an absent value cannot reach here —
        // `appendEvents` canonicalises the payload before this runs — and
        // encoding it as JSON null keeps the column NOT NULL honest.
        canonicalJson(fact.value ?? null),
        provenance.byNode,
        provenance.byProvider,
        provenance.byModel,
        canonicalJson(provenance.fromEvidence),
        provenance.atEvent,
        provenance.at,
        provenance.confidence,
        fact.supersedes ?? null,
        fact.invalidatedBy ?? null,
        null,
        event.seq,
      );
      // The write edge exists because the fact was written. Nothing else has
      // to remember to record it, which is what makes F10.4's graph complete
      // rather than as complete as the last person to touch the writer.
      db.prepare(INSERT_EDGE).run(fact.id, event.runId, provenance.byNode, 'write', event.seq);
      return;
    }

    case 'fact.read':
      db.prepare(INSERT_EDGE).run(
        event.payload.factId,
        event.runId,
        event.payload.by,
        'read',
        event.seq,
      );
      return;

    case 'fact.invalidated':
      // The seq, not the taint list: who is tainted is derived from this
      // number and the read edges, every time it is asked for.
      db.prepare(MARK_INVALIDATED).run(event.seq, event.payload.reason, event.payload.factId);
      return;
  }
}

export interface BlackboardRebuild {
  /** How many `fact.*` events were folded. */
  readonly applied: number;
  /** Rows whose payload this build could not read; they changed nothing. */
  readonly unreadable: number;
}

/**
 * Drops both tables and rebuilds them from the ledger, from seq 0.
 *
 * This is AC2's test made executable, and the daemon's repair path for a
 * blackboard that a partial write or a botched migration left doubtful: the
 * cost of throwing it away is one scan of `event`, and the cost of trusting a
 * projection that might be wrong is unbounded.
 */
export function rebuildBlackboard(db: Db): BlackboardRebuild {
  return db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS fact_edges');
    db.exec('DROP TABLE IF EXISTS fact');
    createBlackboardTables(db);

    let applied = 0;
    let unreadable = 0;
    for (const runId of listRunIds(db)) {
      for (const stored of drainEvents(db, runId)) {
        if (!isFactEventKind(stored.kind)) continue;
        const parsed = parseEvent(stored);
        if (parsed.status !== 'ok') {
          // The `event` table is append-only, so a row a future build wrote
          // and this one cannot read is permanent. Counting it and moving on
          // is the only behaviour that leaves the ledger openable.
          unreadable += 1;
          continue;
        }
        projectFactEvent(db, parsed.event as FactEvent);
        applied += 1;
      }
    }
    return { applied, unreadable };
  });
}

/* -------------------------------------------------------------------------- *
 * Reads
 * -------------------------------------------------------------------------- */

/**
 * The reads below carry no `LIMIT`, and that is a claim about the data rather
 * than an oversight: a run's blackboard is tens of facts — one per finding,
 * decision, scope and verdict a plan produces — served by `fact_by_run_key`,
 * where `event` and `io_chunk` grow with every token an agent emits. The rule
 * `test/bounded-reads.test.ts` enforces is about reads whose *size is the
 * ledger's size*, and if that ever becomes true of `fact`, these want the same
 * bounded drain the event log uses.
 */
const FACT_COLUMNS = `fact_id, run_id, key, kind, schema_id, value,
    by_node, by_provider, by_model, from_evidence, at_event, at, confidence,
    supersedes, invalidated_by, invalidated_reason, written_seq`;

/**
 * Ordered by `at_event` — never by `at`, which is a wall clock (§5.2).
 *
 * Two facts can share an `at_event`: a node that writes three findings from
 * one turn stamps all three with the same event. `written_seq` breaks the tie
 * with the ledger's own total order, which is the only tie-break that is both
 * stable across a rebuild and meaningful to a reader; `fact_id` after it is
 * there so the order is total even for two facts appended in one batch.
 */
const READ_FACTS_SQL = `SELECT ${FACT_COLUMNS} FROM fact
   WHERE run_id = ? ORDER BY at_event, written_seq, fact_id`;

const READ_EDGES_SQL = `SELECT fact_id, run_id, node_id, direction, event_seq FROM fact_edges
   WHERE run_id = ? ORDER BY event_seq, fact_id, node_id, direction`;

/**
 * §8.2's query, verbatim: the consumer set of a fact is one indexed read, and
 * `<` is the whole of the taint rule. `min(event_seq)` is the read that made
 * the node a consumer — a node that read the same fact twice is one item in
 * the queue, dated by the first time it looked.
 */
const READERS_BEFORE_SQL = `SELECT node_id, min(event_seq) AS read_seq FROM fact_edges
   WHERE fact_id = ? AND direction = 'read' AND event_seq < ?
   GROUP BY node_id ORDER BY min(event_seq), node_id`;

const INVALIDATED_FACTS_SQL = `SELECT fact_id, key, invalidated_by, invalidated_reason FROM fact
   WHERE run_id = ? AND invalidated_by IS NOT NULL
   ORDER BY invalidated_by, fact_id`;

interface FactDbRow {
  readonly fact_id: string;
  readonly run_id: string;
  readonly key: string;
  readonly kind: string;
  readonly schema_id: string;
  readonly value: string;
  readonly by_node: string;
  readonly by_provider: string;
  readonly by_model: string;
  readonly from_evidence: string;
  readonly at_event: number;
  readonly at: string;
  readonly confidence: string;
  readonly supersedes: string | null;
  readonly invalidated_by: number | null;
  readonly invalidated_reason: string | null;
  readonly written_seq: number;
}

/**
 * A row back into the `Fact` it was projected from.
 *
 * Not re-validated through `FactSchema`: every row here came from a payload
 * that was validated by `acceptFact` on the way in and by `parseEvent` on the
 * way back, and validating a third time on every read would spend the cost of
 * the guarantee twice without adding one.
 */
function toStoredFact(row: FactDbRow): StoredFact {
  const fact = {
    id: row.fact_id,
    key: row.key,
    kind: row.kind,
    schemaId: row.schema_id,
    value: JSON.parse(row.value) as unknown,
    provenance: {
      byNode: row.by_node,
      byProvider: row.by_provider,
      byModel: row.by_model,
      fromEvidence: JSON.parse(row.from_evidence) as unknown,
      atEvent: row.at_event,
      at: row.at,
      confidence: row.confidence,
    },
    ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
    ...(row.invalidated_by === null ? {} : { invalidatedBy: row.invalidated_by }),
  } as unknown as Fact;

  return {
    runId: row.run_id as RunId,
    writtenSeq: row.written_seq as EventSeq,
    invalidatedReason: row.invalidated_reason,
    fact,
  };
}

/** Every fact of one run, invalidated and superseded ones included — history
 * is never rewritten, so nothing here filters it (AC9). */
export function readFacts(db: Db, runId: RunId): StoredFact[] {
  return db.prepare<FactDbRow>(READ_FACTS_SQL).all(runId).map(toStoredFact);
}

/**
 * The facts a read can currently resolve to: everything except a fact another
 * one supersedes.
 *
 * An **invalidated** fact is deliberately still live. EPIC-09-S44 has a node
 * reading a fact after its invalidation and expects that read to happen and to
 * *not* be tainted — the fact is stale, not deleted, and hiding it would leave
 * the reading node with nothing while claiming the read succeeded.
 */
function liveFacts(stored: readonly StoredFact[]): StoredFact[] {
  const superseded = new Set(
    stored.map((entry) => entry.fact.supersedes).filter((id): id is FactId => id !== undefined),
  );
  return stored.filter((entry) => !superseded.has(entry.fact.id));
}

/** The fact currently visible under `key`, or `null` — the newest by
 * `atEvent`, which is what a superseding fact is. */
export function readFactByKey(db: Db, runId: RunId, key: string): StoredFact | null {
  const matches = liveFacts(readFacts(db, runId)).filter((entry) => entry.fact.key === key);
  return matches.at(-1) ?? null;
}

/** Every edge of one run's memory graph, in event order. F10.4 is this query
 * and no other instrumentation. */
export function readFactEdges(db: Db, runId: RunId): FactEdgeRow[] {
  return db
    .prepare<{
      fact_id: string;
      run_id: string;
      node_id: string;
      direction: string;
      event_seq: number;
    }>(READ_EDGES_SQL)
    .all(runId)
    .map((row) => ({
      runId: row.run_id as RunId,
      factId: row.fact_id as FactId,
      node: row.node_id as NodeId,
      direction: row.direction as FactEdgeDirection,
      eventSeq: row.event_seq as EventSeq,
    }));
}

/** Every node that read `factId` at a seq **strictly earlier** than
 * `beforeSeq`, oldest read first. @see READERS_BEFORE_SQL */
export function readersBefore(
  db: Db,
  factId: FactId,
  beforeSeq: number,
): { node: NodeId; readAtSeq: EventSeq }[] {
  return db
    .prepare<{ node_id: string; read_seq: number }>(READERS_BEFORE_SQL)
    .all(factId, beforeSeq)
    .map((row) => ({ node: row.node_id as NodeId, readAtSeq: row.read_seq as EventSeq }));
}

/**
 * The `tainted` items of the F8.3 approval queue for one run, oldest
 * invalidation first.
 *
 * This is the entire automatic response to an invalidation. Nothing here
 * schedules, retries or re-runs: the F2.5 patch policy is the only thing that
 * may propose a re-run, and a human is the only thing that may accept one.
 */
export function readTaintedNodes(db: Db, runId: RunId): TaintedNode[] {
  const invalidated = db
    .prepare<{
      fact_id: string;
      key: string;
      invalidated_by: number;
      invalidated_reason: string | null;
    }>(INVALIDATED_FACTS_SQL)
    .all(runId);

  return invalidated.flatMap((row) =>
    readersBefore(db, row.fact_id as FactId, row.invalidated_by).map((reader) => ({
      kind: 'tainted' as const,
      runId,
      node: reader.node,
      taint: 'stale-input' as const,
      factId: row.fact_id as FactId,
      key: row.key,
      reason: row.invalidated_reason ?? '',
      seq: row.invalidated_by as EventSeq,
      readAtSeq: reader.readAtSeq,
    })),
  );
}

/* -------------------------------------------------------------------------- *
 * Writes — each one an append, then the same projection
 * -------------------------------------------------------------------------- */

/** The envelope fields a caller supplies for the events these functions
 * append. `seq` is the ledger's to assign and nothing upstream may guess it. */
export interface FactEventEnvelope {
  readonly runId: RunId;
  /** ms epoch, from the injected `Clock` — never `Date.now()` in engine code. */
  readonly ts: number;
  readonly epoch: number;
  readonly attempt?: number;
}

export type WriteFactResult =
  | { readonly ok: true; readonly seq: EventSeq; readonly fact: Fact }
  | { readonly ok: false; readonly error: AcceptFactError };

const draftOf = (
  envelope: FactEventEnvelope,
  kind: FactEventKind,
  nodeId: NodeId,
  payload: unknown,
): EventDraft => ({
  runId: envelope.runId,
  ts: envelope.ts,
  kind,
  v: EVENT_SCHEMAS[kind].v,
  epoch: envelope.epoch,
  nodeId,
  ...(envelope.attempt === undefined ? {} : { attempt: envelope.attempt }),
  payload,
});

/**
 * Accepts a candidate fact and, if it passes, appends `fact.written` and
 * projects it — in that order, in one transaction.
 *
 * Acceptance (KAR-02.8) runs **before** the append and never throws: the
 * `event` table cannot be repaired, so a fact whose value does not satisfy its
 * `schemaId`, or whose `schemaId` is not registered in `.DeFlow/schemas/`,
 * must be refused at the door rather than discovered by a reducer later. The
 * refusal is a value the caller records (AC4, AC5).
 */
export function writeFact(
  db: Db,
  registry: FactSchemaRegistry,
  candidate: unknown,
  envelope: FactEventEnvelope,
): WriteFactResult {
  const accepted = acceptFact(candidate, registry);
  if (!accepted.ok) return { ok: false, error: accepted.error };

  const { fact } = accepted;
  return db.transaction(() => {
    const [seq] = appendEvents(db, [
      draftOf(envelope, 'fact.written', fact.provenance.byNode, { fact }),
    ]);
    if (seq === undefined) throw new Error('appending fact.written returned no seq');
    projectFactEvent(db, { kind: 'fact.written', seq, runId: envelope.runId, payload: { fact } });
    return { ok: true, seq, fact };
  });
}

/** One fact a node's declared read resolved to. */
export interface ResolvedFactRead {
  readonly fact: Fact;
  /**
   * The `fact.written` event — what the resulting context segment records as
   * its `sourceEvent`. Never the `fact.read` event: a segment that pointed at
   * its own read would claim every fact came from the node that consumed it.
   */
  readonly sourceEvent: EventSeq;
  /** The `fact.read` event this resolution appended. */
  readonly readSeq: EventSeq;
}

export interface ResolveReadsOptions extends FactEventEnvelope {
  /** The node whose packet is being assembled. */
  readonly by: NodeId;
  /** Its declared reads, verbatim. Non-`fact` kinds are ignored here: a
   * `spec` read is pinned and an `artifact` read is content-addressed, so
   * neither is a blackboard lookup. */
  readonly reads: readonly ReadDecl[];
}

/**
 * Resolves a node's declared fact reads against the blackboard, appending one
 * `fact.read` per resolved fact.
 *
 * AC6, and the reason the memory graph needs no instrumentation: the edges
 * exist *because the packet was built*, not because a call site remembered to
 * log. A fact the budget later demotes to a handle keeps its edge — it was
 * read, the agent can pull it, and pretending otherwise would make F10.4
 * under-report (EPIC-09-S45 scenario 3).
 *
 * Matching goes through `satisfies` from `@DeFlow/core`, which is the same
 * function plan-time validation uses. Two implementations of "does
 * `finding/*` match this key" is exactly how a plan that validates can fail to
 * resolve at run time.
 */
export function resolveDeclaredReads(
  db: Db,
  options: ResolveReadsOptions,
): readonly ResolvedFactRead[] {
  const keys = options.reads.filter((read) => read.kind === 'fact').map((read) => read.key);
  if (keys.length === 0) return [];

  return db.transaction(() => {
    // Selection is inside the transaction with the rest: a fact written
    // between "what matches" and "record the reads" would otherwise be in the
    // packet's segment list with no edge, or in neither.
    //
    // The whole run's blackboard, filtered in memory — it holds tens of facts,
    // and the alternative is a second matcher written in SQL that has to agree
    // with `satisfies` for ever.
    const matched = liveFacts(readFacts(db, options.runId)).filter((entry) =>
      keys.some((key) => satisfies([entry.fact.key], key)),
    );
    if (matched.length === 0) return [];

    const seqs = appendEvents(
      db,
      matched.map((entry) =>
        draftOf(options, 'fact.read', options.by, {
          factId: entry.fact.id,
          key: entry.fact.key,
          by: options.by,
        }),
      ),
    );

    return matched.map((entry, index) => {
      const seq = seqs[index];
      if (seq === undefined) throw new Error('appending fact.read returned no seq');
      projectFactEvent(db, {
        kind: 'fact.read',
        seq,
        runId: options.runId,
        payload: { factId: entry.fact.id, key: entry.fact.key, by: options.by },
      });
      return { fact: entry.fact, sourceEvent: entry.writtenSeq, readSeq: seq };
    });
  });
}

export interface InvalidateFactOptions extends FactEventEnvelope {
  readonly factId: FactId;
  /** The node that discovered the fact no longer holds. */
  readonly by: NodeId;
  readonly reason: string;
}

export interface FactInvalidation {
  readonly seq: EventSeq;
  /** The nodes that had already read it, as recorded on the event. */
  readonly taints: readonly NodeId[];
}

/**
 * Appends `fact.invalidated` and marks the fact — and nothing else.
 *
 * The `taints` list is computed inside the write transaction, where "every
 * read recorded so far" and "every read strictly earlier than this
 * invalidation" are the same set: nothing can append a read between the query
 * and the insert, because this transaction holds the write lock. The
 * projection re-derives the same set from `event_seq < invalidated_by` on
 * every read, and *that* is the version a rebuild reproduces — the event's
 * array is a record of what was true when it was written, not an input.
 */
export function invalidateFact(db: Db, options: InvalidateFactOptions): FactInvalidation {
  return db.transaction(() => {
    const taints = readersBefore(db, options.factId, Number.MAX_SAFE_INTEGER).map(
      (reader) => reader.node,
    );
    const payload = {
      factId: options.factId,
      by: options.by,
      reason: options.reason,
      taints,
    };
    const [seq] = appendEvents(db, [draftOf(options, 'fact.invalidated', options.by, payload)]);
    if (seq === undefined) throw new Error('appending fact.invalidated returned no seq');
    projectFactEvent(db, {
      kind: 'fact.invalidated',
      seq,
      runId: options.runId,
      payload,
    });
    return { seq, taints };
  });
}

/**
 * KAR-15.6 AC5 — every node that has a `fact.read` for `factId`, and no writer.
 *
 * §8.2's consumer query without the taint clause: `readersBefore` asks *who
 * read this before it went stale*, and F10.4's memory graph asks *who reads
 * this at all*. One `GROUP BY` off `fact_edges_by_fact`, bounded, with the
 * aggregate done in SQLite — a `filter` over `readFactEdges()` returns the same
 * rows and reads every edge of the run to get them, which is a scan of the
 * whole memory graph to answer a question about one fact.
 *
 * `direction = 'read'` is what excludes the writer, and it is in the `WHERE`
 * rather than applied afterwards for the same reason.
 */
const FACT_CONSUMERS_SQL = `SELECT node_id, min(event_seq) AS first_seq, count(*) AS reads
   FROM fact_edges
   WHERE fact_id = ? AND direction = 'read'
   GROUP BY node_id ORDER BY min(event_seq), node_id
   LIMIT ?`;

/** One consumer of a fact: the node, when it first read it, and how often. */
export interface FactConsumerRow {
  readonly node: NodeId;
  readonly firstReadSeq: EventSeq;
  readonly reads: number;
}

export function readFactConsumers(db: Db, factId: FactId, limit: number): FactConsumerRow[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`readFactConsumers: limit must be an integer >= 1, got ${limit}`);
  }
  return db
    .prepare<{ node_id: string; first_seq: number; reads: number }>(FACT_CONSUMERS_SQL)
    .all(factId, limit)
    .map((row) => ({
      node: row.node_id as NodeId,
      firstReadSeq: row.first_seq as EventSeq,
      reads: row.reads,
    }));
}
