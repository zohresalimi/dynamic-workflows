/**
 * KAR-06.3 — `durable()`: the write-ahead effect journal's execution half
 * (docs/05-durable-execution.md §8.2).
 *
 * The protocol is three words long — **intent, act, record** — and the reason
 * it is worth a module is that the intent has to be *durable before the act*,
 * with no window between them. `journalEffect` writes the `effect` row and the
 * `effect.started` event in one transaction, and only then is `perform()`
 * called. A crash between the row and the event is impossible by construction;
 * a crash immediately after leaves a `pending` row, which is the whole point:
 * the next daemon can tell "already happened", "definitely did not happen" and
 * "cannot tell" apart instead of guessing.
 *
 * Read the four branches carefully, because each is a genuinely different real
 * situation and collapsing any two is a bug:
 *
 * | Row                          | Meaning                       | What happens          |
 * | ---------------------------- | ----------------------------- | --------------------- |
 * | `done`                       | completed in a previous life  | memoise; never perform |
 * | `failed`                     | recorded, classified failure  | rethrow; the SCHEDULER decides retry-or-fail |
 * | `pending`, this daemon life  | ordinary concurrency          | fall through and perform |
 * | `pending`, a previous life   | died mid-effect — ambiguous   | `reconcile()`, never a bare re-run |
 *
 * The third row is the one people collapse into the fourth. A `pending` row
 * stamped after this daemon started means another in-process caller is
 * mid-flight; probing the world for an effect that is *currently happening* is
 * both wasteful and wrong.
 *
 * Two things this module deliberately does **not** do:
 *
 * - **It does not hold a counter.** `ordinal` is derived per call from
 *   `nextOrdinal`, which counts the intents already journalled for the
 *   `(runId, nodeId, attempt)` triple. A counter in this file would reset to
 *   zero on restart and hand the second effect of an interrupted attempt the
 *   first effect's key — which `ON CONFLICT DO NOTHING` would then resolve by
 *   memoising the wrong result, silently.
 * - **It does not classify a throw from `perform()`.** The failure taxonomy
 *   and the retry ladder are KAR-06.5's, and the layer that knows which
 *   situation a throw came from is the one that must write the `failed` row
 *   (`markEffectFailed` in @DeFlow/ledger). Guessing a class here would put a
 *   `permanent` row under a rate-limit error and end the run.
 *
 * Verifies: EPIC-06-S8, EPIC-06-S10, EPIC-06-S11, EPIC-06-S17 · AC1–AC7
 */
import type {
  Clock,
  Db,
  EffectKind,
  IdempotencyKey,
  NodeFailure,
  NodeId,
  RunId,
} from '@DeFlow/core';
import { ikey as buildIkey, NodeFailureError } from '@DeFlow/core';
import type { AppendOptions, EffectRow, EventDraft } from '@DeFlow/ledger';
import { journalEffect, markEffectDone, nextOrdinal } from '@DeFlow/ledger';

/**
 * Which of the two operations that look identical this is (EPIC-06-S17).
 *
 * `fresh` — this call created the intent row, so nothing about this effect has
 * happened before. `resume` — a row already existed, so the effect is being
 * re-entered: either another caller is mid-flight or a previous daemon life
 * started it. An adapter that ignores the distinction is answering "re-run
 * this" when it was asked "check whether this already ran".
 */
export type EffectMode = 'fresh' | 'resume';

/** What `perform()` and `reconcile()` are told about the effect they are for. */
export interface EffectCtx {
  readonly ikey: IdempotencyKey;
  readonly mode: EffectMode;
  /** The journalled row, exactly as it was read inside the write-ahead transaction. */
  readonly row: EffectRow;
  /** ms epoch at which the daemon running this effect started. */
  readonly daemonStartedAt: number;
}

/**
 * What a reconcile probe found out there in the world (KAR-06.4).
 *
 * `unknown` is a first-class answer rather than an error, because for a
 * mutating shell command it is the *common* answer and there is no correct
 * automatic action: retrying might apply a migration twice, skipping might
 * drop it, and neither is detectable afterwards.
 */
export type ReconcileProbe<T> =
  | { readonly status: 'done'; readonly result: T }
  | { readonly status: 'not-started' }
  | { readonly status: 'unknown'; readonly detail?: string };

/**
 * One side-effecting operation, described well enough to be journalled before
 * it is performed.
 *
 * `ordinal` is the one field that is usually absent, and its absence is the
 * normal case: omitted, the runner derives the position from the journal,
 * which is what makes the Nth effect of an attempt ordinal N-1 before and
 * after a restart. It is supplied only by a caller that is deliberately
 * **re-entering an effect whose position it already knows** — a resume that
 * replays a specific step, a reconcile, a test asserting the memoised path.
 * It must never be supplied from a counter: see `test/no-ordinal-counter.test.ts`.
 */
export interface Effect<T> {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** 0-based. Part of the key, so a retry mints a new key by construction. */
  readonly attempt: number;
  readonly ordinal?: number;
  readonly kind: EffectKind;
  /** `sha256-<64 hex>` from `requestHash` in @DeFlow/core. */
  readonly requestHash: string;
  /** Does the thing. Called at most once per ikey, ever. */
  perform(ctx: EffectCtx): Promise<T>;
  /**
   * Answers "did this already happen out there?" for a row this daemon
   * inherited in `pending`. Optional because it is per-effect-type and lands
   * with KAR-06.4; without one, an inherited `pending` row is
   * `EffectNeedsReconciliation` rather than a silent re-run.
   */
  reconcile?(ctx: EffectCtx): Promise<ReconcileProbe<T>>;
}

/**
 * A failure that was recorded against an ikey and is being rethrown rather
 * than re-executed (AC5).
 *
 * It carries the original `NodeFailure` untouched, and it carries the
 * `deflowFailure` tag so `toNodeFailure` recognises it structurally — the
 * runner has no opinion about whether `class: 'transient'` means retry. That
 * is the scheduler's decision, and putting it here would make the retry policy
 * a property of the effect runner rather than of the plan.
 */
export class EffectFailed extends Error {
  readonly ikey: string;
  readonly failure: NodeFailure;
  readonly deflowFailure: { reason: NodeFailure['reason']; class: NodeFailure['class'] };

  constructor(ikey: string, failure: NodeFailure) {
    super(
      `effect ${ikey} is journalled failed (${failure.reason}, ${failure.class}): ${failure.message}. ` +
        'A recorded failure is rethrown, never re-executed — the scheduler decides whether that ' +
        'means a retry at a new attempt or a failed node.',
    );
    this.name = 'EffectFailed';
    this.ikey = ikey;
    this.failure = failure;
    this.deflowFailure = { reason: failure.reason, class: failure.class };
  }
}

/**
 * The plan changed underneath a journalled effect (AC7, EPIC-06-S10).
 *
 * A `NodeFailureError` so the classification is the tag rather than a lookup:
 * `effect.request-hash-mismatch`, class `permanent`. Permanent because a
 * retry cannot help — the stored request and the current one describe
 * different work, and no amount of waiting reconciles them.
 */
export class EffectRequestHashMismatch extends NodeFailureError {
  readonly ikey: string;
  readonly storedHash: string;
  readonly computedHash: string;

  constructor(ikey: string, storedHash: string, computedHash: string) {
    super(
      `effect ${ikey} was journalled for request ${storedHash} but is now being entered for ` +
        `request ${computedHash}. A plan edit landed under a live effect: returning the memoised ` +
        'result would answer a question nobody asked, so this is a hard error and no result is returned.',
      {
        reason: 'effect.request-hash-mismatch',
        class: 'permanent',
        detail: { ikey, storedHash, computedHash },
      },
    );
    this.name = 'EffectRequestHashMismatch';
    this.ikey = ikey;
    this.storedHash = storedHash;
    this.computedHash = computedHash;
  }
}

/**
 * An inherited `pending` row that nothing can resolve: either the effect
 * declared no `reconcile()`, or its probe returned `unknown`.
 *
 * `effect.reconcile-unknown` is gate-only in the taxonomy — the schema itself
 * refuses any other class — because there is no correct automatic action.
 * Retrying might double-apply, skipping might drop the work, and neither is
 * detectable afterwards.
 */
export class EffectNeedsReconciliation extends NodeFailureError {
  readonly ikey: string;

  constructor(ikey: string, detail: string) {
    super(
      `effect ${ikey} was left pending by a previous daemon life and cannot be resolved: ${detail}. ` +
        'Whether it landed is unknown, and re-performing it might apply it twice — so this escalates ' +
        'to a human rather than guessing.',
      { reason: 'effect.reconcile-unknown', class: 'gate', detail: { ikey } },
    );
    this.name = 'EffectNeedsReconciliation';
    this.ikey = ikey;
  }
}

export interface EffectRunnerOptions {
  readonly db: Db;
  /** Time enters through the port, never `Date.now()` (NF9). */
  readonly clock: Clock;
  /**
   * ms epoch at which **this** daemon life started.
   *
   * The whole of the third-versus-fourth branch distinction. A `pending` row
   * stamped at or after this instant belongs to a caller in this process; one
   * stamped before it was inherited from a daemon that is gone.
   */
  readonly daemonStartedAt: number;
  /** The daemon epoch stamped on every event this runner appends (KAR-03.7). */
  readonly epoch: number;
  /** Data directory an oversized event payload spills into (KAR-03.9). */
  readonly spillTo?: string;
}

export interface EffectRunner {
  durable<T>(effect: Effect<T>): Promise<T>;
}

const envelope = (
  effect: Effect<unknown>,
  key: IdempotencyKey,
  kind: string,
  ts: number,
  epoch: number,
  payload: unknown,
): EventDraft => ({
  runId: effect.runId,
  ts,
  kind,
  v: 1,
  epoch,
  nodeId: effect.nodeId,
  attempt: effect.attempt,
  ikey: key,
  payload,
});

/**
 * Builds a runner bound to one ledger, one clock and one daemon life.
 *
 * The only state it holds is `inFlight`, a map of ikey to the promise of the
 * call that is performing it right now, deleted the moment that call settles.
 * That is what makes AC3's "exactly one of them performs" true for two callers
 * inside one tick: `ON CONFLICT DO NOTHING` guarantees one *row*, and this map
 * guarantees one *execution*. It is emphatically not a memo cache — a cache
 * would make the second call after the first has finished return from memory,
 * and the property under test is that memoisation survives the process, which
 * only the ledger can do.
 */
export function createEffectRunner(options: EffectRunnerOptions): EffectRunner {
  const { db, clock, daemonStartedAt, epoch } = options;
  const appendOptions: AppendOptions =
    options.spillTo === undefined ? {} : { spillTo: options.spillTo };
  const inFlight = new Map<string, Promise<unknown>>();

  async function run<T>(effect: Effect<T>): Promise<T> {
    // AC6: derived from the journal on every call, held nowhere. A resume that
    // knows which effect it is re-entering names the position itself.
    const ordinal =
      effect.ordinal ??
      nextOrdinal(db, {
        runId: effect.runId,
        nodeId: effect.nodeId,
        attempt: effect.attempt,
      });
    const key = buildIkey(effect.runId, effect.nodeId, effect.attempt, ordinal);

    const startedAt = clock.now();
    const { row, created } = journalEffect(
      db,
      {
        ikey: key,
        runId: effect.runId,
        nodeId: effect.nodeId,
        attempt: effect.attempt,
        ordinal,
        kind: effect.kind,
        requestHash: effect.requestHash,
        startedAt,
      },
      envelope(effect, key, 'effect.started', startedAt, epoch, {
        ikey: key,
        kind: effect.kind,
        requestHash: effect.requestHash,
      }),
      appendOptions,
    );

    const ctx: EffectCtx = {
      ikey: key,
      mode: created ? 'fresh' : 'resume',
      row,
      daemonStartedAt,
    };

    // Before every other branch, including the memoised one: a stale hash must
    // not be able to return a stale result (AC7).
    if (row.requestHash !== effect.requestHash) {
      throw new EffectRequestHashMismatch(key, row.requestHash, effect.requestHash);
    }

    // Completed in a previous life. F4.2 at effect granularity: no perform(),
    // and no second effect.completed — the event describing this effect is
    // already in the ledger and appending another would show one effect
    // finishing twice.
    if (row.state === 'done') return JSON.parse(row.resultJson ?? 'null') as T;

    if (row.state === 'failed') {
      throw new EffectFailed(key, JSON.parse(row.resultJson ?? 'null') as NodeFailure);
    }

    // Inherited `pending`: we died mid-effect. The only genuinely hard case,
    // and the only one reconcile() exists for. A row from this daemon life
    // falls straight past here — it is a concurrent caller, not a crash.
    if (row.startedAt < daemonStartedAt) {
      if (effect.reconcile === undefined) {
        throw new EffectNeedsReconciliation(key, 'the effect declares no reconcile probe');
      }
      const probe = await effect.reconcile(ctx);
      if (probe.status === 'done') return record(effect, key, probe.result, true);
      if (probe.status === 'unknown') {
        throw new EffectNeedsReconciliation(key, probe.detail ?? 'the probe returned unknown');
      }
    }

    return record(effect, key, await effect.perform(ctx), false);
  }

  function record<T>(effect: Effect<T>, key: IdempotencyKey, result: T, reconciled: boolean): T {
    const endedAt = clock.now();
    markEffectDone(
      db,
      key,
      result,
      endedAt,
      envelope(effect, key, 'effect.completed', endedAt, epoch, {
        ikey: key,
        result,
        reconciled,
      }),
      appendOptions,
    );
    return result;
  }

  return {
    async durable<T>(effect: Effect<T>): Promise<T> {
      // Two callers entering the same effect inside one tick share one
      // execution (AC3). `ON CONFLICT DO NOTHING` already guarantees one row;
      // this guarantees one `perform()`.
      //
      // An effect that does not name its ordinal is identified by the triple
      // it is about to take the next position of, because an attempt performs
      // its effects **one at a time** — `ordinal` is a sequence position, so
      // two effects of one attempt in flight at once would have no defined
      // order. Two concurrent entries for one triple are therefore the same
      // effect entered twice, which is exactly what has to be deduplicated.
      // The ordinal itself is not resolved here: doing so would read the
      // journal a second time, and the second caller would read it *after* the
      // first had already written its row.
      const dedupeKey = `${effect.runId}/${effect.nodeId}/${effect.attempt}/${effect.ordinal ?? 'next'}`;

      const existing = inFlight.get(dedupeKey);
      if (existing !== undefined) return (await existing) as T;

      const started = run(effect);
      inFlight.set(dedupeKey, started);
      try {
        return await started;
      } finally {
        inFlight.delete(dedupeKey);
      }
    },
  };
}
