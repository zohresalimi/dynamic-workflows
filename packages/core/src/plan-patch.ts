/**
 * KAR-02.4 — `PlanPatch`, `PatchDecision` and the structural well-formedness
 * check (docs/04-domain-model.md §4).
 *
 * A patch is the *only* way the graph changes at runtime: proposed as data,
 * evaluated by the policy engine, then applied, queued or rejected — and all
 * three outcomes recorded. Two decisions here carry the weight:
 *
 *   1. **`policy` is required, and so is every field in it.** The default
 *      policy in F2.5 — auto-apply read-only analysis, require approval for
 *      anything adding write capability, costing above a threshold, or
 *      exceeding replan depth 3 — is expressible *purely* as predicates over
 *      these six fields. A patch that cannot fill them in is a patch the
 *      policy engine cannot rule on, so it is rejected at validation rather
 *      than defaulted to "auto". `escalatesPermission` is `null` or a
 *      `{ from, to }` pair and never a bare level, because "escalates to
 *      full" is not a fact a rule can compare against without knowing what it
 *      escalated *from*.
 *   2. **`patchIsWellFormed` is where the §1.1 NodeId invariant is enforced.**
 *      This is the one place a graph can change at runtime. The idempotency
 *      key of a pending effect row is `(runId, nodeId, attempt, ordinal)`; if
 *      an id moves between that row being written and the daemon restarting,
 *      the memoised result is orphaned and the side effect runs twice — and
 *      there is no way to detect it afterwards. So a rename is a hard error
 *      and never a warning, and a retired id is never reused, including one
 *      whose lifecycle is already `abandoned`.
 *
 * A rename does not announce itself as a rename: it arrives as an insert of a
 * fresh id that claims `derivedFrom: [<an id that is staying active>]`. That
 * is the shape `'node-id-would-move'` names. The legitimate version of the
 * same shape is a `split-node` (or an `abandon-branch`), which *retires* the
 * ancestor in the same patch — which is why `retirementsOf` exists and is
 * consulted before the rename check fires.
 *
 * What is deliberately *not* here: applying the ops. `applyOps`, the new
 * `plan` row, the `basePlanHash` optimistic-concurrency check and the atomic
 * append are KAR-11.3; the rules that turn a `policy` block into a decision
 * are KAR-11.4. This module is the vocabulary both of them speak.
 *
 * Verifies: EPIC-02-S2, EPIC-02-S3 (validation half), EPIC-02-S12,
 * EPIC-02-S13 · AC1, AC2, AC3, AC4, AC5, AC6, AC7
 */
import { z } from 'zod';
import { type NodeId, NodeIdSchema, type NodeLifecycle, ProviderIdSchema } from './ids.ts';
import {
  PermissionLevelSchema,
  type PlanEdge,
  PlanEdgeSchema,
  type PlanGraph,
  type PlanNode,
  PlanNodeSchema,
} from './plan-graph.ts';

/** Like `PlanGraph.schemaId`, a fixed literal rather than an open `SchemaId`:
 * this module produces and accepts exactly one document shape at v1. */
export const PLANPATCH_SCHEMA_ID = 'DeFlow.planpatch.v1' as const;

/** The five op kinds, in the order §4 introduces them. Exported so a caller
 * enumerating them — the scrubber's legend, a scenario outline — reads the set
 * from the schema rather than restating it. */
export const PATCH_OPS = [
  'insert-nodes',
  'split-node',
  'replace-provider',
  'extend-loop',
  'abandon-branch',
] as const;

export type PatchOpKind = (typeof PATCH_OPS)[number];

/** What the patch touches: the paths it can write and how many nodes it
 * moves. `paths` feeds the F5.3 scope check, `nodeCount` the F2.5 threshold. */
export const BlastRadiusSchema = z.strictObject({
  paths: z.array(z.string()),
  nodeCount: z.int().nonnegative(),
});

export type BlastRadius = z.infer<typeof BlastRadiusSchema>;

/** AC1 / EPIC-02-S12, third scenario: an escalation is a *pair*. A bare level
 * cannot be compared against the ladder, and "escalates to worktree" from
 * `full` is a de-escalation wearing the same word. */
export const PermissionEscalationSchema = z.strictObject({
  from: PermissionLevelSchema,
  to: PermissionLevelSchema,
});

export type PermissionEscalation = z.infer<typeof PermissionEscalationSchema>;

/**
 * AC1. Every field mandatory, and the object is `strictObject` so a
 * misspelled field is a parse error rather than a silently-absent predicate
 * input. Deltas are signed: a patch that *removes* work has a negative cost
 * delta, and clamping that to zero would hide the one case where the policy
 * engine should relax rather than tighten.
 */
export const PatchPolicySchema = z.strictObject({
  /** From the F9.3 pre-flight estimator (KAR-14.3). */
  estimatedCostDeltaUsd: z.number().finite(),
  estimatedWallClockDeltaMs: z.int(),
  blastRadius: BlastRadiusSchema,
  /** Distance from `PlanGraph` v1 — the input to F2.5's "replan depth > 3". */
  replanDepth: z.int().nonnegative(),
  escalatesPermission: PermissionEscalationSchema.nullable(),
  addsWriteCapability: z.boolean(),
});

export type PatchPolicy = z.infer<typeof PatchPolicySchema>;

export const InsertNodesOpSchema = z.strictObject({
  op: z.literal('insert-nodes'),
  nodes: z.array(PlanNodeSchema).min(1),
  edges: z.array(PlanEdgeSchema),
});

export const SplitNodeOpSchema = z.strictObject({
  op: z.literal('split-node'),
  node: NodeIdSchema,
  /** At least two. A "split" into one node is a rename with extra steps, and
   * §1.1 exists to make that unrepresentable rather than merely discouraged. */
  into: z.array(PlanNodeSchema).min(2),
  edges: z.array(PlanEdgeSchema),
});

/**
 * AC4. `provider` and `model` and nothing else — and because the object is
 * strict, an op smuggling `id`, `pathScopes` or `permission` fails at the
 * schema boundary with the offending key named, long before any applier could
 * act on it.
 */
export const ReplaceProviderOpSchema = z.strictObject({
  op: z.literal('replace-provider'),
  node: NodeIdSchema,
  provider: ProviderIdSchema,
  model: z.string().min(1).optional(),
});

export const ExtendLoopOpSchema = z.strictObject({
  op: z.literal('extend-loop'),
  node: NodeIdSchema,
  maxRounds: z.int().positive(),
});

export const AbandonBranchOpSchema = z.strictObject({
  op: z.literal('abandon-branch'),
  root: NodeIdSchema,
  /** Per-op and separate from the patch's own `reason`: one patch may abandon
   * a branch *and* insert its replacement, and the scrubber renders the two
   * explanations in different places. */
  reason: z.string().min(1),
});

export const PatchOpSchema = z.discriminatedUnion('op', [
  InsertNodesOpSchema,
  SplitNodeOpSchema,
  ReplaceProviderOpSchema,
  ExtendLoopOpSchema,
  AbandonBranchOpSchema,
]);

export type PatchOp = z.infer<typeof PatchOpSchema>;

/**
 * AC5. `'scheduler'` sits alongside `'planner'` and `'human'` so F3.9's
 * quota-driven re-route is an ordinary patch — it shows up in the scrubber
 * like everything else, and "why did this node switch to Codex halfway
 * through?" is one click rather than a log line. The three literals come
 * first so they are matched as themselves rather than as node ids they would
 * also lexically satisfy.
 */
const ProposedBySchema = z.union([
  z.literal('planner'),
  z.literal('human'),
  z.literal('scheduler'),
  NodeIdSchema,
]);

/** AC6: required and non-empty, and non-blank — it is rendered verbatim in
 * the scrubber (F10.2) and never summarised or rewritten anywhere in the
 * pipeline, so a patch whose reason is three spaces explains nothing. */
const ReasonSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, 'reason must not be blank');

export const PlanPatchSchema = z.strictObject({
  schemaId: z.literal(PLANPATCH_SCHEMA_ID),
  id: z.string().min(1),
  proposedBy: ProposedBySchema,
  reason: ReasonSchema,
  /** At least one: a patch that changes nothing is not a patch, and an empty
   * `ops` array would still be recorded, decided on and rendered. */
  ops: z.array(PatchOpSchema).min(1),
  /** AC1 — not `.optional()`, not defaulted. */
  policy: PatchPolicySchema,
});

export type PlanPatch = z.infer<typeof PlanPatchSchema>;

export const PATCH_DECISIONS = ['auto', 'approved', 'rejected', 'queued'] as const;

export type PatchDecisionOutcome = (typeof PATCH_DECISIONS)[number];

/**
 * AC7. A rejection with no named rule is unanswerable — "the run silently
 * decided not to do the thing it decided to do" is exactly the state NF10
 * forbids — so `rule` is conditionally required on `'rejected'`, reported on
 * the `rule` path so the caller's error handling does not have to parse prose.
 * It stays optional for the other three outcomes: an auto-apply may or may not
 * have had a named rule fire, and a human approval has a person, not a rule.
 */
export const PatchDecisionSchema = z
  .strictObject({
    decision: z.enum(PATCH_DECISIONS),
    by: z.enum(['policy', 'human']),
    /** Which declarative rule fired. */
    rule: z.string().min(1).optional(),
    /** Display only — ordering is by the `EventSeq` of the event that carries
     * this decision, never by this timestamp (§1.2). */
    at: z.iso.datetime(),
  })
  .superRefine((decision, ctx) => {
    if (decision.decision === 'rejected' && (decision.rule ?? '').trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['rule'],
        message: 'a rejected patch must name the rule that fired',
      });
    }
  });

export type PatchDecision = z.infer<typeof PatchDecisionSchema>;

/** A lifecycle transition a patch implies. `split-node` supersedes its target;
 * `abandon-branch` abandons its root (its descendants follow when the patch is
 * applied — KAR-11.3 — but the *id* the patch names is the root). */
export interface PatchRetirement {
  readonly node: NodeId;
  readonly lifecycle: Extract<NodeLifecycle, 'superseded' | 'abandoned'>;
}

/**
 * AC3. The retirements a patch implies, in op order — the structural answer to
 * "which ids does this patch take out of circulation", which is what the
 * `NodeIdRegistry` (KAR-02.1) is fed and what the rename check below consults
 * to tell a legitimate split from a rename in disguise.
 *
 * Structural operations never delete a node: the id stays in the graph with
 * `lifecycle: 'superseded' | 'abandoned'` and successors carry `derivedFrom`,
 * so the scrubber can animate a split *as* a split rather than as one delete
 * plus three inserts.
 */
export function retirementsOf(patch: PlanPatch): PatchRetirement[] {
  const retirements: PatchRetirement[] = [];
  for (const op of patch.ops) {
    if (op.op === 'split-node') retirements.push({ node: op.node, lifecycle: 'superseded' });
    else if (op.op === 'abandon-branch')
      retirements.push({ node: op.root, lifecycle: 'abandoned' });
  }
  return retirements;
}

export const PATCH_ERROR_KINDS = [
  /** The op names a node the graph does not contain. */
  'unknown-node',
  /** A fresh node claims an id that already exists — at any lifecycle. */
  'node-id-reused',
  /** An insert claims descent from a node that stays active: a rename. */
  'node-id-would-move',
  /** A `split-node` successor does not name the node it came from. */
  'split-missing-derived-from',
  /** Splitting or abandoning a node whose id is already retired. */
  'node-already-retired',
  /** `extend-loop` against something that is not a loop. */
  'wrong-node-type',
] as const;

export type PatchErrorKind = (typeof PATCH_ERROR_KINDS)[number];

export interface PatchError {
  readonly kind: PatchErrorKind;
  /** Index into `patch.ops` — the op that is wrong, so a caller can point at
   * it rather than at the patch. */
  readonly op: number;
  /** Every node id the error is about, in the order the message names them. */
  readonly nodes: readonly NodeId[];
  readonly message: string;
}

export type PatchWellFormedness =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly PatchError[] };

/**
 * AC2, AC3. The structural check: every op references nodes that exist, and
 * **no op moves a node's id**.
 *
 * It reports *every* violation rather than the first, because a patch is
 * rejected whole (KAR-11.3 AC8) and a proposer that has to re-derive wants the
 * complete list on the first round trip.
 *
 * This is not the plan validator: cycles, gate coverage, criterion
 * traceability and read satisfiability are KAR-11.2, which re-runs over the
 * *applied* graph. Nor is it the policy engine: nothing here reads
 * `patch.policy`.
 */
export function patchIsWellFormed(patch: PlanPatch, graph: PlanGraph): PatchWellFormedness {
  const errors: PatchError[] = [];
  const existing = new Map<string, PlanNode>(graph.nodes.map((node) => [node.id, node]));
  // Ids this patch introduces, accumulated as the ops are walked so that a
  // later op may legally reference a node an earlier one inserted — and so
  // that inserting the same fresh id twice is caught.
  const inserted = new Map<string, PlanNode>();
  const retired = new Set<string>(retirementsOf(patch).map((retirement) => retirement.node));

  const fail = (kind: PatchErrorKind, op: number, nodes: NodeId[], message: string): void => {
    errors.push({ kind, op, nodes, message });
  };

  /** A node the patch brings into existence: its id must be free, and it must
   * not be a rename of a node that is staying. */
  const checkFreshNode = (node: PlanNode, index: number): void => {
    const clash = existing.get(node.id);
    if (clash !== undefined) {
      fail(
        'node-id-reused',
        index,
        [node.id],
        `node id "${node.id}" is already present in the graph with lifecycle "${clash.lifecycle}"; ids are never reused, including retired ones`,
      );
    } else if (inserted.has(node.id)) {
      fail(
        'node-id-reused',
        index,
        [node.id],
        `node id "${node.id}" is introduced twice by this patch`,
      );
    } else {
      inserted.set(node.id, node);
    }

    for (const ancestor of node.derivedFrom ?? []) {
      const ancestorNode = existing.get(ancestor);
      if (ancestorNode === undefined && !inserted.has(ancestor)) {
        fail(
          'unknown-node',
          index,
          [ancestor],
          `node "${node.id}" declares derivedFrom "${ancestor}", which is not in the graph`,
        );
      } else if (
        ancestorNode !== undefined &&
        ancestorNode.lifecycle === 'active' &&
        !retired.has(ancestor)
      ) {
        // The rename, undisguised: a fresh id claiming descent from a node
        // this patch leaves active. A genuine structural change retires the
        // ancestor in the same patch. An ancestor that is *already*
        // superseded or abandoned is not a rename either way — its id is out
        // of circulation, and a superseded node is expected to have
        // successors, so only an active one can move.
        fail(
          'node-id-would-move',
          index,
          [ancestor, node.id],
          `node "${ancestor}" would move to "${node.id}": a patch may change anything about a node except its id, and this patch does not retire "${ancestor}"`,
        );
      }
    }
  };

  const checkEdges = (edges: readonly PlanEdge[], index: number): void => {
    for (const edge of edges) {
      for (const endpoint of [edge.from, edge.to]) {
        if (!existing.has(endpoint) && !inserted.has(endpoint)) {
          fail(
            'unknown-node',
            index,
            [endpoint],
            `edge endpoint "${endpoint}" is neither in the graph nor inserted by this patch`,
          );
        }
      }
    }
  };

  /** Resolves an op's target, reporting it as unknown when it is absent. */
  const target = (id: NodeId, index: number, what: string): PlanNode | undefined => {
    const node = existing.get(id);
    if (node === undefined) {
      fail('unknown-node', index, [id], `${what} targets "${id}", which is not in the graph`);
    }
    return node;
  };

  for (const [index, op] of patch.ops.entries()) {
    switch (op.op) {
      case 'insert-nodes': {
        for (const node of op.nodes) checkFreshNode(node, index);
        checkEdges(op.edges, index);
        break;
      }
      case 'split-node': {
        const node = target(op.node, index, 'split-node');
        if (node !== undefined && node.lifecycle !== 'active') {
          fail(
            'node-already-retired',
            index,
            [op.node],
            `cannot split "${op.node}": its lifecycle is already "${node.lifecycle}" and an id retires once`,
          );
        }
        for (const successor of op.into) {
          checkFreshNode(successor, index);
          if (!(successor.derivedFrom ?? []).includes(op.node)) {
            fail(
              'split-missing-derived-from',
              index,
              [successor.id, op.node],
              `split successor "${successor.id}" must carry derivedFrom: ["${op.node}"]`,
            );
          }
        }
        checkEdges(op.edges, index);
        break;
      }
      case 'replace-provider': {
        target(op.node, index, 'replace-provider');
        break;
      }
      case 'extend-loop': {
        const node = target(op.node, index, 'extend-loop');
        if (node !== undefined && node.type !== 'loop') {
          fail(
            'wrong-node-type',
            index,
            [op.node],
            `extend-loop targets "${op.node}", which is a "${node.type}" node, not a loop`,
          );
        }
        break;
      }
      case 'abandon-branch': {
        const node = target(op.root, index, 'abandon-branch');
        if (node !== undefined && node.lifecycle !== 'active') {
          fail(
            'node-already-retired',
            index,
            [op.root],
            `cannot abandon "${op.root}": its lifecycle is already "${node.lifecycle}"`,
          );
        }
        break;
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
