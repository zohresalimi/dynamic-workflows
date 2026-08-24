/**
 * KAR-05.8 AC4, wired — the shim line uuids this node attempt has already made
 * durable.
 *
 * `runShimNode` dedupes on the vendor's own per-line `uuid`, and it takes the
 * already-seen set as a port because `@DeFlow/adapters` owns no database. A
 * caller that passed nothing would be telling it *"nothing is durable yet"* —
 * true for a first attempt, and wrong for a replay: the whole transcript would
 * be appended a second time into a ledger that keeps it for ever.
 *
 * Read back out of the rows the runner itself wrote (`node.progress`, phase
 * `shim.<type>`, message `uuid=<id>[ · N bytes spilled to …]`) rather than out
 * of a side table, because the ledger is the only thing that survives the crash
 * this exists for. The format is one line of `run-shim-node.ts`; if it ever
 * changes, `./shim-replay.test.ts` is what fails.
 */
import type { Db, NodeId, RunId } from '@DeFlow/core';
import { readRange } from '@DeFlow/ledger';

/** One page is a whole run's control plane several times over. */
const EVENT_PAGE = 5_000;

/** The `uuid=` token `runShimNode` writes, or `null` for `uuid=none`. */
function uuidOf(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const match = /^uuid=([^\s·]+)/.exec(message);
  const uuid = match?.[1];
  return uuid === undefined || uuid === 'none' ? null : uuid;
}

/**
 * Every shim line uuid already durable for `(runId, nodeId, attempt)`.
 *
 * An empty set for an attempt with no rows, which is the honest answer for a
 * first attempt — and the `attempt` filter is what keeps a *retry* from
 * inheriting the attempt it replaced, whose transcript is a different turn.
 */
export function seenShimUuids(
  db: Db,
  runId: RunId,
  nodeId: NodeId,
  attempt: number,
): ReadonlySet<string> {
  const seen = new Set<string>();
  let cursor = 0;
  for (;;) {
    const page = readRange(db, runId, cursor, EVENT_PAGE);
    for (const event of page.events) {
      cursor = event.seq;
      if (event.kind !== 'node.progress') continue;
      if (event.nodeId !== nodeId || event.attempt !== attempt) continue;
      const payload = event.payload as { phase?: unknown; message?: unknown };
      if (typeof payload.phase !== 'string' || !payload.phase.startsWith('shim.')) continue;
      const uuid = uuidOf(payload.message);
      if (uuid !== null) seen.add(uuid);
    }
    if (!page.hasMore) return seen;
  }
}
