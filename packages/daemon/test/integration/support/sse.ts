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
  /** Ledger frames seen so far, tallied by their payload's `kind`. */
  countByKind(): Readonly<Record<string, number>>;
  /** Every frame seen so far, control frames included. */
  frameCount(): number;
}

export function readFrames(response: Response, signal: AbortSignal): Frames {
  const body = response.body;
  if (body === null) throw new Error('the stream response carried no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const seen: Frame[] = [];

  const pump = async (): Promise<void> => {
    const { value, done } = await reader.read();
    if (done) throw new Error('the stream closed before the expected frame arrived');
    buffered += decoder.decode(value, { stream: true });
    let boundary = buffered.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const frame = parseFrame(block);
      if (frame !== null) seen.push(frame);
      boundary = buffered.indexOf('\n\n');
    }
  };

  return {
    async until(match): Promise<Frame> {
      for (;;) {
        const found = seen.find(match);
        if (found !== undefined) return found;
        if (signal.aborted) throw new Error('aborted before the expected frame arrived');
        await pump();
      }
    },
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
