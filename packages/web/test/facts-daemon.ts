/**
 * A `fetch` that serves `GET /api/runs/:id/facts/:factId/consumers` the way
 * DeFlowd does.
 *
 * The transport is stubbed; the *shape* is the daemon's own — one row per
 * reading node with `node`, `firstReadSeq` and `reads`, which is what
 * `packages/ledger/src/blackboard.ts`'s indexed `GROUP BY` returns and what
 * `packages/daemon/src/http/api.ts` hands back unchanged.
 *
 * Every request is recorded, because AC3's claim is not *"a consumer list
 * appears"* — the projection could produce one of those from the edges it is
 * already holding. It is *"the complete consumer set is **fetched**"*, and the
 * difference between the two only shows up in a spec that can name a consumer
 * this tab never saw a `fact.read` for.
 */

/** One row of `GET /api/runs/:id/facts/:factId/consumers`. */
export interface FactConsumerRow {
  readonly node: string;
  readonly firstReadSeq: number;
  readonly reads: number;
}

export interface ConsumersAsked {
  readonly runId: string;
  readonly factId: string;
}

export const FACTS_API_BASE = 'http://127.0.0.1:7777/api';

const CONSUMERS = /\/api\/runs\/([^/]+)\/facts\/([^/]+)\/consumers$/;

/**
 * A `fetch` answering the consumers endpoint from `rows`, recording each ask.
 *
 * `rows` is keyed by fact id. A fact it does not know answers `[]` rather than
 * 404: an unread fact is a fact with no consumers, which is a legitimate and
 * common answer.
 */
export function consumersFetch(
  rows: ReadonlyMap<string, readonly FactConsumerRow[]>,
  asked: ConsumersAsked[],
): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const match = CONSUMERS.exec(url.split('?')[0] ?? '');
    if (match === null) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }

    const runId = decodeURIComponent(match[1] as string);
    const factId = decodeURIComponent(match[2] as string);
    asked.push({ runId, factId });

    return Promise.resolve(
      new Response(JSON.stringify(rows.get(factId) ?? []), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}
