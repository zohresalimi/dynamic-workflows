/**
 * Minimal SSE and HMR-websocket clients for the e2e specs.
 *
 * Both speak the wire protocol a browser speaks, over the daemon's single
 * port. That is the whole point of the specs that use them: if HMR and SSE can
 * both be held on one origin from a bare Node client, D10's premise holds
 * without a browser in the loop.
 */

export interface SseEvent {
  readonly event: string;
  readonly data: string;
  readonly id: string | undefined;
  readonly receivedAt: number;
}

export interface SseClient {
  readonly events: () => SseEvent[];
  /**
   * `: keepalive` comments seen so far (KAR-15.3 AC8).
   *
   * Counted rather than parsed into events, because that is the property: a
   * comment carries no field, which is exactly why every SSE client ignores
   * one, and a reader that turned it into an event would be proving the
   * opposite. The idle cadence is a comment and not a named `heartbeat` frame
   * because AC5 reserves named events for stream control — `hello`,
   * `subscribed`, `caught_up`, `fatal` — and a fifth name would be one more
   * thing a reducer has to know to ignore.
   */
  readonly keepalives: () => number;
  /** Resolve with the first event, after `from`, matching `predicate`. */
  readonly next: (predicate: (event: SseEvent) => boolean, timeoutMs: number) => Promise<SseEvent>;
  /** True once the response body has ended — i.e. the stream dropped. */
  readonly ended: () => boolean;
  readonly error: () => unknown;
  readonly close: () => void;
}

/**
 * Opens the stream the way the UI does (KAR-15.2 AC8/AC9): the bearer token
 * travels in the `Authorization` **header**, never in the query string. That is
 * the whole reason the browser client is `eventsource-client` rather than
 * native `EventSource`, which cannot set a header — so a helper that reached
 * for `?token=` here would be testing a design the daemon does not have.
 */
export async function openSse(url: string, token?: string): Promise<SseClient> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: {
      accept: 'text/event-stream',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    signal: controller.signal,
  });
  if (!response.ok || response.body === null) {
    throw new Error(`SSE connect to ${url} failed with ${response.status}`);
  }

  const received: SseEvent[] = [];
  let keepalives = 0;
  let ended = false;
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
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.startsWith(':')) keepalives += 1;
        const parsed = parseBlock(block);
        if (parsed !== undefined) received.push(parsed);
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
    });

  return {
    events: () => [...received],
    keepalives: () => keepalives,
    ended: () => ended,
    error: () => failure,
    close: () => controller.abort(),
    next: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      let cursor = 0;
      while (Date.now() < deadline) {
        while (cursor < received.length) {
          const event = received[cursor];
          cursor += 1;
          if (event !== undefined && predicate(event)) return event;
        }
        if (ended) throw new Error('the SSE stream ended before a matching event arrived');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no matching SSE event within ${timeoutMs} ms`);
    },
  };
}

function parseBlock(block: string): SseEvent | undefined {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  let sawField = false;

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue; // comment / keep-alive
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    sawField = true;
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }

  if (!sawField) return undefined;
  return { event, data: data.join('\n'), id, receivedAt: performance.now() };
}

export interface HmrSocket {
  readonly messages: () => Record<string, unknown>[];
  readonly next: (
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ) => Promise<Record<string, unknown>>;
  readonly close: () => void;
}

/**
 * Connects to Vite's HMR websocket *on the daemon's port*. In middleware mode
 * with `{ server }`, Vite attaches to the parent server's upgrade event, so a
 * successful handshake here is the proof that HMR is not on a second socket.
 */
export async function openHmrSocket(origin: string, timeoutMs = 10_000): Promise<HmrSocket> {
  const socket = new WebSocket(origin.replace(/^http/, 'ws'), 'vite-hmr');
  const received: Record<string, unknown>[] = [];

  socket.addEventListener('message', (event) => {
    try {
      received.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    } catch {
      // Vite only ever sends JSON frames; anything else is not ours to parse.
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the HMR websocket did not open within ${timeoutMs} ms`)),
      timeoutMs,
    );
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('the HMR websocket errored while connecting'));
    });
  });

  return {
    messages: () => [...received],
    close: () => socket.close(),
    next: async (predicate, waitMs) => {
      const deadline = Date.now() + waitMs;
      let cursor = 0;
      while (Date.now() < deadline) {
        while (cursor < received.length) {
          const message = received[cursor];
          cursor += 1;
          if (message !== undefined && predicate(message)) return message;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        `no matching HMR message within ${waitMs} ms; saw ${JSON.stringify(received)}`,
      );
    },
  };
}
