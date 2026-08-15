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
import { frameTooLarge, malformedOutput } from './failures.ts';
import { FRAME_EVIDENCE_BYTES, frameGuard } from './frame-guard.ts';
import type { TransportRecorder } from './recorder.ts';

const decoder = new TextDecoder();
const NEWLINE = 0x0a;

/** The pieces of one ndjson line, joined once its newline has arrived. */
function concat(pieces: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const piece of pieces) total += piece.byteLength;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    joined.set(piece, at);
    at += piece.byteLength;
  }
  return joined;
}

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
  /**
   * KAR-05.7 AC1 — the golden-recording tee, or absent.
   *
   * It is wired **here** and not in ./run-node.ts on purpose. This module is
   * the last place that still has bytes: one line further on they are frames
   * the SDK parsed, and one line after that they are DeFlow's own event
   * vocabulary. A tee at either of those points records the normaliser's
   * reading of the wire, which is structurally unable to see a frame the
   * normaliser did not understand — the exact change a golden corpus exists to
   * make visible.
   */
  readonly recorder?: TransportRecorder;
}

/**
 * The child's stdin, with every byte handed to the recorder on the way past.
 *
 * `"in"` because the recording is written from the **agent's** perspective:
 * what the client writes is what the agent receives. Flipping the label once,
 * here, is what makes the capture directly replayable by
 * `deflow-mock-agent --replay` instead of needing a conversion step every
 * reader has to remember.
 */
function teedStdin(
  child: ChildProcessWithoutNullStreams,
  recorder: TransportRecorder,
): WritableStream<Uint8Array> {
  const writer = Writable.toWeb(child.stdin).getWriter();
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      recorder.note('in', chunk);
      await writer.write(chunk);
    },
    close: () => writer.close(),
    abort: (reason) => writer.abort(reason),
  });
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
  /** The chunks of the line currently being read, cleared at every newline. */
  const line: Uint8Array[] = [];
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
        // Before the guard and before the SDK: a frame that trips the cap, and
        // a frame nothing in this process can parse, are both things the
        // corpus has to be able to show you.
        options.recorder?.note('out', chunk);

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

        // Conformance assertion 7. The SDK's reader **drops** a line it cannot
        // parse and carries on — right for a transport library, wrong for
        // DeFlow: the dropped frame is a hole in a transcript the ledger keeps
        // for ever, under a node that reported success.
        //
        // The chunks are reassembled rather than checked one at a time, and
        // that is not a detail: `takeFrame` returns *either* the tail of a line
        // (ending at its newline) *or* a middle piece with no newline in it, so
        // "this chunk ends in 0x0a" does not mean "this chunk is a whole
        // frame". Measured — the first version of this check believed it did,
        // and rejected a legitimate 8 MiB line whose last 64 KiB happened not
        // to be valid JSON on its own.
        //
        // The buffer is bounded by the frame cap the guard above enforces, so
        // the extra memory is at most one frame's worth and only while a line
        // is incomplete.
        line.push(chunk);
        if (chunk[chunk.length - 1] === NEWLINE) {
          const complete = line.length === 1 ? chunk : concat(line);
          line.length = 0;
          try {
            JSON.parse(decoder.decode(complete));
          } catch {
            const error = malformedOutput(
              complete.slice(0, FRAME_EVIDENCE_BYTES),
              complete.byteLength,
            );
            trip(error);
            controller.error(error);
            child.stdout.destroy();
            return;
          }
        }

        controller.enqueue(chunk);
      },
      cancel() {
        child.stdout.destroy();
      },
    },
    { highWaterMark: 0 },
  );

  // Attached only while recording. Nothing else in DeFlow reads the child's
  // stderr on this path, and a listener registered unconditionally would change
  // when the 64 KiB stderr pipe fills — a behaviour difference between a
  // recorded run and a normal one, in the module whose whole job is to observe
  // without altering.
  //
  // `readable`/`read()` and not `.on('data')`, for the same reason the stdout
  // side is written that way: flowing mode buffers the stream into the heap
  // while DeFlow awaits SQLite, which is the OOM this package exists to avoid
  // and which `test/adapter-shape.test.ts` refuses mechanically.
  if (options.recorder !== undefined) {
    const recorder = options.recorder;
    child.stderr.on('readable', () => {
      for (;;) {
        const chunk = child.stderr.read() as Buffer | null;
        if (chunk === null) return;
        recorder.stderr(chunk);
      }
    });
  }

  return {
    stream: acp.ndJsonStream(
      options.recorder === undefined
        ? Writable.toWeb(child.stdin)
        : teedStdin(child, options.recorder),
      readable,
    ),
    gate,
    bytesRead: () => bytesRead,
    failed,
  };
}
