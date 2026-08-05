/**
 * KAR-03.6 — the checkpoint cache: `run.state_json` + `run.last_seq`, guarded
 * by `run.checkpoint_version` (docs/05-durable-execution.md §5.1).
 *
 * DeFlow ships no snapshot table. A 40-node multi-hour run produces on the
 * order of 2,000 control-plane events and folding those is single-digit
 * milliseconds, so this file is deliberately the *trivial* version of the
 * idea: a cached `RunState` and the seq it covers, written every
 * `CHECKPOINT_EVENT_INTERVAL` events or on quiesce, read at startup, and
 * thrown away at the slightest doubt.
 *
 * Two properties are what make it safe to ship, and both are structural rather
 * than careful:
 *
 * 1. **The checkpoint is written in the same transaction as the events it
 *    covers.** `RunCheckpointer.append` does the insert and the upsert inside
 *    one `BEGIN IMMEDIATE`, so there is no window — not a microsecond, not one
 *    reachable by `SIGKILL` — in which a checkpoint exists without its events.
 *    That is why `run.last_seq <= max(event.seq)` holds by construction
 *    instead of by discipline, and `writeCheckpoint` re-checks it anyway,
 *    because the cost is one aggregate per 500 events and the alternative is a
 *    cursor that lies.
 * 2. **The cache is never believed when it might be stale.** A version
 *    mismatch, a decode failure, a shape the current `RunState` schema refuses
 *    or a `last_seq` past the end of the ledger all mean the same thing: drop
 *    it and fold from zero. Not one of them is an error the daemon has to
 *    survive — a full replay *is* the correct answer, and it is milliseconds.
 *
 * The result is a cache that can make a start slow but cannot make it wrong:
 * turn it off entirely with `DeFlow_NO_CHECKPOINT=1` and every behaviour in
 * this repository is unchanged, which is the property the suite is run with
 * the flag set to prove.
 *
 * `replayRun` is the per-run half of startup; KAR-03.8 wraps it in the
 * `openAndReplay(dataDir)` the daemon actually calls.
 */
import {
  CHECKPOINT_VERSION,
  canonicalJson,
  type Db,
  type EventSeq,
  type FoldReport,
  foldEvents,
  initialRunState,
  type RunId,
  type RunState,
  RunStateSchema,
  type UpcasterRegistry,
} from '@DeFlow/core';
import { appendEvents, type EventDraft, readRange } from './append.ts';
import { drainEvents } from './drain.ts';

/**
 * Events between opportunistic checkpoints.
 *
 * 500 is §5.1's "every ~500 events", and it is the same number as the SSE tail
 * window for the same reason: it is a batch a synchronous driver writes without
 * anyone noticing. There is nothing to tune here — a cache written twice as
 * often saves replay time nobody was waiting for.
 */
export const CHECKPOINT_EVENT_INTERVAL = 500;

/**
 * Set this to turn the cache off (AC6).
 *
 * Set counts as set, empty string included, exactly as `DeFlow_KEEP_TMP`
 * behaves in the testkit: exporting the variable at all is the request. The
 * flag exists so the whole suite can be run without the cache — if anything
 * ever starts *depending* on a checkpoint rather than merely being sped up by
 * one, that run is where it shows.
 */
export const NO_CHECKPOINT_ENV = 'DeFlow_NO_CHECKPOINT';

/** The slice of the environment this module reads. */
export type CheckpointEnv = Readonly<Record<string, string | undefined>>;

/** Whether the cache is on for `env`. @see NO_CHECKPOINT_ENV */
export function checkpointsEnabled(env: CheckpointEnv = process.env): boolean {
  return env[NO_CHECKPOINT_ENV] === undefined;
}

/** Why a cached checkpoint was refused. Every one of them means "replay". */
export type CheckpointRejectionReason =
  /** Written by a binary whose `RunState` had a different shape. */
  | 'version-mismatch'
  /** `state_json` is not JSON — a truncated write, a torn row. */
  | 'decode-failed'
  /** Valid JSON, but not this build's `RunState`. The subtle one. */
  | 'shape-invalid'
  /** `last_seq` names an event the ledger does not have. */
  | 'last-seq-impossible';

export interface CheckpointRejection {
  readonly runId: RunId;
  readonly reason: CheckpointRejectionReason;
  /** One line, for the operator: which version, which field, which seq. */
  readonly detail: string;
}

/** A cache that was read, validated and accepted. */
export interface Checkpoint {
  readonly runId: RunId;
  /** The `seq` of the last event folded into `state`. */
  readonly lastSeq: number;
  readonly state: RunState;
}

export type CheckpointRead =
  | { readonly status: 'absent' }
  | { readonly status: 'hit'; readonly checkpoint: Checkpoint }
  | { readonly status: 'rejected'; readonly rejection: CheckpointRejection };

/**
 * The one warning line a discarded cache produces (EPIC-03-S20).
 *
 * Rendered here rather than at the log call so the wording is asserted by a
 * test instead of by reading a terminal, and so that a discarded checkpoint is
 * one line naming the run and the reason — never a stack trace, because
 * nothing went wrong: the daemon is about to do the correct thing.
 */
export function describeCheckpointRejection(rejection: CheckpointRejection): string {
  return (
    `checkpoint for run ${rejection.runId} discarded (${rejection.reason}): ${rejection.detail}. ` +
    'Replaying this run from seq 0 — the cache is an optimisation and never a source of truth.'
  );
}

/**
 * A checkpoint that claims to cover events the ledger does not have.
 *
 * Thrown at the *write*, never swallowed: on the read side a bad cache is
 * discarded and replay carries on, but a writer producing one has an in-memory
 * state that no longer describes the ledger — usually because its transaction
 * was rolled back under it — and continuing would persist that.
 */
export class CheckpointAheadOfLedger extends Error {
  readonly runId: RunId;
  readonly lastSeq: number;
  readonly ledgerLastSeq: number;

  constructor(runId: RunId, lastSeq: number, ledgerLastSeq: number) {
    super(
      `refusing to write a checkpoint for run ${runId} at last_seq ${lastSeq}: the ledger's ` +
        `highest seq for this run is ${ledgerLastSeq}. A checkpoint is always written in the same ` +
        'transaction as the events it covers, so one ahead of them means the writer is folding ' +
        'events that no longer exist — resume from the ledger (RunCheckpointer.resume) rather ' +
        'than persisting memory.',
    );
    this.name = 'CheckpointAheadOfLedger';
    this.runId = runId;
    this.lastSeq = lastSeq;
    this.ledgerLastSeq = ledgerLastSeq;
  }
}

/**
 * The projection cache upsert. `run` is rebuildable from `event` by
 * definition, so every column here is derived and none of it is a source of
 * truth — which is what makes overwriting the row wholesale correct.
 */
const UPSERT_RUN = `INSERT INTO run
    (run_id, status, plan_hash, last_seq, state_json, checkpoint_version, daemon_epoch)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id) DO UPDATE SET
    status = excluded.status,
    plan_hash = excluded.plan_hash,
    last_seq = excluded.last_seq,
    state_json = excluded.state_json,
    checkpoint_version = excluded.checkpoint_version,
    daemon_epoch = excluded.daemon_epoch`;

const SELECT_RUN = `SELECT run_id, last_seq, state_json, checkpoint_version
  FROM run WHERE run_id = ?`;

// One row out, and `count(*)` rather than a scan: this runs once per checkpoint
// write and once per replay, never per event.
const RUN_EXTENT_SQL = `SELECT count(*) AS events, coalesce(max(seq), 0) AS last_seq
  FROM event WHERE run_id = ?`;

interface RunRow {
  run_id: string;
  last_seq: number;
  state_json: string;
  checkpoint_version: number;
}

/** The highest `seq` the ledger holds for `runId`; 0 when it holds none. */
function ledgerLastSeq(db: Db, runId: RunId): number {
  return db.prepare<{ events: number; last_seq: number }>(RUN_EXTENT_SQL).get(runId)?.last_seq ?? 0;
}

export interface CheckpointWrite {
  readonly runId: RunId;
  readonly state: RunState;
  /** The `seq` of the last event folded into `state`. */
  readonly lastSeq: number;
}

/**
 * Writes (or replaces) the cached projection for one run.
 *
 * **Call this inside the transaction that appended the events it covers.**
 * `RunCheckpointer` is the supported way to do that; this is exported for the
 * daemon's own quiesce path and for tests that need to plant a row.
 *
 * `state_json` is `canonicalJson`, not `JSON.stringify`: the row is compared
 * across daemon versions and it refuses a `Date` or a `NaN` rather than
 * writing one into a cache that will decode into something else.
 */
export function writeCheckpoint(db: Db, { runId, state, lastSeq }: CheckpointWrite): void {
  const ledgerMax = ledgerLastSeq(db, runId);
  if (lastSeq > ledgerMax) throw new CheckpointAheadOfLedger(runId, lastSeq, ledgerMax);

  db.prepare(UPSERT_RUN).run(
    runId,
    state.status,
    // `plan_hash` is NOT NULL and a run has no plan until `run.started`; the
    // empty string is "none yet", and the state_json beside it is the truth.
    state.planHash ?? '',
    lastSeq,
    canonicalJson(state),
    CHECKPOINT_VERSION,
    state.epoch,
  );
}

const rejected = (
  runId: RunId,
  reason: CheckpointRejectionReason,
  detail: string,
): CheckpointRead => ({ status: 'rejected', rejection: { runId, reason, detail } });

/**
 * Reads the cached projection for `runId`, and validates it four ways before
 * agreeing that it is state (AC3, AC5).
 *
 * Order matters only for the quality of the message: the version is checked
 * first because a mismatch is expected and boring, and reporting it as a shape
 * error would send someone looking for a bug that is not there.
 */
export function readCheckpoint(db: Db, runId: RunId): CheckpointRead {
  const row = db.prepare<RunRow>(SELECT_RUN).get(runId);
  if (row === undefined) return { status: 'absent' };

  if (row.checkpoint_version !== CHECKPOINT_VERSION) {
    return rejected(
      runId,
      'version-mismatch',
      `the row was written at checkpoint_version ${row.checkpoint_version}, this build is at ` +
        `${CHECKPOINT_VERSION}`,
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(row.state_json);
  } catch (thrown) {
    return rejected(
      runId,
      'decode-failed',
      thrown instanceof Error ? thrown.message : 'state_json is not JSON',
    );
  }

  // The subtle case, and the reason this is a schema and not a cast: an object
  // of a previous shape parses cleanly and would fold into a state the reducer
  // could never have produced.
  const parsed = RunStateSchema.safeParse(decoded);
  if (!parsed.success) {
    return rejected(
      runId,
      'shape-invalid',
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    );
  }

  const ledgerMax = ledgerLastSeq(db, runId);
  if (!Number.isInteger(row.last_seq) || row.last_seq < 0 || row.last_seq > ledgerMax) {
    return rejected(
      runId,
      'last-seq-impossible',
      `last_seq ${row.last_seq} is not an event this run has; its highest seq is ${ledgerMax}`,
    );
  }

  return {
    status: 'hit',
    checkpoint: { runId, lastSeq: row.last_seq, state: parsed.data },
  };
}

export interface ReplayOptions {
  /** Defaults to `process.env`. @see NO_CHECKPOINT_ENV */
  readonly env?: CheckpointEnv;
  /** Overrides the env flag outright. */
  readonly enabled?: boolean;
  /** The upcaster registry to read through; defaults to the shipped one. */
  readonly registry?: UpcasterRegistry;
  /** Rows per bounded query while draining the tail. */
  readonly batchSize?: number;
}

export interface ReplayResult {
  readonly state: RunState;
  /** Where the fold started from: a decoded cache, or nothing at all. */
  readonly source: 'checkpoint' | 'cold';
  /** The `seq` the fold resumed after; 0 for a cold start. */
  readonly fromSeq: number;
  /**
   * How many rows the fold actually read. This is the number EPIC-03-S18's
   * "exactly 30 events are folded" is asserted against — the cache is only
   * doing anything if this is observable, and a claim nobody can measure is a
   * claim that stops being true without anyone noticing.
   */
  readonly folded: number;
  readonly report: FoldReport;
  /** The cache that was thrown away, if there was one. */
  readonly discarded: CheckpointRejection | null;
}

/**
 * Startup for one run: decode the cache if it is trustworthy, then fold what
 * came after it — `state = checkpointValid ? decode(state_json) : initial`,
 * then `reduce()` over `seq > last_seq`, which is §5.1 verbatim.
 *
 * Never throws for a bad cache. Every rejection path lands on the same
 * behaviour as having no cache at all, and the caller is told which one
 * happened so it can log one line.
 */
export function replayRun(db: Db, runId: RunId, options: ReplayOptions = {}): ReplayResult {
  const enabled = options.enabled ?? checkpointsEnabled(options.env);

  let from = initialRunState();
  let fromSeq = 0;
  let source: ReplayResult['source'] = 'cold';
  let discarded: CheckpointRejection | null = null;

  if (enabled) {
    const read = readCheckpoint(db, runId);
    if (read.status === 'hit') {
      from = read.checkpoint.state;
      fromSeq = read.checkpoint.lastSeq;
      source = 'checkpoint';
    } else if (read.status === 'rejected') {
      discarded = read.rejection;
    }
  }

  let folded = 0;
  const counted = (function* count() {
    const drainOptions =
      options.batchSize === undefined
        ? { afterSeq: fromSeq }
        : { afterSeq: fromSeq, batchSize: options.batchSize };
    for (const event of drainEvents(db, runId, drainOptions)) {
      folded += 1;
      yield event;
    }
  })();

  const report = foldEvents(
    counted,
    from,
    options.registry === undefined ? {} : { registry: options.registry },
  );

  return { state: report.state, source, fromSeq, folded, report, discarded };
}

export interface CheckpointerOptions extends ReplayOptions {
  /** Events between checkpoints. Defaults to `CHECKPOINT_EVENT_INTERVAL`. */
  readonly interval?: number;
  /** The state to fold onto; defaults to a run with no events. */
  readonly state?: RunState;
  /** The `seq` that `state` already covers. */
  readonly lastSeq?: number;
}

/**
 * The write side: appends a run's events and keeps its projection current,
 * checkpointing the pair together.
 *
 * One instance per run, held by the writer that owns that run — the
 * projection it carries is a fold of the events *it* appended, so two
 * instances over one run would each hold half a state.
 *
 * A caveat with a remedy: `append` owns its transaction, and nesting it inside
 * a caller transaction that later rolls back leaves the instance describing
 * events the ledger no longer has. The ledger stays correct (the checkpoint
 * rolls back with its events), but the object is stale — call
 * `RunCheckpointer.resume` to take the state from the ledger again, which is
 * what a daemon does after losing a transaction anyway.
 */
export class RunCheckpointer {
  readonly #db: Db;
  readonly #runId: RunId;
  readonly #interval: number;
  readonly #enabled: boolean;
  readonly #registry: UpcasterRegistry | undefined;
  #state: RunState;
  #lastSeq: number;
  #pending: number;
  #writes = 0;

  constructor(db: Db, runId: RunId, options: CheckpointerOptions = {}) {
    const interval = options.interval ?? CHECKPOINT_EVENT_INTERVAL;
    if (!Number.isInteger(interval) || interval < 1) {
      throw new RangeError(`checkpoint interval must be an integer >= 1, got ${interval}`);
    }
    this.#db = db;
    this.#runId = runId;
    this.#interval = interval;
    this.#enabled = options.enabled ?? checkpointsEnabled(options.env);
    this.#registry = options.registry;
    this.#state = options.state ?? initialRunState();
    this.#lastSeq = options.lastSeq ?? 0;
    this.#pending = 0;
  }

  /**
   * Replays `runId` and returns a checkpointer positioned on the result — the
   * daemon's start-of-run path, and the way back from a rolled-back batch.
   *
   * The events folded past the cache count as pending, so the first `quiesce`
   * after a resume persists them rather than waiting for another 500.
   */
  static resume(db: Db, runId: RunId, options: CheckpointerOptions = {}): RunCheckpointer {
    const replay = replayRun(db, runId, options);
    const checkpointer = new RunCheckpointer(db, runId, {
      ...options,
      state: replay.state,
      lastSeq: Math.max(replay.fromSeq, replay.report.lastSeq),
    });
    checkpointer.#pending = replay.folded;
    return checkpointer;
  }

  /** The projection of every event this instance has appended. */
  get state(): RunState {
    return this.#state;
  }

  /** The `seq` of the last event appended, or the one resumed from. */
  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** Events folded since the last checkpoint was written. */
  get pending(): number {
    return this.#pending;
  }

  /** How many checkpoint rows this instance has written. */
  get writes(): number {
    return this.#writes;
  }

  /**
   * Appends `drafts` and folds them, writing a checkpoint in the **same**
   * transaction once `interval` events have accumulated.
   *
   * The rows are read back through `readRange` — the very query replay uses —
   * rather than folded from the drafts in hand. It costs one indexed query per
   * batch and it removes the entire class of divergence where the live
   * projection sees a payload the stored one does not: what is folded here is
   * byte-for-byte what a restart will fold.
   */
  append(drafts: readonly EventDraft[]): EventSeq[] {
    if (drafts.length === 0) return [];

    return this.#db.transaction(() => {
      const seqs = appendEvents(this.#db, drafts);
      const first = seqs[0];
      if (first === undefined) return seqs;

      const stored = readRange(this.#db, this.#runId, first - 1, seqs.length).events;
      const report = foldEvents(
        stored,
        this.#state,
        this.#registry === undefined ? {} : { registry: this.#registry },
      );

      this.#state = report.state;
      this.#lastSeq = Math.max(this.#lastSeq, ...seqs);
      this.#pending += stored.length;

      if (this.#enabled && this.#pending >= this.#interval) this.#write();
      return seqs;
    });
  }

  /**
   * Writes a checkpoint for whatever has accumulated, however little. Returns
   * whether it wrote one.
   *
   * This is the "or on quiesce" half of §5.1: a run that goes idle 40 events
   * after its last checkpoint should not replay those 40 on every restart for
   * the rest of the day.
   */
  quiesce(): boolean {
    if (!this.#enabled || this.#pending === 0) return false;
    this.#db.transaction(() => {
      this.#write();
    });
    return true;
  }

  #write(): void {
    writeCheckpoint(this.#db, {
      runId: this.#runId,
      state: this.#state,
      lastSeq: this.#lastSeq,
    });
    this.#pending = 0;
    this.#writes += 1;
  }
}
