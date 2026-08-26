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
 * ## KAR-28.1 — the rest of the sentence
 *
 * KAR-27.3 AC3 asked for *"at minimum, tool invocations as they happen"* and the
 * minimum is what shipped: three bare names over a 64-chunk tail, watched on a
 * five-minute framing turn on 2026-08-25. `events` is the whole of what the
 * frames already carried and nothing read — the identifying argument of each
 * call, the `tool_result` frames nothing parsed at all, and the agent's own
 * prose, which this module has extracted since KAR-27.3 while every renderer
 * discarded it. The reading is wider; the rule above is unchanged.
 *
 * Verifies: EPIC-27-S18, EPIC-28-S01, EPIC-28-S02, EPIC-28-S03, EPIC-28-S06 ·
 * KAR-27.3 AC3 · KAR-28.1 AC2–AC5
 */
import { type IoChunkLine, mergeIoChunks } from './node-output.ts';

/** One tool the agent invoked, as the frame named it. */
export interface TurnToolCall {
  /** The `io_chunk.seq` the frame arrived on — a stable key for a list. */
  readonly seq: number;
  /** The vendor's own name for the tool. Never normalised. */
  readonly name: string;
}

/**
 * KAR-28.1 AC3 — what came back from a tool call, as the vendor reported it.
 *
 * Both fields are read off a `tool_result` block and neither is inferred: `ok`
 * is the negation of the vendor's own `is_error`, and `summary` is the text it
 * put in `content`. A block this build cannot read produces **no**
 * `TurnToolResult` at all rather than a hopeful one — see `resultOf`.
 */
export interface TurnToolResult {
  /** `false` only when the vendor said `is_error: true`. */
  readonly ok: boolean;
  /** The vendor's own words, trimmed and truncated for width. May be `''`. */
  readonly summary: string;
}

/** One tool call in the feed: the name, what it acted on, and what came back. */
export interface TurnToolRow {
  readonly kind: 'tool';
  /** Unique within one `turnActivity` answer — a list key, nothing more. */
  readonly key: string;
  /** The `io_chunk.seq` the frame arrived on. */
  readonly seq: number;
  /** The vendor's own name for the tool. Never normalised. */
  readonly name: string;
  /**
   * AC2 — the identifying argument, printed as the frame spelled it and
   * truncated for width. `null` when the call carried no readable one; never a
   * re-worded or stringified stand-in.
   */
  readonly target: string | null;
  /** AC3 — the `tool_result` that answered it, or `null` when none was read. */
  readonly result: TurnToolResult | null;
}

/** AC4 — a stretch of the agent's own prose, in the order it was emitted. */
export interface TurnTextRow {
  readonly kind: 'text';
  readonly key: string;
  readonly seq: number;
  readonly text: string;
}

/**
 * One row of the feed.
 *
 * There is deliberately no `error` member. AC5: a frame this build cannot read
 * is *skipped*, and a union that could represent "something went wrong reading
 * the transcript" is the first step towards a working turn looking broken.
 */
export type TurnEvent = TurnToolRow | TurnTextRow;

export interface TurnActivity {
  /**
   * AC1 — every readable event of the turn, oldest first: tool calls with their
   * arguments and results, and the agent's prose between them.
   */
  readonly events: readonly TurnEvent[];
  /** Oldest first, as they happened. The strip's narrower read of `events`. */
  readonly toolCalls: readonly TurnToolCall[];
  /** The last thing the agent said in words, or `''`. */
  readonly lastText: string;
  /** `ts` of the newest chunk read, or `null` when nothing has arrived. */
  readonly lastOutputTs: number | null;
  /** The highest `seq` read — the cursor the next poll follows from. */
  readonly cursor: number;
}

export const NO_ACTIVITY: TurnActivity = Object.freeze({
  events: [],
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
 * How wide an identifying argument is allowed to be, in characters.
 *
 * AC2 asks for the argument *as the frame spelled it*, truncated only for
 * width — so the cut is here, where a spec can pin it, rather than in a CSS
 * ellipsis a test cannot see. A `Bash` command is routinely several hundred
 * characters and the row it lives on is one line of a side panel.
 */
export const ARGUMENT_LIMIT = 120;

/** The same bound for a result's summary, which is prose rather than a path. */
export const SUMMARY_LIMIT = 240;

/** Never re-worded — only cut, and visibly. */
const forWidth = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

/**
 * AC2 — which of a call's inputs identifies what it acted on.
 *
 * A vendor's tool schema is the vendor's, so this is a *lookup order* over the
 * keys the dialects in use actually spell, with "the first string the frame
 * carries" behind it. What it never does is compose a value: every answer below
 * is one string copied out of the frame, which is what keeps AC5 true when a
 * tool nobody here has heard of turns up.
 */
const ARGUMENT_KEYS = [
  'file_path',
  'notebook_path',
  'path',
  'command',
  'pattern',
  'url',
  'query',
  'id',
  'issueId',
  'prompt',
  'description',
] as const;

function targetOf(input: unknown): string | null {
  const record = asRecord(input);
  if (record === null) return null;

  for (const key of ARGUMENT_KEYS) {
    const named = asString(record[key]);
    if (named !== null) return forWidth(named, ARGUMENT_LIMIT);
  }
  for (const value of Object.values(record)) {
    const first = asString(value);
    if (first !== null) return forWidth(first, ARGUMENT_LIMIT);
  }
  return null;
}

/**
 * The text of a `tool_result`'s `content`, or `null` when there is none to read.
 *
 * Two shapes are in use for one field — a bare string, and the block list an
 * assistant message uses — so both are read. Anything else (an image block, a
 * dialect added after this build) yields `null`, and `resultOf` turns that into
 * *no result on the row* rather than into an empty one.
 */
function summaryOf(content: unknown): string | null {
  const asText = asString(content);
  if (asText !== null) return asText.trim();
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== 'text') continue;
    const text = asString(record.text);
    if (text !== null) parts.push(text);
  }
  return parts.length === 0 ? null : parts.join('\n').trim();
}

/**
 * AC3 — a `tool_result` block, read or skipped.
 *
 * Skipped when nothing legible is in it: no summary *and* no explicit
 * `is_error`. That is the whole of "a result that cannot be read is omitted
 * rather than guessed at" — a row with an invented "ok" beside a call whose
 * answer this build could not read would be a claim, and the claim would be
 * unfounded.
 */
function resultOf(record: Record<string, unknown>): TurnToolResult | null {
  const failed = record.is_error === true;
  const stated = typeof record.is_error === 'boolean';
  const summary = summaryOf(record.content);
  if (summary === null && !stated) return null;

  return { ok: !failed, summary: forWidth(summary ?? '', SUMMARY_LIMIT) };
}

/**
 * Everything the feed and the strip render, from the chunks they hold.
 *
 * Pure, and over the whole held window rather than incrementally: the window is
 * bounded by the poll's `limit` (`./node-output.ts`'s `IO_TAIL_CHUNKS`), and a
 * function of its input is a function a spec can pin without driving a
 * component.
 *
 * Two passes, because a `tool_result` arrives in a later frame than the
 * `tool_use` it answers: the first builds the rows in emission order, the
 * second folds each answer into the row that asked for it — by `tool_use_id`,
 * never by "the most recent call", which is wrong the moment an agent runs two
 * tools in one turn and they come back out of order.
 */
export function turnActivity(chunks: readonly IoChunkLine[]): TurnActivity {
  const events: TurnEvent[] = [];
  const results = new Map<string, TurnToolResult>();
  /** Where in `events` each `tool_use_id` landed. */
  const rowOf = new Map<string, number>();
  let lastText = '';
  let counter = 0;

  for (const frame of frames(chunks)) {
    const assistant = frame.body.type === 'assistant';
    const answering = frame.body.type === 'user';
    if (!assistant && !answering) continue;

    for (const block of contentOf(frame.body)) {
      const record = asRecord(block);
      if (record === null) continue;

      if (assistant && record.type === 'tool_use') {
        const name = asString(record.name);
        if (name === null) continue;
        const id = asString(record.id);
        counter += 1;
        if (id !== null && !rowOf.has(id)) rowOf.set(id, events.length);
        events.push({
          kind: 'tool',
          key: `${String(frame.seq)}:${String(counter)}`,
          seq: frame.seq,
          name,
          target: targetOf(record.input),
          result: null,
        });
        continue;
      }

      if (assistant && record.type === 'text') {
        const text = asString(record.text);
        if (text === null || text.trim() === '') continue;
        lastText = text.trim();
        counter += 1;
        events.push({
          kind: 'text',
          key: `${String(frame.seq)}:${String(counter)}`,
          seq: frame.seq,
          text: text.trim(),
        });
        continue;
      }

      if (answering && record.type === 'tool_result') {
        const id = asString(record.tool_use_id);
        if (id === null) continue; // Unattachable, and guessing is not on offer.
        const result = resultOf(record);
        if (result !== null) results.set(id, result);
      }
    }
  }

  for (const [id, result] of results) {
    const at = rowOf.get(id);
    if (at === undefined) continue;
    const row = events[at];
    if (row?.kind === 'tool') events[at] = { ...row, result };
  }

  const newest = chunks.at(-1);
  return {
    events,
    toolCalls: events.flatMap((event) =>
      event.kind === 'tool' ? [{ seq: event.seq, name: event.name }] : [],
    ),
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
