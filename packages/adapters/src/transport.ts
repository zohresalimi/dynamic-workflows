/**
 * The ndjson transport, and the one thing that makes `nextUpdate()` a real
 * pull rather than a queue-drain.
 *
 * `acp.ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout))` is the
 * documented construction (docs/07-provider-adapter-layer.md §2.2), and it is
 * not quite enough on its own. The SDK's connection reads its input stream in a
 * loop and dispatches without awaiting the handler (verified by reading
 * `dist/jsonrpc.js` in `@agentclientprotocol/sdk@1.3.0`), so a client that
 * merely awaits the SQLite write between `nextUpdate()` calls still lets the
 * reader race ahead into an in-memory queue. The bytes move from the pipe to
 * the heap, which is the exact failure mode `.on('data')` has.
 *
 * So the readable side is built here rather than taken from `Readable.toWeb`:
 * the child's stdout stays in **paused** mode and is read one chunk at a time,
 * from inside `pull()`, and `pull()` first waits for the gate. The pull loop
 * closes the gate while it is appending and opens it afterwards. The
 * consequence is the one the architecture asks for: while DeFlow is writing to
 * SQLite nothing is read, the 64 KiB pipe fills, and the agent blocks in
 * `write()`.
 *
 * `{ highWaterMark: 0 }` matters as much as the gate. A default queuing
 * strategy would let the stream call `pull()` again immediately to top up its
 * own buffer, which is a smaller version of the same problem.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import { Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { frameTooLarge } from './failures.ts';
import { frameGuard } from './frame-guard.ts';

/** A gate the pull loop closes for the duration of each durable append. */
export interface ReadGate {
  close(): void;
  open(): void;
}

export interface AgentTransport {
  readonly stream: acp.Stream;
  readonly gate: ReadGate;
  /** Bytes read off the child's stdout so far. The spec that proves the child
   * blocks in `write()` compares this against what has been made durable. */
  bytesRead(): number;
  /**
   * Rejects when the frame guard trips, and otherwise never settles.
   *
   * A promise rather than a callback because the abort has to reach whichever
   * `await` the turn happens to be sitting on — the handshake, the prompt, or
   * `nextUpdate()` — and `Promise.race` is how those are already written
   * (KAR-05.4 AC1). Erroring the stream alone is not enough: the SDK's reader
   * would surface it as a closed connection at some later, unrelated await.
   */
  readonly failed: Promise<never>;
}

export interface TransportOptions {
  /** The frame cap, in bytes since the last newline. Defaults to 8 MiB. */
  readonly maxFrameBytes?: number;
}

/**
 * Takes **one ndjson frame** out of the stream's buffer, and pushes the rest
 * back.
 *
 * The gate alone is not enough, and measuring is how that became clear: a
 * plain `stdout.read()` hands back the whole buffered window — around 80 KiB,
 * or ten frames of a flooding agent — so one gated pull moved ten frames into
 * the SDK's *unbounded* update queue while the loop made one durable write.
 * Over a 200-frame turn the reader finished before the consumer had appended
 * thirty, which is flowing mode wearing a pull loop's clothes.
 *
 * `unshift` is what fixes it: the remainder goes back into the Readable's own
 * buffer, that buffer counts against its `highWaterMark`, Node stops reading
 * the fd, the 64 KiB pipe fills, and the agent blocks in `write()` — which is
 * exactly the chain docs/07-provider-adapter-layer.md §2.3 describes.
 *
 * A buffer with no newline in it yet is returned whole. That is what keeps
 * this deadlock-free for a frame larger than any window: a partial frame
 * always makes progress, and only *complete* frames are rationed.
 */
function takeFrame(stdout: Readable): Uint8Array | null {
  const buffered = stdout.read() as Buffer | null;
  if (buffered === null) return null;
  const newline = buffered.indexOf(0x0a);
  if (newline === -1 || newline === buffered.length - 1) return new Uint8Array(buffered);
  stdout.unshift(buffered.subarray(newline + 1));
  return new Uint8Array(buffered.subarray(0, newline + 1));
}

/** Resolves with the next frame, or `null` at end of stream. */
function readChunk(stdout: Readable): Promise<Uint8Array | null> {
  const ready = takeFrame(stdout);
  if (ready !== null) return Promise.resolve(ready);

  return new Promise<Uint8Array | null>((resolve) => {
    const settle = (value: Uint8Array | null): void => {
      stdout.off('readable', onReadable);
      stdout.off('end', onEnd);
      stdout.off('close', onEnd);
      stdout.off('error', onEnd);
      resolve(value);
    };
    function onReadable(): void {
      const chunk = takeFrame(stdout);
      // A 'readable' with nothing to read happens at EOF and after a partial
      // read; the next event settles it.
      if (chunk !== null) settle(chunk);
    }
    function onEnd(): void {
      settle(null);
    }
    stdout.on('readable', onReadable);
    stdout.once('end', onEnd);
    stdout.once('close', onEnd);
    stdout.once('error', onEnd);
  });
}

export function agentTransport(
  child: ChildProcessWithoutNullStreams,
  options: TransportOptions = {},
): AgentTransport {
  let bytesRead = 0;
  let closed: { promise: Promise<void>; open: () => void } | null = null;

  // One guard for the whole session, so "bytes since the last newline" spans
  // reads: a frame that arrives in a hundred chunks is one frame, and a counter
  // per chunk would never see it.
  const guard = frameGuard(options.maxFrameBytes);
  let trip = (_error: unknown): void => {};
  const failed = new Promise<never>((_resolve, reject) => {
    trip = reject;
  });
  // Nobody is racing it until the turn starts, and a rejection nobody is
  // listening to yet is an unhandled rejection that takes the process down.
  failed.catch(() => {});

  const gate: ReadGate = {
    close() {
      if (closed !== null) return;
      let open = (): void => {};
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      closed = { promise, open };
    },
    open() {
      const held = closed;
      closed = null;
      held?.open();
    },
  };

  const readable = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (closed !== null) await closed.promise;
        const chunk = await readChunk(child.stdout);
        if (chunk === null) {
          controller.close();
          return;
        }
        bytesRead += chunk.byteLength;

        // Upstream of `ndJsonStream`, and therefore upstream of the SDK's
        // unbounded `LineBuffer`: a cap applied to the parsed frame is too late
        // because the buffer has already grown (§10.1). Nothing is enqueued
        // once the guard trips — the offending bytes must not reach the SDK at
        // all — and no recovery is attempted.
        const report = guard.inspect(chunk);
        if (report !== null) {
          const error = frameTooLarge(report);
          trip(error);
          controller.error(error);
          child.stdout.destroy();
          return;
        }

        controller.enqueue(chunk);
      },
      cancel() {
        child.stdout.destroy();
      },
    },
    { highWaterMark: 0 },
  );

  return {
    stream: acp.ndJsonStream(Writable.toWeb(child.stdin), readable),
    gate,
    bytesRead: () => bytesRead,
    failed,
  };
}
