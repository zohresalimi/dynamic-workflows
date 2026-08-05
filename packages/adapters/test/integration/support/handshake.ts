/**
 * The smallest honest `initialize` exchange, for specs that need a *driven*
 * child rather than a probed one.
 *
 * `probeProvider` owns the production handshake, but it spawns the child
 * itself; the launch strategy under test in `spawn-strategy.test.ts` is the
 * thing that decides *how* to spawn, so its specs need to drive a child they
 * were handed. This is that continuation, and nothing more: write one frame,
 * read until the answer or the end of the stream, and throw if the stream ended
 * first — which is precisely what an argv-parse rejection looks like from here.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface InitializeResult {
  readonly protocolVersion: number;
  readonly agentCapabilities?: unknown;
  readonly authMethods?: unknown;
}

export class HandshakeEnded extends Error {}

/** Sends `initialize` and resolves with its result member. */
export async function initializeOnce(
  child: ChildProcessWithoutNullStreams,
): Promise<InitializeResult> {
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: 1 },
    })}\n`,
  );
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue;
      let frame: { id?: unknown; result?: InitializeResult };
      try {
        frame = JSON.parse(line) as { id?: unknown; result?: InitializeResult };
      } catch {
        continue;
      }
      if (frame.id !== 0 || frame.result === undefined) continue;
      return frame.result;
    }
  } finally {
    lines.close();
  }
  throw new HandshakeEnded('the child closed its stdout without answering initialize');
}
