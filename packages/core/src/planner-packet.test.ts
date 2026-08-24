/**
 * KAR-10.5 AC7 — the planner reads facts, never a recon transcript.
 *
 * F6.1's rule is *"do not let the planner see another node's transcript"*
 * (docs/06-planning-and-replanning.md §8), and the recon session is the place
 * it is most tempting to break: the transcript is right there and it looks like
 * free context. So the allowlist is structural in the same way
 * `buildFramingPacket`'s is — `history.summary` is not a kind a planner packet
 * has, and a caller that supplies one is refused rather than quietly filtered.
 *
 * The golden snapshot of a whole planner packet built from real recon facts is
 * `packages/daemon/test/integration/recon-survey.test.ts`; these are the rules
 * that hold with no ledger in sight.
 *
 * Verifies: EPIC-10-S24 (second scenario), EPIC-10-S28 (third scenario) · AC7
 */
import { expect, it, describe as suite } from 'vitest';
import { contextSegment } from './pinned-set.ts';
import type { NodeType, ToolKind } from './plan-graph.ts';
import {
  buildPlannerPacket,
  CAPABILITY_SEGMENT_ID,
  ForeignSegmentInPlannerPacket,
  PLAN_RULES_SEGMENT_ID,
  PLANNER_SEGMENT_KINDS,
  type PlannerCapability,
} from './planner-packet.ts';
import { type TaskSpec, TaskSpecSchema } from './task-spec.ts';

const SPEC: TaskSpec = TaskSpecSchema.parse({
  schemaId: 'DeFlow.taskspec.v1',
  goal: 'Migrate every component under packages/ui to Vue 3.',
  scope: { included: ['packages/ui'] },
  nonGoals: ['Do not touch packages/legacy.'],
  constraints: ['No new runtime dependency.'],
  priorDecisions: [],
  acceptanceCriteria: [{ id: 'ac-1', statement: 'pnpm typecheck passes.' }],
  knownFailureModes: [],
  approvedBy: { at: '2026-08-07T10:15:00.000Z', via: 'ui' },
  specHash: `sha256-${'1'.repeat(64)}`,
});

/** Two probed rows, in the shape the daemon reads them out of
 * `provider_capabilities` — never a constant keyed by provider name. */
const CAPABILITIES: readonly PlannerCapability[] = [
  {
    provider: 'claude',
    version: '2.1.220',
    structuredOutput: 'native',
    strongestEffort: 'max',
    answers: [
      { key: 'resume', supported: true, reason: 'capability-granted' },
      { key: 'mediatedExecution', supported: undefined, reason: 'capability-absent' },
    ],
    sourceEvent: 7,
  },
  {
    provider: 'opencode',
    version: '1.18.11',
    structuredOutput: 'prompt-only',
    strongestEffort: null,
    answers: [{ key: 'resume', supported: true, reason: 'capability-granted' }],
    sourceEvent: 8,
  },
];

const input = () => ({
  runId: 'run_20260807T101500Z_ac1005',
  nodeId: 'planner',
  attempt: 0,
  builtAtEvent: 12,
  target: { provider: 'mock', model: 'mock-1', maxContext: 200_000 },
  spec: SPEC,
  capabilities: CAPABILITIES,
  // KAR-23.13 — required, for the same reason `capabilities` is: a packet
  // assembled without it teaches the planner about an imagined daemon.
  performable: { nodeTypes: ['agent', 'gate', 'tool'], toolKinds: ['script'] } as {
    readonly nodeTypes: readonly NodeType[];
    readonly toolKinds: readonly ToolKind[];
  },
  facts: [
    {
      key: 'finding/test-command',
      confidence: 'verified' as const,
      value: { reconKind: 'command', role: 'test', command: 'pnpm test', script: 'vitest run' },
      fromEvidence: ['file://package.json#L5-L5'],
      sourceEvent: 9,
    },
    {
      key: 'scope/touched-paths',
      confidence: 'verified' as const,
      value: { reconKind: 'scope', paths: ['packages/ui'], fileCount: 47 },
      fromEvidence: [`artifact://${'a'.repeat(64)}`],
      sourceEvent: 10,
    },
  ],
});

suite('the planner packet carries facts', () => {
  it('renders one fact segment per recon fact, with its key, confidence and evidence', async () => {
    const packet = await buildPlannerPacket(input());
    const facts = packet.segments.filter(
      (segment) => segment.kind === 'fact' && segment.id !== CAPABILITY_SEGMENT_ID,
    );

    expect(facts).toHaveLength(2);
    expect(facts[0]?.text).toContain('finding/test-command');
    expect(facts[0]?.text).toContain('verified');
    expect(facts[0]?.text).toContain('file://package.json#L5-L5');
    expect(facts[1]?.text).toContain('scope/touched-paths');
    // AC3 — the file count the patch policy's blastRadiusFiles reads.
    expect(facts[1]?.text).toContain('47');
    // Each fact's segment points back at the `fact.written` that put it there.
    expect(facts.map((segment) => segment.sourceEvent)).toEqual([9, 10]);
  });

  it('pins the approved spec first, as every other packet does', async () => {
    const packet = await buildPlannerPacket(input());
    expect(packet.segments[0]?.pinned).toBe(true);
    expect(packet.pinnedDigests.length).toBeGreaterThan(0);
  });
});

suite('EPIC-11-S2 — the third input: the capability list (KAR-11.1 AC1, AC2)', () => {
  const capabilitySegment = async (capabilities: readonly PlannerCapability[]) => {
    const packet = await buildPlannerPacket({ ...input(), capabilities });
    const segments = packet.segments.filter((entry) => entry.id === CAPABILITY_SEGMENT_ID);
    expect(segments).toHaveLength(1);
    return segments[0];
  };

  it('carries exactly one segment naming every probed provider and version', async () => {
    const segment = await capabilitySegment(CAPABILITIES);
    expect(segment?.text).toContain('claude 2.1.220');
    expect(segment?.text).toContain('opencode 1.18.11');
  });

  it('states the structured-output mechanism and the strongest effort per row', async () => {
    const segment = await capabilitySegment(CAPABILITIES);
    expect(segment?.text).toContain('native');
    expect(segment?.text).toContain('prompt-only');
    expect(segment?.text).toContain('max');
  });

  it('keeps absent apart from granted, because the probe does', async () => {
    const segment = await capabilitySegment(CAPABILITIES);
    expect(segment?.text).toContain('capability-absent');
    expect(segment?.text).toContain('capability-granted');
  });

  it('drops a provider when its row is gone — the list is materialised, not constant', async () => {
    const segment = await capabilitySegment([CAPABILITIES[0] as PlannerCapability]);
    expect(segment?.text).toContain('claude');
    expect(segment?.text).not.toContain('opencode');
  });

  it('says so rather than going missing when nothing has been probed', async () => {
    const segment = await capabilitySegment([]);
    expect(segment?.text).toContain('no provider has been probed');
  });

  it('points its provenance at the newest probe event it was built from', async () => {
    const segment = await capabilitySegment(CAPABILITIES);
    expect(segment?.sourceEvent).toBe(8);
  });

  it('is not pinned: a capability list is measured now, not approved once', async () => {
    const segment = await capabilitySegment(CAPABILITIES);
    expect(segment?.pinned).toBe(false);
  });
});

suite('AC1 — three input groups and the pinned safety segments, and nothing else', () => {
  it('has a pinned group, a recon-fact group, one capability segment and the rules', async () => {
    const packet = await buildPlannerPacket(input());
    const pinned = packet.segments.filter((entry) => entry.pinned);
    const facts = packet.segments.filter(
      (entry) => entry.kind === 'fact' && entry.id !== CAPABILITY_SEGMENT_ID,
    );
    const capabilities = packet.segments.filter((entry) => entry.id === CAPABILITY_SEGMENT_ID);
    // KAR-23.13's `plan-rules`: DeFlow's own instructions about the document
    // the planner is being asked to write. A fourth group, counted rather than
    // waved through, so a fifth cannot arrive unnoticed.
    const rules = packet.segments.filter((entry) => entry.id === PLAN_RULES_SEGMENT_ID);

    expect(pinned.length).toBeGreaterThan(0);
    expect(facts).toHaveLength(2);
    expect(capabilities).toHaveLength(1);
    expect(rules).toHaveLength(1);
    expect(pinned.length + facts.length + capabilities.length + rules.length).toBe(
      packet.segments.length,
    );
    expect(packet.totals.byKind['history.summary']).toBe(0);
  });
});

suite('EPIC-10-S28 — no recon transcript reaches the planner (AC7)', () => {
  it('has no history.summary in its vocabulary at all', () => {
    expect(PLANNER_SEGMENT_KINDS).not.toContain('history.summary');
  });

  it('refuses a supplied history.summary rather than dropping it', async () => {
    const transcript = await contextSegment({
      id: 'recon-transcript',
      kind: 'history.summary',
      text: 'The recon agent said: I looked at package.json and then…',
      sourceEvent: 11 as never,
    });

    await expect(buildPlannerPacket({ ...input(), segments: [transcript] })).rejects.toBeInstanceOf(
      ForeignSegmentInPlannerPacket,
    );
  });

  it('builds a packet whose rendered prompt holds no transcript text', async () => {
    const packet = await buildPlannerPacket(input());
    const rendered = packet.segments.map((segment) => segment.text).join('\n');
    expect(rendered).not.toContain('agent_message_chunk');
    expect(packet.segments.some((segment) => segment.kind === 'history.summary')).toBe(false);
  });
});

suite('KAR-23.13 — the rules DeFlow enforces, stated to the planner up front', () => {
  const rulesOf = async (over: Partial<ReturnType<typeof input>> = {}) => {
    const packet = await buildPlannerPacket({ ...input(), ...over });
    return packet.segments.find((segment) => segment.id === PLAN_RULES_SEGMENT_ID);
  };

  it('ships on attempt 0, which is the whole economic argument', async () => {
    // Three consecutive runs (MET-1007) had their *first* plan rejected by
    // validation, each costing one planner turn at maximum effort. A rule
    // carried only on the retry packet is a rule that arrives after it was
    // needed.
    const rules = await rulesOf({ attempt: 0 });
    expect(rules).toBeDefined();
    expect(rules?.kind).toBe('task.brief');
    expect(rules?.pinned).toBe(false);
  });

  it('sits after the pinned spec and before the facts', async () => {
    const packet = await buildPlannerPacket(input());
    const ids: string[] = packet.segments.map((segment) => segment.id as string);
    const pinnedLast = packet.segments.map((segment) => segment.pinned).lastIndexOf(true);
    const at = ids.indexOf(PLAN_RULES_SEGMENT_ID);

    expect(at).toBeGreaterThan(pinnedLast);
    expect(at).toBeLessThan(ids.indexOf(CAPABILITY_SEGMENT_ID));
  });

  it('names the performable node types and tool kinds it was given, not a literal', async () => {
    const rules = await rulesOf({ performable: { nodeTypes: ['agent'], toolKinds: ['mcp'] } });
    expect(rules?.text).toContain('agent');
    expect(rules?.text).toContain('mcp');
    expect(rules?.text).not.toContain('tool.kind must be script');
  });

  it('states the five rules this story exists for', async () => {
    const text = (await rulesOf())?.text ?? '';
    // Permission: the 2026-08-24 defect, stated positively.
    expect(text).toContain("'full' is not available to a tool node");
    expect(text).toContain('least level the work needs');
    // Kind.
    expect(text).toContain('tool.kind must be script');
    // The deny list.
    expect(text).toContain('terraform apply');
    // Node types.
    expect(text).toContain('agent, gate and tool');
    // The honesty rule Defect B enforces, as the plan-authoring rule that
    // keeps it off legitimately-empty nodes.
    expect(text).toContain('pathScopes.write: []');
  });
});
