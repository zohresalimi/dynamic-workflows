/**
 * What a *previous daemon life* left behind, assembled for a resume spec: a
 * `context.built` event, the segment bytes behind it in the real blob store,
 * and the capability row the probe would have written.
 *
 * Everything here is written through the same file-backed ledger the daemon
 * uses, because AC7's claim is about surviving `db.close()` — a fixture that
 * kept the packet in a `Map` would prove nothing about the case the story
 * exists for.
 */
import type { NodeId, ProviderId, RunId } from '@DeFlow/core';
import { ProviderIdSchema } from '@DeFlow/core';
import { spillBytes } from '@DeFlow/ledger';
import { CAPABILITY_PROFILES, type CapabilityProfileName } from '@DeFlow/mock-agent';
import { readFileSync } from 'node:fs';
import type { AgentBinary, CapabilityRow } from '../../../src/index.ts';
import {
  buildPacketFixture,
  type PacketFixture,
  type SegmentInput,
} from '../../support/packet-fixture.ts';
import type { TestLedger } from './harness.ts';

/** The three segments every resume spec in this suite sends. */
export const RESUME_SEGMENTS: readonly SegmentInput[] = [
  {
    id: 'seg-spec',
    kind: 'pinned.spec',
    sourceEvent: 2,
    // Distinctive on purpose: the native-resume assertion is that these exact
    // bytes are *absent* from the prompt sent after `session/resume`.
    text: 'PINNED SPEC: the ledger is the sole source of truth for a run.',
    pinned: true,
  },
  {
    id: 'seg-brief',
    kind: 'task.brief',
    sourceEvent: 5,
    text: 'Finish the node without re-running what already completed.',
    pinned: false,
  },
  {
    id: 'seg-fact',
    kind: 'fact',
    sourceEvent: 6,
    text: 'fact: two of five providers cannot resume at all.',
    pinned: false,
  },
];

export interface SeedPacketInput {
  readonly dataDir: string;
  readonly ledger: TestLedger;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly provider: ProviderId;
  readonly segments?: readonly SegmentInput[];
}

/**
 * Writes the packet's segment bytes into the content-addressed store and
 * appends the `context.built` event that names them.
 *
 * This is EPIC-09's job in production; it is here because KAR-05.5 owns only
 * the reading half, and the round trip needs both.
 */
export async function seedContextBuilt(input: SeedPacketInput): Promise<PacketFixture> {
  const fixture = await buildPacketFixture({
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    builtAtEvent: 1,
    provider: input.provider,
    segments: input.segments ?? RESUME_SEGMENTS,
  });

  for (const segment of fixture.record.segments) {
    const text = fixture.blobs.get(segment.contentHash);
    if (text !== undefined) spillBytes(input.dataDir, Buffer.from(text, 'utf8'), 'text/plain');
  }

  await input.ledger.sink.append({
    kind: 'context.built',
    v: 1,
    ts: 1_754_313_093_000,
    nodeId: input.nodeId,
    attempt: input.attempt,
    payload: { node: input.nodeId, attempt: input.attempt, packet: fixture.record },
  });

  return fixture;
}

/** The manifest row the probe would have written for `profile`. */
export function capabilityRowFor(
  profile: CapabilityProfileName,
  binary: AgentBinary,
): CapabilityRow {
  return {
    provider: ProviderIdSchema.parse(profile === 'mock-full' ? 'mock' : profile),
    version: binary.version,
    binarySha256: binary.sha256,
    binaryPath: binary.path,
    capsJson: JSON.stringify({
      protocolVersion: 1,
      agentCapabilities: CAPABILITY_PROFILES[profile],
      authMethods: [],
    }),
    probedAt: 1_754_313_093_000,
  };
}

/** Every frame the client sent, as the agent received it. */
export function wireFrames(path: string): { method?: string; params?: unknown }[] {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // No file means no frame was ever written, which is an answer and not an
    // error: "DeFlow never spawned an agent" is exactly what a refused resume
    // must look like from here.
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { method?: string; params?: unknown });
}

export function wireMethods(path: string): string[] {
  return wireFrames(path)
    .map((frame) => frame.method)
    .filter((method): method is string => method !== undefined);
}
