/**
 * KAR-11.1 — compiling `PlanGraph` v1 from the three inputs
 * (docs/06-planning-and-replanning.md §2, §3.5).
 *
 * The shape of this file is the story, and the order of the steps is what makes
 * each one honest:
 *
 *   1. **Refuse before spawning** (AC3, EPIC-11-S3 third scenario). The planner
 *      is the one node whose whole output is a structured document, so an
 *      adapter that cannot enforce a schema cannot run it. The check is a table
 *      read and a registry lookup, so the refusal costs a query rather than a
 *      process — *"no tokens were spent"*.
 *   2. **Materialise the capability list from `provider_capabilities`** (AC2).
 *      Every plan compilation re-reads the table. There is no cache to
 *      invalidate because there is nothing cached: 06 §2.2 says a hardcoded
 *      matrix *"will be wrong within a month"*, and a memoised one goes stale
 *      the first time somebody upgrades a CLI mid-run.
 *   3. **Assemble the packet from exactly three input groups** (AC1) —
 *      `buildPlannerPacket` is where the F6.1 allowlist lives, and a recon
 *      transcript is refused there rather than filtered out here.
 *   4. **Take the return as structured output, and validate it with Ajv**
 *      (AC3). A prose answer fails. **There is no fenced-block extraction, no
 *      regex and no heuristic parse** — 06 §8: *"a regex over prose is how the
 *      planner layer starts breaking on every CLI update"*. The absence is the
 *      feature; `packages/daemon/test/no-plan-extraction.test.ts` scans this
 *      file for the parse that would undo it.
 *   5. **Stamp the envelope DeFlow owns, then compute the hash** (AC4). The
 *      planner supplies nodes and edges; it cannot know the run id, the pinned
 *      spec's digest, or its own document's content address. Overwriting those
 *      is not leniency — it is the difference between a document DeFlow can
 *      address and one it has to trust an agent about.
 *   6. **Validate the plan and, on failure, retry exactly once** (§3.5). The
 *      whole of §3 runs here through `validatePlanVersion` — KAR-11.2's single
 *      entry point, git's verdict on every node id included — and never a
 *      subset of it: reachability alone would admit a plan with a cycle, an
 *      uncoverable criterion or an adapter that cannot honour a node, and each
 *      of those costs hours rather than milliseconds to discover later. The
 *      diagnostics are appended as `plan.validation_failed` and handed back to
 *      the planner verbatim; a second failure is `run.needs_human`. **Two
 *      attempts, not three** — an unbounded planner retry loop is the same
 *      failure shape the churn breaker exists to stop, arriving earlier — and
 *      the bound is a constant with no configuration path, so raising it is a
 *      code change a reviewer sees.
 *   7. **Persist**, which is one call into `persistPlanVersion`: the row, the
 *      file and `plan.proposed` in one transaction, or none of them. The
 *      diagnostics travel with it, because that call will not run without them
 *      (KAR-11.2 AC9).
 *
 * **Nothing here decides whether the run continues.** Every arm returns a value
 * — `compiled`, `failed` or `needs-human` — because that is the scheduler's
 * decision to make and it needs the outcome as data (04 §8).
 *
 * Verifies: EPIC-11-S1, EPIC-11-S2, EPIC-11-S3, EPIC-11-S5 · AC1, AC2, AC3,
 * AC4, AC5, AC6, AC7, AC8
 */

import { plannerCapabilityList, planTimeCapabilities, strongestEffort } from '@DeFlow/adapters';
import type {
  Constraint,
  Db,
  NodeId,
  PlanDiagnostic,
  PlanGraph,
  PlanNode,
  PlannerFact,
  PlannerTier,
  RunId,
  SchemaIssue,
  Segment,
  StructuredOutput,
  TaskSpec,
} from '@DeFlow/core';
import {
  buildPlannerPacket,
  type ContextPacket,
  contextSegment,
  EventSeqSchema,
  hasBlockingDiagnostic,
  NodeFailureError,
  PLANGRAPH_SCHEMA_ID,
  parsePlanGraph,
  planHash,
  renderPacket,
  renderPlanDiagnostics,
  schemaFileName,
} from '@DeFlow/core';
import { appendEvents, listProviderCapabilities, persistPlanVersion } from '@DeFlow/ledger';
import { join } from 'node:path';
import { PERFORMABLE_NODE_TYPES, PERFORMABLE_TOOL_KINDS } from '../exec/performable.ts';
import type { HandoffValidator } from '../handoff/enforce.ts';
import { type NodeRefChecker, validatePlanVersion } from './validate.ts';

/**
 * 06 §3.5's bound: *"Two attempts, not three."*
 *
 * A named constant referenced in exactly one place, and the escalation after it
 * is unconditional — there is no configuration path, no `options.maxAttempts`
 * and no caller that can pass a larger number. §3.5's reason for the bound is
 * that *"an unbounded planner retry loop is the same failure shape the churn
 * breaker exists to stop, arriving earlier"*, so raising it has to be a code
 * change a reviewer sees rather than a value in a YAML file.
 */
export const PLANNER_ATTEMPT_LIMIT = 2;

/** The tier 06 §6 assigns to the initial `PlanGraph`: one call per run, and the
 * single highest-leverage inference in the system. No switching logic ships in
 * M1 — AC6's fields exist so the measurement is possible later. */
export const PLAN_V1_TIER: PlannerTier = 'strongest';

/** One planner turn. */
export interface PlannerRequest {
  readonly prompt: string;
  /** 0 for the first attempt, 1 for the one retry. */
  readonly attempt: number;
  /** The strongest setting this adapter exposes, or `null` where it exposes
   * none. Passed rather than resolved inside the port so a recording of the
   * turn shows what was actually asked for. */
  readonly effort: string | null;
  /** The emitted `DeFlow.plangraph.v1.json` the adapter enforces (AC3). */
  readonly schemaPath: string;
}

export interface PlannerTurn {
  readonly structuredOutput: StructuredOutput;
}

/** Opens a fresh session and prompts it once. A port, because what a scripted
 * session cannot prove — that the vendor honours `--json-schema` — belongs to
 * the conformance battery, not here. */
export interface PlannerAgent {
  plan(request: PlannerRequest): Promise<PlannerTurn>;
}

export interface CompilePlanOptions {
  readonly db: Db;
  readonly runId: RunId;
  readonly node: NodeId;
  readonly epoch: number;
  /** From the injected `Clock`, never `Date.now()`. */
  readonly ts: number;
  /** `<target-repo>/.DeFlow/runs/<runId>`. */
  readonly runDir: string;
  /** The pinned spec — planner input one. */
  readonly spec: TaskSpec;
  /** The run's safety constraints, pinned alongside it (F5.6). */
  readonly constraints?: readonly Constraint[];
  /** The recon facts — planner input two. */
  readonly facts: readonly PlannerFact[];
  /** The `provider.probed` seq the capability segment's provenance points at. */
  readonly probedEvent: number;
  readonly provider: string;
  readonly model: string;
  readonly maxContext: number;
  /** Ajv over `.DeFlow/schemas/`, `strict: true`, `allErrors: true`. */
  readonly schemas: HandoffValidator;
  /** Where the emitted documents live, so the adapter can be handed a path. */
  readonly schemasDir: string;
  readonly agent: PlannerAgent;
  /**
   * KAR-11.2 AC7 — real `git check-ref-format`, for §3.3's identifier check.
   *
   * Required, not optional. An optional checker is one a caller forgets to
   * pass, and the silent consequence — a plan whose node ids were never shown
   * to git — is exactly the failure §3.3 describes as *"the run died at node 31
   * because the id had a colon in it"*.
   */
  readonly refs: NodeRefChecker;
  /**
   * KAR-11.2 AC5 — the calibrated packet estimate for a node, as KAR-14.3's
   * estimator produces it. Defaults to zero: a compiler with no estimator wired
   * in yet cannot overflow a window it has not measured, and inventing a
   * plausible figure would make `PACKET_EXCEEDS_BUDGET` fire on arithmetic
   * nothing else in the system performs.
   */
  readonly estimatePacketTokens?: ((node: PlanNode) => number) | undefined;
}

export type CompilePlanOutcome =
  | {
      readonly outcome: 'compiled';
      readonly plan: PlanGraph;
      /**
       * KAR-12.4 AC3 — the pinned spec as validation leaves it: every
       * criterion's `coveredByGates` recomputed from this plan's active gate
       * nodes and overwritten, whatever arrived in the field.
       *
       * This is the document the run executes against from here on. Its
       * `specHash` is unchanged — `specHash` excludes the derived field — so it
       * is the *same* document the ledger pinned and every verdict cites, with
       * the criterion → node mapping filled in rather than a second version of
       * the spec that would have to be re-approved.
       */
      readonly spec: TaskSpec;
      /**
       * What validation found on the accepted version — necessarily all
       * non-blocking, or this arm would not have been reached.
       *
       * A warning is not persisted anywhere (`plan.proposed` carries the
       * document, not the verdict on it), so returning it is the only way it is
       * seen at all: KAR-12.4 AC3's `COVERED_BY_GATES_MISMATCH` exists to make
       * a hand-edited spec *visible*, and a diagnostic computed and dropped
       * makes it exactly as invisible as not computing it. `commitPatchedPlan`
       * has always returned its diagnostics on the committed arm; this is the
       * v1 path catching up.
       */
      readonly diagnostics: readonly PlanDiagnostic[];
      /** The packet the accepted attempt was prompted with. */
      readonly packet: ContextPacket;
      readonly seq: number;
      readonly path: string;
      /** 1 or 2. */
      readonly attempts: number;
    }
  | {
      readonly outcome: 'failed';
      readonly failure: NodeFailureError;
      readonly attempts: number;
    }
  | {
      readonly outcome: 'needs-human';
      readonly diagnostics: readonly PlanDiagnostic[];
      readonly attempts: number;
    };

/**
 * AC3's first half — the refusal that costs a table read.
 *
 * Two conditions, and they are different failures wearing the same reason. A
 * provider with **no probed row** is one DeFlow has never shaken hands with,
 * and 07 §6.1's rule is that a documentation claim is never believed over a
 * handshake. A provider whose row exists but whose adapter is `prompt-only` can
 * be spawned — it simply cannot be *held* to a schema, and a planner whose
 * output is only checked after the fact is a planner that has already spent the
 * quota by the time the contract fails.
 */
function admitPlanner(
  node: NodeId,
  provider: string,
  capabilities: readonly { provider: string; structuredOutput: string }[],
): NodeFailureError | null {
  const entry = capabilities.find((candidate) => candidate.provider === provider);
  if (entry === undefined) {
    return new NodeFailureError(
      `the planner is scheduled onto ${provider}, which has no row in provider_capabilities: ` +
        'DeFlow never believes a documentation claim over a handshake, so the node is refused ' +
        'before it is spawned rather than discovered to be unschedulable mid-turn',
      {
        reason: 'adapter.capability-missing',
        class: 'permanent',
        detail: { node, provider, code: 'PROVIDER_NOT_PROBED' },
      },
    );
  }
  if (entry.structuredOutput !== 'native') {
    return new NodeFailureError(
      `the planner is scheduled onto ${provider}, which takes no schema flag, so its return ` +
        'contract could only be enforced after the tokens were spent. The plan is data, not ' +
        'prose (F2.1): the node is refused before it is spawned',
      {
        reason: 'adapter.capability-missing',
        class: 'permanent',
        detail: { node, provider, code: 'NO_STRUCTURED_OUTPUT' },
      },
    );
  }
  return null;
}

/** A return that is not a schema-valid `PlanGraph`, with Ajv's own pointers. */
function schemaInvalid(node: NodeId, attempt: number, issues: readonly SchemaIssue[]) {
  return new NodeFailureError(
    `the planner's return does not validate against ${PLANGRAPH_SCHEMA_ID}` +
      (issues.length === 0
        ? ": nothing arrived in the result envelope's structured output field"
        : `: ${issues.map((issue) => `${issue.pointer || '/'} ${issue.message}`).join('; ')}`),
    {
      reason: 'contract.schema-invalid',
      class: 'permanent',
      detail: { node, attempt, issues: issues.map((issue) => ({ ...issue })) },
    },
  );
}

/**
 * The envelope fields DeFlow owns, stamped over whatever the planner wrote.
 *
 * Not leniency and not repair: a planner cannot know the run id it is planning
 * for, the digest of the spec it was handed, or the content address of the
 * document it is still writing. Accepting its guesses would make the `plan`
 * table's primary key a value an agent chose.
 */
function stampEnvelope(
  returned: Record<string, unknown>,
  options: CompilePlanOptions,
): Record<string, unknown> {
  return {
    ...returned,
    schemaId: PLANGRAPH_SCHEMA_ID,
    runId: options.runId,
    version: 1,
    parent: null,
    taskSpecHash: options.spec.specHash,
    createdBy: 'planner',
    createdAt: new Date(options.ts).toISOString(),
  };
}

function appendValidationFailed(
  options: CompilePlanOptions,
  attempt: number,
  hash: string,
  diagnostics: readonly PlanDiagnostic[],
): void {
  appendEvents(options.db, [
    {
      runId: options.runId,
      ts: options.ts,
      kind: 'plan.validation_failed',
      v: 1,
      epoch: options.epoch,
      nodeId: options.node,
      attempt,
      payload: {
        version: 1,
        planHash: hash,
        by: 'planner',
        attempt,
        diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })),
      },
    },
  ]);
}

function appendNeedsHuman(
  options: CompilePlanOptions,
  diagnostics: readonly PlanDiagnostic[],
): void {
  appendEvents(options.db, [
    {
      runId: options.runId,
      ts: options.ts,
      kind: 'run.needs_human',
      v: 3,
      epoch: options.epoch,
      payload: {
        reason: 'plan-invalid',
        // Rendered on one line, because `run.needs_human.detail` is a
        // single-line field and the Operator's board cell is one row. The full
        // multi-line rendering is on each `plan.validation_failed`, which is
        // what the escalation view links through to.
        detail: renderPlanDiagnostics(diagnostics).replaceAll('\n', ' · '),
      },
    },
  ]);
}

/**
 * Compiles, validates and persists `PlanGraph` v1.
 *
 * Returns on every arm; appends `plan.validation_failed` and `run.needs_human`
 * itself, because those are records of what the compiler did rather than
 * decisions about what happens next.
 */
export async function compilePlanV1(options: CompilePlanOptions): Promise<CompilePlanOutcome> {
  // AC2 — read at plan time, every time. Nothing is cached, so nothing is stale.
  const rows = listProviderCapabilities(options.db);
  const capabilities = plannerCapabilityList(rows, options.probedEvent);

  const refusal = admitPlanner(options.node, options.provider, capabilities);
  if (refusal !== null) return { outcome: 'failed', failure: refusal, attempts: 0 };

  const effort = strongestEffort(options.provider)?.effort ?? null;
  const schemaPath = join(options.schemasDir, schemaFileName(PLANGRAPH_SCHEMA_ID));

  let carried: readonly PlanDiagnostic[] = [];

  for (let attempt = 0; attempt < PLANNER_ATTEMPT_LIMIT; attempt += 1) {
    const packet = await buildPlannerPacket({
      runId: options.runId,
      nodeId: options.node,
      attempt,
      builtAtEvent: options.probedEvent,
      target: {
        provider: options.provider,
        model: options.model,
        maxContext: options.maxContext,
      },
      spec: options.spec,
      ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
      facts: options.facts,
      capabilities,
      // KAR-23.13 — the same two constants `plan/validate.ts` enforces against,
      // so what the packet promises the planner and what validation refuses are
      // one fact. The rules segment they render ships on attempt 0, which is
      // the point: three consecutive runs had their *first* plan rejected, and
      // a rule carried only on the retry arrives one turn too late.
      performable: {
        nodeTypes: PERFORMABLE_NODE_TYPES,
        toolKinds: PERFORMABLE_TOOL_KINDS,
      },
      // §3.5 — the retry's packet carries the diagnostics **verbatim**. A
      // `task.brief`, not a fact: this is an instruction to the planner about
      // the document it just wrote, not something anybody measured.
      ...(carried.length === 0
        ? {}
        : {
            segments: [await plannerDiagnosticsSegment(carried, options.probedEvent)],
          }),
    });

    const prompt = renderPacket(packet);
    const turn = await options.agent.plan({ prompt, attempt, effort, schemaPath });

    // AC3 — the document is read from the result envelope's structured output
    // field, or it is not read at all. No extraction, no regex, no fallback.
    if (!turn.structuredOutput.present) {
      return {
        outcome: 'failed',
        failure: schemaInvalid(options.node, attempt, []),
        attempts: attempt + 1,
      };
    }

    const issues = options.schemas.validate(PLANGRAPH_SCHEMA_ID, turn.structuredOutput.value);
    if (issues.length > 0) {
      return {
        outcome: 'failed',
        failure: schemaInvalid(options.node, attempt, issues),
        attempts: attempt + 1,
      };
    }

    const stamped = stampEnvelope(turn.structuredOutput.value as Record<string, unknown>, options);
    const parsed = parsePlanGraph(stamped);
    if (!parsed.success) {
      return {
        outcome: 'failed',
        failure: schemaInvalid(
          options.node,
          attempt,
          parsed.issues.map((issue) => ({
            pointer: `/${issue.path.join('/')}`,
            message: issue.message,
          })),
        ),
        attempts: attempt + 1,
      };
    }

    // AC4 — the identity is computed here, over the document as it will be
    // stored, and never taken from what the planner asserted.
    const graph: PlanGraph = {
      ...parsed.data,
      planHash: await planHash(parsed.data as unknown as Record<string, unknown>),
    };

    // AC9 — the *whole* of §3, on every version, through the one entry point
    // that can also ask git about a node id.
    const { diagnostics, spec } = await validatePlanVersion({
      plan: graph,
      spec: options.spec,
      caps: planTimeCapabilities(rows, () => options.maxContext),
      estimatePacketTokens: options.estimatePacketTokens ?? (() => 0),
      refs: options.refs,
    });
    if (hasBlockingDiagnostic(diagnostics)) {
      appendValidationFailed(options, attempt, graph.planHash, diagnostics);
      carried = diagnostics;
      continue;
    }

    const persisted = await persistPlanVersion(options.db, {
      runDir: options.runDir,
      graph,
      by: 'planner',
      planner: { model: options.model, effort, tier: PLAN_V1_TIER },
      diagnostics,
      ts: options.ts,
      epoch: options.epoch,
      nodeId: options.node,
      attempt,
    });

    return {
      outcome: 'compiled',
      plan: graph,
      // AC3 — validation's output, not the planner's input: the spec that
      // arrived is never the one that travels on.
      spec,
      diagnostics,
      packet,
      seq: persisted.seq,
      path: persisted.path,
      attempts: attempt + 1,
    };
  }

  // Both attempts produced a plan that did not validate. §3.5: escalate with
  // the diagnostics rendered, and make no third automatic attempt.
  appendNeedsHuman(options, carried);
  return { outcome: 'needs-human', diagnostics: carried, attempts: PLANNER_ATTEMPT_LIMIT };
}

/**
 * The diagnostics the retry is handed (§3.5), as a segment the planner
 * allowlist accepts.
 *
 * A `task.brief` rather than a `fact`, and the distinction is not cosmetic: a
 * fact is something DeFlow measured about the repository, and this is an
 * instruction about the document the planner just wrote. Filing it as a fact
 * would put DeFlow's own complaint on the same footing as
 * `finding/test-command`.
 *
 * `sourceEvent` is the `plan.validation_failed` that carries the same
 * diagnostics, so F10.3's click-through from this segment lands on the record
 * of the failure rather than on the packet that reported it.
 */
function plannerDiagnosticsSegment(
  diagnostics: readonly PlanDiagnostic[],
  sourceEvent: number,
): Promise<Segment> {
  return contextSegment({
    id: 'plan-diagnostics',
    kind: 'task.brief',
    text:
      'Your previous plan did not pass validation. Fix exactly these, and change nothing ' +
      `else:\n\n${renderPlanDiagnostics(diagnostics)}`,
    sourceEvent: EventSeqSchema.parse(sourceEvent),
  });
}
