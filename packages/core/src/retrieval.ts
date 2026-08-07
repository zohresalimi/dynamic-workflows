/**
 * KAR-09.10 — turning an `artifact_fts` hit into a `retrieved` context
 * segment (docs/08-context-and-memory.md §5.2, §10; AC4, AC5).
 *
 * This module is deliberately thin and knows nothing about SQLite: it takes
 * the rows `@DeFlow/ledger`'s `queryArtifactFts` already resolved — the FTS5
 * `MATCH`, the `bm25(2.0, 1.0)` ranking and the `snippet()` formatting all
 * happened before this runs (R1: core performs no I/O) — and turns each one
 * into the one thing a packet can hold: a `Segment`.
 *
 * **Why the segment's `text` carries the handle rather than a dedicated
 * field.** `Segment` (./context-packet.ts) has no `handle` column — the
 * schema is `DeFlow.contextpacket.v1` and shipped, and a handle is not a
 * property of the bytes, it is a property of the sentence DeFlow writes about
 * them. `handleStubText` (./artifact-offload.ts) already made this call for a
 * demoted body; `retrievedSegmentText` makes the same call for a retrieved
 * one, so a `retrieved` segment reads the same way a demoted one does: a
 * snippet the agent can act on, a `${READ_ARTIFACT_TOOL}` pull line naming
 * the exact handle, and — because a search hit's provenance is "which node
 * produced this", not "how big is it" — the producing node's id in place of
 * the byte count.
 *
 * **Why this bounds to 20 again, on top of the SQL `LIMIT 20`.** `Db` is a
 * port; nothing here trusts a caller's query to have used the documented
 * shape. `RETRIEVED_ARTIFACT_LIMIT` is exported so the ledger's `LIMIT`
 * parameter and this ceiling are the same literal 20, never two numbers with
 * a chance to drift.
 *
 * Verifies: EPIC-09-S53 (segment provenance), EPIC-09-S54 (bounded results) ·
 * AC5
 */
import { READ_ARTIFACT_TOOL } from './artifact-offload.ts';
import type { Segment } from './context-packet.ts';
import type { EventSeq, Handle } from './ids.ts';
import { contextSegment, heuristicTokens, type TokenEstimator } from './pinned-set.ts';

/** §10's `LIMIT 20`, single-sourced so the SQL bound and this ceiling cannot
 * silently disagree. */
export const RETRIEVED_ARTIFACT_LIMIT = 20;

/**
 * One `artifact_fts` search hit, already resolved to what a segment needs:
 * the snippet text, the node that produced the artifact, the handle that
 * addresses it and the event that put it there (AC5's click-through).
 */
export interface ArtifactRetrievalHit {
  readonly nodeId: string;
  /** `snippet(artifact_fts, 1, '[', ']', '…', 24)` — the bracketed excerpt. */
  readonly snippet: string;
  readonly handle: Handle;
  readonly sourceEvent: EventSeq;
}

/**
 * §5.2's handle line, adapted for a search hit: the snippet is already the
 * agent-facing summary (the bracketed match), so the pull line only has to
 * say *whose* artifact this is and how to fetch the rest of it.
 */
export function retrievedSegmentText(
  hit: Pick<ArtifactRetrievalHit, 'nodeId' | 'snippet' | 'handle'>,
): string {
  return (
    `${hit.snippet}\n` +
    `  — from node "${hit.nodeId}"; pull the full artifact with the \`${READ_ARTIFACT_TOOL}\` ` +
    `MCP tool: ${hit.handle}`
  );
}

/**
 * AC5: one unpinned, compactable `retrieved` segment per hit, in the order
 * the ranking already produced — `queryArtifactFts` orders by `rank`, and
 * re-sorting here would silently discard that.
 *
 * Bounded to `RETRIEVED_ARTIFACT_LIMIT` regardless of how many hits arrive
 * (EPIC-09-S54's "at most 20 retrieved segments enter the packet"). Zero
 * hits — an empty index, or a query with no match — produces zero segments
 * and never throws (EPIC-09-S54's third scenario).
 */
export async function retrievedSegmentsOf(
  hits: readonly ArtifactRetrievalHit[],
  estimate: TokenEstimator = heuristicTokens,
): Promise<Segment[]> {
  const bounded = hits.slice(0, RETRIEVED_ARTIFACT_LIMIT);
  return Promise.all(
    bounded.map((hit, index) =>
      contextSegment({
        id: `retrieved-${index + 1}`,
        kind: 'retrieved',
        text: retrievedSegmentText(hit),
        sourceEvent: hit.sourceEvent,
        estimate,
      }),
    ),
  );
}
