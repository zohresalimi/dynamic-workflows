/**
 * The bytes behind the five pathological behaviours, as pure values.
 *
 * Everything here is a string builder with no I/O, for two reasons. The frames
 * have to be **written raw**, outside `acp.ndJsonStream`, because the SDK
 * serialises what it is given and would either refuse or repair a frame whose
 * whole purpose is to be wrong — a mock that could only emit valid ACP could
 * not produce the stimulus at all. And a pure builder can be checked against
 * `@agentclientprotocol/sdk/schema/schema.json` in a unit test, which is the
 * only conformance oracle ACP has (262 `$defs`, verified 2026-08-02).
 *
 * The two failures are deliberately distinct. `malformedLine` is not JSON;
 * `invalidFrame` is perfectly good JSON that the schema rejects. They map onto
 * `adapter.malformed-output` and `adapter.protocol-error`
 * (docs/04-domain-model.md §8) — different `class` values, different scheduler
 * decisions — so a generator that blurred them would let a parser that
 * conflates them stay green.
 */

/** The default 10 MB payload, in bytes: one line, no newline inside it. */
export const HUGE_LINE_TOTAL_BYTES = 10 * 1024 * 1024;

/** The write size for every raw flood, so the reader sees the line grow. */
export const RAW_CHUNK_BYTES = 64 * 1024;

/** The gap between raw chunks in the never-terminates case. */
export const NO_NEWLINE_INTERVAL_MS = 10;

/** Not JSON at all: an unbalanced brace, cut at a key. */
export const MALFORMED_LINE = '{"jsonrpc":"2.0","method":';

/** A real frame, cut mid-key — what a `process.exit` in the middle leaves. */
export const TRUNCATED_FRAME_PREFIX =
  '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"';

/** The malformed line as it goes on the wire: complete, and newline-terminated. */
export function malformedLine(text: string = MALFORMED_LINE): string {
  return `${text}\n`;
}

/**
 * The half-written frame a mid-turn exit leaves on stdout.
 *
 * No trailing newline: that absence is the whole signal. A recovery path that
 * assumes every line it reads is complete will report
 * `adapter.malformed-output` for what is actually `agent.nonzero-exit`.
 */
export function truncatedFrame(sessionId: string): string {
  return TRUNCATED_FRAME_PREFIX + sessionId;
}

// ---------------------------------------------------------------------------
// The 10 MB payload
// ---------------------------------------------------------------------------

/**
 * 64 characters that need no JSON escaping, so the payload's length on the
 * wire is its length in memory and a byte-count assertion means what it says.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';

/**
 * `length` bytes of the payload, as if starting at absolute offset `at`.
 *
 * Generated, never random and never checked in: random bytes would break
 * `--seed` reproducibility, and a recorded fixture of ten megabytes would
 * balloon the repository for a value that can be recomputed in a millisecond.
 * Keying on the absolute offset is what lets the flood be written in chunks
 * and still be one continuous, reproducible pattern.
 */
export function patternSlice(at: number, length: number): string {
  if (length <= 0) return '';
  const period = ALPHABET.length;
  const start = ((at % period) + period) % period;
  const rotated = (ALPHABET + ALPHABET).slice(start, start + period);
  return rotated.repeat(Math.ceil(length / period)).slice(0, length);
}

/**
 * The two halves of a syntactically valid `session/update` frame, to be
 * wrapped around a payload written in chunks.
 *
 * Valid on purpose: the stimulus for KAR-05.4's 8 MiB cap should be a frame
 * that is *too large*, not one that is also malformed, or the defence could
 * pass by rejecting it for the wrong reason.
 */
export function hugeLineFrameParts(sessionId: string): { prefix: string; suffix: string } {
  return {
    prefix:
      `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":${JSON.stringify(sessionId)},` +
      '"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"',
    suffix: '"}}}}',
  };
}

// ---------------------------------------------------------------------------
// Valid JSON the ACP schema rejects
// ---------------------------------------------------------------------------

/**
 * The schema violations EPIC-04-S11 tabulates. The first is the discriminator
 * case — the one an upstream SDK bump actually produces — and the rest cover a
 * missing required field, an unknown enum member in a nested array, an
 * out-of-union response value, and a wrongly typed scalar, so a validator that
 * only checks the top level cannot pass them all.
 */
export const INVALID_FRAME_VARIANTS = [
  'unknownSessionUpdate',
  'toolCallMissingId',
  'unknownPermissionOptionKind',
  'unknownStopReason',
  'locationPathNotAString',
] as const;

export type InvalidFrameVariant = (typeof INVALID_FRAME_VARIANTS)[number];

export interface InvalidFrameSpec {
  readonly variant: InvalidFrameVariant;
  /** The whole frame, serialised and newline-terminated: what is written. */
  readonly line: string;
  /** The `$defs` name in `schema/schema.json` this frame violates. */
  readonly definition: string;
  /** Which member of the frame that definition describes. */
  readonly subject: 'params' | 'result';
  /** A string the validator's error report must contain, naming the fault. */
  readonly pointer: string;
}

export interface InvalidFrameContext {
  readonly sessionId: string;
  /** The JSON-RPC id for the variants that are a request or a response. */
  readonly requestId?: number;
}

const line = (frame: Record<string, unknown>): string => `${JSON.stringify(frame)}\n`;

export function invalidFrame(
  variant: InvalidFrameVariant,
  context: InvalidFrameContext,
): InvalidFrameSpec {
  const { sessionId } = context;
  const id = context.requestId ?? 1;

  if (variant === 'toolCallMissingId') {
    return {
      variant,
      definition: 'SessionNotification',
      subject: 'params',
      pointer: 'toolCallId',
      line: line({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            title: 'a tool call with no id',
            kind: 'read',
            status: 'pending',
            locations: [{ path: '/tmp/DeFlow-mock/read-me.txt' }],
          },
        },
      }),
    };
  }

  if (variant === 'unknownPermissionOptionKind') {
    return {
      variant,
      definition: 'RequestPermissionRequest',
      subject: 'params',
      pointer: '/options/0/kind',
      line: line({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: 'mock-tool-invalid-1',
            title: 'write a file',
            kind: 'edit',
            status: 'pending',
            locations: [{ path: '/tmp/DeFlow-mock/write-me.txt' }],
          },
          options: [{ optionId: 'maybe', name: 'Maybe', kind: 'maybe_once' }],
        },
      }),
    };
  }

  if (variant === 'unknownStopReason') {
    return {
      variant,
      definition: 'PromptResponse',
      subject: 'result',
      pointer: '/stopReason',
      // A response, not a notification: `finished` is the value someone who
      // knows other agent protocols reaches for, and ACP does not define it.
      line: line({ jsonrpc: '2.0', id, result: { stopReason: 'finished' } }),
    };
  }

  if (variant === 'locationPathNotAString') {
    return {
      variant,
      definition: 'SessionNotification',
      subject: 'params',
      pointer: '/update/locations/0/path',
      line: line({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'mock-tool-invalid-2',
            title: 'a location that is a number',
            kind: 'read',
            status: 'pending',
            locations: [{ path: 42 }],
          },
        },
      }),
    };
  }

  return {
    variant: 'unknownSessionUpdate',
    definition: 'SessionNotification',
    subject: 'params',
    pointer: '/update/sessionUpdate',
    line: line({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_thought_stream_v3',
          content: { type: 'text', text: 'a discriminator no version of ACP defines' },
        },
      },
    }),
  };
}
