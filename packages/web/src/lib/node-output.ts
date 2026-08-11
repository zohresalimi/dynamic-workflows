/**
 * KAR-17.5 — how a panel asks for a node's output, and which renderer the
 * answer deserves.
 *
 * Verifies: EPIC-17-S20, EPIC-17-S21, EPIC-17-S23 · AC6, AC10
 *
 * ## The tail is the absence of a parameter
 *
 * `GET /api/runs/:id/nodes/:nodeId/io` has two modes and no flag to choose
 * between them (docs/11-api-and-realtime.md §7.6):
 *
 * - **`fromSeq` omitted, `limit` set** — the tail. One index walk backwards
 *   from the end of `io_chunk`, bounded by `limit`.
 * - **`fromSeq` set** — pages forward with `seq > fromSeq`, for following on
 *   from a cursor the panel already holds.
 *
 * Paging forward from zero to reach the end reads the whole table to answer
 * *"what are the last few hundred lines"*, and on a node with 200 MB of output
 * that is the difference between a panel and a stalled tab. Because the mode is
 * chosen by a **missing key**, `ioTailQuery()` returns an object that does not
 * have one — not one whose value is `undefined`, which most query serialisers
 * render as `?fromSeq=undefined` and the daemon reads as `0`.
 *
 * ## The renderer is chosen by the stream, not by the vendor
 *
 * `io_chunk.stream` is one of `stdout`, `stderr` or `agent_json`
 * (`packages/ledger/src/io-chunk.ts`), and that is already the distinction
 * docs/12 §6.6 draws: `agent_json` is a typed JSON-RPC frame and belongs in a
 * list of typed message components; `stdout` from a CLI shim is genuinely ANSI
 * with cursor movement and spinners and belongs in xterm. Deriving it from the
 * provider's name instead would need a capability table this project does not
 * keep, and would be wrong the first time an adapter changed dialects
 * mid-release.
 */

/** The three streams a node produces, as `packages/ledger` names them. */
export type IoStream = 'stdout' | 'stderr' | 'agent_json';

/** One `io_chunk` as the NDJSON tail frames it. AC11: unversioned on purpose. */
export interface IoChunkLine {
  readonly seq: number;
  readonly stream: IoStream;
  /** ms epoch. */
  readonly ts: number;
  readonly data: string;
}

/**
 * How many chunks a reattach asks for.
 *
 * The endpoint's own bound is `{ fallback: 500, cap: 2000 }`
 * (`packages/daemon/src/http/read-limits.ts`). 500 chunks is a few hundred
 * kilobytes of agent output — comfortably more than the 5,000 scrollback lines
 * a terminal will hold and comfortably less than a log — and asking for the cap
 * would trade a slower first paint for scrollback nobody scrolls to.
 */
export const IO_TAIL_CHUNKS = 500;

/** The endpoint's cap. Asking beyond it is clamped silently, so we do not. */
const IO_LIMIT_CAP = 2_000;

const boundedLimit = (limit: number): string =>
  String(Number.isInteger(limit) && limit > 0 ? Math.min(limit, IO_LIMIT_CAP) : IO_TAIL_CHUNKS);

/** AC6 — the reattach: the last N chunks, and never the whole log. */
export function ioTailQuery(limit: number = IO_TAIL_CHUNKS): { readonly limit: string } {
  return { limit: boundedLimit(limit) };
}

/**
 * Following on from a cursor the panel already applied.
 *
 * `fromSeq` is the highest seq *seen*, not that plus one: `io_chunk.seq` is
 * `AUTOINCREMENT` and pruning leaves permanent gaps, so `seq > fromSeq` is the
 * only comparison that cannot skip a frame.
 */
export function ioFollowQuery(
  fromSeq: number,
  limit: number = IO_TAIL_CHUNKS,
): { readonly fromSeq: string; readonly limit: string } {
  return { fromSeq: String(fromSeq), limit: boundedLimit(limit) };
}

/**
 * NDJSON in, chunks out — tolerant of the last line being half an object.
 *
 * The response is read and painted as it arrives, which is the whole reason it
 * is `application/x-ndjson` and not a JSON array. Every read therefore ends
 * mid-object sooner or later, and a parser that threw would take the panel down
 * for a chunk boundary rather than for a problem.
 */
export function parseIoNdjson(text: string): IoChunkLine[] {
  const lines: IoChunkLine[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      lines.push(JSON.parse(line) as IoChunkLine);
    } catch {
      // A torn trailing line. The next read starts with the rest of it.
    }
  }
  return lines;
}

/** Which surface a node's output belongs on. */
export type OutputRenderer = 'structured' | 'terminal' | 'none';

/**
 * AC10 — what the panel says for a node that produced nothing.
 *
 * A sentence rather than an empty terminal, because an empty terminal and a
 * broken terminal look identical and the operator opened this panel precisely
 * because they could not tell which situation they were in.
 */
export const NO_OUTPUT_AT_ALL = 'This node produced no output at all.';

/**
 * AC10 — and what it says when the adapter stopped without finishing its turn.
 */
export const ENDED_WITHOUT_RESULT =
  'The adapter’s output ended without a result envelope — the turn did not finish.';

/**
 * EPIC-17-S21 — the right renderer for the right stream.
 *
 * A single `agent_json` frame is enough to choose the typed list: an ACP
 * bridge writes its own diagnostics to stderr, and one line of those must not
 * demote a whole typed transcript to a terminal.
 */
export function outputRendererFor(chunks: readonly IoChunkLine[]): OutputRenderer {
  if (chunks.length === 0) return 'none';
  return chunks.some((chunk) => chunk.stream === 'agent_json') ? 'structured' : 'terminal';
}
