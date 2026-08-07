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
  PlanGraph,
  PlanHash,
  PlannerAttribution,
  ProposedBy,
} from '@DeFlow/core';
import { canonicalJson, planHash } from '@DeFlow/core';
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
  readonly by: ProposedBy;
  /** AC6 — which model planned, at what effort, in which tier (06 §6). */
  readonly planner: PlannerAttribution;
  /** From the injected `Clock`, never `Date.now()`. */
  readonly ts: number;
  readonly epoch: number;
  readonly nodeId?: string;
  readonly attempt?: number;
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

/** Write, fsync, rename — docs/05-durable-execution.md §9.4, with the temp file
 * a sibling of its target so the rename is atomic rather than a
 * cross-filesystem copy. */
function writeFileAtomic(path: string, text: string): void {
  const temp = `${path}.DeFlow.tmp`;
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
  const doc = canonicalJson(graph);

  const actual = await planHash(graph as unknown as Record<string, unknown>);
  if (actual !== graph.planHash) throw new PlanHashMismatch(graph.planHash, actual);

  const path = planPathOf(runDir, graph.version);
  mkdirSync(planDirOf(runDir), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(graph, null, 2)}\n`);

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
