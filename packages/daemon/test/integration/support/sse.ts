/**
 * Frames off a live `text/event-stream`, awaited one predicate at a time.
 *
 * Deliberately hand-rolled rather than `EventSource`: the assertions are about
 * the `id:` line, about an *unnamed* event type, and about how many frames of
 * each `kind` arrived — and `EventSource` hides the first two behind
 * `onmessage` and makes the third a matter of counting callbacks.
 *
 * `countByKind` is what KAR-13.2 AC5 asks for in as many words: *"asserted by
 * counting frames by `kind`, not by eyeballing a log"*.
 */
export interface Frame {
  readonly id?: string | undefined;
  readonly event?: string | undefined;
  readonly data: string;
}

export interface Frames {
  /** Resolves with the first frame matching `match`, reading more if needed. */
  until(match: (frame: Frame) => boolean): Promise<Frame>;
  /** Resolves once at least `count` `: keepalive` comments have arrived. */
  untilKeepalives(count: number): Promise<void>;
  /** Resolves when the server closes the connection; rejects if it does not. */
  untilEnd(): Promise<void>;
  /** Ledger frames seen so far, tallied by their payload's `kind`. */
  countByKind(): Readonly<Record<string, number>>;
  /** Every frame seen so far, control frames included. */
  frameCount(): number;
  /** Every frame seen so far, in arrival order. */
  all(): readonly Frame[];
  /**
   * `: keepalive` comments seen so far.
   *
   * Counted rather than parsed into frames: a comment carries no field, which
   * is exactly why every SSE client ignores it, and a reader that turned one
   * into a frame would be proving the opposite of the property under test.
   */
  keepalives(): number;
  /** Every byte received so far, for assertions about the wire itself. */
  raw(): string;
  /** True once the response body has ended — the stream closed. */
  ended(): boolean;
}

export function readFrames(response: Response, signal: AbortSignal): Frames {
  const body = response.body;
  if (body === null) throw new Error('the stream response carried no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let raw = '';
  let keepalives = 0;
  let ended = false;
  const seen: Frame[] = [];

  const take = (text: string): void => {
    raw += text;
    buffered += text;
    let boundary = buffered.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      if (block.startsWith(':')) keepalives += 1;
      const frame = parseFrame(block);
      if (frame !== null) seen.push(frame);
      boundary = buffered.indexOf('\n\n');
    }
  };

  /**
   * The body is drained in the background rather than on demand.
   *
   * A reader that only pumped when something awaited it would make *"how many
   * frames arrived"* a question about the test's polling rather than about the
   * daemon's delivery — and a spec asserting "none of these 500 arrived" would
   * pass without ever having read the socket.
   */
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      take(decoder.decode(value, { stream: true }));
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      ended = true;
    });

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

  return {
    async until(match): Promise<Frame> {
      for (;;) {
        const found = seen.find(match);
        if (found !== undefined) return found;
        if (signal.aborted) throw new Error('aborted before the expected frame arrived');
        if (ended) throw new Error('the stream closed before the expected frame arrived');
        await settle();
      }
    },
    async untilKeepalives(count): Promise<void> {
      while (keepalives < count) {
        if (signal.aborted) throw new Error('aborted before the keepalives arrived');
        if (ended) throw new Error('the stream closed before the keepalives arrived');
        await settle();
      }
    },
    async untilEnd(): Promise<void> {
      while (!ended) {
        if (signal.aborted) throw new Error('aborted before the stream closed');
        await settle();
      }
    },
    all: () => [...seen],
    keepalives: () => keepalives,
    raw: () => raw,
    ended: () => ended,
    countByKind(): Readonly<Record<string, number>> {
      const counts: Record<string, number> = {};
      for (const frame of seen) {
        // Only ledger frames have a `kind`; control frames are named and are
        // never fed to a reducer, so they are never counted as data either.
        if (frame.event !== undefined) continue;
        const kind = (JSON.parse(frame.data) as { kind?: string }).kind;
        if (kind === undefined) continue;
        counts[kind] = (counts[kind] ?? 0) + 1;
      }
      return counts;
    },
    frameCount: () => seen.length,
  };
}

function parseFrame(block: string): Frame | null {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':') || line === '') continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  return { id, event, data: data.join('\n') };
}
