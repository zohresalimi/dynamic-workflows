/**
 * KAR-11.2 — `validatePlan`: docs/06-planning-and-replanning.md §3, implemented
 * literally, and *"the cheapest correctness gate in the system"*.
 *
 * Six checks, one entry point, and every one of them delegates to the module
 * that already owns the rule rather than restating it:
 *
 *   - **Reachability** (§3.1, F6.2) is `validateDeclaredReads` — EPIC-09's
 *     module note calls itself *"the **only** implementation of the F6.2
 *     read-reachability gate in the workspace"*, and this file is the caller
 *     that note was written for.
 *   - **Cycles** (§3.1) are `topoSort` throwing `PlanCycleError`. There is no
 *     second traversal here; the `catch` *is* the check.
 *   - **Orphan writes** (§3.1) fall out of the same two sets, as a `warning`,
 *     because *"it is usually a leftover from a patch, occasionally
 *     deliberate"*.
 *   - **Identifiers** (§3.3) are the `NodeId` charset (`isNodeIdSlug`), a
 *     case-insensitive duplicate check, and the verdict real
 *     `git check-ref-format` returned — passed in as `refusedRefs` rather than
 *     spawned here, because @DeFlow/core performs no I/O (R1) and git's rules
 *     are git's to state.
 *   - **Capabilities** (§3.2) read the probed row through `PlanTimeCapability`,
 *     which the caller projects from `provider_capabilities`. There is no
 *     capability table in this package and there cannot be one.
 *   - **Criteria coverage** (§3.4, F7.4) is `revalidateSpecAgainstPlan`, which
 *     KAR-10.3 already wrote for the spec-edit path. The same question asked at
 *     two moments must not have two answers.
 *
 * **Diagnostics are values, never exceptions** (§3.5). `PlanCycleError` is
 * caught here and turned into one; nothing else escapes. That is what makes the
 * retry in §3.5 possible at all — a stack trace is not something a planner can
 * act on, and `run.needs_human` cannot render one usefully.
 *
 * **Every diagnostic, not the first** (AC1), sorted by `(node, code, key)` so
 * the array is stable enough to snapshot and so an operator reading four
 * failures reads them in an order that does not depend on the order the planner
 * emitted its nodes in.
 *
 * Verifies: EPIC-11-S6, EPIC-11-S7, EPIC-11-S8, EPIC-11-S9, EPIC-11-S10
 * (charset half), EPIC-11-S11 · AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC12
 */
import { BUDGET_FRACTION_CEILING } from './build-packet.ts';
import { isNodeIdSlug, type NodeId } from './ids.ts';
import type { PlanDiagnostic } from './plan-diagnostics.ts';
import type { AgentNode, PermissionLevel, PlanGraph, PlanNode } from './plan-graph.ts';
import { revalidateSpecAgainstPlan } from './spec-approval.ts';
import type { TaskSpec } from './task-spec.ts';
import { toSingleLine } from './text.ts';
import { PlanCycleError, topoSort } from './topo-sort.ts';
import { satisfies, validateDeclaredReads } from './validate-declared-reads.ts';

/**
 * The `node` a plan-scoped diagnostic carries.
 *
 * An uncovered acceptance criterion is a fault of the *document*, not of any
 * one node, and inventing a node to blame would put a highlight on an innocent
 * box in F10.1's graph. The parentheses are what keep it outside the `NodeId`
 * charset, so it can never be mistaken for one.
 */
export const PLAN_SCOPE = '(plan)';

/**
 * What plan validation needs to know about one probed adapter.
 *
 * A projection of a `provider_capabilities` row, assembled by the caller — the
 * daemon reads the table, `@DeFlow/adapters` answers the capability questions,
 * and this package sees the result. 06 §2.2 is blunt about why it may not be
 * anything else: *"a hardcoded capability matrix will be wrong within a
 * month"*, and the two of five versions in the measured matrix that were
 * published the same day they were probed are the evidence.
 *
 * `maxContext` is on this type even though no `initialize` response advertises
 * it, because it is still a property of the resolved adapter and the packet
 * budget is computed against it. A window-size table would be the same mistake
 * in a different column — the caller supplies the figure it is actually going
 * to budget with.
 */
export interface PlanTimeCapability {
  readonly provider: string;
  /** The binary's own `--version` output, as the probe recorded it. */
  readonly version: string;
  /** Whether the CLI enforces a returned JSON Schema itself. */
  readonly structuredOutput: boolean;
  /** Whether the probed row grants `session/resume`. */
  readonly resume: boolean;
  /** The levels DeFlow can actually enforce against this adapter (F5.4). */
  readonly permissionLevels: readonly PermissionLevel[];
  readonly maxContext: number;
}

export interface ValidatePlanOptions {
  /**
   * The calibrated packet estimate for a node, as KAR-14.3's estimator
   * produces it — never the raw tokenizer count, which is the figure the
   * calibration exists to correct.
   *
   * A port rather than a computation here: pricing, calibration and the
   * tokenizer are all EPIC-14's, and re-deriving a cheaper approximation would
   * make `PACKET_EXCEEDS_BUDGET` fire against a number nothing else in the
   * system uses.
   */
  readonly estimatePacketTokens: (node: PlanNode) => number;
  /**
   * The node ids real `git check-ref-format` refused, for the ref
   * `refs/heads/DeFlow/<runId>__<nodeId>` (§3.3).
   *
   * Passed in, because git's rules are git's: reimplementing them in TypeScript
   * is the failure §3.3 exists to prevent, and this package cannot spawn a
   * process to ask.
   */
  readonly refusedRefs?: Iterable<string> | undefined;
}

/* -------------------------------------------------------------------------- *
 * §3.1 — reachability, cycles and orphan writes
 * -------------------------------------------------------------------------- */

/** §3.1's sentence, spelled once — the string the planner is handed on its one
 * retry and the string the operator reads in `run.needs_human`. */
function readUnreachableMessage(node: string, key: string): string {
  return (
    `node '${node}' reads '${key}' but no ancestor writes it and it is not ` + 'in the pinned spec'
  );
}

function reachabilityDiagnostics(plan: PlanGraph): PlanDiagnostic[] {
  return validateDeclaredReads(plan).map((error) => ({
    severity: 'error' as const,
    code: 'READ_UNREACHABLE' as const,
    node: error.node as string,
    key: error.key,
    message: readUnreachableMessage(error.node as string, error.key),
  }));
}

/**
 * The cycle check: run the walk, and report what it threw.
 *
 * The order itself is discarded — this function wants the exception, not the
 * sequence — but running the *same* walk is the point. A cheaper "is there a
 * cycle" predicate would be a second implementation, and the two would be free
 * to disagree.
 */
function cycleDiagnostics(plan: PlanGraph): PlanDiagnostic[] {
  try {
    topoSort(plan);
    return [];
  } catch (thrown) {
    if (!(thrown instanceof PlanCycleError)) throw thrown;
    const cycle = thrown.cycle;
    const first = cycle[0];
    if (first === undefined) return [];
    return [
      {
        severity: 'error',
        code: 'PLAN_CYCLE',
        node: first,
        key: cycle.join(','),
        message: toSingleLine(thrown.message),
      },
    ];
  }
}

/** Every `fact` key any node in the plan declares reading. */
function readKeys(plan: PlanGraph): string[] {
  return plan.nodes.flatMap((node) =>
    node.reads.filter((read) => read.kind === 'fact').map((read) => read.key),
  );
}

/**
 * §3.1's third check. A written key no read matches — in either direction, so
 * `finding/*` on either side counts — is a `warning`.
 *
 * `satisfies` is reused for the match so the glob rule is EPIC-09's one rule.
 * Only `fact` reads are considered: `satisfies` short-circuits on the pinned
 * `spec:*` keys, which no `WriteDecl` can ever produce, and feeding it a spec
 * read would mark every write in the plan as consumed.
 */
function orphanWriteDiagnostics(plan: PlanGraph): PlanDiagnostic[] {
  const reads = readKeys(plan);
  const diagnostics: PlanDiagnostic[] = [];
  for (const node of plan.nodes) {
    for (const write of node.writes) {
      if (reads.some((read) => satisfies([write.key], read))) continue;
      diagnostics.push({
        severity: 'warning',
        code: 'ORPHAN_WRITE',
        node: node.id,
        key: write.key,
        message:
          `node '${node.id}' writes '${write.key}' and no node reads it. Usually a leftover ` +
          'from a patch, occasionally deliberate — the run is not blocked.',
      });
    }
  }
  return diagnostics;
}

/* -------------------------------------------------------------------------- *
 * §3.3 — identifiers
 * -------------------------------------------------------------------------- */

function identifierDiagnostics(plan: PlanGraph, refused: ReadonlySet<string>): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = [];
  const seen = new Map<string, string>();

  for (const node of plan.nodes) {
    const id: string = node.id;

    if (!isNodeIdSlug(id)) {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_NODE_ID',
        node: id,
        key: id,
        message:
          `node id '${id}' is outside the DeFlow charset. A node id becomes a branch name, a ` +
          'worktree directory, an artifact path and a URL segment, so it must be lowercase ' +
          'kebab, 1-63 characters, starting alphanumeric.',
      });
    }

    if (refused.has(id)) {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_NODE_ID',
        node: id,
        key: id,
        message:
          `git check-ref-format refused refs/heads/DeFlow/${plan.runId}__${id}, so node id ` +
          `'${id}' cannot become the branch its worktree is checked out on.`,
      });
    }

    const folded = id.toLowerCase();
    const earlier = seen.get(folded);
    if (earlier === undefined) {
      seen.set(folded, id);
    } else {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_NODE_ID',
        node: id,
        key: id,
        message:
          `node id '${id}' duplicates '${earlier}' case-insensitively. The id is also a ` +
          'directory name, and a case-insensitive filesystem would give both nodes the same ' +
          'worktree.',
      });
    }
  }

  return diagnostics;
}

/* -------------------------------------------------------------------------- *
 * §3.2 — adapter capability checks
 * -------------------------------------------------------------------------- */

/** §3.2 walks the agent nodes: they are the only ones that name an adapter. */
function agentNodes(plan: PlanGraph): AgentNode[] {
  return plan.nodes.filter((node): node is AgentNode => node.type === 'agent');
}

/**
 * `AgentNode.provider.requires` spells "this node cannot run without a resumed
 * session" as `resumableSessions` — the same vocabulary admission control reads
 * at spawn time (`ADAPTER_REQUIREMENT_CAPABILITIES`). `resume:
 * 'native-if-available'` is the soft form of the same wish, and the difference
 * between the two is the difference between §3.2's hard and soft `NO_RESUME`.
 */
function requiresResume(node: AgentNode): boolean {
  return node.provider.requires.some((requirement) => requirement === 'resumableSessions');
}

function capabilityDiagnostics(
  plan: PlanGraph,
  caps: readonly PlanTimeCapability[],
  estimatePacketTokens: (node: PlanNode) => number,
): PlanDiagnostic[] {
  const byProvider = new Map(caps.map((capability) => [capability.provider, capability]));
  const diagnostics: PlanDiagnostic[] = [];

  for (const node of agentNodes(plan)) {
    // The plan states a *preference*; the adapter is whichever preferred
    // provider has actually been probed. A preference nothing satisfies is the
    // refusal, not a licence to pick something else.
    const preferred: readonly string[] = node.provider.prefer;
    const resolved = preferred.map((name) => byProvider.get(name)).find((row) => row !== undefined);

    if (resolved === undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'PROVIDER_NOT_PROBED',
        node: node.id,
        key: preferred[0] ?? '(unspecified)',
        message:
          `node '${node.id}' prefers ${preferred.length === 0 ? '(no provider)' : preferred.join(', ')}` +
          ', and no probed provider_capabilities row exists for any of them. DeFlow never ' +
          'believes a documentation claim over a handshake.',
      });
      continue;
    }

    if (!resolved.structuredOutput) {
      diagnostics.push({
        severity: 'error',
        code: 'NO_STRUCTURED_OUTPUT',
        node: node.id,
        key: node.returns.schemaId,
        message:
          `node '${node.id}' returns ${node.returns.schemaId}, but ${resolved.provider} ` +
          `${resolved.version} enforces no schema, so its return contract could only be ` +
          'checked after the tokens were spent.',
      });
    }

    if (!resolved.resume) {
      const hard = requiresResume(node);
      const soft = node.resume === 'native-if-available';
      if (hard || soft) {
        diagnostics.push({
          severity: hard ? 'error' : 'warning',
          code: 'NO_RESUME',
          node: node.id,
          key: 'session.resume',
          message: hard
            ? `node '${node.id}' declares it requires a resumable session, and ` +
              `${resolved.provider} ${resolved.version} does not advertise session.resume.`
            : `node '${node.id}' prefers a native resume that ${resolved.provider} ` +
              `${resolved.version} does not advertise; it will use the ResumeByReplay strategy ` +
              'instead, which is the durability mechanism in any case.',
        });
      }
    }

    if (!resolved.permissionLevels.includes(node.permission)) {
      diagnostics.push({
        severity: 'error',
        code: 'PERMISSION_UNSUPPORTED',
        node: node.id,
        key: node.permission,
        message:
          `node '${node.id}' asks for permission level '${node.permission}', which ` +
          `${resolved.provider} ${resolved.version} cannot express. DeFlow refuses to schedule ` +
          'it rather than escalating or downgrading it silently (F5.4).',
      });
    }

    // §3.2's last line, and the 0.6 comes from the packet-assembly policy
    // (08-context-and-memory §5.2) rather than from a literal here: above it
    // there is no room left for a vendor compaction summary.
    const ceiling = resolved.maxContext * BUDGET_FRACTION_CEILING;
    const estimated = estimatePacketTokens(node);
    if (estimated > ceiling) {
      diagnostics.push({
        severity: 'error',
        code: 'PACKET_EXCEEDS_BUDGET',
        node: node.id,
        key: 'maxContext',
        message:
          `node '${node.id}' is estimated at ${estimated} packet tokens against ` +
          `${resolved.provider}'s ${resolved.maxContext}-token window, over the ` +
          `${BUDGET_FRACTION_CEILING} ceiling of ${Math.floor(ceiling)}.`,
      });
    }
  }

  return diagnostics;
}

/* -------------------------------------------------------------------------- *
 * §3.4 — criteria coverage
 * -------------------------------------------------------------------------- */

function coverageDiagnostics(plan: PlanGraph, spec: TaskSpec): PlanDiagnostic[] {
  return revalidateSpecAgainstPlan(spec, plan).map((issue) => ({
    severity: 'error' as const,
    code: 'CRITERION_UNCOVERED' as const,
    node: PLAN_SCOPE,
    key: issue.criterion as string,
    message: toSingleLine(issue.message),
  }));
}

/* -------------------------------------------------------------------------- *
 * the entry point
 * -------------------------------------------------------------------------- */

/** `(node, code, key)`, so two runs over one document produce one array. */
function ordered(diagnostics: readonly PlanDiagnostic[]): readonly PlanDiagnostic[] {
  return diagnostics.toSorted(
    (a, b) =>
      a.node.localeCompare(b.node) || a.code.localeCompare(b.code) || a.key.localeCompare(b.key),
  );
}

/**
 * Every diagnostic §3 produces for one plan version.
 *
 * Pure, total, and it returns **all** of them: a validator that stops at the
 * first fault turns one planner retry into four, and §3.5 allows exactly one.
 */
export function validatePlan(
  plan: PlanGraph,
  spec: TaskSpec,
  caps: readonly PlanTimeCapability[],
  options: ValidatePlanOptions,
): readonly PlanDiagnostic[] {
  const refused = new Set(options.refusedRefs ?? []);
  return ordered([
    ...reachabilityDiagnostics(plan),
    ...cycleDiagnostics(plan),
    ...orphanWriteDiagnostics(plan),
    ...identifierDiagnostics(plan, refused),
    ...capabilityDiagnostics(plan, caps, options.estimatePacketTokens),
    ...coverageDiagnostics(plan, spec),
  ]);
}

/**
 * AC6 — the nodes a soft `NO_RESUME` annotates.
 *
 * Derived from the diagnostics rather than written onto the graph, because the
 * plan document is immutable and content-addressed: annotating a node in place
 * would change the hash the `plan` row is filed under, and the fact being
 * recorded is about *this machine's* adapters rather than about the plan.
 */
export function resumeByReplayNodes(diagnostics: readonly PlanDiagnostic[]): readonly NodeId[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.code === 'NO_RESUME' && diagnostic.severity === 'warning')
    .map((diagnostic) => diagnostic.node as NodeId);
}
