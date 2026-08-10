/**
 * The two pure decisions the PTY socket makes (KAR-15.8 AC1, AC3,
 * docs/11-api-and-realtime.md §7.7).
 *
 * They live apart from the socket wiring because both are ordinary parsing and
 * both are where the mistakes are. Routing has to *refuse* a shape rather than
 * pattern-match loosely — an upgrade that fell through to a prefix match would
 * attach a terminal to whatever the next path segment happened to be — and a
 * text frame is still untrusted input after the upgrade was authenticated: the
 * numbers in it are handed to `TIOCSWINSZ`.
 *
 * The frame table this implements is fixed by §7.7 and is deliberately tiny:
 * binary in both directions is raw pty bytes, and the only text frames are
 * `resize` inbound and `exit` outbound. Anything else is refused rather than
 * ignored, because a silently dropped frame is a client that ships against a
 * feature the daemon does not have.
 */
import type { NodeId, RunId } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import type { PtyExit } from '../pty/pty-session.ts';
import { WsProtocolError } from './ws-frame.ts';

/** `/api/pty/:runId/:nodeId`, and nothing else. */
export const PTY_PATH_PREFIX = '/api/pty/';

export interface PtyTarget {
  readonly runId: RunId;
  readonly nodeId: NodeId;
}

/**
 * The target, or `null` when the path is not a terminal at all — including
 * when the ids are malformed. Null is a 404 and never a 500, the same rule
 * `asRunId` follows for the HTTP routes: a bad id is a request for a terminal
 * that does not exist, which is exactly what the caller needs to be told.
 */
export function parsePtyPath(path: string): PtyTarget | null {
  if (!path.startsWith(PTY_PATH_PREFIX)) return null;
  const segments = path.slice(PTY_PATH_PREFIX.length).split('/');
  if (segments.length !== 2) return null;
  const [rawRun = '', rawNode = ''] = segments;

  const runId = RunIdSchema.safeParse(decodeSegment(rawRun));
  const nodeId = NodeIdSchema.safeParse(decodeSegment(rawNode));
  if (!runId.success || !nodeId.success) return null;
  return { runId: runId.data, nodeId: nodeId.data };
}

/** A percent-escape that does not decode is not an id; it is refused as one. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

export interface ResizeCommand {
  readonly t: 'resize';
  readonly cols: number;
  readonly rows: number;
}

export type ClientCommand = ResizeCommand;

/**
 * xterm.js will not ask for more, and the value ends up in a `winsize` struct
 * whose fields are 16-bit. A bound here is cheaper than finding out what a
 * particular libc does with 100,000 columns.
 */
export const MAX_DIMENSION = 10_000;

export function parseClientText(text: string): ClientCommand {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WsProtocolError('a text frame on the pty socket must be JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WsProtocolError('a text frame on the pty socket must be a JSON object');
  }

  const frame = parsed as Record<string, unknown>;
  if (frame['t'] !== 'resize') {
    throw new WsProtocolError(`unknown pty frame type ${JSON.stringify(frame['t'])}`);
  }
  return {
    t: 'resize',
    cols: dimension(frame['cols'], 'cols'),
    rows: dimension(frame['rows'], 'rows'),
  };
}

function dimension(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
    throw new WsProtocolError(`${name} must be an integer between 1 and ${MAX_DIMENSION}`);
  }
  return value;
}

/**
 * AC5's frame. A signalled process has **no** exit code, so `code` stays null
 * and the signal is named alongside it: reporting 0 or 137 there would both be
 * fiction, and a panel that printed "exited 0" for a killed node would be the
 * kind of wrong that is never questioned.
 */
export function exitFrameText(exit: PtyExit): string {
  return exit.signal === null || exit.signal === 0
    ? JSON.stringify({ t: 'exit', code: exit.code })
    : JSON.stringify({ t: 'exit', code: exit.code, signal: exit.signal });
}
