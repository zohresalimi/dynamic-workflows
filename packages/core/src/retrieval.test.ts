/**
 * KAR-09.10 — turning an FTS5 hit into a `retrieved` context segment.
 *
 * Unit, because everything here is a pure function of a hit: the pull-line
 * text, the segment shape, and the 20-row ceiling. The half that needs a real
 * SQLite file — `artifact_fts` itself, the tokenizer, `bm25`/`snippet`/`rank`
 * — is `packages/ledger/test/integration/artifact-fts.test.ts`.
 *
 * Verifies: EPIC-09-S53 (segment provenance), EPIC-09-S54 (bounded results,
 * fill order) · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { buildPacket, FILL_ORDER, type PacketBuildInput } from './build-packet.ts';
import { type EventSeq, EventSeqSchema, type Handle } from './ids.ts';
import { contextSegment } from './pinned-set.ts';
import {
  type ArtifactRetrievalHit,
  RETRIEVED_ARTIFACT_LIMIT,
  retrievedSegmentsOf,
  retrievedSegmentText,
} from './retrieval.ts';
import { TaskSpecSchema } from './task-spec.ts';

const seq = (value: number): EventSeq => EventSeqSchema.parse(value);
const handle = (hex: string): Handle => `artifact://${hex.repeat(64).slice(0, 64)}` as Handle;

function hit(overrides: Partial<ArtifactRetrievalHit> = {}): ArtifactRetrievalHit {
  return {
    nodeId: 'recon',
    snippet: 'stack trace mentions [get_user_by_id] at line 42',
    handle: handle('3f'),
    sourceEvent: seq(12),
    ...overrides,
  };
}

suite('retrievedSegmentText (AC5)', () => {
  it('carries the snippet, the producing node and the artifact handle', () => {
    const text = retrievedSegmentText(hit());
    expect(text).toContain('[get_user_by_id]');
    expect(text).toContain('recon');
    expect(text).toContain(handle('3f'));
    expect(text).toContain('DeFlow_read_artifact');
  });
});

suite('retrievedSegmentsOf (AC5)', () => {
  it('builds one unpinned, compactable "retrieved" segment per hit', async () => {
    const segments = await retrievedSegmentsOf([hit(), hit({ nodeId: 'implement' })]);
    expect(segments).toHaveLength(2);
    for (const segment of segments) {
      expect(segment.kind).toBe('retrieved');
      expect(segment.pinned).toBe(false);
      expect(segment.compactable).toBe(true);
    }
  });

  it("carries the hit's sourceEvent, so the inspector can click through (AC5)", async () => {
    const [segment] = await retrievedSegmentsOf([hit({ sourceEvent: seq(77) })]);
    expect(segment?.sourceEvent).toBe(77);
  });

  it('assigns stable, distinct segment ids in hit order', async () => {
    const segments = await retrievedSegmentsOf([hit(), hit(), hit()]);
    expect(segments.map((s) => s.id)).toEqual(['retrieved-1', 'retrieved-2', 'retrieved-3']);
  });

  it('never returns more than RETRIEVED_ARTIFACT_LIMIT segments, even given more hits', async () => {
    expect(RETRIEVED_ARTIFACT_LIMIT).toBe(20);
    const hits = Array.from({ length: 27 }, (_unused, index) =>
      hit({ nodeId: `node-${index}`, sourceEvent: seq(index + 1) }),
    );
    const segments = await retrievedSegmentsOf(hits);
    expect(segments).toHaveLength(20);
  });

  it('degrades to zero segments, not an error, when there are no hits', async () => {
    expect(await retrievedSegmentsOf([])).toEqual([]);
  });
});

suite('fill order: retrieved segments sit after declared reads, before artifact handles', () => {
  it('places a supplied "retrieved" segment at its documented FILL_ORDER slot', () => {
    expect(FILL_ORDER.indexOf('fact')).toBeLessThan(FILL_ORDER.indexOf('retrieved'));
    expect(FILL_ORDER.indexOf('retrieved')).toBeLessThan(FILL_ORDER.indexOf('artifact.handle'));
  });

  it('buildPacket orders a real retrieved segment between a fact and an artifact handle', async () => {
    const draft: Record<string, unknown> = {
      schemaId: 'DeFlow.taskspec.v1',
      goal: 'ship it',
      scope: { included: ['checkout'] },
      nonGoals: [],
      constraints: [],
      priorDecisions: [],
      acceptanceCriteria: [{ id: 'ac-1', statement: 'works' }],
      knownFailureModes: [],
      approvedBy: { at: '2026-08-07T09:00:00Z', via: 'ui' },
      specHash: `sha256-${'a'.repeat(64)}`,
    };
    const spec = TaskSpecSchema.parse(draft);

    const factSeg = await contextSegment({
      id: 'a-fact',
      kind: 'fact',
      text: 'a fact',
      sourceEvent: seq(5),
    });
    const retrievedSegments = await retrievedSegmentsOf([hit()]);
    const retrievedSeg = retrievedSegments[0];
    if (retrievedSeg === undefined) throw new Error('retrievedSegmentsOf lost its one hit');
    const handleSeg = await contextSegment({
      id: 'a-handle',
      kind: 'artifact.handle',
      text: 'a handle',
      sourceEvent: seq(6),
    });

    const build = await buildPacket({
      runId: 'run_20260807T090000Z_5c1d2e',
      nodeId: 'implement',
      attempt: 0,
      builtAtEvent: seq(60),
      target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 200_000 },
      pinned: {
        spec,
        node: { pathScopes: ['src/**'], permission: 'worktree' },
        sourceEvent: seq(1),
      },
      // Supplied out of fill order on purpose — buildPacket re-sorts.
      segments: [handleSeg, factSeg, retrievedSeg],
    } satisfies PacketBuildInput);

    const kinds = build.packet.segments.filter((s) => !s.pinned).map((s) => s.kind);
    expect(kinds.indexOf('fact')).toBeLessThan(kinds.indexOf('retrieved'));
    expect(kinds.indexOf('retrieved')).toBeLessThan(kinds.indexOf('artifact.handle'));
  });
});
