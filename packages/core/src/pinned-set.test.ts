/**
 * KAR-09.3 — the five pinned content types, and the two rules that make the
 * flag mean something: nothing else may set it, and nothing may take it away.
 *
 * Verifies: EPIC-09-S14 (first and third scenarios), EPIC-09-S15, EPIC-09-S8 ·
 * AC1, AC2 · test plan #6
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { type Constraint, restateForbidAsAllowOnly } from './constraint.ts';
import {
  type ContextPacket,
  ContextPacketSchema,
  SEGMENT_KINDS,
  type Segment,
  SegmentSchema,
} from './context-packet.ts';
import { contentHash } from './hash.ts';
import { type EventSeq, EventSeqSchema, SegmentIdSchema } from './ids.ts';
import {
  assertPinnedSetFitsBudget,
  buildPinnedSegments,
  contextSegment,
  demoteToBudget,
  PINNED_CONTENT_TYPES,
  PinnedSetExceedsBudget,
  selectCompactionCandidates,
} from './pinned-set.ts';
import { type TaskSpec, TaskSpecSchema } from './task-spec.ts';

const fixturePath = fileURLToPath(
  new URL('../test/fixtures/specs/vue3-migration.json', import.meta.url),
);
const baseSpec: Record<string, unknown> = JSON.parse(readFileSync(fixturePath, 'utf8'));

/** EPIC-09-S14's background: goal, two nonGoals, three acceptanceCriteria and
 * two constraints, approved. */
function approvedSpec(): TaskSpec {
  const draft = structuredClone(baseSpec);
  draft.nonGoals = ['Rewriting the payment gateway integration', 'Touching the pricing service'];
  draft.constraints = [
    'must not change the public API of @voyado/ui',
    'must not run database migrations',
  ];
  draft.approvedBy = { at: '2026-08-06T09:00:00Z', via: 'ui' };
  return TaskSpecSchema.parse(draft);
}

const NODE = {
  pathScopes: ['src/checkout/**'],
  permission: 'worktree',
} as const;

const SOURCE: EventSeq = EventSeqSchema.parse(41);

/** `ContextTotals.byKind` is a full record: every kind, 0 where there are none. */
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

const packetOf = (segments: readonly Segment[], limitTokens = 100_000): ContextPacket =>
  ContextPacketSchema.parse({
    schemaId: 'DeFlow.contextpacket.v1',
    runId: 'run_20260806T090000Z_5c1d2e',
    nodeId: 'implement',
    attempt: 0,
    builtAtEvent: 42,
    target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 200_000 },
    budget: { fraction: 0.5, limitTokens },
    totals: totalsOf(segments),
    renderedPromptHandle: 'artifact://'.concat('a'.repeat(64)),
    pinnedDigests: segments
      .filter((segment) => segment.pinned)
      .map((segment) => segment.contentHash),
    segments,
  });

/** A non-pinned segment of a given size, for the demotion ladder. */
async function bulk(name: string, kind: 'tool.output' | 'retrieved' | 'fact', tokens: number) {
  const text = `${name}: ${'x'.repeat(tokens * 4)}`;
  return SegmentSchema.parse({
    id: SegmentIdSchema.parse(name),
    kind,
    sourceEvent: SOURCE,
    contentHash: await contentHash(text),
    tokens: { estimated: tokens, method: 'heuristic' },
    pinned: false,
    compactable: true,
    text,
  });
}

suite('the pinned set is exactly five things (AC1)', () => {
  it('names the five content types from §4.1 and their kinds', () => {
    expect(PINNED_CONTENT_TYPES.map((entry) => entry.kind)).toEqual([
      'pinned.spec',
      'pinned.spec',
      'pinned.constraints',
      'pinned.pathscope',
      'pinned.constraints',
    ]);
    expect(PINNED_CONTENT_TYPES).toHaveLength(5);
  });

  it('builds exactly those five segments, all pinned and none compactable', async () => {
    const segments = await buildPinnedSegments({
      spec: approvedSpec(),
      node: NODE,
      sourceEvent: SOURCE,
    });

    expect(segments).toHaveLength(5);
    expect(segments.map((segment) => segment.kind)).toEqual(
      PINNED_CONTENT_TYPES.map((entry) => entry.kind),
    );
    expect(segments.every((segment) => segment.pinned)).toBe(true);
    expect(segments.some((segment) => segment.compactable)).toBe(false);
  });

  it('carries the goal and the non-goals in one segment and the criteria in another', async () => {
    const spec = approvedSpec();
    const [goal, criteria, constraints, pathscope, permission] = await buildPinnedSegments({
      spec,
      node: NODE,
      sourceEvent: SOURCE,
    });

    expect(goal?.text).toContain(spec.goal);
    for (const nonGoal of spec.nonGoals) expect(goal?.text).toContain(nonGoal);
    for (const criterion of spec.acceptanceCriteria) {
      expect(criteria?.text).toContain(criterion.statement);
    }
    for (const constraint of spec.constraints) expect(constraints?.text).toContain(constraint);
    expect(pathscope?.text).toContain('src/checkout/**');
    expect(permission?.text).toContain('worktree');
  });

  it('hashes each pinned segment over its own bytes, so the ledger can prove them', async () => {
    const segments = await buildPinnedSegments({
      spec: approvedSpec(),
      node: NODE,
      sourceEvent: SOURCE,
    });

    for (const segment of segments) {
      expect(segment.contentHash).toBe(await contentHash(segment.text));
    }
  });

  it('is byte-identical for the same spec and node — a rebuild re-injects the same bytes', async () => {
    const spec = approvedSpec();
    const first = await buildPinnedSegments({ spec, node: NODE, sourceEvent: SOURCE });
    const second = await buildPinnedSegments({ spec, node: NODE, sourceEvent: SOURCE });

    expect(second.map((segment) => segment.text)).toEqual(first.map((segment) => segment.text));
    expect(second.map((segment) => segment.contentHash)).toEqual(
      first.map((segment) => segment.contentHash),
    );
  });

  it('refuses to build any other kind as pinned — the flag has one producer', async () => {
    const segment = await contextSegment({
      id: 'brief',
      kind: 'task.brief',
      text: 'Do the thing.',
      sourceEvent: SOURCE,
    });

    expect(segment.pinned).toBe(false);

    // A pinned kind is not in `contextSegment`'s vocabulary and there is no
    // `pinned` parameter to pass: the invalid combination is unrepresentable
    // rather than rejected at runtime (EPIC-09-S15 second scenario). The
    // `@ts-expect-error` below is the assertion — `pnpm typecheck` fails if
    // the call ever starts compiling — and the runtime half is that even a
    // caller who forces it past the type checker cannot get the flag out.
    const forced = await contextSegment({
      // @ts-expect-error — 'pinned.spec' is not an UnpinnedSegmentKind.
      kind: 'pinned.spec',
      id: 'sneaky',
      text: 'Goal: something.',
      sourceEvent: SOURCE,
    });
    expect(forced.pinned).toBe(false);
  });
});

suite('pinned ⇒ never compactable, never demotable (AC2)', () => {
  it('hides every pinned segment from the compaction selector, in every archetype', async () => {
    const pinned = await buildPinnedSegments({
      spec: approvedSpec(),
      node: NODE,
      sourceEvent: SOURCE,
    });
    const others = [
      await bulk('log', 'tool.output', 900),
      await bulk('recall', 'retrieved', 300),
      await bulk('finding', 'fact', 120),
    ];

    const candidates = selectCompactionCandidates(packetOf([...pinned, ...others]));

    expect(candidates.some((segment) => segment.pinned)).toBe(false);
    expect(candidates.map((segment) => segment.id)).toEqual(others.map((segment) => segment.id));
  });

  it('returns every pinned segment unchanged from a 3×-over-budget demotion pass', async () => {
    const pinned = await buildPinnedSegments({
      spec: approvedSpec(),
      node: NODE,
      sourceEvent: SOURCE,
    });
    const pinnedTokens = pinned.reduce((sum, segment) => sum + segment.tokens.estimated, 0);
    // The pinned block is the single largest contributor, and the packet is
    // three times its budget.
    const others = [
      await bulk('log', 'tool.output', Math.floor(pinnedTokens / 2)),
      await bulk('recall', 'retrieved', Math.floor(pinnedTokens / 2)),
    ];
    const total = pinnedTokens + others.reduce((sum, s) => sum + s.tokens.estimated, 0);
    const packet = packetOf([...pinned, ...others], Math.floor(total / 3));

    const result = demoteToBudget(packet);

    const keptPinned = result.kept.filter((segment) => segment.pinned);
    expect(keptPinned.map((segment) => segment.contentHash)).toEqual(
      pinned.map((segment) => segment.contentHash),
    );
    expect(keptPinned.map((segment) => segment.text)).toEqual(
      pinned.map((segment) => segment.text),
    );
    // Everything demotable went, and it still could not reach the budget.
    expect(result.demoted).toEqual(others.map((segment) => segment.id));
    expect(result.reachedBudget).toBe(false);
  });

  it('demotes the largest tool.output first and stops as soon as it fits', async () => {
    const pinned = await buildPinnedSegments({
      spec: approvedSpec(),
      node: NODE,
      sourceEvent: SOURCE,
    });
    const small = await bulk('small-log', 'tool.output', 100);
    const large = await bulk('large-log', 'tool.output', 900);
    const recalled = await bulk('recall', 'retrieved', 400);
    const pinnedTokens = pinned.reduce((sum, segment) => sum + segment.tokens.estimated, 0);
    const packet = packetOf([...pinned, small, large, recalled], pinnedTokens + 600);

    const result = demoteToBudget(packet);

    expect(result.demoted).toEqual([large.id]);
    expect(result.reachedBudget).toBe(true);
  });
});

suite('an unbudgetable pinned set is a plan error (EPIC-09-S8)', () => {
  it('throws PinnedSetExceedsBudget naming the node, the pinned total and the adapter', async () => {
    const pinned = await buildPinnedSegments({
      spec: approvedSpec(),
      node: NODE,
      sourceEvent: SOURCE,
    });
    const pinnedTokens = pinned.reduce((sum, segment) => sum + segment.tokens.estimated, 0);
    const packet = packetOf(pinned, Math.floor(pinnedTokens / 2));

    expect(() => {
      assertPinnedSetFitsBudget(packet);
    }).toThrow(PinnedSetExceedsBudget);

    let thrown: PinnedSetExceedsBudget | null = null;
    try {
      assertPinnedSetFitsBudget(packet);
    } catch (error) {
      thrown = error as PinnedSetExceedsBudget;
    }

    expect(thrown?.node).toBe('implement');
    expect(thrown?.pinnedTokens).toBe(pinnedTokens);
    expect(thrown?.limitTokens).toBe(Math.floor(pinnedTokens / 2));
    expect(thrown?.message).toContain('implement');
    expect(thrown?.message).toContain(String(pinnedTokens));
    // The operator-facing message says which adapter's window is too small.
    expect(thrown?.message).toContain('claude-code');
    expect(thrown?.message).toContain('200000');
    expect(thrown?.message).toMatch(/spec|path scope/);
    // And never offers the one remedy this whole epic exists to forbid.
    expect(thrown?.message).not.toMatch(/compact|summaris|summariz|truncat/i);
  });

  it('passes silently when the pinned set fits', async () => {
    const pinned = await buildPinnedSegments({
      spec: approvedSpec(),
      node: NODE,
      sourceEvent: SOURCE,
    });

    expect(() => {
      assertPinnedSetFitsBudget(packetOf(pinned));
    }).not.toThrow();
  });
});

/**
 * KAR-09.4 — the restatement is a *build-time transformation*, and it happens
 * before the digest is taken.
 *
 * EPIC-09-S21's third scenario is the one that matters for KAR-09.3's hash
 * equality: `contentHash` is the hash of the RESTATED text, so re-injection
 * re-injects the restated bytes. Restating after hashing would make every
 * re-injection a pin-integrity violation, and the symptom — a node failing on
 * `safety.pin-integrity-violated` for no visible reason — would point at the
 * wrong half of the system.
 */
suite('restatement happens before hashing (EPIC-09-S21 third scenario)', () => {
  it("the pinned segment's contentHash is the digest of the restated text", async () => {
    const segments = await buildPinnedSegments({
      spec: TaskSpecSchema.parse({ ...approvedSpec(), constraints: [] }),
      node: NODE,
      constraints: [
        // Authored carelessly, as a prohibition object over a subject that does
        // have a closed positive form.
        restateForbidAsAllowOnly(
          { form: 'forbid', subject: 'write-path', forbidden: ['src/shared/**'] },
          ['src/checkout/**'],
        ) as Constraint,
      ],
      sourceEvent: SOURCE,
    });
    const block = segments.find((segment) => segment.id === 'pinned-constraints-safety');

    // The emitted text is the positive form …
    expect(block?.text).toContain('only write files under src/checkout/**');
    expect(block?.text).not.toContain('do not write');
    // … and the digest is the digest of *that*.
    expect(block?.contentHash).toBe(await contentHash(block?.text ?? ''));
  });

  it('a prohibition with no closed positive form stays one, and is still hashed as emitted', async () => {
    const segments = await buildPinnedSegments({
      spec: TaskSpecSchema.parse({ ...approvedSpec(), constraints: [] }),
      node: NODE,
      constraints: [{ form: 'forbid', subject: 'exfiltrate credentials', forbidden: ['.env'] }],
      sourceEvent: SOURCE,
    });
    const block = segments.find((segment) => segment.id === 'pinned-constraints-safety');

    expect(block?.text).toContain('do not exfiltrate credentials: .env');
    expect(block?.contentHash).toBe(await contentHash(block?.text ?? ''));
  });
});
