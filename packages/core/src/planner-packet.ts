/**
 * KAR-10.5 AC7 — the planner's packet: the pinned spec and the recon **facts**,
 * and no session's transcript (F6.1, docs/06-planning-and-planning §8).
 *
 * > Do not let the planner see another node's transcript. It gets the spec, the
 * > recon output and the capability list.
 *
 * The recon transcript is the temptation this builder exists to remove. It is
 * right there when the planner is assembled, it reads fluently, and it looks
 * like free context — and a planner that reads it plans against a conversation
 * rather than against verified facts, which makes the edges in the plan graph
 * mean nothing. So `PLANNER_SEGMENT_KINDS` is an allowlist with no
 * `history.summary` in it, and a supplied segment outside the list is **refused
 * rather than dropped**: a dropped segment leaves a caller who still believes
 * the context arrived.
 *
 * A fact renders as its key, its `confidence`, its value and its evidence
 * handles. `confidence` is on the line rather than in a footnote because *"the
 * repo probably uses Pinia"* and *"`package.json` lists `pinia@3.0.4`"* must not
 * be indistinguishable to the model that plans from them.
 *
 * **The third input** (KAR-11.1 AC1, AC2). F2.2 names three planner inputs, and
 * the one people get wrong is the provider capability list: it is *materialised
 * from `provider_capabilities` rows at plan time*, never a constant keyed by
 * provider name — 06 §2.2 says a hardcoded matrix *"will be wrong within a
 * month"*, and the 2026-08-02 probe already contradicts the vendor docs in two
 * places. So `capabilities` is a **required** input here rather than an
 * optional one: a planner packet assembled without it is a planner planning
 * against an imagined fleet, and that must not be expressible.
 *
 * It renders as a `fact` segment rather than a kind of its own, and that is a
 * deliberate reading rather than a shortcut. `DeFlow.contextpacket.v1` is a
 * published, append-only document schema, and what this segment carries *is* a
 * set of measured facts about this machine, each traceable to the
 * `provider.probed` event that recorded the row it came from. It is not pinned:
 * the pinned set is what a human approved (F1.3), and nobody approved a probe.
 *
 * Verifies: EPIC-10-S24 (second scenario), EPIC-10-S28 (third scenario),
 * EPIC-11-S2 · AC7 · KAR-11.1 AC1, AC2
 */
import { resolveContextBudget } from './build-packet.ts';
import type { Constraint } from './constraint.ts';
import {
  type ContextPacket,
  ContextPacketSchema,
  SEGMENT_KINDS,
  type Segment,
  type SegmentKind,
} from './context-packet.ts';
import type { Confidence } from './fact.ts';
import { contentHash } from './hash.ts';
import { EventSeqSchema } from './ids.ts';
import {
  buildSpecPinnedSegments,
  contextSegment,
  heuristicTokens,
  type TokenEstimator,
} from './pinned-set.ts';
import type { NodeType, ToolKind } from './plan-graph.ts';
import { TOOL_KINDS } from './plan-graph.ts';
import { renderPacket } from './render-packet.ts';
import type { TaskSpec } from './task-spec.ts';

/**
 * Every segment kind a planner packet may carry.
 *
 * `history.summary` is absent, and that absence is the whole of AC7.
 * `tool.output` and `retrieved` are absent for the same reason: both are a
 * node's own working material, and the planner is not resuming a node.
 */
export const PLANNER_SEGMENT_KINDS = [
  'pinned.constraints',
  'pinned.spec',
  'task.brief',
  'fact',
  'artifact.handle',
] as const satisfies readonly SegmentKind[];

export type PlannerSegmentKind = (typeof PLANNER_SEGMENT_KINDS)[number];

/** A caller handing the planner a segment it may not carry. */
export class ForeignSegmentInPlannerPacket extends Error {
  readonly segment: string;
  readonly kind: string;

  constructor(id: string, kind: string) {
    super(
      `segment "${id}" is a ${kind} and the planner packet may only carry ` +
        `${PLANNER_SEGMENT_KINDS.join(', ')}. The planner reads the spec and the recon facts ` +
        '(F6.1): a recon transcript is right there and it looks like free context, which is ' +
        'exactly why it is refused here rather than filtered out somewhere downstream.',
    );
    this.name = 'ForeignSegmentInPlannerPacket';
    this.segment = id;
    this.kind = kind;
  }
}

/** One blackboard fact, at the shape the packet renders it from. */
export interface PlannerFact {
  readonly key: string;
  readonly confidence: Confidence;
  readonly value: unknown;
  readonly fromEvidence: readonly string[];
  /** The `fact.written` event that put it on the blackboard — never the
   * `fact.read` this packet's assembly appended (F6.2). */
  readonly sourceEvent: number;
}

/** The id of the one segment carrying the capability list, so the compiler,
 * the golden snapshot and the API all address it by the same name. */
export const CAPABILITY_SEGMENT_ID = 'capabilities';

/** The id of the segment carrying the rules validation will enforce. */
export const PLAN_RULES_SEGMENT_ID = 'plan-rules';

/** What the daemon about to run this plan can perform — the same shape
 * `validatePlan` takes, supplied from the same constant, so the packet cannot
 * promise something validation then refuses. */
export interface PlannerPerformableSet {
  readonly nodeTypes: readonly NodeType[];
  readonly toolKinds: readonly ToolKind[];
}

/**
 * KAR-23.13 — the rules DeFlow enforces on a plan **before** the run starts,
 * stated positively and shipped on attempt 0.
 *
 * The economics are the whole argument. Three consecutive runs (MET-1007) had
 * their first plan attempt rejected by validation — `CRITERION_UNCOVERED`,
 * `ORPHAN_WRITE` — and each rejection costs one planner turn at maximum
 * effort. `plannerDiagnosticsSegment` is the *reactive* half of §3.5 and
 * arrives one turn too late by construction; this is the same vocabulary said
 * up front, where it is free.
 *
 * A `task.brief` and unpinned, for the reason the diagnostics segment is one:
 * a fact is something DeFlow measured about the repository, and this is an
 * instruction about the document the planner is being asked to write. Nothing
 * here was approved by a human either, so pinning it would put DeFlow's own
 * house rules on the same footing as F1.3's approved spec.
 *
 * The node-type and tool-kind lists are **interpolated from `performable`**
 * rather than written out, so widening `PERFORMABLE_TOOL_KINDS` updates the
 * promise and the check together or neither.
 */
export function renderPlanRulesSegmentText(performable: PlannerPerformableSet): string {
  const types = [...performable.nodeTypes];
  const last = types.pop();
  const typeList = last === undefined ? 'no node type at all' : `${types.join(', ')} and ${last}`;
  const kinds = [...performable.toolKinds].join(', ');
  const only = performable.toolKinds.length === 1 ? kinds : `one of ${kinds}`;
  const unsupportedKinds = TOOL_KINDS.filter((kind) => !performable.toolKinds.includes(kind)).join(
    ' and ',
  );

  return [
    'Rules DeFlow enforces on this plan before the run starts. A plan that follows them validates',
    'on the first attempt; a plan that does not comes back to you as diagnostics and costs a turn.',
    '',
    `- Node types: this daemon can run ${typeList} nodes, and answers human nodes with a person.`,
    '  Any other node type has no performer and is refused.',
    "- Permission: ask for the least level the work needs — 'read' for a node that only reads,",
    "  'worktree' for one that edits files in its own worktree, 'worktree+net' when it must reach",
    "  the network. 'full' is not available to a tool node: full is not a sandbox, and no run-level",
    "  opt-in authorises it today, so a tool node at 'full' is refused at validation and never runs.",
    "  A branch, a checkout, an install or a build is 'worktree' work.",
    `- Tool nodes: tool.kind must be ${only}. A script node's run line is handed to /bin/sh -c`,
    "  inside the node's own worktree, as a single argument.",
    ...(unsupportedKinds === ''
      ? []
      : [
          `  Kinds ${unsupportedKinds} have no performer here — express the call as a script node,`,
          '  or plan the work as an agent node.',
        ]),
    '- A run line may not perform an infrastructure action: no terraform apply or destroy, no',
    '  kubectl delete or apply, no aws, gcloud or az at all, no git push --force, no migration',
    '  deploy. If the task genuinely needs one, plan a human node that asks for it rather than a',
    '  script that does it.',
    "- Write scopes: pathScopes.write is this node's promise that it changes files. A node that",
    '  finishes without changing anything inside its declared write scope is failed, not completed.',
    '  Give a node that only reads, reviews, verifies or returns a document pathScopes.write: [],',
    '  and give a node that does write the narrowest globs that cover what it will write.',
    '- Coverage: every acceptance criterion in the pinned spec must be named in the criteria of at',
    '  least one active gate node, or the plan is rejected as CRITERION_UNCOVERED.',
    '- Blackboard keys: every key a node writes should be read by a later node; a written key',
    '  nothing reads is reported as ORPHAN_WRITE.',
  ].join('\n');
}

/**
 * One capability question and what the probed row answered.
 *
 * `supported` is `boolean | undefined` and `reason` travels beside it because
 * 06 §2.2's whole finding is that **absent, `{}` and an explicit `false` are
 * three different answers**: Gemini returned no `sessionCapabilities` key at
 * all, Copilot returned `{ list: {} }`, and Codex returned literal `false`.
 * Flattening them into one falsy value is how a planner schedules a node onto
 * an adapter that cannot run it.
 */
export interface PlannerCapabilityAnswer {
  readonly key: string;
  /** `undefined` if and only if the key was absent from the response. */
  readonly supported: boolean | undefined;
  /** `capability-granted` | `capability-empty` | `capability-denied` |
   * `capability-absent`, as `@DeFlow/adapters`' `capability()` reports it. */
  readonly reason: string;
}

/**
 * What the planner is told about one installed, probed adapter.
 *
 * Assembled by the caller from `provider_capabilities` rows (the daemon reads
 * the table; `@DeFlow/core` performs no I/O, R1), so this package cannot hold a
 * capability table even by accident.
 */
export interface PlannerCapability {
  readonly provider: string;
  /** The binary's own `--version` output, as the probe recorded it. */
  readonly version: string;
  /** `native` when the CLI enforces a JSON Schema itself, `prompt-only` when
   * the contract holds only because Ajv rejects what comes back. Invocation
   * knowledge, not a probe answer — nothing in an ACP `initialize` response
   * advertises structured output. */
  readonly structuredOutput: string;
  /** The strongest reasoning-effort setting this adapter exposes, or `null`
   * where it exposes none (KAR-11.1 AC8). */
  readonly strongestEffort: string | null;
  readonly answers: readonly PlannerCapabilityAnswer[];
  /** The `provider.probed` event that recorded the row, so F10.3's
   * click-through from this segment lands somewhere real. */
  readonly sourceEvent: number;
}

/** One provider's line, and its answers underneath it. */
function renderCapabilityLines(capability: PlannerCapability): readonly string[] {
  const effort =
    capability.strongestEffort === null
      ? 'no reasoning-effort control'
      : `strongest effort: ${capability.strongestEffort}`;
  return [
    `${capability.provider} ${capability.version} — structured output: ` +
      `${capability.structuredOutput}, ${effort}`,
    ...capability.answers.map((answer) => `  ${answer.key}: ${answer.reason}`),
  ];
}

/**
 * The capability list as the planner reads it.
 *
 * An empty list renders as a sentence rather than as nothing, because "no
 * provider has been probed" is a fact the planner must plan around — a missing
 * segment would read as "the list was not assembled", which is a different
 * situation with a different fix.
 */
export function renderCapabilitySegmentText(capabilities: readonly PlannerCapability[]): string {
  if (capabilities.length === 0) {
    return (
      'no provider has been probed on this machine, so no adapter may be named in the plan: ' +
      'DeFlow never believes a documentation claim over a handshake.'
    );
  }
  return [
    'Installed, probed adapters — read from provider_capabilities, not from a table in the code:',
    ...capabilities.flatMap((capability) => renderCapabilityLines(capability)),
  ].join('\n');
}

export interface PlannerPacketInput {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly builtAtEvent: number;
  readonly target: {
    readonly provider: string;
    readonly model: string;
    readonly maxContext: number;
  };
  /** From `.DeFlow/config.yaml`. Absent means the 0.5 default. */
  readonly configuredFraction?: number;
  /** The approved spec, pinned verbatim. */
  readonly spec: TaskSpec;
  /** The run's safety constraints (F5.6). */
  readonly constraints?: readonly Constraint[];
  /** The recon output, as facts. */
  readonly facts: readonly PlannerFact[];
  /** F2.2's third input, materialised from `provider_capabilities` rows.
   * Required, and an empty array is a legitimate value that says so. */
  readonly capabilities: readonly PlannerCapability[];
  /**
   * KAR-23.13 — what the daemon about to run this plan can perform.
   *
   * **Required, not optional**, and for the same argument as `capabilities`: a
   * packet assembled without it teaches the planner about an imagined daemon,
   * and a rules segment that quietly said nothing would be worse than no rules
   * segment, because the caller would still believe the planner was told.
   */
  readonly performable: PlannerPerformableSet;
  readonly segments?: readonly Segment[];
  readonly estimate?: TokenEstimator;
}

/** A fact as the planner reads it: what it says, how much it is worth, and
 * where to click through to. */
export function renderFactSegmentText(fact: PlannerFact): string {
  const evidence =
    fact.fromEvidence.length === 0
      ? "evidence: none — this is the surveying agent's own claim"
      : `evidence: ${fact.fromEvidence.join(', ')}`;
  return [
    `${fact.key} (confidence: ${fact.confidence})`,
    JSON.stringify(fact.value, null, 2),
    evidence,
  ].join('\n');
}

const sumTokens = (of: readonly Segment[]): number =>
  of.reduce((total, entry) => total + entry.tokens.estimated, 0);

function totalsOf(segments: readonly Segment[]) {
  return {
    tokens: sumTokens(segments),
    byKind: Object.fromEntries(
      SEGMENT_KINDS.map((kind) => [
        kind,
        sumTokens(segments.filter((entry) => entry.kind === kind)),
      ]),
    ),
  };
}

/** A fact key as a segment id: `finding/test-command` → `fact-finding-test-command`. */
function segmentIdFor(key: string): string {
  return `fact-${key.replaceAll(/[^a-z0-9]+/gi, '-')}`;
}

/** AC7 — the planner's packet. */
export async function buildPlannerPacket(input: PlannerPacketInput): Promise<ContextPacket> {
  const estimate = input.estimate ?? heuristicTokens;

  for (const supplied of input.segments ?? []) {
    if (!(PLANNER_SEGMENT_KINDS as readonly string[]).includes(supplied.kind)) {
      throw new ForeignSegmentInPlannerPacket(supplied.id, supplied.kind);
    }
  }

  const pinned = await buildSpecPinnedSegments({
    spec: input.spec,
    ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
    sourceEvent: EventSeqSchema.parse(input.builtAtEvent),
    estimate,
  });

  // KAR-23.13 — after the pinned spec, before the facts: the planner reads
  // what it was asked for, then the house rules it must satisfy, then the
  // measurements it plans against.
  const rules = await contextSegment({
    id: PLAN_RULES_SEGMENT_ID,
    kind: 'task.brief',
    text: renderPlanRulesSegmentText(input.performable),
    sourceEvent: EventSeqSchema.parse(input.builtAtEvent),
    estimate,
  });

  const facts: Segment[] = [];
  for (const fact of input.facts) {
    facts.push(
      await contextSegment({
        id: segmentIdFor(fact.key),
        kind: 'fact',
        text: renderFactSegmentText(fact),
        sourceEvent: EventSeqSchema.parse(fact.sourceEvent),
        estimate,
      }),
    );
  }

  // The newest probe this list was built from, so the segment's click-through
  // lands on an event that exists; `builtAtEvent` when there is no probe to
  // point at, which is the only honest answer for an empty list.
  const probedAt = input.capabilities.map((capability) => capability.sourceEvent);
  const capabilities = await contextSegment({
    id: CAPABILITY_SEGMENT_ID,
    kind: 'fact',
    text: renderCapabilitySegmentText(input.capabilities),
    sourceEvent: EventSeqSchema.parse(
      probedAt.length === 0 ? input.builtAtEvent : Math.max(...probedAt),
    ),
    estimate,
  });

  const segments = [...pinned, rules, ...facts, capabilities, ...(input.segments ?? [])];
  const prompt = renderPacket({ segments });
  const { budget } = resolveContextBudget({
    maxContext: input.target.maxContext,
    ...(input.configuredFraction === undefined
      ? {}
      : { configuredFraction: input.configuredFraction }),
  });

  return ContextPacketSchema.parse({
    schemaId: 'DeFlow.contextpacket.v1',
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    builtAtEvent: input.builtAtEvent,
    target: input.target,
    budget,
    totals: totalsOf(segments),
    renderedPromptHandle: `artifact://${(await contentHash(prompt)).slice('sha256-'.length)}`,
    pinnedDigests: segments.filter((entry) => entry.pinned).map((entry) => entry.contentHash),
    segments,
  });
}
