/**
 * KAR-12.6 AC6, AC7 — the input half of the gate-hygiene projection: which
 * runs "the last N runs" means, and what `gates.loaded` and `gate.evaluated`
 * said across them (docs/10-verification-gates.md §2, §9.1).
 *
 * The arithmetic — the first-pass rate, the 40% floor, the 100% tail — is
 * `gateHygiene()` in `@DeFlow/gates`, and it is a pure reducer over what this
 * function returns. The split is deliberate: a rate is a fact about a sample,
 * and *choosing the sample* is the part that reads the log. Without this
 * module the projection is only ever as right as the array somebody typed
 * into it.
 *
 * Deliberately **not** a run projection, for the same reason
 * `readLatestRateLimits` is not: `reduce()` answers "what is the state of this
 * run", and "which gate has nobody scheduled lately" is a question about the
 * data directory, spanning runs that finished days ago.
 *
 * **The window is by run, not by event.** Taking the newest N `gate.evaluated`
 * rows would answer a different question, and answer it in a way that flatters
 * the busiest gate: one chatty run with forty evaluations would fill the sample
 * on its own and every gate outside it would read as never evaluated. So the
 * runs are selected first and every gate event inside them is read.
 *
 * **Ordered by `seq`, never by `ts`.** `seq` is the ledger's only total order
 * (docs/04-domain-model.md §1.2); `ts` is display-only and moves backwards
 * across an NTP correction, which would silently pull an older run into the
 * window and push a newer one out.
 *
 * **Runs are ranked by where they *started* (`min(seq)`), not by their last
 * activity.** "The last 10 runs" is a claim about which runs happened, and
 * ranking by `max(seq)` would let one long-lived run that is still appending
 * outrank ten shorter runs that started after it — so a gate could be reported
 * as never scheduled on the strength of a sample that excluded most of the
 * week.
 */
import type { Db, GateId, RunId, VerdictOutcome } from '@DeFlow/core';
import { VERDICT_OUTCOMES } from '@DeFlow/core';

/** One `gate.evaluated` occurrence, reduced to what the projection reads. */
export interface SampledGateEvaluation {
  readonly gate: GateId;
  readonly outcome: VerdictOutcome;
  /** The run it happened in — a breadcrumb for the doctor's output, not a scope. */
  readonly runId: RunId;
}

/**
 * What the last N runs said about gates. Structurally the `GateHygieneInput`
 * of `@DeFlow/gates`, which is where the arithmetic lives — the dependency
 * runs that way round (`@DeFlow/gates` depends on `@DeFlow/ledger`), so the
 * shape is matched here rather than imported.
 */
export interface GateHygieneSample {
  /**
   * Every gate id the window knows of, in first-seen `seq` order: the ones a
   * sampled run's `gates.loaded` named, plus any a sampled run evaluated.
   *
   * The second half is not redundancy. A gate whose declaration aged out of the
   * window but which is still being scheduled inside it is the gate the
   * first-pass rate matters most about, and reporting no row for it would read
   * as "no such gate" rather than as "its `gates.loaded` is older than ten
   * runs".
   */
  readonly definedGates: readonly GateId[];
  /** How many runs were really found — never more than `runs`, often fewer. */
  readonly sampledRuns: number;
  /** The sampled runs themselves, newest first. */
  readonly runIds: readonly RunId[];
  /** Every `gate.evaluated` in those runs, in `seq` order. */
  readonly evaluations: readonly SampledGateEvaluation[];
}

/**
 * The default window: PRD §12's first-pass rate over the last ten runs.
 *
 * Ten because it is the number AC6 and the S38 scenario are written in, and
 * because the metric it feeds is a trend rather than a measurement of one run
 * — a window of one would report every gate the current run happens not to
 * schedule as decoration.
 */
export const DEFAULT_HYGIENE_RUN_SAMPLE = 10;

export interface GateHygieneSampleOptions {
  /** How many recent runs to sample. Defaults to `DEFAULT_HYGIENE_RUN_SAMPLE`. */
  readonly runs?: number;
}

/**
 * The N most recently started runs, newest first.
 *
 * `GROUP BY run_id` over `event` rather than a read of the `run` table: `run`
 * is a projection *cache* that is allowed to be stale or absent (KAR-03.6),
 * and a report whose job is to say "nobody has scheduled this gate" must not
 * be able to disagree with the rows it counts.
 */
const RECENT_RUNS_SQL = `
  SELECT run_id FROM event
  GROUP BY run_id
  ORDER BY min(seq) DESC
  LIMIT ?
`;

/**
 * One bounded window of one run's gate events.
 *
 * `run_id = ? AND seq > ?` with a `LIMIT`, drained in a loop, because that is
 * the only shape a read over `event` is allowed to take here (KAR-03.4 AC5,
 * and `test/append-only.test.ts` / `test/bounded-reads.test.ts` enforce both
 * halves). better-sqlite3 is fully synchronous: one unbounded scan across ten
 * runs would not make the doctor slow, it would stop the event loop under
 * every in-flight SSE stream in the daemon.
 *
 * Filtered on `kind` rather than drained through `drainEvents`, which would
 * read every event of every sampled run — on the order of 2,000 per run
 * (KAR-03.4 AC6) — and JSON-parse each payload to discard almost all of them.
 * Ten runs of gate events is tens of rows.
 */
const GATE_EVENTS_SQL = `
  SELECT run_id, kind, seq, payload FROM event
  WHERE run_id = ? AND seq > ? AND kind IN ('gates.loaded', 'gate.evaluated')
  ORDER BY seq
  LIMIT ?
`;

/** Rows per bounded query, matching `DEFAULT_DRAIN_BATCH`: it is the same
 * statement shape, and there is no reason for this drain to use another. */
const BATCH = 500;

interface GateEventRow {
  readonly run_id: string;
  readonly kind: string;
  readonly seq: number;
  readonly payload: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parsePayload = (payload: string): Record<string, unknown> | null => {
  try {
    return asRecord(JSON.parse(payload));
  } catch {
    // A payload this connection cannot parse is skipped rather than thrown on:
    // this is a read of history across every run in the directory, and one
    // unreadable row from an older build must not make the whole report
    // unavailable.
    return null;
  }
};

const isOutcome = (value: unknown): value is VerdictOutcome =>
  typeof value === 'string' && (VERDICT_OUTCOMES as readonly string[]).includes(value);

/**
 * Samples the last N runs for what the gate-hygiene projection needs.
 *
 * Read defensively rather than through `GateEvaluatedSchema`: the window
 * reaches back across runs written by older builds, and a strict parse would
 * turn a retired payload shape into a thrown report. Every field it does read
 * — `gates[].id`, `gate`, `verdict.outcome` — has been present since v1, and
 * an event that does not carry them is skipped rather than guessed at.
 */
export function sampleGateHygiene(
  db: Db,
  options: GateHygieneSampleOptions = {},
): GateHygieneSample {
  const window = Math.max(0, Math.trunc(options.runs ?? DEFAULT_HYGIENE_RUN_SAMPLE));
  if (window === 0) {
    return { definedGates: [], sampledRuns: 0, runIds: [], evaluations: [] };
  }

  const runIds = db
    .prepare<{ run_id: string }>(RECENT_RUNS_SQL)
    .all(window)
    .map((row) => row.run_id as RunId);

  if (runIds.length === 0) {
    return { definedGates: [], sampledRuns: 0, runIds: [], evaluations: [] };
  }

  const statement = db.prepare<GateEventRow>(GATE_EVENTS_SQL);
  const definedGates: GateId[] = [];
  const seen = new Set<string>();
  const evaluations: SampledGateEvaluation[] = [];

  const define = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    definedGates.push(id as GateId);
  };

  // Oldest sampled run first, so `definedGates` reads in the order the window
  // saw them. `runIds` itself stays newest-first, which is how a report lists
  // runs.
  for (const runId of runIds.toReversed()) {
    let cursor = 0;
    for (;;) {
      const rows = statement.all(runId, cursor, BATCH);
      for (const row of rows) {
        cursor = row.seq;
        const payload = parsePayload(row.payload);
        if (!payload) continue;

        if (row.kind === 'gates.loaded') {
          const gates = Array.isArray(payload.gates) ? payload.gates : [];
          for (const entry of gates) {
            const id = asRecord(entry)?.id;
            if (typeof id === 'string') define(id);
          }
          continue;
        }

        const gate = payload.gate;
        const outcome = asRecord(payload.verdict)?.outcome;
        if (typeof gate !== 'string' || !isOutcome(outcome)) continue;
        define(gate);
        evaluations.push({ gate: gate as GateId, outcome, runId: row.run_id as RunId });
      }
      if (rows.length < BATCH) break;
    }
  }

  return { definedGates, sampledRuns: runIds.length, runIds, evaluations };
}
