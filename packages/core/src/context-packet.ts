/**
 * KAR-02.6 — `ContextPacket` and typed segments (docs/04-domain-model.md §6).
 *
 * A packet is an addressable array of typed segments, not a flat string,
 * because four P0 requirements are literally unsatisfiable against a blob
 * (§6.1): F6.1 (no implicit context inheritance) needs a record of exactly
 * what a node received; F6.2 (declared reads/writes) needs each segment's
 * `sourceEvent` so "this fact entered this packet because node X wrote it at
 * seq N" is a field lookup; F10.3/F10.5 (the node inspector and the context
 * budget chart) need a per-segment token breakdown that cannot be recovered
 * from a rendered prompt after the fact; and F6.6 (the compaction audit)
 * needs "what was dropped" to be a set operation over `SegmentId`s rather
 * than a diff of two large strings.
 *
 * The nine-kind `SegmentKind` vocabulary is not invented — it mirrors the
 * categories Claude Code itself uses for its own `/context` breakdown, so
 * F10.5's chart lines up visually with what the user already sees inside the
 * vendor CLI (**Verified 2026-08-02** by decompiling the shipping bundle).
 *
 * Two invariants are enforced at the schema boundary rather than trusted:
 *
 *   1. `pinned` implies `!compactable` (one-way — `Segment.superRefine`).
 *   2. `pinnedDigests` is derived from, and checked against, each pinned
 *      segment's `contentHash` (`ContextPacket.superRefine`) — it is the F6.6
 *      integrity check's input, not a separately maintained array a builder
 *      bug could forget to update.
 *
 * `packet.totals` consistency is deliberately *not* one of the schema's
 * checks: §AC1 asks for an explicit, exported predicate
 * (`packetTotalsAreConsistent`) rather than baking the sum into `.parse()`,
 * so a caller that wants the check gets it by calling it — the totals are
 * not implicitly trusted just because a packet parsed.
 *
 * Verifies: EPIC-02-S17, EPIC-02-S18 · AC1-AC7
 */
import { z } from 'zod';
import type { SchemaId } from './ids.ts';
import {
  EventSeqSchema,
  HandleSchema,
  NodeIdSchema,
  ProviderIdSchema,
  RunIdSchema,
  SegmentIdSchema,
} from './ids.ts';

/** §6: the nine-kind closed vocabulary, mirroring Claude Code's own
 * `/context` breakdown so F10.5's chart lines up with the vendor CLI. */
export const SEGMENT_KINDS = [
  'pinned.constraints',
  'pinned.spec',
  'pinned.pathscope',
  'task.brief',
  'fact',
  'artifact.handle',
  'retrieved',
  'history.summary',
  'tool.output',
] as const;

export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export const SegmentKindSchema: z.ZodType<SegmentKind> = z.enum(SEGMENT_KINDS);

/** AC5: the three token-counting methods. `method` is required and has no
 * default — an estimate whose method is unknown is not a usable number. */
export const TOKEN_COUNT_METHODS = [
  'gpt-tokenizer/o200k_base',
  'heuristic',
  'vendor-reported',
] as const;

export type TokenCountMethod = (typeof TOKEN_COUNT_METHODS)[number];

export const TokenCountMethodSchema: z.ZodType<TokenCountMethod> = z.enum(TOKEN_COUNT_METHODS);

export const TokenCountSchema = z.strictObject({
  estimated: z.number().int().nonnegative(),
  method: TokenCountMethodSchema,
});

export type TokenCount = z.infer<typeof TokenCountSchema>;

/** `Segment.contentHash` is `sha256-<64 hex>` — see `contentHash()` in
 * ./hash.ts, which is the sole intended producer of this string. */
const CONTENT_HASH_PATTERN = /^sha256-[0-9a-f]{64}$/;

const ContentHashSchema = z
  .string()
  .regex(CONTENT_HASH_PATTERN, `contentHash must match ${CONTENT_HASH_PATTERN}`);

export const SegmentSchema = z
  .strictObject({
    id: SegmentIdSchema,
    kind: SegmentKindSchema,
    /** Which event put this here — click-through in the inspector (AC7,
     * F10.3). */
    sourceEvent: EventSeqSchema,
    contentHash: ContentHashSchema,
    text: z.string(),
    tokens: TokenCountSchema,
    /** Never eligible for compaction, always rendered first. */
    pinned: z.boolean(),
    compactable: z.boolean(),
  })
  .superRefine((segment, ctx) => {
    // AC2: pinned implies not compactable. The implication is one-way — a
    // segment that is neither pinned nor compactable is legal.
    if (segment.pinned && segment.compactable) {
      ctx.addIssue({
        code: 'custom',
        path: ['compactable'],
        message: 'a pinned segment cannot be compactable: pinned implies !compactable',
      });
    }
  });

export type Segment = z.infer<typeof SegmentSchema>;

const ContextTargetSchema = z.strictObject({
  provider: ProviderIdSchema,
  model: z.string().min(1),
  maxContext: z.number().int().positive(),
});

const BUDGET_FRACTION_MAX = 0.6;
const BUDGET_FRACTION_DEFAULT = 0.5;

/** AC3: `fraction` defaults to 0.5 and is rejected above 0.6 — the cap is
 * enforced here, not left as advice in a comment. */
export const ContextBudgetSchema = z.strictObject({
  fraction: z
    .number()
    .max(BUDGET_FRACTION_MAX, `budget.fraction must not exceed ${BUDGET_FRACTION_MAX}`)
    .default(BUDGET_FRACTION_DEFAULT),
  limitTokens: z.number().int().nonnegative(),
});

export type ContextBudget = z.infer<typeof ContextBudgetSchema>;

/** A full record, not a partial one: every `SegmentKind` must have an entry
 * (0 where a packet has no segments of that kind) — matching the domain
 * model's `Record<SegmentKind, number>`. */
const ContextTotalsSchema = z.strictObject({
  tokens: z.number().int().nonnegative(),
  byKind: z.record(SegmentKindSchema, z.number().int().nonnegative()),
});

export type ContextTotals = z.infer<typeof ContextTotalsSchema>;

/** `ContextPacket.schemaId` is a fixed literal: this module only ever
 * produces or accepts one document shape at v1. */
export const CONTEXTPACKET_SCHEMA_ID = 'DeFlow.contextpacket.v1' as const;

const ContextPacketSchemaIdSchema: z.ZodType<SchemaId, string> = z
  .literal(CONTEXTPACKET_SCHEMA_ID)
  .transform((value): SchemaId => value as SchemaId);

export const ContextPacketSchema = z
  .strictObject({
    schemaId: ContextPacketSchemaIdSchema,
    runId: RunIdSchema,
    nodeId: NodeIdSchema,
    attempt: z.number().int().nonnegative(),
    builtAtEvent: EventSeqSchema,
    target: ContextTargetSchema,
    budget: ContextBudgetSchema,
    segments: z.array(SegmentSchema),
    totals: ContextTotalsSchema,
    /** The rendered prompt is stored too — but derived, not authoritative
     * (§6.1). */
    renderedPromptHandle: HandleSchema,
    /** AC4: one sha256 per pinned segment, checked below against that
     * segment's `contentHash` — the F6.6 integrity check's input is
     * derivable, not separately maintained. */
    pinnedDigests: z.array(ContentHashSchema),
  })
  .superRefine((packet, ctx) => {
    const expected = packet.segments
      .filter((segment) => segment.pinned)
      .map((segment) => segment.contentHash)
      .toSorted();
    const actual = [...packet.pinnedDigests].toSorted();
    const matches =
      expected.length === actual.length &&
      expected.every((value, index) => value === actual[index]);
    if (!matches) {
      ctx.addIssue({
        code: 'custom',
        path: ['pinnedDigests'],
        message:
          'pinnedDigests must contain exactly one sha256 per pinned segment, each equal to ' +
          "that segment's contentHash — no extra, missing, or mismatched entries",
      });
    }
  });

export type ContextPacket = z.infer<typeof ContextPacketSchema>;

/**
 * AC1: whether `packet.totals` reconciles with `packet.segments`. Not
 * enforced by `ContextPacketSchema` itself — a packet can parse with a
 * doctored total — so a caller that cares (a test, the packet builder before
 * it emits `context.built`) must call this explicitly rather than trusting
 * the shape.
 */
export type PacketTotalsResult =
  | { readonly consistent: true }
  | { readonly consistent: false; readonly path: string; readonly message: string };

export function packetTotalsAreConsistent(packet: ContextPacket): PacketTotalsResult {
  const expectedTokens = packet.segments.reduce(
    (sum, segment) => sum + segment.tokens.estimated,
    0,
  );
  if (packet.totals.tokens !== expectedTokens) {
    return {
      consistent: false,
      path: 'totals.tokens',
      message: `totals.tokens is ${packet.totals.tokens} but segments sum to ${expectedTokens}`,
    };
  }

  for (const kind of SEGMENT_KINDS) {
    const expectedForKind = packet.segments
      .filter((segment) => segment.kind === kind)
      .reduce((sum, segment) => sum + segment.tokens.estimated, 0);
    const actualForKind = packet.totals.byKind[kind];
    if (actualForKind !== expectedForKind) {
      return {
        consistent: false,
        path: `totals.byKind.${kind}`,
        message: `totals.byKind["${kind}"] is ${actualForKind} but segments of that kind sum to ${expectedForKind}`,
      };
    }
  }

  return { consistent: true };
}

function bySourceEvent(a: Segment, b: Segment): number {
  return a.sourceEvent - b.sourceEvent;
}

/**
 * AC6: pinned segments first, then everything else in chronological
 * (`sourceEvent`) order — so a `history.summary` segment lands where the
 * turns it replaced used to be, rather than in a preamble bucket ahead of
 * older, still-present segments.
 */
export function renderOrderOf(packet: ContextPacket): readonly Segment[] {
  const pinned = packet.segments.filter((segment) => segment.pinned).toSorted(bySourceEvent);
  const rest = packet.segments.filter((segment) => !segment.pinned).toSorted(bySourceEvent);
  return [...pinned, ...rest];
}
