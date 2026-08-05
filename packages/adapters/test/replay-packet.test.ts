/**
 * KAR-05.5 AC3 — the prompt a replay resume sends is re-derived from the
 * ledger and from DeFlow's own content-addressed store, and from nothing else.
 *
 * The round trip is the point. `buildPacketFixture` writes the packet forwards
 * — text in, digests and totals out — and `reconstructPacket` reads it
 * backwards, re-hashing every segment's bytes and re-rendering the prompt.
 * Byte equality between the two is the claim; the failure cases below are what
 * make it a claim rather than a tautology, because a store whose bytes have
 * drifted must be refused rather than silently sent to an agent.
 *
 * Verifies: EPIC-05-S19 (scenario 3) · AC3 · test plan #4
 */
import {
  canonicalJson,
  type EventSeq,
  NodeIdSchema,
  ProviderIdSchema,
  RunIdSchema,
  sha256Hex,
} from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { type LedgerEventRow, reconstructPacket } from '../src/index.ts';
import { buildPacketFixture, type PacketFixture } from './support/packet-fixture.ts';

const RUN = RunIdSchema.parse('run_20260805T101500Z_ac0505');
const NODE = NodeIdSchema.parse('n1');
const PROVIDER = ProviderIdSchema.parse('mock');

const fixture = async (attempt = 0): Promise<PacketFixture> =>
  await buildPacketFixture({
    runId: RUN,
    nodeId: NODE,
    attempt,
    builtAtEvent: 7,
    provider: PROVIDER,
    segments: [
      {
        id: 'seg-spec',
        kind: 'pinned.spec',
        sourceEvent: 2,
        text: 'The spec: ship KAR-05.5.',
        pinned: true,
      },
      {
        id: 'seg-brief',
        kind: 'task.brief',
        sourceEvent: 5,
        text: 'Resume the node without re-running its completed effects.',
        pinned: false,
      },
      {
        id: 'seg-fact',
        kind: 'fact',
        sourceEvent: 6,
        text: 'fact: the ledger is the source of truth.',
        pinned: false,
      },
    ],
  });

function history(
  packets: readonly { attempt: number; record: unknown }[],
): readonly LedgerEventRow[] {
  return packets.map((entry, index) => ({
    seq: (10 + index) as EventSeq,
    kind: 'context.built',
    payload: { node: NODE, attempt: entry.attempt, packet: entry.record },
  }));
}

const sources = (fixtureUsed: PacketFixture, overrides: Record<string, string | null> = {}) => ({
  readSegmentText: (contentHash: string): string | null => {
    if (Object.hasOwn(overrides, contentHash)) return overrides[contentHash] ?? null;
    return fixtureUsed.blobs.get(contentHash) ?? null;
  },
});

suite('a replay packet is rebuilt from the ledger alone (EPIC-05-S19)', () => {
  it('re-derives a byte-identical packet and the exact prompt', async () => {
    const built = await fixture();
    const rebuilt = await reconstructPacket(
      history([{ attempt: 0, record: built.record }]),
      { nodeId: NODE, attempt: 0 },
      sources(built),
    );

    expect(canonicalJson(rebuilt.packet)).toBe(canonicalJson(built.record));
    expect(rebuilt.prompt).toBe(built.prompt);
    // The handle is the digest of the bytes, so this is the same claim from
    // the other side: what was sent is what the record says was sent.
    expect(rebuilt.packet.renderedPromptHandle).toBe(
      `artifact://${await sha256Hex(rebuilt.prompt)}`,
    );
  });

  it('reads only its inputs — no vendor session file, no vendor API', async () => {
    const built = await fixture();
    const asked: string[] = [];
    await reconstructPacket(
      history([{ attempt: 0, record: built.record }]),
      {
        nodeId: NODE,
        attempt: 0,
      },
      {
        readSegmentText: (hash) => {
          asked.push(hash);
          return built.blobs.get(hash) ?? null;
        },
      },
    );
    // Exactly the segments the record names, and nothing else was consulted.
    expect(asked).toEqual(built.record.segments.map((segment) => segment.contentHash));
  });

  it('rebuilds the packet for the attempt asked for', async () => {
    const first = await fixture(0);
    const second = await buildPacketFixture({
      runId: RUN,
      nodeId: NODE,
      attempt: 1,
      builtAtEvent: 21,
      provider: PROVIDER,
      segments: [
        { id: 'seg-retry', kind: 'task.brief', sourceEvent: 20, text: 'try again', pinned: false },
      ],
    });
    const rows = history([
      { attempt: 0, record: first.record },
      { attempt: 1, record: second.record },
    ]);

    const rebuilt = await reconstructPacket(
      rows,
      { nodeId: NODE, attempt: 1 },
      {
        readSegmentText: (hash) => second.blobs.get(hash) ?? first.blobs.get(hash) ?? null,
      },
    );
    expect(rebuilt.prompt).toBe(second.prompt);
  });
});

suite('a store that no longer agrees with the log is refused (AC3)', () => {
  it('refuses a segment whose bytes have drifted', async () => {
    const built = await fixture();
    const drifted = built.record.segments[0]?.contentHash as string;
    await expect(
      reconstructPacket(
        history([{ attempt: 0, record: built.record }]),
        { nodeId: NODE, attempt: 0 },
        sources(built, { [drifted]: 'The spec: ship something else entirely.' }),
      ),
    ).rejects.toMatchObject({
      deflowFailure: { reason: 'safety.pin-integrity-violated', class: 'permanent' },
    });
  });

  it('refuses a segment whose bytes are gone', async () => {
    const built = await fixture();
    const missing = built.record.segments[1]?.contentHash as string;
    await expect(
      reconstructPacket(
        history([{ attempt: 0, record: built.record }]),
        { nodeId: NODE, attempt: 0 },
        sources(built, { [missing]: null }),
      ),
    ).rejects.toMatchObject({
      deflowFailure: {
        reason: 'safety.pin-integrity-violated',
        detail: { segmentIds: [built.record.segments[1]?.id] },
      },
    });
  });

  it('refuses a record whose totals do not reconcile with its segments', async () => {
    const built = await fixture();
    const doctored = {
      ...built.record,
      totals: { ...built.record.totals, tokens: built.record.totals.tokens + 99 },
    };
    await expect(
      reconstructPacket(
        history([{ attempt: 0, record: doctored }]),
        { nodeId: NODE, attempt: 0 },
        sources(built),
      ),
    ).rejects.toMatchObject({ deflowFailure: { class: 'permanent' } });
  });
});

suite('a packet that was never recorded is not invented (AC3)', () => {
  it('refuses when the attempt has no context.built at all', async () => {
    const built = await fixture();
    await expect(
      reconstructPacket(
        history([{ attempt: 0, record: built.record }]),
        { nodeId: NODE, attempt: 3 },
        sources(built),
      ),
    ).rejects.toThrow(/context\.built/);
  });

  it('refuses a context.built payload it cannot parse', async () => {
    await expect(
      reconstructPacket(
        [{ seq: 4 as EventSeq, kind: 'context.built', payload: { node: NODE, attempt: 0 } }],
        { nodeId: NODE, attempt: 0 },
        { readSegmentText: () => null },
      ),
    ).rejects.toThrow();
  });
});
