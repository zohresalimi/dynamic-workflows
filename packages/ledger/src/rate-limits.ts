/**
 * KAR-14.4 AC10 — the most recent `provider.rate_limited` per provider, across
 * every run in the data directory.
 *
 * Deliberately not a run projection. `reduce()` returns `null` for
 * `provider.rate_limited` because a vendor's quota is a fact about **a binary
 * on this machine** rather than about the run that happened to trip it — and
 * that is exactly why the doctor needs it: the limit that makes today's plan
 * unroutable was very likely tripped by yesterday's run.
 *
 * `resetsAt` is `null` when the payload carried none, and it is never filled
 * in. Every honest reading of "we do not know when this lifts" ends here, and a
 * plausible instant invented one layer down would be read as a measurement.
 *
 * Ordered by `seq`, never by `ts`: `seq` is the ledger's only total order
 * (docs/04-domain-model.md §1.2), and `ts` is display-only and can move
 * backwards across an NTP correction — which would silently pick the older
 * limit as "latest".
 */
import type { Db, DbStatement } from '@DeFlow/core';

/** One provider's current rate-limit state, as the ledger last saw it. */
export interface StoredRateLimit {
  readonly provider: string;
  /** ms epoch, or `null` when the vendor never said when the limit lifts. */
  readonly resetsAt: number | null;
  /** The envelope `ts` of the event, for "how long ago did this happen". */
  readonly at: number;
  /** The run that observed it — a breadcrumb, not a scope. */
  readonly runId: string;
}

interface EventRow {
  readonly run_id: string;
  readonly ts: number;
  readonly payload: string;
}

/**
 * How many providers one report may name.
 *
 * A bound rather than "all of them", because better-sqlite3 is fully
 * synchronous and an unbounded read on the write connection stalls every
 * in-flight SSE stream in the daemon rather than making one query slow. Sixty-
 * four is far beyond the five adapters the 2026-08-02 matrix measured and far
 * below anything that could stall a tick, so it is a ceiling nobody reaches
 * rather than a page size somebody has to paginate through.
 */
export const MAX_REPORTED_PROVIDERS = 64;

/**
 * The latest event per provider, as a `max(seq)` aggregate rather than a scan
 * with a cursor.
 *
 * Written as a grouped maximum on purpose, and not as "read the newest N rows
 * and de-duplicate in JavaScript": a window would silently drop a provider
 * whose last limit is older than N events, and the one thing this report exists
 * to say is *which providers are currently unusable*. It also keeps the read
 * inside `seq`, the ledger's only total order — `ts` is display-only and moves
 * backwards across an NTP correction, which would pick the older limit.
 *
 * The `WHERE kind = …` predicate is spelled exactly as migration 0013's partial
 * index is, because a partial index is only used when the query's predicate
 * matches it.
 */
const LATEST_SQL = `
  SELECT run_id, ts, payload FROM event
  WHERE seq IN (
    SELECT max(seq) FROM event
    WHERE kind = 'provider.rate_limited'
    GROUP BY json_extract(payload, '$.provider')
  )
  ORDER BY seq DESC
  LIMIT ?
`;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function readLatestRateLimits(
  db: Db,
  limit: number = MAX_REPORTED_PROVIDERS,
): readonly StoredRateLimit[] {
  const statement: DbStatement<EventRow> = db.prepare(LATEST_SQL);
  const latest = new Map<string, StoredRateLimit>();

  for (const row of statement.all(limit)) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      // A payload that will not parse is a corrupted row, and this is a
      // *report*: skipping it leaves the operator with the providers that do
      // parse, which beats a doctor command that cannot run at all.
      continue;
    }
    const record = asRecord(payload);
    const provider = record?.provider;
    if (typeof provider !== 'string' || provider === '') continue;
    // Newest first, so the first sighting is the current one.
    if (latest.has(provider)) continue;

    const resetsAt = record?.resetsAt;
    latest.set(provider, {
      provider,
      resetsAt: typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt : null,
      at: row.ts,
      runId: row.run_id,
    });
  }

  return [...latest.values()].toSorted((left, right) =>
    left.provider < right.provider ? -1 : left.provider > right.provider ? 1 : 0,
  );
}
