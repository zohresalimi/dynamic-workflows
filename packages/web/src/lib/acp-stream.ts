/**
 * KAR-17.5 — ACP `agent_json` frames folded into the typed messages the list
 * renders.
 *
 * Verifies: EPIC-17-S20 (scenario 4), EPIC-17-S21 · AC1, AC10
 *
 * ## Why this exists rather than a terminal
 *
 * ACP streaming updates are typed JSON, not a TTY byte stream. Feeding them to
 * xterm would throw away everything they already are — a `tool_call` with an
 * id, a status and a title becomes a line of text you cannot select, search,
 * link to or theme. So the frames are parsed into records and rendered as
 * components (docs/12-frontend-architecture.md §6.6).
 *
 * ## Three decisions the shapes force
 *
 * **Chunks of one message are one message.** A vendor emits
 * `agent_message_chunk` per token-ish delta, all carrying the same `messageId`
 * — the real recording has four for one sentence. Rendering each as a row would
 * make a paragraph look like a stutter. They are concatenated, and the message
 * keeps the `seq` of the frame it **began** at, because AC1 wants a link and a
 * link has to point at a real `io_chunk.seq` that will still be there.
 *
 * **Housekeeping is not transcript.** `usage_update`,
 * `available_commands_update` and `session_info_update` are accounting and
 * capability news. They belong to the cost view and the provider table; in a
 * panel opened to answer *"what is it doing"* they are noise that buries the
 * answer.
 *
 * **A frame this build has never seen is data, not an error.** An unknown
 * `sessionUpdate` renders as itself with its JSON as the body. The alternative
 * — dropping it — makes a newer agent look like a silent one, which is the
 * failure this whole panel exists to prevent.
 *
 * ## The end of a turn
 *
 * A prompt turn ends with the JSON-RPC *response* to `session/prompt`:
 * `{"id":3,"result":{"stopReason":"end_turn"}}`. Its absence after messages
 * have arrived is AC10's second honest state — the adapter's output stopped
 * without the turn finishing — and is reported rather than smoothed over,
 * because a panel that renders a truncated turn identically to a complete one
 * is how "it looked like it finished" becomes an hour of confusion.
 */
import type { IoChunkLine } from './node-output.ts';

/** The ACP discriminators this list renders, plus the catch-all. */
export type AcpMessageKind =
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'user_message_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'unknown';

/** One row of the typed message list. */
export interface AcpMessage {
  /** The `io_chunk.seq` this message began at — AC1's link target. */
  readonly seq: number;
  readonly kind: AcpMessageKind;
  /** A one-line label: the tool's title, the update's discriminator. */
  readonly title: string;
  /** The body the streaming highlighter is fed. */
  readonly text: string;
  readonly toolCallId: string | null;
  readonly status: string | null;
}

export interface AcpTranscript {
  readonly messages: readonly AcpMessage[];
  /** `end_turn`, `cancelled`, … or `null` while the turn is still open. */
  readonly stopReason: string | null;
  /** AC10 — messages arrived and the turn never closed. */
  readonly endedWithoutResult: boolean;
}

/** Discriminators that are protocol housekeeping rather than transcript. */
const HOUSEKEEPING = new Set([
  'usage_update',
  'available_commands_update',
  'session_info_update',
  'current_mode_update',
]);

const RENDERED = new Set<AcpMessageKind>([
  'agent_message_chunk',
  'agent_thought_chunk',
  'user_message_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
]);

interface Frame {
  readonly seq: number;
  readonly body: Record<string, unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Every JSON-RPC frame in a chunk stream.
 *
 * One `io_chunk` can hold several frames and can hold a partial one: a pipe
 * splits where the kernel felt like it, and `io_chunk` preserves that faithfully
 * rather than tidying it. So the data is re-joined across chunks and re-split on
 * newlines, and a line that does not parse is skipped — the next chunk carries
 * the rest of it, and the frame after that is still readable.
 */
function frames(chunks: readonly IoChunkLine[]): Frame[] {
  const found: Frame[] = [];
  let pending = '';
  let pendingSeq = 0;

  for (const chunk of chunks) {
    if (pending === '') pendingSeq = chunk.seq;
    pending += chunk.data;

    const parts = pending.split('\n');
    pending = parts.pop() ?? '';

    for (const part of parts) {
      if (part.trim() === '') continue;
      try {
        const body = asRecord(JSON.parse(part));
        if (body !== null) found.push({ seq: pendingSeq, body });
      } catch {
        // Not a frame. A vendor bridge occasionally writes a plain line to the
        // same pipe; dropping it here is right, because `stderr` is where that
        // belongs and the terminal path renders it.
      }
      pendingSeq = chunk.seq;
    }
    pendingSeq = pending === '' ? chunk.seq : pendingSeq;
  }

  return found;
}

/** The text of an ACP content block, or `''` for a block that carries none. */
function textOf(content: unknown): string {
  const block = asRecord(content);
  if (block === null) return '';
  return block['type'] === 'text' ? (asString(block['text']) ?? '') : '';
}

/** A plan update rendered as its entries, one per line, status first. */
function planText(update: Record<string, unknown>): string {
  const entries = Array.isArray(update['entries']) ? update['entries'] : [];
  return entries
    .map((raw) => {
      const entry = asRecord(raw);
      if (entry === null) return '';
      const status = asString(entry['status']) ?? 'pending';
      return `[${status}] ${asString(entry['content']) ?? ''}`;
    })
    .filter((line) => line !== '')
    .join('\n');
}

function messageOf(seq: number, update: Record<string, unknown>): AcpMessage | null {
  const raw = asString(update['sessionUpdate']) ?? '';
  if (HOUSEKEEPING.has(raw)) return null;

  const kind = (RENDERED.has(raw as AcpMessageKind) ? raw : 'unknown') as AcpMessageKind;
  const toolCallId = asString(update['toolCallId']);
  const status = asString(update['status']);

  switch (kind) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'user_message_chunk':
      return { seq, kind, title: raw, text: textOf(update['content']), toolCallId, status };

    case 'tool_call':
    case 'tool_call_update': {
      const content = Array.isArray(update['content']) ? update['content'] : [];
      const body = content
        .map((block) => textOf(asRecord(block)?.['content']))
        .filter((text) => text !== '')
        .join('');
      return {
        seq,
        kind,
        title: asString(update['title']) ?? toolCallId ?? raw,
        text: body,
        toolCallId,
        status,
      };
    }

    case 'plan':
      return { seq, kind, title: 'plan', text: planText(update), toolCallId, status };

    default:
      return { seq, kind: 'unknown', title: raw, text: JSON.stringify(update), toolCallId, status };
  }
}

/**
 * The stop reason on a `session/prompt` response, or `null` for any other
 * frame.
 *
 * Matched on the *shape* — a `result` object carrying `stopReason` — rather
 * than on the request id, because the panel reattaching to a running node did
 * not see the request go out and has no id to match against.
 */
function stopReasonOf(body: Record<string, unknown>): string | null {
  const result = asRecord(body['result']);
  return result === null ? null : asString(result['stopReason']);
}

/** Folds a node's `agent_json` chunks into the transcript the list renders. */
export function acpTranscript(chunks: readonly IoChunkLine[]): AcpTranscript {
  const messages: AcpMessage[] = [];
  let stopReason: string | null = null;
  /** The `messageId` the trailing message is still accumulating, if any. */
  let openMessageId: string | null = null;

  for (const frame of frames(chunks)) {
    const reason = stopReasonOf(frame.body);
    if (reason !== null) {
      stopReason = reason;
      continue;
    }

    const update = asRecord(asRecord(frame.body['params'])?.['update']);
    if (update === null) continue;

    const message = messageOf(frame.seq, update);
    if (message === null) continue;

    const messageId = asString(update['messageId']);
    const previous = messages.at(-1);
    const continues =
      previous !== undefined &&
      messageId !== null &&
      messageId === openMessageId &&
      previous.kind === message.kind;

    if (continues) {
      // Concatenated onto the message it belongs to, keeping the seq it began
      // at. Replaced rather than mutated so a consumer holding the previous
      // array sees an immutable history.
      messages[messages.length - 1] = { ...previous, text: previous.text + message.text };
      continue;
    }

    messages.push(message);
    openMessageId = messageId;
  }

  return {
    messages,
    stopReason,
    // An empty stream is "no output at all", which is a different sentence.
    endedWithoutResult: messages.length > 0 && stopReason === null,
  };
}
