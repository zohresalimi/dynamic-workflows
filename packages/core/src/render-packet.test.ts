/**
 * KAR-09.3 — pinned first, in every archetype, whatever order the builder was
 * driven in (AC3).
 *
 * The five archetypes are built with the pinned segments added **last** on
 * purpose: an implementation that rendered in insertion order would pass a
 * test whose fixture was built in the right order, and the failure it hides —
 * the constraints arriving after the brief, where the paper says they stop
 * being honoured — is invisible afterwards.
 *
 * Verifies: EPIC-09-S14 (second scenario) · AC3 · test plan #7
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import {
  type ContextPacket,
  ContextPacketSchema,
  SEGMENT_KINDS,
  type Segment,
} from './context-packet.ts';
import { type EventSeq, EventSeqSchema } from './ids.ts';
import { buildPinnedSegments, contextSegment } from './pinned-set.ts';
import { renderPacket } from './render-packet.ts';
import { type TaskSpec, TaskSpecSchema } from './task-spec.ts';

const fixturePath = fileURLToPath(
  new URL('../test/fixtures/specs/vue3-migration.json', import.meta.url),
);

function approvedSpec(): TaskSpec {
  const draft: Record<string, unknown> = JSON.parse(readFileSync(fixturePath, 'utf8'));
  draft.approvedBy = { at: '2026-08-06T09:00:00Z', via: 'ui' };
  return TaskSpecSchema.parse(draft);
}

const seq = (value: number): EventSeq => EventSeqSchema.parse(value);

/** The five node archetypes the epic's Definition of Done names, each with the
 * unpinned segments a node of that shape really carries. */
const ARCHETYPES = {
  recon: {
    permission: 'read',
    pathScopes: [],
    segments: [
      { id: 'brief', kind: 'task.brief', text: 'Map the checkout module.', at: 10 },
      { id: 'recall', kind: 'retrieved', text: 'ADR-0010: ESM only.', at: 11 },
    ],
  },
  implement: {
    permission: 'worktree',
    pathScopes: ['src/checkout/**'],
    segments: [
      { id: 'brief', kind: 'task.brief', text: 'Port CheckoutForm to <script setup>.', at: 20 },
      { id: 'finding', kind: 'fact', text: 'finding/auth-uses-jwt = true', at: 21 },
      { id: 'log', kind: 'tool.output', text: 'vitest: 12 passed', at: 22 },
    ],
  },
  gate: {
    permission: 'read',
    pathScopes: [],
    segments: [
      { id: 'brief', kind: 'task.brief', text: 'Judge criterion no-v-model-regression.', at: 30 },
      {
        id: 'diff',
        kind: 'artifact.handle',
        text: 'artifact://deadbeef — diff, 412 lines',
        at: 31,
      },
    ],
  },
  human: {
    permission: 'read',
    pathScopes: [],
    segments: [
      { id: 'brief', kind: 'task.brief', text: 'Summarise the change for approval.', at: 40 },
      { id: 'summary', kind: 'history.summary', text: 'Turns 1-9 summarised.', at: 41 },
    ],
  },
  'map-child': {
    permission: 'worktree',
    pathScopes: ['src/checkout/steps/**'],
    segments: [
      { id: 'brief', kind: 'task.brief', text: 'Port one step component.', at: 50 },
      { id: 'shard', kind: 'fact', text: 'shard = steps/Address.vue', at: 51 },
    ],
  },
} as const;

type ArchetypeName = keyof typeof ARCHETYPES;

const ARCHETYPE_NAMES = Object.keys(ARCHETYPES) as readonly ArchetypeName[];

/** The pinned segments are appended **after** the rest — see the file note. */
async function archetypePacket(name: ArchetypeName): Promise<ContextPacket> {
  const archetype = ARCHETYPES[name];
  const rest: Segment[] = [];
  for (const declared of archetype.segments) {
    rest.push(
      await contextSegment({
        id: declared.id,
        kind: declared.kind,
        text: declared.text,
        sourceEvent: seq(declared.at),
      }),
    );
  }
  const pinned = await buildPinnedSegments({
    spec: approvedSpec(),
    node: { pathScopes: archetype.pathScopes, permission: archetype.permission },
    sourceEvent: seq(9),
  });
  const segments = [...rest, ...pinned];

  return ContextPacketSchema.parse({
    schemaId: 'DeFlow.contextpacket.v1',
    runId: 'run_20260806T090000Z_5c1d2e',
    nodeId: name,
    attempt: 0,
    builtAtEvent: 60,
    target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 200_000 },
    budget: { fraction: 0.5, limitTokens: 100_000 },
    totals: {
      tokens: segments.reduce((sum, segment) => sum + segment.tokens.estimated, 0),
      byKind: Object.fromEntries(
        SEGMENT_KINDS.map((kind) => [
          kind,
          segments
            .filter((segment) => segment.kind === kind)
            .reduce((sum, segment) => sum + segment.tokens.estimated, 0),
        ]),
      ),
    },
    renderedPromptHandle: `artifact://${'b'.repeat(64)}`,
    pinnedDigests: segments.filter((s) => s.pinned).map((s) => s.contentHash),
    segments,
  });
}

suite('render order (AC3)', () => {
  for (const name of ARCHETYPE_NAMES) {
    it(`puts every pinned segment before task.brief in the ${name} archetype`, async () => {
      const packet = await archetypePacket(name);
      const rendered = renderPacket(packet);

      const pinnedCount = packet.segments.filter((segment) => segment.pinned).length;
      const positions = packet.segments.map((segment) => ({
        pinned: segment.pinned,
        at: rendered.indexOf(segment.text),
      }));

      expect(positions.every((position) => position.at >= 0)).toBe(true);
      const lastPinned = Math.max(
        ...positions.filter((position) => position.pinned).map((position) => position.at),
      );
      const firstUnpinned = Math.min(
        ...positions.filter((position) => !position.pinned).map((position) => position.at),
      );
      expect(lastPinned).toBeLessThan(firstUnpinned);
      expect(pinnedCount).toBe(5);
    });
  }

  it('renders every segment verbatim, so the integrity check can find them', async () => {
    const packet = await archetypePacket('implement');
    const rendered = renderPacket(packet);

    for (const segment of packet.segments) expect(rendered).toContain(segment.text);
  });

  it('is pure: the same packet renders to the same bytes', async () => {
    const packet = await archetypePacket('gate');

    expect(renderPacket(packet)).toBe(renderPacket(packet));
  });

  it('renders the five archetypes the way the golden file says', async () => {
    const golden: Record<string, string> = {};
    for (const name of ARCHETYPE_NAMES) golden[name] = renderPacket(await archetypePacket(name));

    expect(golden).toMatchSnapshot();
  });
});
