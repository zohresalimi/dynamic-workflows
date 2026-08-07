/**
 * KAR-09.5 — the inline threshold and the handle line
 * (docs/08-context-and-memory.md §5.2).
 *
 * Two rules, and the second one only matters because of the first.
 *
 * **A body over the threshold leaves the packet whatever the budget says.**
 * KAR-09.2 demotes when the packet is *over budget*; that is necessary and it
 * is not sufficient. A 38 KB build log inside a 100k-token budget fits, and
 * inlining it still costs the agent a third of the window it has left after
 * the vendor's own overhead — for bytes it can fetch in one tool call if it
 * turns out to want them. So the threshold is its own rule, applied before the
 * ladder ever runs, and it is configurable
 * (`context.inlineThresholdBytes` in `.DeFlow/config.yaml`).
 *
 * **The line has to be worth the tokens it costs.** An `artifact://` handle on
 * its own is unreadable — sixty-four hex characters that say nothing about
 * whether the agent should spend a turn pulling them. §5.2's line is what the
 * agent actually decides from:
 *
 * ```
 * artifact://3f2a…c91  build-log for `pnpm -r build` (fail)  · 412 lines · 38.4 KB
 *   → pull with the `DeFlow_read_artifact` MCP tool
 * ```
 *
 * The digest is truncated on that line **for the reader**, which leaves one
 * problem the documented sketch does not solve: an agent cannot pass `3f2a…c91`
 * to a tool. So the retrieval line carries the complete handle. Both spellings,
 * one line each, is the smallest honest form — a truncated digest the agent
 * copies is a call that fails, and a bare 64-hex address is a line nobody reads.
 *
 * Nothing here reaches a provider, an adapter, a socket or a subprocess, and
 * `packages/core/test/demotion-is-provider-free.test.ts` is what keeps it that
 * way: **offload, don't summarise** is only a rule while the module that
 * offloads is structurally unable to summarise.
 *
 * Verifies: EPIC-09-S26 (first scenario), EPIC-09-S28 · AC1, AC2, AC3, AC6
 */
import type { Segment } from './context-packet.ts';
import type { Handle } from './ids.ts';

/**
 * The default inline threshold: 8 KB.
 *
 * Chosen against the two sizes that matter rather than as a round number. A
 * `fact` body, a gate criterion, a node's return envelope — the things a packet
 * is *made of* — are hundreds of bytes to a couple of kilobytes, and offloading
 * one costs the agent a tool call to read what it already had. A build log, a
 * test transcript, a coverage report — the things that blow a window — start
 * around ten kilobytes and have no upper bound. 8 KB sits in the empty space
 * between them, so the rule fires on transcripts and never on facts.
 */
export const INLINE_THRESHOLD_BYTES_DEFAULT = 8 * 1024;

/** The tool the handle line names. Spelled the way every agent-facing document
 * spells it (docs/08-context-and-memory.md §5.2), and the same string the MCP
 * catalog registers — a line that names a tool the host does not serve is a
 * line that costs a wasted turn. */
export const READ_ARTIFACT_TOOL = 'DeFlow_read_artifact';

const SHA256_PREFIX = 'sha256-';

const encoder = new TextEncoder();

/** UTF-8 bytes, not characters: the threshold is about what travels, and a
 * body of box-drawing characters is three times the length it looks. */
export function byteLengthOf(text: string): number {
  return encoder.encode(text).length;
}

/** Lines as a reader counts them, which is what §5.2's `412 lines` means. */
export function lineCountOf(text: string): number {
  return text.split('\n').length;
}

const KB = 1024;
const MB = KB * 1024;

/** `412 B`, `38.4 KB`, `1.5 MB` — one decimal above a kilobyte, because the
 * agent is deciding whether to spend a turn and the second decimal never
 * changes that answer. */
export function formatByteSize(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

/**
 * `3f2a…c91` — head and tail, never a prefix alone.
 *
 * A prefix is what a truncation reaches for and it is the wrong half: two
 * artifacts in one packet with a shared prefix are indistinguishable, and the
 * one place a human reads these is a diff of two packets. Head plus tail
 * distinguishes them for the same eight characters.
 */
export function truncatedDigest(value: string): string {
  const hex = value.startsWith(SHA256_PREFIX) ? value.slice(SHA256_PREFIX.length) : value;
  return `${hex.slice(0, 4)}…${hex.slice(-3)}`;
}

/** `artifact://<sha256>` for a segment, derived from the digest it already
 * carries — which is why offloading needs no store, no port and no `await`,
 * and why two identical bodies mint one handle without anything comparing
 * them (AC2). */
export function handleForSegment(segment: Segment): Handle {
  return `artifact://${segment.contentHash.slice(SHA256_PREFIX.length)}` as Handle;
}

/** What the handle line says the body *is*, when the caller supplied nothing.
 * Names the kind and the segment, which is everything this layer knows — a
 * guess at content would be a summary, and summarising is the one thing this
 * module exists not to do. */
export function defaultDescription(segment: Segment): string {
  return `${segment.kind} body "${segment.id}"`;
}

/**
 * §5.2's handle, verbatim in shape: the address, what it is, how big it was,
 * and how to get it back. Every part is a function of the segment and the
 * description, so the stub is byte-stable and its own `contentHash` is
 * reproducible.
 */
export function handleStubText(segment: Segment, description?: string): string {
  const handle = handleForSegment(segment);
  const what = description ?? defaultDescription(segment);
  const lines = lineCountOf(segment.text);
  const size = formatByteSize(byteLengthOf(segment.text));
  return (
    `artifact://${truncatedDigest(segment.contentHash)}  ${what}  · ${lines} lines · ${size}\n` +
    `  → pull with the \`${READ_ARTIFACT_TOOL}\` MCP tool: ${handle}`
  );
}

/** AC1 — whether this body is one the packet should carry by reference. */
export function exceedsInlineThreshold(segment: Segment, thresholdBytes: number): boolean {
  return byteLengthOf(segment.text) > thresholdBytes;
}
