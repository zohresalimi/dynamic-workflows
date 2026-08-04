/**
 * A bare SSE client that records when each event *arrived*, not when the server
 * says it was produced.
 *
 * That distinction is the whole measurement. A server can honestly log "one
 * event per second" while a compressing intermediary holds all six hundred of
 * them and flushes at the end; only receipt timestamps taken on the client side
 * can tell those two apart, which is why AC2 says "measured from the CSV, not
 * by watching a terminal".
 *
 * Blocks with no `data:` field — comments and the standalone `retry:` frame —
 * are deliberately not recorded: per the SSE specification they dispatch no
 * event, so counting them would inflate every measurement below.
 */

export interface ReceivedEvent {
  /** The `id:` field as a number, or `-1` when the frame carried none. */
  readonly seq: number;
  readonly event: string;
  readonly data: string;
  /** Milliseconds since this client connected. */
  readonly receivedAtMs: number;
}

export interface SseRecorder {
  readonly events: () => ReceivedEvent[];
  readonly waitFor: (count: number, timeoutMs: number) => Promise<ReceivedEvent[]>;
  readonly next: (
    predicate: (event: ReceivedEvent) => boolean,
    timeoutMs: number,
  ) => Promise<ReceivedEvent>;
  /** True once the response body ended — i.e. the stream dropped. */
  readonly ended: () => boolean;
  /** Milliseconds since connect at which the body ended, if it has. */
  readonly endedAtMs: () => number | null;
  readonly error: () => unknown;
  readonly responseHeaders: () => Headers;
  readonly close: () => void;
}

export interface ConnectOptions {
  readonly lastEventId?: string;
  readonly acceptEncoding?: string;
}

export async function connectSse(url: string, options: ConnectOptions = {}): Promise<SseRecorder> {
  const controller = new AbortController();
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (options.lastEventId !== undefined) headers['last-event-id'] = options.lastEventId;
  if (options.acceptEncoding !== undefined) headers['accept-encoding'] = options.acceptEncoding;

  const response = await fetch(url, { headers, signal: controller.signal });
  if (!response.ok || response.body === null) {
    throw new Error(`SSE connect to ${url} failed with ${response.status}`);
  }

  const startedAt = performance.now();
  const received: ReceivedEvent[] = [];
  let ended = false;
  let endedAtMs: number | null = null;
  let failure: unknown;

  const pump = async (): Promise<void> => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const parsed = parseBlock(buffer.slice(0, boundary), performance.now() - startedAt);
        if (parsed !== undefined) received.push(parsed);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
  };

  void pump()
    .catch((error: unknown) => {
      if (!controller.signal.aborted) failure = error;
    })
    .finally(() => {
      ended = true;
      endedAtMs = performance.now() - startedAt;
    });

  const waitUntil = async <T>(
    attempt: () => T | undefined,
    timeoutMs: number,
    what: string,
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = attempt();
      if (found !== undefined) return found;
      if (ended) throw new Error(`the stream ended before ${what} (${received.length} received)`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${what} did not happen within ${timeoutMs} ms (${received.length} received)`);
  };

  return {
    events: () => [...received],
    ended: () => ended,
    endedAtMs: () => endedAtMs,
    error: () => failure,
    responseHeaders: () => response.headers,
    close: () => controller.abort(),
    waitFor: (count, timeoutMs) =>
      waitUntil(
        () => (received.length >= count ? received.slice(0, count) : undefined),
        timeoutMs,
        `${count} events`,
      ),
    next: (predicate, timeoutMs) =>
      waitUntil(() => received.find(predicate), timeoutMs, 'a matching event'),
  };
}

function parseBlock(block: string, receivedAtMs: number): ReceivedEvent | undefined {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue; // a comment dispatches nothing
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }

  if (data.length === 0) return undefined; // e.g. a bare `retry:` frame
  return { seq: id === undefined ? -1 : Number(id), event, data: data.join('\n'), receivedAtMs };
}
