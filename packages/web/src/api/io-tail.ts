/**
 * KAR-17.5 — the client half of `GET /api/runs/:id/nodes/:nodeId/io`.
 *
 * Verifies: EPIC-17-S20 (scenarios 1 and 3) · AC6, AC8
 *
 * **This is deliberately not a query and not a projection.** The two halves of
 * KAR-16.4's state split are "an event was appended" (projection) and "a file
 * on disk changed" (query, `@pinia/colada`); `io_chunk` is neither. It is the
 * data plane — physically a different table from `event`, never folded by a
 * reducer, and megabytes where the control plane is kilobytes
 * (`packages/ledger/src/io-chunk.ts`). Putting it behind either would put agent
 * output into the store the whole design keeps it out of, which is AC8.
 *
 * So the panel owns its own bytes, holds a bounded window of them, and drops
 * them when it unmounts. Nothing else in the application can see them.
 *
 * The framing is **outside the versioned contract** (KAR-15.6 AC11): the
 * response carries `X-DeFlow-Unversioned` saying so on every request. The
 * stable archive is `runs/<runId>/nodes/<nodeId>/stdout.log`, which is what
 * "Open full log" reads.
 */
import { type IoChunkLine, ioFollowQuery, ioTailQuery, parseIoNdjson } from '../lib/node-output.ts';
import type { ApiClient } from './client.ts';

export interface IoPage {
  readonly chunks: readonly IoChunkLine[];
  /** The endpoint's own answer to "is there more behind this window". */
  readonly hasMore: boolean;
}

type IoRequest = Parameters<ApiClient['runs'][':id']['nodes'][':nodeId']['io']['$get']>[0];

async function readPage(
  client: ApiClient,
  runId: string,
  nodeId: string,
  query: Record<string, string>,
): Promise<IoPage> {
  // One cast, at one site, and it is honest about why: the daemon reads
  // `limit` and `fromSeq` with `c.req.query(...)` rather than through a zod
  // validator, so Hono's RPC type for this route carries `param` and no
  // `query` at all. The alternative — adding a validator purely to please a
  // client type — would change the endpoint's error behaviour (a 400 where the
  // documented answer is "clamp and say so in `X-DeFlow-Limit`", KAR-15.6 AC9)
  // to make a type nicer, which is the wrong way round.
  const request = { param: { id: runId, nodeId }, query } as unknown as IoRequest;
  const response = await client.runs[':id'].nodes[':nodeId'].io.$get(request);

  if (!response.ok) {
    throw new Error(`reading output of ${nodeId} answered ${response.status}`);
  }

  return {
    chunks: parseIoNdjson(await response.text()),
    hasMore: response.headers.get('X-DeFlow-Io-More') === 'true',
  };
}

/** AC6 — the reattach: the last N chunks, `fromSeq` omitted. */
export const readIoTail = (
  client: ApiClient,
  runId: string,
  nodeId: string,
  limit?: number,
): Promise<IoPage> => readPage(client, runId, nodeId, { ...ioTailQuery(limit) });

/** Following on from the highest seq already applied. */
export const readIoSince = (
  client: ApiClient,
  runId: string,
  nodeId: string,
  fromSeq: number,
  limit?: number,
): Promise<IoPage> => readPage(client, runId, nodeId, { ...ioFollowQuery(fromSeq, limit) });
