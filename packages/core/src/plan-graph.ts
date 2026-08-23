/**
 * KAR-02.3 — `PlanGraph`, `NodeBase` and the seven-member `PlanNode`
 * discriminated union (docs/04-domain-model.md §3, §3.1, §3.2).
 *
 * The plan is **data, not code** (ADR-0005). Everything the scheduler, the
 * safety model and the inspector need to know about a step is a field on that
 * step, so a plan can be diffed, patched, snapshotted and rendered without
 * re-executing anything.
 *
 * Three decisions in here are load-bearing:
 *
 *   1. **The union is discriminated, and every branch is strict.** A node
 *      carrying a field belonging to a different node type — an `agent` with
 *      a `gate` — is a parse error naming the offending key, not an ignored
 *      extra property. `z.union` would instead report seven parallel
 *      failures and let a wrong-but-structurally-valid node through the first
 *      branch that happens to accept it.
 *   2. **`permission` and `pathScopes` have no default**, on any node type,
 *      including `human` and `subgraph`. A defaulted permission level is how
 *      a system silently escalates, which is the ODW binary-permission hazard
 *      (PRD G6) this design exists to avoid. `retry`, `budget` and
 *      `returns.maxTokens` *do* default, because their defaults are
 *      conservative and their absence is an authoring convenience, not a
 *      safety claim (EPIC-02-S10, second scenario).
 *   3. **The tuning constants are named and exported once.**
 *      `DEFAULT_RETURNS_MAX_TOKENS` is Unverified (roadmap A4-6): the
 *      500–2000 band traces to Anthropic's multi-agent research system and
 *      practitioner consensus, not a controlled study. It is one edit here
 *      precisely because it is expected to move once M1 gives us an oversize
 *      rate per node type to tune from.
 *
 * `planHash` is *validated* here and *computed* in ./hash.ts — over the
 * canonical encoding of the document with `planHash` itself omitted, so a
 * parsed-and-reserialised graph hashes to the value it carries.
 *
 * Verifies: EPIC-02-S4 (schema half), EPIC-02-S9, EPIC-02-S10 ·
 * AC1, AC2, AC3, AC4, AC5, AC7, AC8
 */
import { z } from 'zod';
import {
  CriterionIdSchema,
  GateIdSchema,
  HandleSchema,
  NodeIdSchema,
  NodeLifecycleSchema,
  PlanHashSchema,
  ProviderIdSchema,
  RunIdSchema,
  SchemaIdSchema,
} from './ids.ts';
import type { ItemIdFrom } from './map-child-id.ts';
import { NodeFailureReasonSchema } from './node-failure.ts';
import { DEFAULT_BACKOFF, DEFAULT_MAX_ATTEMPTS } from './retry-defaults.ts';

/** `PlanGraph.schemaId` is a fixed literal, not an open `SchemaId`: this
 * module produces and accepts exactly one document shape at v1, and the
 * version suffix is part of the id (§1) because schemas are append-only. */
export const PLANGRAPH_SCHEMA_ID = 'DeFlow.plangraph.v1' as const;

/** The seven node types, in the order §3.2 introduces them. Exported so a
 * caller enumerating node kinds — the renderer, a scenario outline — reads
 * the set from the schema rather than restating it. */
export const NODE_TYPES = ['agent', 'tool', 'gate', 'human', 'map', 'loop', 'subgraph'] as const;

export type NodeType = (typeof NODE_TYPES)[number];

/**
 * AC4 / F6.4 / F6.9. **Unverified** (roadmap A4-6) — see the module note.
 * One named constant, referenced by the schema, so tuning it is one edit.
 */
export const DEFAULT_RETURNS_MAX_TOKENS = 1500;

/** F5.4. The ladder is ordered least to most capable; `PERMISSION_LEVELS`
 * order is the ladder order, which KAR-08.x compares against. */
export const PERMISSION_LEVELS = ['read', 'worktree', 'worktree+net', 'full'] as const;

export const PermissionLevelSchema = z.enum(PERMISSION_LEVELS);

export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

/** F5.3. `write` is rendered into the context packet as a positive
 * requirement ("you may write these paths"), never as a prohibition list. */
export const PathScopeSchema = z.strictObject({
  write: z.array(z.string()),
  read: z.array(z.string()).optional(),
});

export type PathScope = z.infer<typeof PathScopeSchema>;

/**
 * Full jitter, and only full jitter: the `jitter` field is a literal rather
 * than an enum because 05-durable-execution §10.3 names one strategy, and an
 * "equal"/"decorrelated" option nobody implements is a field that lies.
 */
export const RetryPolicySchema = z.strictObject({
  maxAttempts: z.int().min(1),
  backoff: z.strictObject({
    base: z.int().nonnegative(),
    cap: z.int().nonnegative(),
    jitter: z.literal('full'),
  }),
  /** F4.5 — "retry with a different provider" is policy on the node, not a
   * decision buried in the scheduler. */
  onFailure: z
    .array(
      z.strictObject({
        when: NodeFailureReasonSchema,
        action: z.enum(['retry', 'reroute', 'escalate']),
      }),
    )
    .optional(),
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * AC5. `maxAttempts: 3` is F7.5's surgical-repair cap; the backoff constants
 * are 05-durable-execution §10.3's. Frozen, and handed to the schema through
 * a factory that clones it, so a caller mutating one parsed node's `retry`
 * cannot reach into the default every other node shares.
 *
 * The two numbers come from `./retry-defaults.ts` — a zod-free module — so a
 * consumer that needs the ceiling and nothing else does not drag this file's
 * schemas along with it. See that file for what happened when one did.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  backoff: DEFAULT_BACKOFF,
});

export const NodeBudgetSchema = z.strictObject({
  maxCostUsd: z.number().nonnegative().optional(),
  maxWallClockMs: z.int().positive().optional(),
  maxTokens: z.int().positive().optional(),
});

export type NodeBudget = z.infer<typeof NodeBudgetSchema>;

/**
 * F6.2. A read is declared or it does not happen. `{ kind: 'fact' }` accepts
 * both an exact key and the `finding/*` prefix form — as does `WriteDecl`, so
 * the prefix can appear on either side of the match. `validateDeclaredReads`
 * (./validate-declared-reads.ts) is what decides whether the declaration is
 * reachable from an ancestor's write; `readsAreSatisfiable`
 * (./reads-satisfiable.ts) is the same gate under KAR-02.3's name and return
 * shape, delegating to it rather than walking the graph a second time.
 */
export const ReadDeclSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fact'), key: z.string().min(1) }),
  z.strictObject({ kind: z.literal('artifact'), handle: HandleSchema }),
  z.strictObject({
    kind: z.literal('spec'),
    section: z.enum(['goal', 'criteria', 'constraints', 'nonGoals']),
  }),
]);

export type ReadDecl = z.infer<typeof ReadDeclSchema>;

/** Only facts are written by a node: an artifact is content-addressed and a
 * spec is pinned, so neither is something a plan step declares producing. */
export const WriteDeclSchema = z.strictObject({
  kind: z.literal('fact'),
  key: z.string().min(1),
  schemaId: SchemaIdSchema,
});

export type WriteDecl = z.infer<typeof WriteDeclSchema>;

/** F6.4, F6.9 — the return contract. `maxTokens` is what the packet builder
 * budgets against and what the oversize rate is measured against. */
export const NodeReturnsSchema = z.strictObject({
  schemaId: SchemaIdSchema,
  maxTokens: z.int().positive().default(DEFAULT_RETURNS_MAX_TOKENS),
});

export type NodeReturns = z.infer<typeof NodeReturnsSchema>;

/** Planner intent about the adapter, resolved against probed capabilities by
 * the scheduler (F3.5, F2.7) — never asserted as fact by the plan. */
export const AdapterRequirementSchema = z.union([
  z.enum(['structuredOutput', 'streaming', 'imageInput', 'mcp', 'resumableSessions']),
  z.strictObject({ minContext: z.int().positive() }),
  z.strictObject({ permission: PermissionLevelSchema }),
]);

export type AdapterRequirement = z.infer<typeof AdapterRequirementSchema>;

/**
 * The `NodeBase` contract (§3.1), spread into all seven branches rather than
 * expressed as `NodeBaseSchema.extend(...)`, because `z.discriminatedUnion`
 * needs to see each branch's own shape to build its discriminator map.
 *
 * Everything here is required except `derivedFrom` (set by a split patch,
 * KAR-02.4), `retry` and `budget` (defaulted — see decision 2 in the module
 * note).
 */
const nodeBaseShape = {
  id: NodeIdSchema,
  title: z.string().min(1),
  deps: z.array(NodeIdSchema),
  lifecycle: NodeLifecycleSchema,
  /** F2.5: a node produced by splitting another names its ancestor, so the
   * plan-evolution scrubber can animate a split as a split. */
  derivedFrom: z.array(NodeIdSchema).optional(),

  reads: z.array(ReadDeclSchema),
  writes: z.array(WriteDeclSchema),
  permission: PermissionLevelSchema,
  pathScopes: PathScopeSchema,
  returns: NodeReturnsSchema,
  retry: RetryPolicySchema.default(() => structuredClone(DEFAULT_RETRY_POLICY)),
  budget: NodeBudgetSchema.default(() => ({})),
} as const;

export const AgentNodeSchema = z.strictObject({
  ...nodeBaseShape,
  type: z.literal('agent'),
  /** The scoped instruction, not a full prompt: the packet builder assembles
   * the prompt from the brief plus the pinned spec segments. */
  brief: z.string().min(1),
  provider: z.strictObject({
    prefer: z.array(ProviderIdSchema),
    requires: z.array(AdapterRequirementSchema),
  }),
  model: z.string().min(1).optional(),
  /** Vendor session reuse is an optimisation; replay from the ledger is the
   * durability mechanism (D9). */
  resume: z.enum(['native-if-available', 'always-replay']),
});

export const ToolNodeSchema = z.strictObject({
  ...nodeBaseShape,
  type: z.literal('tool'),
  tool: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('script'),
      run: z.string().min(1),
      cwd: z.string().optional(),
    }),
    z.strictObject({
      kind: z.literal('mcp'),
      server: z.string().min(1),
      tool: z.string().min(1),
      args: z.unknown(),
    }),
    z.strictObject({ kind: z.literal('http'), method: z.string().min(1), url: z.string().min(1) }),
  ]),
  /** Classified at *plan* time, not run time, because it decides the
   * reconcile strategy in the effect journal (EPIC-06): a `mutating` command
   * whose reconcile returns `unknown` is never auto-retried. */
  effectClass: z.enum(['pure', 'mutating']),
});

export const GateNodeSchema = z.strictObject({
  ...nodeBaseShape,
  type: z.literal('gate'),
  gate: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('deterministic'), gateId: GateIdSchema }),
    z.strictObject({ kind: z.literal('adversarial'), brief: z.string().min(1) }),
  ]),
  /** F7.4 traceability: which acceptance criteria this gate is judging. */
  criteria: z.array(CriterionIdSchema),
  /** F7.2: the producer cannot judge its own output. */
  independence: z.strictObject({
    notSessionOf: z.array(NodeIdSchema),
    preferDifferentProvider: z.boolean(),
  }),
});

/**
 * KAR-13.1 AC8 — what selecting an option *does*, as a closed set.
 *
 * `approve` completes the node, `reject` fails its branch, `edit` replaces the
 * node's output with one the operator supplies, `inject` completes it and
 * carries the operator's words into the dependents' packets. Named here rather
 * than spelled inline so the responder, the queue and the renderer read the
 * same four values.
 */
export const HUMAN_OPTION_EFFECTS = ['approve', 'reject', 'edit', 'inject'] as const;

export type HumanOptionEffect = (typeof HUMAN_OPTION_EFFECTS)[number];

/** What a deadline does when it passes with nobody having answered (§10.4). */
export const HUMAN_TIMEOUT_ACTIONS = ['fail', 'escalate', 'default'] as const;

export type HumanTimeoutAction = (typeof HUMAN_TIMEOUT_ACTIONS)[number];

export const HumanOptionSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  effect: z.enum(HUMAN_OPTION_EFFECTS),
});

export type HumanOption = z.infer<typeof HumanOptionSchema>;

/** Suspension is durable (`node_wake`), so a deadline of hours costs one
 * SQLite row rather than a held timer. */
export const HumanDeadlineSchema = z.strictObject({
  wakeAt: z.iso.datetime(),
  onTimeout: z.enum(HUMAN_TIMEOUT_ACTIONS),
  /** The option id `onTimeout: 'default'` answers with. Checked against
   * `options` by plan validation, never at expiry (KAR-13.1 AC7). */
  default: z.string().optional(),
});

export type HumanDeadline = z.infer<typeof HumanDeadlineSchema>;

export const HumanNodeSchema = z.strictObject({
  ...nodeBaseShape,
  type: z.literal('human'),
  prompt: z.string().min(1),
  options: z.array(HumanOptionSchema).min(1),
  deadline: HumanDeadlineSchema.optional(),
});

/** AC7 — the safe default. Index-derived ids move when a collection is
 * re-derived after a replan, and moving `NodeId`s is exactly what §1.1
 * forbids (see ./map-child-id.ts). */
export const DEFAULT_ITEM_ID_FROM: ItemIdFrom = 'value-hash';

export const MapNodeSchema = z.strictObject({
  ...nodeBaseShape,
  type: z.literal('map'),
  over: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('fact'), key: z.string().min(1) }),
    z.strictObject({ kind: z.literal('glob'), pattern: z.string().min(1) }),
  ]),
  concurrency: z.int().positive(),
  /** A node id, instantiated once per item; children are materialised as real
   * nodes with real ids (`<mapNodeId>--<itemId>`). */
  body: NodeIdSchema,
  itemIdFrom: z.enum(['index', 'value-hash']).default(DEFAULT_ITEM_ID_FROM),
});

export const LoopNodeSchema = z.strictObject({
  ...nodeBaseShape,
  type: z.literal('loop'),
  body: NodeIdSchema,
  maxRounds: z.int().positive(),
  goal: z.strictObject({ kind: z.literal('gate'), gate: NodeIdSchema }),
  /** F4.7 — the most expensive failure mode in autonomous loops is a loop
   * that keeps paying for rounds that are not converging, so the halt
   * condition is data on the node rather than a heuristic in the scheduler. */
  noProgress: z.strictObject({
    sameFailureSignatureLimit: z.int().positive(),
    diffSimilarityThreshold: z.number().min(0).max(1),
  }),
});

export type AgentNode = z.infer<typeof AgentNodeSchema>;
export type ToolNode = z.infer<typeof ToolNodeSchema>;
export type GateNode = z.infer<typeof GateNodeSchema>;
export type HumanNode = z.infer<typeof HumanNodeSchema>;
export type MapNode = z.infer<typeof MapNodeSchema>;
export type LoopNode = z.infer<typeof LoopNodeSchema>;

/** F10.1: an edge is labelled with what flows across it, so the renderer can
 * draw a data edge as the fact it carries rather than as an arrow. */
export const PlanEdgeSchema = z.strictObject({
  from: NodeIdSchema,
  to: NodeIdSchema,
  kind: z.enum(['control', 'data']),
  carries: z.array(z.string().min(1)).optional(),
});

export type PlanEdge = z.infer<typeof PlanEdgeSchema>;

/**
 * The `NodeBase` contract as a *type*, derived from the agent branch rather
 * than restated: everything an `AgentNode` carries apart from its own
 * discriminator and payload is exactly `NodeBase`. Derived, so the two can
 * never drift.
 */
export type NodeBase = Omit<AgentNode, 'type' | 'brief' | 'provider' | 'model' | 'resume'>;

/**
 * `SubgraphNode` and `PlanNode` are the one pair of types in this module
 * written by hand instead of inferred, because a `subgraph` can contain the
 * very union it belongs to and TypeScript cannot infer a type through that
 * cycle (it reports the schema as implicitly `any`). Writing the fixpoint by
 * hand breaks the cycle; the `planNodeRef` assignment below is what keeps the
 * hand-written type honest — it fails to compile the moment the schema and
 * the type disagree.
 */
export interface SubgraphNode extends NodeBase {
  type: 'subgraph';
  graph:
    | { kind: 'inline'; nodes: PlanNode[]; edges: PlanEdge[] }
    | { kind: 'template'; templateId: string; params: Record<string, unknown> };
}

export type PlanNode =
  | AgentNode
  | ToolNode
  | GateNode
  | HumanNode
  | MapNode
  | LoopNode
  | SubgraphNode;

/**
 * The indirection that lets an inline subgraph reference the union it is a
 * member of. It is a mutable holder with an *explicit* type rather than a
 * direct reference to `PlanNodeSchema`, so nothing in `SubgraphNodeSchema`'s
 * type depends on `PlanNodeSchema`'s: the cycle is broken at the type level
 * as well as at the value level. Filled in immediately below the union.
 */
const planNodeRef: { schema: z.ZodType<PlanNode> } = { schema: z.never() };

export const SubgraphNodeSchema = z.strictObject({
  ...nodeBaseShape,
  type: z.literal('subgraph'),
  graph: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('inline'),
      // z.lazy, not a shape getter: `z.discriminatedUnion` reads every
      // option's shape when it is constructed, which would evaluate a getter
      // here before the union it points at exists.
      nodes: z.lazy(() => z.array(planNodeRef.schema)),
      edges: z.array(PlanEdgeSchema),
    }),
    z.strictObject({
      kind: z.literal('template'),
      templateId: z.string().min(1),
      params: z.record(z.string(), z.unknown()),
    }),
  ]),
});

/**
 * AC2. `z.discriminatedUnion`, never `z.union`: the discriminator selects one
 * branch, so a malformed `agent` reports the agent branch's own issue paths
 * instead of seven parallel failures, and — because every branch is strict —
 * an `agent` carrying a `gate` field is rejected rather than silently
 * accepted with the extra key ignored.
 */
export const PlanNodeSchema = z.discriminatedUnion('type', [
  AgentNodeSchema,
  ToolNodeSchema,
  GateNodeSchema,
  HumanNodeSchema,
  MapNodeSchema,
  LoopNodeSchema,
  SubgraphNodeSchema,
]);

// Both halves of the fixpoint, in one statement: the runtime reference an
// inline subgraph resolves at parse time, and the compile-time proof that the
// schema really does produce the hand-written `PlanNode` above.
planNodeRef.schema = PlanNodeSchema;

const SPEC_HASH_PATTERN = /^sha256-[0-9a-f]{64}$/;

/**
 * `'planner' | 'human' | NodeId` — a replan proposed by a running node names
 * that node, which is what makes the plan-evolution scrubber able to say
 * *who* changed the plan. The two literals come first so they are matched as
 * themselves rather than as node ids they would also lexically satisfy.
 */
const CreatedBySchema = z.union([z.literal('planner'), z.literal('human'), NodeIdSchema]);

export const PlanGraphSchema = z.strictObject({
  schemaId: z.literal(PLANGRAPH_SCHEMA_ID),
  runId: RunIdSchema,
  /** Monotonic per run: a replan writes a new document and a new row, it
   * never mutates the previous one. */
  version: z.int().positive(),
  /** Validated here, computed by `planHash` in ./hash.ts over the
   * canonicalised document with this field omitted (AC8). */
  planHash: PlanHashSchema,
  parent: PlanHashSchema.nullable(),
  taskSpecHash: z.string().regex(SPEC_HASH_PATTERN, `taskSpecHash must match ${SPEC_HASH_PATTERN}`),
  createdBy: CreatedBySchema,
  createdAt: z.iso.datetime(),
  nodes: z.array(PlanNodeSchema),
  edges: z.array(PlanEdgeSchema),
});

export type PlanGraph = z.infer<typeof PlanGraphSchema>;

/** One parse failure, with the node array index already resolved to the node
 * id it belongs to. */
export interface PlanIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly code: string;
}

export type ParsedPlanGraph =
  | { readonly success: true; readonly data: PlanGraph }
  | { readonly success: false; readonly issues: readonly PlanIssue[] };

/** The `id` of each entry of `input.nodes`, positionally, for any entry that
 * has a string one. Read off the *raw* input because a graph that failed to
 * parse has no parsed nodes to read ids from. */
function rawNodeIds(input: unknown): (string | undefined)[] {
  if (typeof input !== 'object' || input === null) return [];
  const nodes: unknown = (input as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  const entries: unknown[] = nodes;
  return entries.map((node) => {
    if (typeof node !== 'object' || node === null) return undefined;
    const id: unknown = (node as { id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  });
}

/**
 * AC3: parses a plan graph and reports a failure whose path **names the node
 * id**, not its array index — `['nodes', 'recon-auth-surface', 'permission']`
 * rather than `['nodes', 3, 'permission']`.
 *
 * The index is what Zod can know; the id is what a human, a log line and a
 * patch all address the node by, and a plan's node order is not stable across
 * versions. `PlanGraphSchema` stays available unchanged for callers that want
 * the raw Zod result.
 */
export function parsePlanGraph(input: unknown): ParsedPlanGraph {
  const result = PlanGraphSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data };

  const ids = rawNodeIds(input);
  const issues = result.error.issues.map((issue): PlanIssue => {
    const [head, index, ...rest] = issue.path;
    const id = typeof index === 'number' ? ids[index] : undefined;
    return {
      path:
        head === 'nodes' && id !== undefined
          ? ['nodes', id, ...rest.map(String)]
          : issue.path.map(String),
      message: issue.message,
      code: issue.code,
    };
  });
  return { success: false, issues };
}
