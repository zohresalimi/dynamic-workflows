/**
 * KAR-05.6 — the frames DeFlowd and `DeFlow-mcp` exchange over the UDS.
 *
 * Newline-delimited JSON, five frames each way, and every one of them parsed
 * strictly. Strictness is not tidiness here: the process on the other end of
 * this socket was spawned by an *agent*, so the shim is the one component of
 * DeFlow whose peer is only as trustworthy as the model driving it. A frame
 * nobody understands is refused rather than guessed at, and a line that grows
 * past the cap is refused rather than buffered — the same rule, and the same
 * reason, as the ACP transport's frame guard (KAR-05.4).
 *
 * The bridge is deliberately *not* MCP. The shim already speaks MCP on its
 * stdio side; re-speaking it over the socket would mean two JSON-RPC stacks,
 * two notions of a request id and two places for a tool result to be
 * validated. What crosses the socket is the minimum the host needs to be the
 * authority: who is asking, what they asked for, and what the answer was.
 */
import { z } from 'zod';

/** Bumped when a frame's shape changes. Mismatched ends refuse each other. */
export const BRIDGE_VERSION = 1;

/** The most bytes one bridge line may occupy before it is refused. */
export const MAX_BRIDGE_LINE_BYTES = 1024 * 1024;

export class BridgeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeProtocolError';
  }
}

const version = z.literal(BRIDGE_VERSION);

const ShimFrameSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('hello'),
    v: version,
    run: z.string().min(1),
    token: z.string().min(1),
  }),
  z.strictObject({
    t: z.literal('call'),
    id: z.number().int().nonnegative(),
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({ t: z.literal('denied'), tool: z.string().min(1) }),
]);

const HostFrameSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('welcome'), v: version, tools: z.array(z.string()) }),
  z.strictObject({ t: z.literal('tools'), tools: z.array(z.string()) }),
  z.strictObject({
    t: z.literal('result'),
    id: z.number().int().nonnegative(),
    value: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    t: z.literal('error'),
    id: z.number().int().nonnegative(),
    message: z.string(),
  }),
  z.strictObject({ t: z.literal('refused'), reason: z.string() }),
]);

export type ShimFrame = z.infer<typeof ShimFrameSchema>;
export type HostFrame = z.infer<typeof HostFrameSchema>;

export function encodeFrame(frame: ShimFrame | HostFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

function parse<T>(schema: z.ZodType<T>, line: string, side: string): T {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new BridgeProtocolError(
      `the ${side} sent a line that is not JSON: ${line.slice(0, 120)}`,
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new BridgeProtocolError(
      `the ${side} sent a frame this bridge does not understand: ` +
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; '),
    );
  }
  return parsed.data;
}

export function parseShimFrame(line: string): ShimFrame {
  return parse(ShimFrameSchema, line, 'MCP shim');
}

export function parseHostFrame(line: string): HostFrame {
  return parse(HostFrameSchema, line, 'daemon');
}

/**
 * A newline splitter that holds a partial tail across chunks and refuses a
 * line above `limit` instead of growing to hold it.
 *
 * Bytes, not characters: `limit` bounds what the process is asked to keep in
 * memory, and a caller feeding it UTF-8 text should get the same answer as one
 * feeding it a buffer.
 */
export function lineReader(limit: number = MAX_BRIDGE_LINE_BYTES): (chunk: string) => string[] {
  let tail = '';
  return (chunk: string): string[] => {
    tail += chunk;
    const lines: string[] = [];
    for (;;) {
      const newline = tail.indexOf('\n');
      if (newline === -1) break;
      const line = tail.slice(0, newline).trim();
      tail = tail.slice(newline + 1);
      if (line !== '') lines.push(line);
    }
    if (tail.length > limit) {
      tail = '';
      throw new BridgeProtocolError(
        `a bridge line exceeded ${limit} bytes without a newline and was refused`,
      );
    }
    return lines;
  };
}
