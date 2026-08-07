/**
 * A real `ContextPacket` with a real pinned set, built through the shipped
 * builders rather than hand-written.
 *
 * The whole claim under test is that the bytes the packet builder produced are
 * the bytes the child process was handed, so a fixture that hand-wrote its own
 * segments and its own digests would be asserting against itself.
 */
import {
  buildPinnedSegments,
  type Constraint,
  type ContextPacket,
  ContextPacketSchema,
  contextSegment,
  EventSeqSchema,
  renderPacket,
  SEGMENT_KINDS,
  type Segment,
  type TaskSpec,
  TaskSpecSchema,
} from '@DeFlow/core';

export const SPEC_GOAL =
  'Migrate the checkout module from Vue 2 to Vue 3 without changing its public API.';

/** Approved, because F1.5 pins an *approved* spec and nothing else. */
export function approvedSpec(overrides: Partial<Record<string, unknown>> = {}): TaskSpec {
  return TaskSpecSchema.parse({
    schemaId: 'DeFlow.taskspec.v1',
    goal: SPEC_GOAL,
    scope: { included: ['src/checkout/**'], paths: ['src/checkout'] },
    nonGoals: ['Rewriting the payment gateway integration'],
    constraints: ['must not change the public API of the checkout package'],
    priorDecisions: [],
    acceptanceCriteria: [
      {
        id: 'unit-tests-pass',
        statement: 'All existing checkout unit tests pass unmodified.',
        check: { kind: 'command', run: 'pnpm test', expect: 'exit-zero' },
        coveredByGates: [],
      },
    ],
    knownFailureModes: [],
    approvedBy: { at: '2026-08-06T09:00:00Z', via: 'ui' },
    specHash: `sha256-${'0'.repeat(64)}`,
    ...overrides,
  });
}

export interface PinnedPacketOptions {
  readonly nodeId?: string;
  readonly pathScopes?: readonly string[];
  readonly permission?: string;
  readonly constraints?: readonly Constraint[];
  readonly brief?: string;
  readonly spec?: TaskSpec;
}

const totalsOf = (segments: readonly Segment[]) => ({
  tokens: segments.reduce((sum, segment) => sum + segment.tokens.estimated, 0),
  byKind: Object.fromEntries(
    SEGMENT_KINDS.map((kind) => [
      kind,
      segments
        .filter((segment) => segment.kind === kind)
        .reduce((sum, segment) => sum + segment.tokens.estimated, 0),
    ]),
  ),
});

/** A packet whose pinned block is the five §4.1 content types, plus a brief. */
export async function pinnedPacket(options: PinnedPacketOptions = {}): Promise<ContextPacket> {
  const spec = options.spec ?? approvedSpec();
  const pinned = await buildPinnedSegments({
    spec,
    node: {
      pathScopes: options.pathScopes ?? ['src/checkout/**'],
      permission: options.permission ?? 'worktree',
    },
    ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
    sourceEvent: EventSeqSchema.parse(1),
  });
  const brief = await contextSegment({
    id: 'brief',
    kind: 'task.brief',
    text: options.brief ?? 'Port CheckoutForm.vue to the Composition API.',
    sourceEvent: EventSeqSchema.parse(2),
  });
  // Pinned segments deliberately added *last*: the render puts them first.
  const segments = [brief, ...pinned];

  return ContextPacketSchema.parse({
    schemaId: 'DeFlow.contextpacket.v1',
    runId: 'run_20260805T101500Z_ac0501',
    nodeId: options.nodeId ?? 'n1',
    attempt: 0,
    builtAtEvent: 3,
    target: { provider: 'mock', model: 'mock-1', maxContext: 200_000 },
    budget: { fraction: 0.5, limitTokens: 100_000 },
    totals: totalsOf(segments),
    renderedPromptHandle: `artifact://${'c'.repeat(64)}`,
    pinnedDigests: segments.filter((s) => s.pinned).map((s) => s.contentHash),
    segments,
  });
}

/** The pinned slice `runAcpNode` carries, which is what it checks the prompt
 * against immediately before it spawns. */
export const pinsOf = (packet: ContextPacket) =>
  packet.segments
    .filter((segment) => segment.pinned)
    .map((segment) => ({
      id: segment.id,
      text: segment.text,
      contentHash: segment.contentHash,
      pinned: true as const,
    }));

export { renderPacket };
