/**
 * A `context.built` record and the segment bytes behind it, built forwards.
 *
 * KAR-05.5 AC3 is a round-trip claim — the packet `ResumeByReplay`
 * reconstructs from the ledger must be byte-identical to the one
 * `context.built` recorded — and a round trip needs both directions written
 * independently. This is the forward half: text in, digests and totals out,
 * the way EPIC-09's packet builder will emit them. `reconstructPacket` is the
 * backward half, and it shares exactly one thing with this file:
 * `renderPrompt`, because "the rendered prompt" must have one definition or
 * the round trip proves nothing about the real one.
 */
import {
  CONTEXTPACKET_SCHEMA_ID,
  type ContextPacket,
  type ContextPacketRecord,
  ContextPacketRecordSchema,
  ContextPacketSchema,
  contentHash,
  HandleSchema,
  type NodeId,
  type ProviderId,
  type RunId,
  SEGMENT_KINDS,
  type Segment,
  SegmentIdSchema,
  type SegmentKind,
  sha256Hex,
} from '@DeFlow/core';
import { renderPrompt } from '../../src/index.ts';

export interface SegmentInput {
  readonly id: string;
  readonly kind: SegmentKind;
  readonly sourceEvent: number;
  readonly text: string;
  readonly pinned: boolean;
}

export interface PacketFixture {
  /** The packet with text, as the builder held it in memory. */
  readonly packet: ContextPacket;
  /** The packet as `context.built` records it — every segment minus `text`. */
  readonly record: ContextPacketRecord;
  /** The bytes DeFlow sends, and the bytes a replay has to re-derive. */
  readonly prompt: string;
  /** The content-addressed store, keyed the way segments reference it. */
  readonly blobs: ReadonlyMap<string, string>;
}

export interface PacketFixtureInput {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly builtAtEvent: number;
  readonly provider: ProviderId;
  readonly segments: readonly SegmentInput[];
}

/** The heuristic estimate KAR-05.1 already uses, labelled as one. */
const estimate = (text: string): number => Math.ceil(text.length / 4);

export async function buildPacketFixture(input: PacketFixtureInput): Promise<PacketFixture> {
  const segments: Segment[] = [];
  const blobs = new Map<string, string>();

  for (const segment of input.segments) {
    const hash = await contentHash(segment.text);
    blobs.set(hash, segment.text);
    segments.push({
      id: SegmentIdSchema.parse(segment.id),
      kind: segment.kind,
      sourceEvent: segment.sourceEvent,
      contentHash: hash,
      tokens: { estimated: estimate(segment.text), method: 'heuristic' },
      pinned: segment.pinned,
      compactable: !segment.pinned,
      text: segment.text,
    });
  }

  const byKind = Object.fromEntries(
    SEGMENT_KINDS.map((kind) => [
      kind,
      segments
        .filter((segment) => segment.kind === kind)
        .reduce((sum, segment) => sum + segment.tokens.estimated, 0),
    ]),
  ) as Record<SegmentKind, number>;

  const draft = {
    schemaId: CONTEXTPACKET_SCHEMA_ID,
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    builtAtEvent: input.builtAtEvent,
    target: { provider: input.provider, model: 'mock-1', maxContext: 200_000 },
    budget: { fraction: 0.5, limitTokens: 100_000 },
    totals: {
      tokens: segments.reduce((sum, segment) => sum + segment.tokens.estimated, 0),
      byKind,
    },
    pinnedDigests: segments.filter((s) => s.pinned).map((s) => s.contentHash),
  };

  // Rendered first, so the handle in the record is the digest of the exact
  // bytes this fixture claims were sent.
  const withText = ContextPacketSchema.parse({
    ...draft,
    // A placeholder digest, replaced below: the schema needs a valid handle
    // before the packet exists, and the handle is a function of the packet.
    renderedPromptHandle: `artifact://${'0'.repeat(64)}`,
    segments,
  });
  const prompt = renderPrompt(withText);
  const renderedPromptHandle = HandleSchema.parse(`artifact://${await sha256Hex(prompt)}`);
  blobs.set(renderedPromptHandle, prompt);

  const packet = ContextPacketSchema.parse({ ...draft, renderedPromptHandle, segments });
  const record = ContextPacketRecordSchema.parse({
    ...draft,
    renderedPromptHandle,
    segments: segments.map(({ text: _text, ...rest }) => rest),
  });

  return { packet, record, prompt, blobs };
}
