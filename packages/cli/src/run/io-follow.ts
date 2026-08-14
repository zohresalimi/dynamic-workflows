/**
 * KAR-19.4 AC3 — the agent's own bytes, on the terminal, while the node runs.
 *
 * `DeFlow run` watches the **control plane**: `node.started`, `gate.evaluated`,
 * `run.completed`. Agent stdout is deliberately not there — it lives in
 * `io_chunk`, a separate table with a separate endpoint, precisely so a chatty
 * agent cannot drown the ledger every replay re-reads (KAR-03.4). Which means
 * that until this file existed, `DeFlow run` could render a perfect transcript
 * of a ten-minute node and show the operator nothing the agent said.
 *
 * Three rules, and each of them is the difference between output and the
 * appearance of output.
 *
 * **It follows from a cursor, never from zero.** `?fromSeq=<highest seen>` with
 * `seq > fromSeq` — not `cursor + 1`, because `io_chunk.seq` is `AUTOINCREMENT`
 * and pruning leaves permanent gaps, so `+1` silently skips a frame. The query
 * builder and the NDJSON parser are `@DeFlow/web`'s, the same ones the browser
 * panel uses: `./run.ts`'s standing rule is that there is **no second protocol
 * implementation**, and a tail format is a protocol.
 *
 * **It stops following a node only after draining it.** A `node.completed`
 * arrives on the control plane the instant the node ends, and the last chunks
 * are already in the table by then — but a follower that unregistered on the
 * event would race its own last poll and drop the end of the output, which is
 * the part that says what happened. So an ended node is drained once more and
 * only then forgotten, and `close()` drains everything still open.
 *
 * **It never holds the run open.** The poll is a plain `setTimeout` chain that
 * is cancelled by `close()`; nothing here can keep the process alive after the
 * verdict, and a failed request is a skipped poll rather than a thrown command
 * — the run is the daemon's, and a viewer that exited because one HTTP request
 * failed would be the least useful possible response to a flaky socket.
 *
 * Verifies: EPIC-19-S25 · AC3
 */
import type { Event, NodeId } from '@DeFlow/core';
import { IO_TAIL_CHUNKS, type IoChunkLine, ioFollowQuery, parseIoNdjson } from '@DeFlow/web';

/** How often a followed node is asked for what has arrived since the cursor. */
export const IO_POLL_MS = 100;

export interface IoFollowOptions {
  readonly runId: string;
  /** The daemon's origin, without the `/api` suffix. */
  readonly baseUrl: string;
  readonly token?: string | undefined;
  /** Called with every chunk, in produced order, as it arrives. */
  readonly onChunk: (node: NodeId, chunk: IoChunkLine) => void;
  readonly pollMs?: number | undefined;
  /** Injected only so a spec can drive the poll without a socket. */
  readonly fetch?: typeof globalThis.fetch;
  /** A ref'd wait; see `RunCommandOptions.sleep` for why that matters. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface IoFollower {
  /** Every control event the command renders is offered here too. */
  onEvent(event: Event): void;
  /** Drains every node still open, then stops polling. Idempotent. */
  close(): Promise<void>;
}

/** The control events that mean *this node has bytes to read*. */
const OPENS: readonly string[] = ['node.started'];

/** …and the ones that mean *there will be no more of them*. */
const CLOSES: readonly string[] = ['node.completed', 'node.failed', 'node.cancelled'];

interface Followed {
  readonly node: NodeId;
  readonly attempt: number;
  cursor: number;
  /** Set when the control plane says the node ended; cleared after one final
   * drain, which is what stops the race described in the module note. */
  ended: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Follows every node of one run that starts while this is open.
 *
 * Stateless about the run itself: which nodes exist comes from the control
 * events the command is already rendering, so there is no second subscription
 * and no second idea of what the run is doing.
 */
export function followNodeOutput(options: IoFollowOptions): IoFollower {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? IO_POLL_MS;
  const following = new Map<string, Followed>();
  // A field rather than a `let`: `close()` flips it while `loop()` is awaiting,
  // which is exactly the concurrency a flow analysis over a local cannot see —
  // and a linter that decides the check is dead is right about the local and
  // wrong about the program.
  const life: { closed: boolean } = { closed: false };
  let looping: Promise<void> | null = null;

  function onEvent(event: Event): void {
    const node = event.nodeId;
    if (node === undefined) return;

    if (OPENS.includes(event.kind)) {
      // The data plane counts attempts from 1 and the event envelope from 0.
      // The translation lives in `packages/daemon/src/exec/ledger-sink.ts` on
      // the write side and in the route on the read side; getting it wrong here
      // does not fail — it silently serves the output of the attempt this one
      // replaced.
      const attempt = event.attempt ?? 0;
      const key = `${node}/${String(attempt)}`;
      if (!following.has(key)) following.set(key, { node, attempt, cursor: 0, ended: false });
      start();
      return;
    }

    if (CLOSES.includes(event.kind)) {
      const entry = following.get(`${node}/${String(event.attempt ?? 0)}`);
      if (entry !== undefined) entry.ended = true;
    }
  }

  function start(): void {
    if (life.closed || looping !== null) return;
    looping = loop();
  }

  async function loop(): Promise<void> {
    // `life.closed` is read once per pass, at the top. A second check after the
    // sleep would buy nothing — the loop is about to read it anyway — and would
    // be the kind of belt-and-braces condition that is unreachable by
    // construction and looks like a bug to the next reader.
    while (following.size > 0 && !life.closed) {
      await drain();
      if (following.size === 0) break;
      await sleep(pollMs);
    }
    looping = null;
  }

  /** One pass over every followed node. An ended node is dropped after it. */
  async function drain(): Promise<void> {
    for (const [key, entry] of following) {
      const wasEnded = entry.ended;
      await pull(entry);
      // Dropped *after* the pull that followed the ending event, never on the
      // event itself: the last chunks and `node.completed` land in different
      // tables and the read that would have found them has to happen first.
      if (wasEnded) following.delete(key);
    }
  }

  async function pull(entry: Followed): Promise<void> {
    const query = ioFollowQuery(entry.cursor, IO_TAIL_CHUNKS);
    const url =
      `${options.baseUrl.replace(/\/$/, '')}/api/runs/${encodeURIComponent(options.runId)}` +
      `/nodes/${encodeURIComponent(entry.node)}/io` +
      `?fromSeq=${query.fromSeq}&limit=${query.limit}&attempt=${String(entry.attempt)}`;

    let text: string;
    try {
      const response = await doFetch(url, {
        headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
      });
      if (!response.ok) return;
      text = await response.text();
    } catch {
      // A viewer that exited because one poll failed would be the least useful
      // possible answer to a flaky socket. The cursor is unchanged, so the next
      // pass asks for the same window.
      return;
    }

    for (const chunk of parseIoNdjson(text)) {
      if (chunk.seq <= entry.cursor) continue;
      entry.cursor = chunk.seq;
      options.onChunk(entry.node, chunk);
    }
  }

  async function close(): Promise<void> {
    if (life.closed) return;
    // The flag first, then the loop is let finish, and only then the last read.
    // In that order there is never a second `drain()` running beside the poll's
    // own — two concurrent readers of the same cursor would each skip what the
    // other had just consumed.
    life.closed = true;
    await looping;
    // Every open node is read one last time before the door shuts: the run's
    // final bytes are usually produced in the same instant as the event that
    // ends it, and losing them is losing the answer.
    if (following.size > 0) await drain();
  }

  return { onEvent, close };
}
