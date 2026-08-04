/**
 * The minimum honest ACP client: JSON-RPC 2.0 over newline-delimited stdio,
 * with DeFlow's own frame cap in front of the framer.
 *
 * It deliberately does not use `@agentclientprotocol/sdk`'s
 * `ClientSideConnection`. Two of the eight acceptance criteria are about
 * behaviour the SDK does not have — an upstream frame cap, and continuing to
 * drain the stream after the prompt promise has settled — and a client built
 * on the SDK could not demonstrate either. The SDK is still used, in
 * verify-recording.ts, for the one thing it is authoritative about: the wire
 * schema.
 */
import { CappedLineFramer, DEFAULT_FRAME_CAP_BYTES, FrameTooLargeError } from './framing.ts';
import type { Direction } from './recording.ts';

export interface Clock {
  /** Monotonic milliseconds. Never `Date.now()` — this measures durations. */
  now(): number;
}

export const monotonicClock: Clock = { now: () => performance.now() };

/** A duplex byte channel: a spawned agent, or a recording being replayed. */
export interface Channel {
  write(bytes: Uint8Array): void;
  onData(handler: (bytes: Uint8Array) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void;
}

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface Outcome {
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

export interface ClientOptions {
  readonly clock?: Clock;
  readonly frameCapBytes?: number;
  /** The transport tee. Called with raw bytes, before and after nothing. */
  readonly tee?: (t: number, dir: Direction, bytes: Uint8Array) => void;
  readonly onNotification?: (message: JsonRpcMessage, receivedAt: number) => void;
  /** Answers an agent→client request. Returning `undefined` sends `{}`. */
  readonly onRequest?: (message: JsonRpcMessage) => unknown;
  /**
   * Called synchronously as a response frame is dispatched — before the
   * awaiting promise's continuation runs. "Did this notification arrive after
   * the prompt settled?" is a question about frame order, and answering it
   * from a microtask would make it a question about scheduling instead.
   */
  readonly onResponse?: (message: JsonRpcMessage) => void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class AcpClient {
  readonly #channel: Channel;
  readonly #clock: Clock;
  readonly #framer: CappedLineFramer;
  readonly #options: ClientOptions;
  readonly #pending = new Map<number, (outcome: Outcome) => void>();
  readonly #startedAt: number;
  #nextId = 1;
  #closed = false;
  #framingFailure: FrameTooLargeError | null = null;

  constructor(channel: Channel, options: ClientOptions = {}) {
    this.#channel = channel;
    this.#options = options;
    this.#clock = options.clock ?? monotonicClock;
    this.#framer = new CappedLineFramer(options.frameCapBytes ?? DEFAULT_FRAME_CAP_BYTES);
    this.#startedAt = this.#clock.now();
    channel.onData((bytes) => {
      this.#ingest(bytes);
    });
    channel.onClose((error) => {
      this.#settleAll({ error: { code: -1, message: error?.message ?? 'channel closed' } });
      this.#closed = true;
    });
  }

  get framingFailure(): FrameTooLargeError | null {
    return this.#framingFailure;
  }

  /** Milliseconds since the transport opened. */
  elapsed(): number {
    return this.#clock.now() - this.#startedAt;
  }

  request(method: string, params: unknown): Promise<Outcome> {
    const id = this.#nextId++;
    return new Promise<Outcome>((resolve) => {
      this.#pending.set(id, resolve);
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.#send({ jsonrpc: '2.0', id, result });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#channel.close();
  }

  #send(message: JsonRpcMessage): void {
    const bytes = encoder.encode(`${JSON.stringify(message)}\n`);
    this.#options.tee?.(this.elapsed(), 'out', bytes);
    this.#channel.write(bytes);
  }

  #ingest(bytes: Uint8Array): void {
    const receivedAt = this.elapsed();
    this.#options.tee?.(receivedAt, 'in', bytes);
    let lines: Uint8Array[];
    try {
      lines = this.#framer.push(bytes);
    } catch (error) {
      if (!(error instanceof FrameTooLargeError)) throw error;
      // The cap is not advice: the connection goes down with the buffer still
      // bounded, rather than growing until the process dies.
      this.#framingFailure = error;
      this.#settleAll({ error: { code: -32000, message: error.message } });
      this.close();
      return;
    }
    for (const line of lines) {
      const text = decoder.decode(line);
      if (text.trim() === '') continue;
      this.#dispatch(JSON.parse(text) as JsonRpcMessage, receivedAt);
    }
  }

  #dispatch(message: JsonRpcMessage, receivedAt: number): void {
    const isResponse =
      message.id !== undefined && (message.result !== undefined || message.error !== undefined);
    if (isResponse) {
      this.#options.onResponse?.(message);
      const resolve = this.#pending.get(message.id as number);
      if (resolve) {
        this.#pending.delete(message.id as number);
        // The prompt promise settling is not permission to stop reading; the
        // channel keeps delivering and this method keeps being called.
        resolve(message.error ? { error: message.error } : ({ result: message.result } as Outcome));
      }
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      const result = this.#options.onRequest?.(message);
      this.respond(message.id, result ?? {});
      return;
    }
    if (message.method !== undefined) {
      this.#options.onNotification?.(message, receivedAt);
    }
  }

  #settleAll(outcome: Outcome): void {
    for (const [id, resolve] of this.#pending) {
      this.#pending.delete(id);
      resolve(outcome);
    }
  }
}
