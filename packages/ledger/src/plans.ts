/**
 * KAR-11.1 AC4, AC5 — persisting one immutable, content-addressed plan version.
 *
 * A version lands in three places or in none:
 *
 *   1. `plan(hash, run_id, created_at, doc)` — the immutable, content-addressed
 *      row `run.plan_hash` points at.
 *   2. `.DeFlow/runs/<runId>/plan/v<n>.json` — NF8's *"every artefact
 *      inspectable on disk in an open format"*. `cat` it; no daemon required.
 *   3. `plan.proposed` — the event a replay rebuilds the projection from.
 *
 * **The row and the event are one transaction, and that is the whole story.**
 * A `plan` row with no event is a document nobody can explain the provenance
 * of; an event with no row is a `run.plan_hash` addressing a document that does
 * not exist. Neither is repairable afterwards, because the ledger is
 * append-only — there is no later write that can make a torn pair whole.
 *
 * **The file is written before the transaction**, exactly as
 * `persistContextPacket` writes blobs before `context.built`, and for the same
 * reason: an event that exists must be an event whose content resolves. The
 * residue of the failing direction is a `v<n>.json` with no row, which is inert
 * — nothing reads a plan file to decide anything, and the next attempt at the
 * same version overwrites it — while the reverse would be a row addressing a
 * file a crash never wrote.
 *
 * **A document is stored under the hash that addresses it, or not at all**
 * (AC4). `PlanHashMismatch` is checked first, before any write: the `plan`
 * table's primary key *is* the content address, and a row filed under a hash
 * that does not address its own `doc` would silently break every join in the
 * system — `run.plan_hash`, `PlanPatch.basePlanHash`, and the scrubber's whole
 * version rail.
 *
 * The hash itself is `@DeFlow/core`'s `planHash` and never a second
 * implementation, over the canonical encoder core owns. Not `ohash`: its
 * README promises only best-effort stable serialisation, which is fine for
 * change detection and wrong for a primary key that has to mean the same thing
 * across daemon versions (04 §3, 06 §2.3).
 */
import type {
  Db,
  DbStatement,
  PatchDecision,
  PlanDiagnostic,
  PlanGraph,
  PlanHash,
  PlannerAttribution,
  ProposedBy,
} from '@DeFlow/core';
import {
  canonicalJson,
  hasBlockingDiagnostic,
  planHash,
  renderPlanDiagnostics,
} from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvents, type EventDraft } from './append.ts';

/** `<runDir>/plan/` — repo-layout §7.1. */
export const RUN_PLAN_DIR = 'plan';

export function planDirOf(runDir: string): string {
  return join(runDir, RUN_PLAN_DIR);
}

/** `<runDir>/plan/v<version>.json`. Named by version, not by hash: the disk
 * copy is what a human opens, and *"the third replan"* is how a human refers to
 * it. The hash addresses the row. */
export function planPathOf(runDir: string, version: number): string {
  return join(planDirOf(runDir), `v${version}.json`);
}

/** A graph whose declared `planHash` does not address its own content. */
export class PlanHashMismatch extends Error {
  readonly declared: string;
  readonly actual: string;

  constructor(declared: string, actual: string) {
    super(
      `plan graph declares planHash ${declared} but its canonical encoding hashes to ${actual}. ` +
        'The plan table is content-addressed and run.plan_hash joins on it, so a document filed ' +
        'under a hash that does not address it breaks every join in the system — compute the ' +
        'hash with planHash() from @DeFlow/core and set it before persisting.',
    );
    this.name = 'PlanHashMismatch';
    this.declared = declared;
    this.actual = actual;
  }
}

export interface PersistPlanOptions {
  /** `<target-repo>/.DeFlow/runs/<runId>`. */
  readonly runDir: string;
  /** The document, with `planHash` already set to its own content address. */
  readonly graph: PlanGraph;
  /**
   * KAR-11.2 AC9 — what `validatePlan` said about this document.
   *
   * **Required, never optional, and that is the whole mechanism.** 06 §3 says
   * validation runs on *"every plan version — v1 and every patched successor"*,
   * and §8's warning is that the patch which bites is the one at node 27 of 40.
   * A caller that has not validated cannot construct this argument, so the
   * second write path somebody adds in six months is a compile error rather
   * than an unvalidated plan. `[]` is a legitimate value — it means the
   * validator ran and found nothing — and the runtime check below is what stops
   * it being used to smuggle a failing document past the type.
   */
  readonly diagnostics: readonly PlanDiagnostic[];
  readonly by: ProposedBy;
  /** AC6 — which model planned, at what effort, in which tier (06 §6). */
  readonly planner: PlannerAttribution;
  /** From the injected `Clock`, never `Date.now()`. */
  readonly ts: number;
  readonly epoch: number;
  readonly nodeId?: string;
  readonly attempt?: number;
}

/**
 * KAR-11.2 AC9 — a plan version whose own diagnostics refuse it.
 *
 * Thrown *before* anything is written, including the file: 06 §3.5 is that
 * diagnostics are values, so a caller reaching here has already been told what
 * is wrong and has chosen to persist anyway. That is a programming error rather
 * than a plan fault, and it gets an exception rather than a return value for
 * exactly that reason.
 */
export class PlanNotValidated extends Error {
  readonly diagnostics: readonly PlanDiagnostic[];

  constructor(diagnostics: readonly PlanDiagnostic[]) {
    super(
      'this plan version carries blocking validation diagnostics and must not be persisted: ' +
        `${renderPlanDiagnostics(diagnostics).replaceAll('\n', ' · ')}. Validation runs on every ` +
        'plan version — v1 and every patched successor (06 §3) — and a failing patch is rejected ' +
        'whole, never partially applied.',
    );
    this.name = 'PlanNotValidated';
    this.diagnostics = diagnostics;
  }
}

export interface PersistedPlan {
  readonly seq: number;
  readonly planHash: PlanHash;
  /** The version's file, so a caller can name it in a log line. */
  readonly path: string;
}

const INSERT_PLAN_SQL = `
  INSERT INTO plan (hash, run_id, created_at, doc)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (hash) DO NOTHING
`;

const READ_PLAN_SQL = 'SELECT doc FROM plan WHERE hash = ?';

/** The stored canonical encoding of the plan `hash` addresses, or `null`. */
export function readPlanDoc(db: Db, hash: string): string | null {
  const statement: DbStatement<{ doc: string }> = db.prepare(READ_PLAN_SQL);
  return statement.get(hash)?.doc ?? null;
}

/**
 * Write, fsync, rename — docs/05-durable-execution.md §9.4, with the temp file
 * a sibling of its target so the rename is atomic rather than a
 * cross-filesystem copy.
 *
 * `key` distinguishes two writers aiming at the same target. Two rival
 * proposers (KAR-11.3 AC10) both compose a `v2` and so both name
 * `plan/v2.json`; with one shared `.DeFlow.tmp` sibling, whichever renamed
 * first deleted the other's temp file out from under it and the loser died on
 * `ENOENT` — a *verified* failure, reproduced by
 * `test/integration/rival-patches.test.ts` before this argument existed. The
 * content address is the natural key: two writers with the same one are writing
 * the same bytes.
 */
function writeFileAtomic(path: string, text: string, key: string): void {
  const temp = `${path}.${key}.DeFlow.tmp`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, Buffer.from(text, 'utf8'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/**
 * The canonical encoding to file under `graph.planHash`, having first proved
 * that the hash addresses it (AC4).
 *
 * Checked before any write, by both entry points: the `plan` table's primary
 * key *is* the content address, so a row filed under a hash that does not
 * address its own `doc` would silently break `run.plan_hash`, a patch's
 * `basePlanHash` and the scrubber's whole version rail at once.
 */
async function sealedDoc(graph: PlanGraph): Promise<string> {
  const actual = await planHash(graph as unknown as Record<string, unknown>);
  if (actual !== graph.planHash) throw new PlanHashMismatch(graph.planHash, actual);
  return canonicalJson(graph);
}

/** NF8's `<runDir>/plan/v<n>.json` — the copy a human opens with `cat`, with no
 * daemon in the way. */
function writePlanFile(runDir: string, graph: PlanGraph): string {
  const path = planPathOf(runDir, graph.version);
  mkdirSync(planDirOf(runDir), { recursive: true });
  // Keyed on the content address, so two writers aiming at the same `vN.json`
  // cannot delete each other's temp file.
  writeFileAtomic(path, `${JSON.stringify(graph, null, 2)}\n`, graph.planHash.slice(-16));
  return path;
}

/**
 * Stores one plan version: the file, then the row and `plan.proposed` in one
 * transaction.
 *
 * `ON CONFLICT DO NOTHING` on the insert, because the table is
 * content-addressed and immutable: a hash already present is *the same
 * document*, and re-proposing an identical graph — which a retry after a
 * transient failure does — must not be an error and must not rewrite a row an
 * earlier event already references.
 */
export async function persistPlanVersion(
  db: Db,
  options: PersistPlanOptions,
): Promise<PersistedPlan> {
  const { graph, runDir } = options;
  // AC9, first: before the hash, before the file, before the transaction. A
  // plan that does not validate leaves no residue at all.
  if (hasBlockingDiagnostic(options.diagnostics)) throw new PlanNotValidated(options.diagnostics);

  const doc = await sealedDoc(graph);
  const path = writePlanFile(runDir, graph);

  const draft: EventDraft = {
    runId: graph.runId,
    ts: options.ts,
    kind: 'plan.proposed',
    v: 2,
    epoch: options.epoch,
    ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
    ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
    payload: {
      version: graph.version,
      planHash: graph.planHash,
      graph,
      by: options.by,
      planner: options.planner,
    },
  } as EventDraft;

  const seq = db.transaction(() => {
    db.prepare(INSERT_PLAN_SQL).run(graph.planHash, graph.runId, options.ts, doc);
    const [assigned] = appendEvents(db, [draft]);
    if (assigned === undefined) throw new Error('appending plan.proposed returned no seq');
    return assigned;
  });

  return { seq, planHash: graph.planHash, path };
}

// ── KAR-11.3: applying a patched version ─────────────────────────────────────

/** `run.plan_hash` is the run's *current* plan, and the only thing a
 * `basePlanHash` is ever compared against. */
const READ_RUN_PLAN_HASH_SQL = 'SELECT plan_hash FROM run WHERE run_id = ?';

const UPDATE_RUN_PLAN_HASH_SQL = 'UPDATE run SET plan_hash = ? WHERE run_id = ?';

/**
 * AC6's rejection code, exported because the proposer branches on it: a stale
 * patch is not a bad patch, and the answer is *re-derive against the hash in
 * this rejection*, not *give up*.
 */
export const PATCH_STALE = 'PATCH_STALE' as const;

/** The plan the run is on right now, or `null` when it has no projection row
 * yet — which is itself a stale base, because a patch against a run with no
 * current plan is a patch derived from a graph nothing is executing. */
function currentPlanHash(db: Db, runId: string): string | null {
  const row = db.prepare<{ plan_hash: string }>(READ_RUN_PLAN_HASH_SQL).get(runId);
  return row?.plan_hash ?? null;
}

export interface ApplyPatchedPlanOptions extends PersistPlanOptions {
  /**
   * AC6 — the hash the proposer derived its ops against. Compared against
   * `run.plan_hash` **inside** the write transaction, so two proposers racing
   * from the same base are serialised by SQLite's own write lock rather than
   * by a check that read the world a moment before it changed.
   */
  readonly basePlanHash: string;
  readonly patchId: string;
  /**
   * The policy engine's ruling, recorded on `plan.patched` and **never
   * consulted here**. EPIC-11-S18's second scenario is that an `auto` decision
   * does not buy a patch past validation; the ordering that guarantees it is
   * the caller's (revalidate, then commit), and the ruling reaches this
   * function only as a field of the event it has to carry.
   */
  readonly decision: PatchDecision;
  /**
   * AC4's kill point, called after `UPDATE run SET plan_hash` and before
   * `INSERT INTO event`, which is the one instant at which a torn state would
   * be observable if the three statements were not one transaction.
   *
   * Undefined in production and left in the signature deliberately: the
   * crash-fuzz harness needs a place to stand inside the transaction, and a
   * window it has to widen by luck is a window it never lands in. Throwing
   * from it is how the "forces a failure between the second and the third
   * statement" test rolls all three back.
   */
  readonly crashPoint?: (() => void) | undefined;
}

export type ApplyPatchedPlanOutcome =
  | {
      readonly outcome: 'applied';
      readonly seq: number;
      readonly planHash: PlanHash;
      readonly path: string;
    }
  | {
      readonly outcome: 'stale';
      readonly code: typeof PATCH_STALE;
      /** What the proposer must re-derive against (AC6). `null` when the run
       * has no plan projection at all. */
      readonly currentPlanHash: string | null;
    };

/**
 * KAR-11.3 AC4 — the successor row, `run.plan_hash` and `plan.patched`, in one
 * `BEGIN IMMEDIATE … COMMIT`.
 *
 * *"A crash mid-apply leaves either the old plan and no event, or the new plan
 * and its event. Never a torn state"* (06 §4.2). There is no repair path for
 * the torn version — the ledger is append-only, so a `plan` row whose event
 * never landed can never be explained afterwards and an event whose row never
 * landed addresses a document that does not exist.
 *
 * The staleness check is the **first statement of the same transaction**, which
 * is what makes AC10 true across processes as well as inside one: SQLite
 * permits a single writer, an immediate transaction takes that lock up front,
 * and a rival that read the same base a millisecond earlier finds a different
 * `run.plan_hash` by the time it is allowed to write. No rebase is attempted,
 * ever — *"the proposer had a reason based on a graph that no longer exists"*.
 *
 * **The `vN.json` is written inside the transaction, and that is the one place
 * this differs from `persistPlanVersion`.** There, the file goes first and the
 * residue of a failure is an inert file *"the next attempt at the same version
 * overwrites"*. Under two rival proposers that reasoning does not hold: both
 * compose a `v2`, both would write `plan/v2.json`, and the loser's write can
 * land last — leaving a file on disk that shows a graph which never ran while
 * `run.plan_hash` points at the winner's. A missing file is a gap; a
 * confidently wrong one is a lie, and NF8's whole promise is that `cat` answers
 * honestly. So the write happens once the race is won. The cost is filesystem
 * I/O under the write lock, which `appendEvents` avoids for spilled blobs and
 * accepts here for the same reason it is acceptable there: a plan document is
 * tens of kilobytes and this runs once per plan version, not once per event.
 */
export async function applyPatchedPlanVersion(
  db: Db,
  options: ApplyPatchedPlanOptions,
): Promise<ApplyPatchedPlanOutcome> {
  const { graph, runDir } = options;
  if (hasBlockingDiagnostic(options.diagnostics)) throw new PlanNotValidated(options.diagnostics);

  const doc = await sealedDoc(graph);

  // A cheap read before the write lock is asked for, so the ordinary stale case
  // — the proposer is simply behind — costs no contention. It is an
  // optimisation and never the guarantee; the check inside the transaction is.
  const before = currentPlanHash(db, graph.runId);
  if (before !== options.basePlanHash) {
    return { outcome: 'stale', code: PATCH_STALE, currentPlanHash: before };
  }

  const draft: EventDraft = {
    runId: graph.runId,
    ts: options.ts,
    kind: 'plan.patched',
    v: 1,
    epoch: options.epoch,
    ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
    ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
    payload: {
      version: graph.version,
      fromHash: options.basePlanHash,
      toHash: graph.planHash,
      patchId: options.patchId,
      decision: options.decision,
    },
  } as EventDraft;

  return db.transaction((): ApplyPatchedPlanOutcome => {
    const current = currentPlanHash(db, graph.runId);
    if (current !== options.basePlanHash) {
      return { outcome: 'stale', code: PATCH_STALE, currentPlanHash: current };
    }

    const path = writePlanFile(runDir, graph);
    db.prepare(INSERT_PLAN_SQL).run(graph.planHash, graph.runId, options.ts, doc);
    db.prepare(UPDATE_RUN_PLAN_HASH_SQL).run(graph.planHash, graph.runId);
    options.crashPoint?.();
    const [seq] = appendEvents(db, [draft]);
    if (seq === undefined) throw new Error('appending plan.patched returned no seq');

    return { outcome: 'applied', seq, planHash: graph.planHash, path };
  });
}
