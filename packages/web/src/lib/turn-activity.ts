/**
 * KAR-27.3 AC3 — what a pre-execution turn is doing *now*, read off its own
 * stdout.
 *
 * On 2026-08-23 a framing turn made five Linear queries and read the
 * repository. Every one of those was a `tool_use` block in a `stream-json`
 * frame on the child's stdout; none of it reached a screen. KAR-27.3 AC2 put
 * those bytes in the io store, and this is the function that turns them back
 * into the sentence an operator wanted: *"it is reading the repository"*.
 *
 * ## Why this is web-side rather than `@DeFlow/adapters`'s parser
 *
 * `test/dependency-direction.test.ts` forbids `@DeFlow/web` from importing
 * `@DeFlow/adapters` — the browser has no business carrying a package built to
 * spawn processes. So the reading is done here, over the same NDJSON the io
 * tail already delivers, exactly as `./acp-stream.ts` reads the ACP dialect for
 * the other transport. What is duplicated is the *field names of a vendor's
 * wire format*, which are not DeFlow's to own in one place; what is emphatically
 * not duplicated is any judgement about the turn.
 *
 * ## Nothing is invented
 *
 * A tool name is printed as the frame spelled it (`Read`,
 * `mcp__linear__list_issues`). A frame this build cannot read is skipped rather
 * than rendered as an error: a newer vendor dialect must make the strip quieter,
 * never make a working turn look broken.
 *
 * Verifies: EPIC-27-S18 · AC3
 */
import { type IoChunkLine, mergeIoChunks } from './node-output.ts';

/** One tool the agent invoked, as the frame named it. */
export interface TurnToolCall {
  /** The `io_chunk.seq` the frame arrived on — a stable key for a list. */
  readonly seq: number;
  /** The vendor's own name for the tool. Never normalised. */
  readonly name: string;
}

export interface TurnActivity {
  /** Oldest first, as they happened. */
  readonly toolCalls: readonly TurnToolCall[];
  /** The last thing the agent said in words, or `''`. */
  readonly lastText: string;
  /** `ts` of the newest chunk read, or `null` when nothing has arrived. */
  readonly lastOutputTs: number | null;
  /** The highest `seq` read — the cursor the next poll follows from. */
  readonly cursor: number;
}

export const NO_ACTIVITY: TurnActivity = Object.freeze({
  toolCalls: [],
  lastText: '',
  lastOutputTs: null,
  cursor: 0,
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

interface Frame {
  readonly seq: number;
  readonly body: Record<string, unknown>;
}

/**
 * Complete JSON lines across chunk boundaries.
 *
 * A chunk is however many bytes the kernel handed the daemon's pipe, so a frame
 * routinely spans two of them and two frames routinely share one. Parsing per
 * chunk would drop most of a busy turn's frames and, worse, drop them
 * *selectively* — the long ones, which are the ones carrying tool calls.
 *
 * The `seq` a frame is attributed is the chunk it **began** in, so a link to it
 * points at a row that exists.
 */
function frames(chunks: readonly IoChunkLine[]): Frame[] {
  const found: Frame[] = [];
  let pending = '';
  let pendingSeq = 0;

  for (const chunk of chunks) {
    if (chunk.stream !== 'stdout') continue;
    if (pending === '') pendingSeq = chunk.seq;
    pending += chunk.data;

    const parts = pending.split('\n');
    pending = parts.pop() ?? '';

    for (const part of parts) {
      if (part.trim() !== '') {
        try {
          const body = asRecord(JSON.parse(part));
          if (body !== null) found.push({ seq: pendingSeq, body });
        } catch {
          // Not a frame. The vendor writes the odd plain line to the same pipe,
          // and a strip is not the place to complain about it.
        }
      }
      pendingSeq = chunk.seq;
    }
    pendingSeq = pending === '' ? chunk.seq : pendingSeq;
  }

  return found;
}

/** The `content` blocks of an assistant frame, or an empty list. */
const contentOf = (body: Record<string, unknown>): readonly unknown[] => {
  const message = asRecord(body.message);
  const content = message?.content;
  return Array.isArray(content) ? content : [];
};

/**
 * Everything the strip renders, from the chunks it holds.
 *
 * Pure, and over the whole held window rather than incrementally: the window is
 * bounded by the poll's `limit` (`./node-output.ts`'s `IO_TAIL_CHUNKS`), and a
 * function of its input is a function a spec can pin without driving a
 * component.
 */
export function turnActivity(chunks: readonly IoChunkLine[]): TurnActivity {
  const toolCalls: TurnToolCall[] = [];
  let lastText = '';

  for (const frame of frames(chunks)) {
    if (frame.body.type !== 'assistant') continue;
    for (const block of contentOf(frame.body)) {
      const record = asRecord(block);
      if (record === null) continue;
      if (record.type === 'tool_use') {
        const name = asString(record.name);
        if (name !== null) toolCalls.push({ seq: frame.seq, name });
        continue;
      }
      if (record.type === 'text') {
        const text = asString(record.text);
        if (text !== null) lastText = text.trim();
      }
    }
  }

  const newest = chunks.at(-1);
  return {
    toolCalls,
    lastText,
    lastOutputTs: newest?.ts ?? null,
    cursor: chunks.reduce((highest, chunk) => Math.max(highest, chunk.seq), 0),
  };
}

/**
 * The held window plus what just arrived, deduped and ordered.
 *
 * `mergeIoChunks` rather than a second merge, for the reason it exists: a
 * re-delivered chunk is the same bytes and must not end up in the window twice,
 * and a pruned `seq` leaves a hole that is never filled.
 */
export const holdChunks = (
  held: readonly IoChunkLine[],
  arrived: readonly IoChunkLine[],
  cap: number,
): readonly IoChunkLine[] => mergeIoChunks(held, arrived).slice(-cap);
