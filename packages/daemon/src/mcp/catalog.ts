/**
 * KAR-05.6 — the M1 workflow tool set, and which phase may call each one.
 *
 * Three tools, all of them about the *orchestration* layer rather than the
 * repository: read a `Fact` off the blackboard, pull an artifact by handle,
 * propose a `PlanPatch`. Everything a vendor already does well — edit a file,
 * run a command — stays with the vendor. What no vendor can do is reach the
 * run it is a node of, and that is the whole surface here.
 *
 * **Both schemas, on every tool.** MCP's `outputSchema` is what turns a tool
 * result from prose into `structuredContent` the SDK validates before it
 * reaches the model; a tool with only an `inputSchema` hands back a string and
 * hopes. The types are Zod raw shapes because that is what `registerTool`
 * consumes directly (`ZodRawShapeCompat`), and the same shapes are what the
 * host validates against on its side of the socket.
 *
 * **The phase table is data, not a branch.** A phase is a set of tool names,
 * and unlocking one is a set difference the shim can turn into
 * `enable()`/`disable()` plus one `sendToolListChanged()`. EPIC-11 owns the
 * real phase vocabulary; the two here are the two the plan needs at M1, and
 * `WORKFLOW_PHASES` is what a later story extends.
 */
import { z } from 'zod';

export const WORKFLOW_PHASES = ['analysis', 'implementation'] as const;

export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export function isWorkflowPhase(value: string): value is WorkflowPhase {
  return (WORKFLOW_PHASES as readonly string[]).includes(value);
}

export const READ_FACT = 'DeFlow.readFact';
/**
 * KAR-09.5 AC3 — `DeFlow_read_artifact`, spelled exactly as the handle line
 * every offloaded body leaves in the prompt spells it
 * (docs/08-context-and-memory.md §5.2).
 *
 * The odd one out in this file, and deliberately: a tool name the agent is
 * *told to call in prose* has to match the tool the host serves, or the line
 * costs a wasted turn and a confused model. The underscore spelling is also the
 * portable one — a `.` is legal in MCP and illegal in the Anthropic API's tool
 * names, which is what an `mcp__<server>__<tool>` bridge produces.
 */
export const READ_ARTIFACT = 'DeFlow_read_artifact';
export const PROPOSE_PLAN_PATCH = 'DeFlow.proposePlanPatch';

/** How much of an artifact a tool result will inline before it truncates.
 * A tool result travels back through the agent's context window, so "the whole
 * artifact" is not a safe default for a store that holds multi-megabyte logs. */
export const ARTIFACT_INLINE_LIMIT_BYTES = 64 * 1024;

export interface WorkflowTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  readonly outputSchema: z.ZodRawShape;
  /** The phases in which this tool is callable. */
  readonly phases: readonly WorkflowPhase[];
}

const readFact: WorkflowTool = {
  name: READ_FACT,
  title: 'Read a workflow fact',
  description:
    'Read a fact from the run blackboard by key, for example "finding/auth-uses-jwt". ' +
    'The read is recorded against this node, which is what lets DeFlow taint this ' +
    'node if the fact is later invalidated.',
  inputSchema: {
    key: z.string().min(1).describe('The fact key, "<kind>/<slug>" or "ext:<namespace>/<key>".'),
  },
  outputSchema: {
    factId: z.string(),
    key: z.string(),
    kind: z.string(),
    schemaId: z.string(),
    value: z.unknown(),
    confidence: z.string(),
  },
  phases: ['analysis', 'implementation'],
};

const readArtifact: WorkflowTool = {
  name: READ_ARTIFACT,
  title: 'Read an artifact by handle',
  description:
    'Fetch the content behind a handle. An artifact:// handle resolves to the full body ' +
    "from the run's content-addressed store — this is how you pull back a body the " +
    'context packet replaced with a one-line handle. A file://<path>#L12-L40 handle ' +
    'resolves to exactly those lines of that file in your worktree, subject to the same ' +
    'permission level and path scope as any other read. Content above the inline limit ' +
    'comes back truncated with "truncated": true.',
  inputSchema: {
    handle: z
      .string()
      .min(1)
      .describe(
        'artifact://<64 hex sha256> as printed in a handle line, or ' +
          'file://<repo-relative path>#L12-L40.',
      ),
  },
  outputSchema: {
    handle: z.string(),
    bytes: z.number().int().nonnegative(),
    text: z.string(),
    truncated: z.boolean(),
  },
  phases: ['analysis', 'implementation'],
};

const proposePlanPatch: WorkflowTool = {
  name: PROPOSE_PLAN_PATCH,
  title: 'Propose a change to the plan',
  description:
    'Propose a PlanPatch against the running plan. The patch is recorded as a proposal; ' +
    "whether it is applied, queued or rejected is the policy engine's decision, not this " +
    "call's. Proposing is never applying.",
  inputSchema: {
    patch: z.unknown().describe('A DeFlow.planpatch.v1 document.'),
    /**
     * KAR-11.3 AC6 — required, and never defaulted to "whatever is current".
     *
     * Defaulting would be a silent rebase: the proposal would be evaluated
     * against a graph the proposer never saw, applying its reason to a plan it
     * was never about. 06 §4.2 refuses that explicitly, so a proposer that
     * cannot say which version it read cannot propose.
     */
    basePlanHash: z
      .string()
      .min(1)
      .describe(
        'The planHash of the plan version you read, "sha256-<64 hex>". The proposal is ' +
          'rejected with PATCH_STALE if another patch has landed since; re-read the plan ' +
          'and propose again.',
      ),
  },
  outputSchema: {
    patchId: z.string(),
    accepted: z.boolean(),
    detail: z.string(),
  },
  phases: ['implementation'],
};

/** In the order the story introduces them; the order tools/list reports. */
export const M1_TOOLS: readonly WorkflowTool[] = [readFact, readArtifact, proposePlanPatch];

const BY_NAME: ReadonlyMap<string, WorkflowTool> = new Map(
  M1_TOOLS.map((tool) => [tool.name, tool]),
);

export function toolByName(name: string): WorkflowTool | undefined {
  return BY_NAME.get(name);
}

export function toolsForPhase(phase: WorkflowPhase): readonly WorkflowTool[] {
  return M1_TOOLS.filter((tool) => tool.phases.includes(phase));
}

export function toolNamesForPhase(phase: WorkflowPhase): string[] {
  return toolsForPhase(phase).map((tool) => tool.name);
}
