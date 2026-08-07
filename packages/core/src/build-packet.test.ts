/**
 * KAR-09.2 — packet assembly under a token budget.
 *
 * The fixtures are sized in tokens rather than in prose because every
 * assertion here is arithmetic over the budget: `heuristicTokens` is exactly
 * four characters per token, so `'x'.repeat(4 * n)` is `n` tokens and the
 * ladder's decisions are checkable by hand.
 *
 * Verifies: EPIC-09-S6, EPIC-09-S7, EPIC-09-S8, EPIC-09-S9, EPIC-09-S11,
 * EPIC-09-S12, EPIC-09-S28 · AC1-AC9 · test plan #1-#8
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import {
  BUDGET_FRACTION_CEILING,
  BUDGET_FRACTION_DEFAULT,
  buildPacket,
  FILL_ORDER,
  type PacketBuildInput,
  resolveContextBudget,
} from './build-packet.ts';
import { packetTotalsAreConsistent, type Segment } from './context-packet.ts';
import { contentHash } from './hash.ts';
import { type EventSeq, EventSeqSchema } from './ids.ts';
import {
  contextSegment,
  heuristicTokens,
  PINNED_CONTENT_TYPES,
  PinnedSetExceedsBudget,
  type UnpinnedSegmentKind,
} from './pinned-set.ts';
import { renderPacket } from './render-packet.ts';
import { type TaskSpec, TaskSpecSchema } from './task-spec.ts';

const fixturePath = fileURLToPath(
  new URL('../test/fixtures/specs/vue3-migration.json', import.meta.url),
);
const baseSpec: Record<string, unknown> = JSON.parse(readFileSync(fixturePath, 'utf8'));

/** EPIC-09-S6's background spec, approved. `goalPadTokens` inflates the goal
 * when a scenario needs a pinned set of a particular size (EPIC-09-S8). */
function approvedSpec(goalPadTokens = 0): TaskSpec {
  const draft = structuredClone(baseSpec);
  draft.nonGoals = ['Rewriting the payment gateway integration', 'Touching the pricing service'];
  draft.constraints = [
    'must not change the public API of @voyado/ui',
    'must not run database migrations',
  ];
  if (goalPadTokens > 0) draft.goal = `${String(draft.goal)} ${'x'.repeat(goalPadTokens * 4)}`;
  draft.approvedBy = { at: '2026-08-06T09:00:00Z', via: 'ui' };
  return TaskSpecSchema.parse(draft);
}

const seq = (value: number): EventSeq => EventSeqSchema.parse(value);

/** A non-pinned segment of exactly `tokens` tokens. */
async function sized(
  id: string,
  kind: UnpinnedSegmentKind,
  tokens: number,
  at = 20,
): Promise<Segment> {
  const label = `${id}: `;
  return contextSegment({
    id,
    kind,
    text: label + 'x'.repeat(tokens * 4 - label.length),
    sourceEvent: seq(at),
  });
}

/**
 * EPIC-09-S6's background: an `implement` node at `worktree` permission with a
 * write scope, against an adapter declaring `maxContext` 200000.
 */
function input(overrides: Partial<PacketBuildInput> = {}): PacketBuildInput {
  return {
    runId: 'run_20260806T090000Z_5c1d2e',
    nodeId: 'implement',
    attempt: 0,
    builtAtEvent: seq(60),
    target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 200_000 },
    pinned: {
      spec: approvedSpec(),
      node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
      sourceEvent: seq(9),
    },
    segments: [],
    ...overrides,
  };
}

const kindsOf = (segments: readonly Segment[]): string[] => segments.map((s) => s.kind);

const sum = (segments: readonly Segment[]): number =>
  segments.reduce((total, s) => total + s.tokens.estimated, 0);

/** The `PinnedSetExceedsBudget` a build refused with. Throws if it resolved:
 * a passing build is the failure these scenarios are about. */
async function refusal(build: Promise<unknown>): Promise<PinnedSetExceedsBudget> {
  try {
    await build;
  } catch (thrown) {
    if (thrown instanceof PinnedSetExceedsBudget) return thrown;
    throw thrown;
  }
  throw new Error('the build produced a packet instead of refusing an unbudgetable pinned set');
}

/* -------------------------------------------------------------------------- *
 * EPIC-09-S6 — fill order, addressability, and the golden packet
 * -------------------------------------------------------------------------- */

suite('the documented fill order (EPIC-09-S6, AC1)', () => {
  it('assembles pinned first, then task brief, declared reads, retrieved, artifact handles', async () => {
    const { packet } = await buildPacket(
      input({
        // Deliberately shuffled: an implementation that preserved insertion
        // order would pass a fixture handed to it in the right order, and the
        // failure it hides — an artifact handle rendered ahead of the brief —
        // is invisible afterwards.
        segments: [
          await sized('diff-handle', 'artifact.handle', 30, 24),
          await sized('recall', 'retrieved', 40, 23),
          await sized('brief', 'task.brief', 50, 21),
          await sized('finding', 'fact', 60, 22),
        ],
      }),
    );

    // The pinned block leads, in §4.1's order — which EPIC-09-S14 fixes as a
    // closed five-row table and is therefore what the pinned prefix looks
    // like. EPIC-09-S6's three `pinned.*` rows name the kinds present, not a
    // reordering of that table.
    expect(kindsOf(packet.segments).slice(0, PINNED_CONTENT_TYPES.length)).toEqual(
      PINNED_CONTENT_TYPES.map((type) => type.kind),
    );
    expect(kindsOf(packet.segments).slice(PINNED_CONTENT_TYPES.length)).toEqual([
      'task.brief',
      'fact',
      'retrieved',
      'artifact.handle',
    ]);
    expect(packet.segments[0]?.pinned).toBe(true);
  });

  it('orders every unpinned kind by the declared fill order, whatever order it was handed', async () => {
    const shuffled: Segment[] = [];
    for (const [index, kind] of [...FILL_ORDER].reverse().entries()) {
      shuffled.push(await sized(`seg-${index}`, kind, 10, 21 + index));
    }

    const { packet } = await buildPacket(input({ segments: shuffled }));

    expect(kindsOf(packet.segments).slice(PINNED_CONTENT_TYPES.length)).toEqual([...FILL_ORDER]);
  });

  it('sums totals.byKind exactly to totals.tokens', async () => {
    const { packet } = await buildPacket(
      input({
        segments: [
          await sized('brief', 'task.brief', 50, 21),
          await sized('finding', 'fact', 60, 22),
          await sized('recall', 'retrieved', 40, 23),
        ],
      }),
    );

    expect(packetTotalsAreConsistent(packet)).toEqual({ consistent: true });
    expect(packet.totals.tokens).toBe(sum(packet.segments));
  });

  it('makes every segment addressable and attributable (AC2)', async () => {
    const { packet } = await buildPacket(
      input({ segments: [await sized('brief', 'task.brief', 50, 21)] }),
    );

    for (const segment of packet.segments) {
      expect(segment.id.length).toBeGreaterThan(0);
      expect(segment.sourceEvent).toBeGreaterThan(0);
      expect(segment.contentHash).toBe(await contentHash(segment.text));
      expect(segment.tokens.method).toBe('heuristic');
      if (segment.pinned) expect(segment.compactable).toBe(false);
    }
    expect(packet.pinnedDigests).toEqual(
      packet.segments.filter((s) => s.pinned).map((s) => s.contentHash),
    );
  });

  it('refuses a segment whose contentHash does not match its text (AC2)', async () => {
    const brief = await sized('brief', 'task.brief', 50, 21);
    const doctored: Segment = { ...brief, contentHash: `sha256-${'0'.repeat(64)}` };

    await expect(buildPacket(input({ segments: [doctored] }))).rejects.toThrow(/contentHash/);
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-09-S9 — the budget ceiling
 * -------------------------------------------------------------------------- */

suite('the budget ceiling (EPIC-09-S9, AC3)', () => {
  const CASES = [
    { configured: undefined, effective: 0.5, limit: 100_000, warned: false },
    { configured: 0.4, effective: 0.4, limit: 80_000, warned: false },
    { configured: 0.6, effective: 0.6, limit: 120_000, warned: false },
    { configured: 0.75, effective: 0.6, limit: 120_000, warned: true },
    { configured: 1, effective: 0.6, limit: 120_000, warned: true },
  ] as const;

  for (const testCase of CASES) {
    it(`resolves a configured ${String(testCase.configured)} to ${testCase.effective}`, () => {
      const resolved = resolveContextBudget({
        maxContext: 200_000,
        ...(testCase.configured === undefined ? {} : { configuredFraction: testCase.configured }),
      });

      expect(resolved.budget.fraction).toBe(testCase.effective);
      expect(resolved.budget.limitTokens).toBe(testCase.limit);
      expect(resolved.warning === null).toBe(!testCase.warned);
      if (testCase.warned) expect(resolved.warning).toContain(String(testCase.configured));
    });
  }

  it('states the default and the ceiling as constants rather than as literals', () => {
    expect(BUDGET_FRACTION_DEFAULT).toBe(0.5);
    expect(BUDGET_FRACTION_CEILING).toBe(0.6);
  });

  it('carries the clamp warning out of buildPacket rather than swallowing it', async () => {
    const { packet, warnings } = await buildPacket(
      input({ configuredFraction: 0.75, segments: [await sized('brief', 'task.brief', 10, 21)] }),
    );

    expect(packet.budget.fraction).toBe(0.6);
    expect(warnings.join('\n')).toContain('0.75');
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-09-S7 — offload, don't summarise
 * -------------------------------------------------------------------------- */

/** EPIC-09-S7's assembled packet, minus the pinned block the real spec
 * contributes. */
async function overBudgetSegments(): Promise<Segment[]> {
  return [
    await sized('brief', 'task.brief', 500, 21),
    await sized('big-log', 'tool.output', 40_000, 22),
    await sized('small-log', 'tool.output', 6000, 23),
    await sized('recall', 'retrieved', 8000, 24),
    await sized('finding', 'fact', 2000, 25),
  ];
}

suite('demotion order, largest tool.output first (EPIC-09-S7, AC4)', () => {
  it('demotes the 40000-token tool.output and stops as soon as the packet fits', async () => {
    // maxContext 40000 at the default 0.5 is EPIC-09-S7's limitTokens of 20000.
    const { packet, demotion } = await buildPacket(
      input({
        target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 40_000 },
        segments: await overBudgetSegments(),
      }),
    );

    expect(packet.budget.limitTokens).toBe(20_000);
    expect(demotion.droppedSegments.map(String)).toEqual(['big-log']);
    expect(packet.totals.tokens).toBeLessThanOrEqual(20_000);

    const byId = new Map(packet.segments.map((s) => [String(s.id), s]));
    expect(byId.get('big-log')?.kind).toBe('artifact.handle');
    expect(byId.get('small-log')?.kind).toBe('tool.output');
    expect(byId.get('recall')?.tokens.estimated).toBe(8000);
    expect(byId.get('finding')?.tokens.estimated).toBe(2000);
  });

  it('walks the ladder in order: largest tool.output, second tool.output, retrieved, fact, handle', async () => {
    const segments = [
      ...(await overBudgetSegments()),
      await sized('inlined-artifact', 'artifact.handle', 1000, 26),
    ];
    const { packet, demotion } = await buildPacket(
      input({
        target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 12_000 },
        segments,
      }),
    );

    // The ladder is the order the pass *offered* segments, recorded whether or
    // not it got that far — "demotion stops as soon as the packet fits" is only
    // checkable against the order it would have continued in.
    expect(demotion.ladder.map(String)).toEqual([
      'big-log',
      'small-log',
      'recall',
      'finding',
      'inlined-artifact',
    ]);
    // No pinned segment appears in the demotion list, at any rung.
    const pinnedIds = new Set(packet.segments.filter((s) => s.pinned).map((s) => s.id));
    expect(demotion.ladder.some((id) => pinnedIds.has(id))).toBe(false);
    expect(demotion.ladder.slice(0, demotion.droppedSegments.length).map(String)).toEqual(
      demotion.droppedSegments.map(String),
    );
  });

  it('records what it demoted rather than leaving it to be inferred', async () => {
    const { packet, demotion } = await buildPacket(
      input({
        target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 12_000 },
        segments: await overBudgetSegments(),
      }),
    );

    expect(demotion.demotedToHandles.length).toBe(demotion.droppedSegments.length);
    expect(demotion.before).toBeGreaterThan(demotion.after);
    expect(demotion.after).toBe(packet.totals.tokens);
    expect(demotion.fits).toBe(true);
    // A handle is lossless: it addresses the exact bytes that left the packet.
    const original = (await overBudgetSegments()).find((s) => s.id === 'big-log');
    expect(demotion.demotedToHandles).toContain(
      `artifact://${(original?.contentHash ?? '').slice('sha256-'.length)}`,
    );
  });

  it('renders the demoted body as a handle the agent can pull, not as a summary', async () => {
    const { packet } = await buildPacket(
      input({
        target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 40_000 },
        segments: await overBudgetSegments(),
      }),
    );

    const stub = packet.segments.find((s) => s.id === 'big-log');
    expect(stub?.text).toContain('artifact://');
    expect(stub?.text).toContain('DeFlow_read_artifact');
    expect(stub?.compactable).toBe(false);
    expect(stub?.tokens.estimated).toBeLessThan(200);
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-09-S8 — an unbudgetable pinned set is a plan error
 * -------------------------------------------------------------------------- */

suite('an unbudgetable pinned set (EPIC-09-S8, AC6)', () => {
  it('throws PinnedSetExceedsBudget naming the node and the pinned total, and builds nothing', async () => {
    const build = buildPacket(
      input({
        // 8000 padding tokens on the goal puts the pinned block well over a
        // 4000-token budget on its own.
        pinned: {
          spec: approvedSpec(8000),
          node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
          sourceEvent: seq(9),
        },
        target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 8000 },
        segments: [await sized('brief', 'task.brief', 10, 21)],
      }),
    );

    await expect(build).rejects.toThrow(PinnedSetExceedsBudget);
    const error = await refusal(build);
    expect(error.node).toBe('implement');
    expect(error.limitTokens).toBe(4000);
    expect(error.pinnedTokens).toBeGreaterThan(4000);
    expect(error.message).toContain('implement');
    expect(error.message).toContain(String(error.pinnedTokens));
  });

  it('does not offer compaction, summarisation or truncation as the remedy', async () => {
    const error = await refusal(
      buildPacket(
        input({
          pinned: {
            spec: approvedSpec(8000),
            node: { pathScopes: [], permission: 'read' },
            sourceEvent: seq(9),
          },
          target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 8000 },
        }),
      ),
    );

    expect(error.message).toMatch(/claude-code/);
    expect(error.message).toMatch(/8000/);
    expect(error.message.toLowerCase()).not.toMatch(/compact|summaris|summariz|truncat/);
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-09-S28 — demotion never summarises
 * -------------------------------------------------------------------------- */

suite('demotion never summarises (EPIC-09-S28, AC5)', () => {
  it('completes a 5x-over-budget build of six oversized bodies without touching a provider', async () => {
    // Any property read on this object throws. `buildPacket` takes no
    // provider parameter at all, so the only way it could reach one is
    // through an ambient import — which the structural guard in
    // test/demotion-has-no-provider-dependency.test.ts also rules out.
    const provider = new Proxy(
      {},
      {
        get: (_target, key) => {
          throw new Error(`the demotion path called the provider (${String(key)})`);
        },
      },
    );

    const segments: Segment[] = [];
    for (let index = 0; index < 6; index += 1) {
      segments.push(await sized(`body-${index}`, 'tool.output', 10_000, 21 + index));
    }
    const { packet, demotion } = await buildPacket(
      input({
        target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 24_000 },
        segments,
      }),
    );

    expect(demotion.fits).toBe(true);
    expect(packet.totals.tokens).toBeLessThanOrEqual(12_000);
    expect(packet.segments.some((s) => s.kind === 'history.summary')).toBe(false);
    expect(Object.keys(provider)).toEqual([]);
  });

  it('produces no history.summary for a node that is not a declared continuation', async () => {
    const { packet } = await buildPacket(
      input({
        target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 8000 },
        segments: [
          await sized('finding', 'fact', 3000, 21),
          await sized('recall', 'retrieved', 3000, 22),
          await sized('log', 'tool.output', 3000, 23),
        ],
      }),
    );

    for (const segment of packet.segments) expect(segment.kind).not.toBe('history.summary');
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-09-S11 — render is pure, total and order-stable
 * -------------------------------------------------------------------------- */

suite('render is pure and order-stable (EPIC-09-S11, AC7)', () => {
  it('returns one distinct string across 50 calls', async () => {
    const { packet } = await buildPacket(
      input({
        segments: [
          await sized('brief', 'task.brief', 50, 21),
          await sized('finding', 'fact', 60, 22),
          await sized('recall', 'retrieved', 40, 23),
        ],
      }),
    );

    const renders = new Set(Array.from({ length: 50 }, () => renderPacket(packet)));

    expect(renders.size).toBe(1);
  });

  it('completes with Date and Math.random replaced by throwing stubs', async () => {
    const { packet } = await buildPacket(
      input({ segments: [await sized('brief', 'task.brief', 20, 21)] }),
    );
    // Reached through a reference rather than written as `Math.random`, which
    // the lint rule bans outright — what this asserts is the opposite of using
    // it: that `render()` never reads it.
    const mathGlobal: { random: () => number } = Math;
    const realDate = globalThis.Date;
    const realRandom = mathGlobal.random;
    const boom = (): never => {
      throw new Error('render read an ambient dependency');
    };

    try {
      globalThis.Date = boom as unknown as DateConstructor;
      mathGlobal.random = boom;
      expect(renderPacket(packet).length).toBeGreaterThan(0);
    } finally {
      globalThis.Date = realDate;
      mathGlobal.random = realRandom;
    }
  });

  it('puts the rendered prompt behind a handle derived from the bytes themselves', async () => {
    const { packet } = await buildPacket(
      input({ segments: [await sized('brief', 'task.brief', 20, 21)] }),
    );

    const expected = (await contentHash(renderPacket(packet))).slice('sha256-'.length);
    expect(packet.renderedPromptHandle).toBe(`artifact://${expected}`);
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-09-S12 — a history.summary sits where the turns it replaced sat
 * -------------------------------------------------------------------------- */

suite('ordered interleaving of summaries (EPIC-09-S12, AC8)', () => {
  it('renders the summary after segment 2 and before segment 6', async () => {
    const surviving: Segment[] = [];
    for (const index of [1, 2, 6, 7, 8]) {
      surviving.push(await sized(`turn-${index}`, 'tool.output', 20, 20 + index));
    }
    // Segments 3-5 are replaced by one summary carrying the sourceEvent of the
    // first turn it replaced — that is what "the chronological position of
    // what it replaced" is, expressed as data rather than as a render rule.
    const summary = await contextSegment({
      id: 'history-3-5',
      kind: 'history.summary',
      text: 'Turns 3-5 summarised: the codemod ran and two tests failed.',
      sourceEvent: seq(23),
    });

    const { packet } = await buildPacket(input({ segments: [...surviving, summary] }));
    const rendered = renderPacket(packet);

    const at = (id: string): number => {
      const segment = packet.segments.find((s) => s.id === id);
      return rendered.indexOf(segment?.text ?? ' ');
    };
    expect(at('turn-2')).toBeLessThan(at('history-3-5'));
    expect(at('history-3-5')).toBeLessThan(at('turn-6'));
    // Not hoisted into a preamble either: the pinned block still leads.
    expect(at('history-3-5')).toBeGreaterThan(at(packet.segments[0]?.id ?? ''));
  });

  it('leaves fact, retrieved and tool.output segments alone', async () => {
    const { packet } = await buildPacket(
      input({
        segments: [
          await sized('finding', 'fact', 20, 21),
          await sized('recall', 'retrieved', 20, 22),
          await sized('log', 'tool.output', 20, 23),
        ],
      }),
    );

    for (const id of ['finding', 'recall', 'log']) {
      expect(packet.segments.find((s) => s.id === id)?.kind).not.toBe('history.summary');
    }
  });
});

/* -------------------------------------------------------------------------- *
 * Golden packets, one per node archetype (test plan #1, #2)
 * -------------------------------------------------------------------------- */

const ARCHETYPES = {
  recon: {
    node: { pathScopes: [], permission: 'read' },
    segments: [
      { id: 'brief', kind: 'task.brief', text: 'Map the checkout module.', at: 10 },
      { id: 'recall', kind: 'retrieved', text: 'ADR-0010: ESM only.', at: 11 },
    ],
  },
  implement: {
    node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
    segments: [
      { id: 'brief', kind: 'task.brief', text: 'Port CheckoutForm to <script setup>.', at: 20 },
      { id: 'finding', kind: 'fact', text: 'finding/auth-uses-jwt = true', at: 21 },
      { id: 'log', kind: 'tool.output', text: 'vitest: 12 passed', at: 22 },
    ],
  },
  gate: {
    node: { pathScopes: [], permission: 'read' },
    segments: [
      { id: 'brief', kind: 'task.brief', text: 'Judge criterion no-v-model-regression.', at: 30 },
      {
        id: 'diff',
        kind: 'artifact.handle',
        text: 'artifact://deadbeef - diff, 412 lines',
        at: 31,
      },
    ],
  },
  human: {
    node: { pathScopes: [], permission: 'read' },
    segments: [
      { id: 'brief', kind: 'task.brief', text: 'Summarise the change for approval.', at: 40 },
      { id: 'summary', kind: 'history.summary', text: 'Turns 1-9 summarised.', at: 41 },
    ],
  },
  'map-child': {
    node: { pathScopes: ['src/checkout/steps/**'], permission: 'worktree' },
    segments: [
      { id: 'brief', kind: 'task.brief', text: 'Port one step component.', at: 50 },
      { id: 'shard', kind: 'fact', text: 'shard = steps/Address.vue', at: 51 },
    ],
  },
} as const;

type ArchetypeName = keyof typeof ARCHETYPES;

const ARCHETYPE_NAMES = Object.keys(ARCHETYPES) as readonly ArchetypeName[];

suite('golden packets per node archetype (EPIC-09-S6, test plan #1, #2)', () => {
  it('matches the committed snapshot, with a pinned segment first in every one', async () => {
    const golden: Record<string, unknown> = {};
    for (const name of ARCHETYPE_NAMES) {
      const archetype = ARCHETYPES[name];
      const segments: Segment[] = [];
      for (const declared of archetype.segments) {
        segments.push(
          await contextSegment({
            id: declared.id,
            kind: declared.kind,
            text: declared.text,
            sourceEvent: seq(declared.at),
          }),
        );
      }
      const { packet } = await buildPacket(
        input({
          nodeId: name,
          pinned: { spec: approvedSpec(), node: archetype.node, sourceEvent: seq(9) },
          segments,
        }),
      );

      expect(packet.segments[0]?.pinned).toBe(true);
      golden[name] = {
        kinds: kindsOf(packet.segments),
        totals: packet.totals,
        prompt: renderPacket(packet),
      };
    }

    expect(golden).toMatchSnapshot();
  });
});

suite('the estimator is a port, not a call (AC2)', () => {
  it('labels every segment with the injected estimator method', async () => {
    const { packet } = await buildPacket(
      input({
        estimate: (text) => ({ estimated: text.length, method: 'gpt-tokenizer/o200k_base' }),
        segments: [await sized('brief', 'task.brief', 20, 21)],
      }),
    );

    for (const segment of packet.segments) {
      expect(segment.tokens.method).toBe('gpt-tokenizer/o200k_base');
    }
    // The caller's pre-built segments are re-measured through the same port,
    // so one packet never mixes two tiers (§7).
    expect(heuristicTokens('abcd').method).toBe('heuristic');
  });
});

/* -------------------------------------------------------------------------- *
 * KAR-09.4
 * -------------------------------------------------------------------------- */

suite('the build counts what it pinned (AC4, EPIC-09-S22, test plan #4)', () => {
  it('reports every constraint form, spec prose folded in as require', async () => {
    // The fixture spec carries two prose constraints, which are `require`.
    const build = await buildPacket(
      input({
        pinned: {
          spec: approvedSpec(),
          node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
          sourceEvent: seq(9),
          constraints: [
            { form: 'allow-only', subject: 'write-path', allowed: ['src/checkout/**'] },
            { form: 'allow-only', subject: 'branch', allowed: ['DeFlow/r1__implement'] },
            { form: 'allow-only', subject: 'command', allowed: ['pnpm test'] },
            { form: 'forbid', subject: 'exfiltrate credentials', forbidden: ['.env'] },
          ],
        },
      }),
    );

    expect(build.constraints).toEqual({ allowOnly: 3, require: 2, forbid: 1 });
  });

  it('is zero for every form when nothing was declared', async () => {
    const spec = TaskSpecSchema.parse({ ...approvedSpec(), constraints: [] });
    const build = await buildPacket(
      input({
        pinned: {
          spec,
          node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
          sourceEvent: seq(9),
        },
      }),
    );

    expect(build.constraints).toEqual({ allowOnly: 0, require: 0, forbid: 0 });
  });

  it('renders the forbid last in the pinned block whatever order it was authored in (AC3)', async () => {
    const build = await buildPacket(
      input({
        pinned: {
          spec: TaskSpecSchema.parse({ ...approvedSpec(), constraints: [] }),
          node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
          sourceEvent: seq(9),
          constraints: [
            { form: 'forbid', subject: 'exfiltrate credentials', forbidden: ['.env'] },
            { form: 'allow-only', subject: 'write-path', allowed: ['src/checkout/**'] },
            {
              form: 'require',
              statement: 'stop after at most 3 fix attempts and escalate to a human',
            },
          ],
        },
      }),
    );
    const block = build.packet.segments.find(
      (segment) => segment.id === 'pinned-constraints-safety',
    );

    const lines = (block?.text ?? '').split('\n');
    expect(lines.at(-1)).toBe('- do not exfiltrate credentials: .env');
    expect(lines).toContain('- only write files under src/checkout/**');
  });
});

suite('the AC6 planning warning (EPIC-09-S24)', () => {
  const reinjection = { pinReinjectTurns: 8, expectedTurns: 30 };

  it('warns exactly once when the adapter cannot be steered', async () => {
    const build = await buildPacket(input({ reinjection: { ...reinjection, steering: false } }));

    const warnings = build.warnings.filter((warning) => warning.includes('re-injection'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('implement');
    expect(warnings[0]).toContain('30');
  });

  it('does not warn where the adapter advertises mid-session steering', async () => {
    const build = await buildPacket(input({ reinjection: { ...reinjection, steering: true } }));

    expect(build.warnings).toEqual([]);
  });

  it('warns for an unadvertised capability exactly as for a refused one', async () => {
    const build = await buildPacket(
      input({ reinjection: { ...reinjection, steering: undefined } }),
    );

    expect(build.warnings.filter((warning) => warning.includes('re-injection'))).toHaveLength(1);
  });

  it('says nothing when the node is expected to stay inside the interval', async () => {
    const build = await buildPacket(
      input({ reinjection: { pinReinjectTurns: 8, expectedTurns: 5, steering: false } }),
    );

    expect(build.warnings).toEqual([]);
  });
});
