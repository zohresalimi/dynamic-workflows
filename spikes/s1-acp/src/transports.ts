/**
 * Two channels for the same client.
 *
 * `spawnChannel` is a real child process — the vendor binary under the
 * author's own account, per AR-1: no token file is read and no auth
 * environment variable is set, so whatever credentials the agent finds are the
 * ones the developer already has.
 *
 * `replayChannel` is the reason the live run only has to happen once. It feeds
 * the committed recording back through the same client, gated on the client
 * producing the same outbound frames in the same order — so it is a
 * conformance test of the client, not a re-read of the log. A client that
 * stopped sending `mcpServers`, or that cancelled at a different point in the
 * stream, stalls here instead of quietly passing.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import type { Channel, Clock } from './client.ts';
import type { RecordedFrame } from './recording.ts';

export interface SpawnedChannel extends Channel {
  readonly child: ChildProcess;
  readonly stderr: () => string;
}

export function spawnChannel(
  command: string,
  args: readonly string[],
  cwd: string,
): SpawnedChannel {
  const child = spawn(command, [...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // AR-1: the ambient environment is passed through untouched. Nothing is
    // injected, and in particular no API key is manufactured.
    env: process.env,
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  return {
    child,
    stderr: () => stderr,
    write(bytes) {
      child.stdin?.write(bytes);
    },
    onData(handler) {
      child.stdout?.on('data', (chunk: Buffer) => {
        handler(new Uint8Array(chunk));
      });
    },
    onClose(handler) {
      child.on('exit', (code, signal) => {
        handler(new Error(`agent exited code=${String(code)} signal=${String(signal)}`));
      });
      child.on('error', handler);
    },
    close() {
      child.kill('SIGKILL');
    },
  };
}

export class ReplayMismatchError extends Error {
  constructor(index: number, expected: string, actual: string) {
    super(
      `replay diverged at frame ${index}:\n  recording expected the client to send: ${expected}\n  the client sent:                       ${actual}`,
    );
    this.name = 'ReplayMismatchError';
  }
}

/** Every key path in an object, sorted — the shape, without the values. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${prefix}[]`));
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value)
    .flatMap(([key, child]) => keyPaths(child, `${prefix}.${key}`))
    .sort();
}

/**
 * The identity a replayed outbound frame is matched on: which method, which
 * correlation id, and the shape of the params. Values are excluded because
 * absolute paths differ between the machine that recorded and the machine that
 * replays; the shape is included because "the client stopped sending
 * `mcpServers`" has to fail here rather than pass quietly.
 */
function identity(frame: unknown): string {
  const message = frame as {
    method?: string;
    id?: number | string;
    params?: unknown;
    result?: unknown;
  };
  const id = String(message.id ?? '-');
  if (message.method !== undefined) {
    return `${message.method}#${id}|${keyPaths(message.params).join(',')}`;
  }
  return `response#${id}|${keyPaths(message.result).join(',')}`;
}

const encoder = new TextEncoder();

export interface ReplayChannel extends Channel {
  /** Resolves when the recording is exhausted, rejects on divergence. */
  readonly done: Promise<void>;
  /**
   * The recording's own clock.
   *
   * A replay delivers frames as fast as the event loop allows, so its
   * wall-clock inter-arrival times are an artefact of the replay and mean
   * nothing. The times that mean something were measured once, at the
   * transport, against the real agent — so in replay mode time enters the
   * client through this port and the measurement reported is the recorded one.
   */
  readonly clock: Clock;
}

export function replayChannel(frames: readonly RecordedFrame[]): ReplayChannel {
  let cursor = 0;
  let virtualNow = 0;
  let dataHandler: ((bytes: Uint8Array) => void) | null = null;
  let closeHandler: ((error?: Error) => void) | null = null;
  let closed = false;
  const writes: string[] = [];
  let notifyWrite: (() => void) | null = null;
  let fail: ((error: Error) => void) | null = null;

  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  async function nextWrite(): Promise<string> {
    while (writes.length === 0) {
      if (closed) throw new Error('replay: the client closed before sending the next frame');
      await new Promise<void>((resolve) => {
        notifyWrite = resolve;
      });
    }
    return writes.shift() as string;
  }

  const done = new Promise<void>((resolve, reject) => {
    fail = reject;
    void (async () => {
      try {
        while (cursor < frames.length && !closed) {
          const frame = frames[cursor] as RecordedFrame;
          if (frame.dir === 'in') {
            cursor += 1;
            virtualNow = frame.t;
            dataHandler?.(encoder.encode(`${frame.text}\n`));
            // One frame per turn of the loop: the client must be given the
            // chance to react to each notification before the next arrives,
            // which is exactly what a real stream does.
            await tick();
          } else {
            const actual = await nextWrite();
            const expected = identity(frame.json);
            if (identity(JSON.parse(actual)) !== expected) {
              throw new ReplayMismatchError(cursor, frame.text, actual);
            }
            virtualNow = frame.t;
            cursor += 1;
          }
        }
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });

  return {
    done,
    clock: { now: () => virtualNow },
    write(bytes) {
      for (const line of new TextDecoder().decode(bytes).split('\n')) {
        if (line.trim() !== '') writes.push(line);
      }
      notifyWrite?.();
      notifyWrite = null;
    },
    onData(handler) {
      dataHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    close() {
      closed = true;
      notifyWrite?.();
      closeHandler?.();
      // Nothing to reject: an early close is how a completed cycle ends.
      void fail;
    },
  };
}
