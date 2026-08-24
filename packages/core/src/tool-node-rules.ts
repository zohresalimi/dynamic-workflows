/**
 * KAR-23.13 — the three **static** refusals of a `tool` node, in one place, as
 * data.
 *
 * On 2026-08-24 `run_20260824T174326Z_3b9ba1` validated a plan, fired
 * `run.started`, and lost all fourteen of its nodes inside a second: one
 * `safety.permission-unschedulable` — *"tool node branch-setup asks for
 * permission level full"* — and thirteen `dependency.failed` behind it. The
 * refusal was correct. What was wrong is *where it happened*: `node.type`,
 * `tool.kind`, `permission` and the `run` line are all plan content, fixed the
 * moment the planner wrote the document, and every one of them was knowable
 * when validation ran. The planner was never told it had made a refusable
 * choice, so it could not repair it; the run died instead.
 *
 * This module is the answer, and its shape is the point: **one hand-written
 * copy of each sentence in the workspace**. `validate-plan.ts` turns the
 * refusals into repairable diagnostics before the run starts, and
 * `packages/daemon/src/pipeline/tool-node.ts` throws them as `NodeFailure`s
 * when a plan reaches `perform()` anyway — a resumed run, a document compiled
 * by an older build, a hand-written plan. Defence in depth is the contract:
 * this story moves *where* the three are discovered and adds nothing to what
 * they refuse.
 *
 * **In `@DeFlow/core` and not in the daemon**, which is forced rather than
 * chosen: `plan/validate.ts` may not import from `pipeline/` (see the note on
 * `packages/daemon/src/exec/performable.ts` — `live-nodes.ts` cycles, and the
 * validator has no business reaching into the pipeline at all). Core already
 * owns both halves of the vocabulary these rules need, `FULL_IS_NOT_A_SANDBOX`
 * and `destructiveShellLine`, so this is where they can be *implemented*
 * rather than mirrored. The one thing core cannot know — which tool kinds the
 * daemon composes a performer for — is passed in, exactly as `caps` and
 * `performable` already are.
 *
 * Verifies: KAR-23.13
 */
import { destructiveShellLine } from './destructive-command.ts';
import { FULL_IS_NOT_A_SANDBOX } from './full-permission.ts';
import type { PermissionLevel, ToolKind, ToolNode } from './plan-graph.ts';
import { resolvePosix } from './scope.ts';
import { toSingleLine } from './text.ts';

/**
 * The synthetic worktree root a run line is judged against before a worktree
 * exists.
 *
 * The deny list's context-reading rules (`git reset --hard` outside the tree,
 * a shallow `rm -rf`, a database client's host) only ever ask *"does this path
 * argument resolve outside the node's own tree?"*. At plan time the tree has no
 * path yet, so the rules judge the line against this root, with `cwd` resolved
 * from the node's own declared `tool.cwd` exactly as `perform()` resolves it
 * against the real one. Every **relative** argument gets the identical verdict;
 * the only divergence is an *absolute* path argument that happens to sit inside
 * the real worktree — a path a planner cannot know and must never write. So the
 * plan-time verdict is equal-or-stricter than the run-time one, never laxer,
 * and a strictly-stricter verdict costs one repairable diagnostic rather than a
 * security hole.
 */
export const PLAN_TIME_COMMAND_CONTEXT_ROOT = '/deflow/worktree';

/** How long a run line is allowed to be when it is quoted back in a message.
 * The whole line is in the plan document; this is what a human reads. */
const RUN_LINE_IN_MESSAGE = 120;

/** One static refusal a `tool` node earned, spelled for both of its readers. */
export interface ToolNodeRefusal {
  /** The stable rule name — the join a reader keeps when a message is
   * reworded. Never rendered; always greppable. */
  readonly rule: 'permission-full' | 'kind-unperformable' | 'destructive-run-line';
  /** How plan validation files it. */
  readonly code:
    | 'TOOL_PERMISSION_UNSCHEDULABLE'
    | 'TOOL_KIND_UNPERFORMABLE'
    | 'TOOL_COMMAND_REFUSED';
  /** How the performer fails it, when a plan reached execution by a path
   * validation does not gate. */
  readonly reason:
    | 'safety.permission-unschedulable'
    | 'adapter.capability-missing'
    | 'safety.execution-boundary';
  /** The diagnostic's `key`: the level, the kind, or the deny-list rule. */
  readonly key: string;
  /** One line, written for both readers: what is refused, and what to do
   * instead. */
  readonly message: string;
  /** `NodeFailure.detail`, and the structured half of the diagnostic. */
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * What the rules read of a node.
 *
 * `ToolNode` satisfies it structurally, so `validate-plan.ts` passes the plan
 * node itself. The performer passes `command.permission` instead of
 * `node.permission` so that run time judges the level actually being
 * *executed* — they are the same value (`decide.ts` copies it verbatim from
 * the plan and never from the projection), and asking the performer to prove
 * that again at every call would be a second answer to a settled question.
 */
export interface ToolNodeUnderRule {
  readonly id: string;
  readonly permission: PermissionLevel;
  readonly tool: ToolNode['tool'];
}

/** The `run`/`cwd` of a `script` node, or `null` for a kind that has neither. */
function scriptOf(tool: ToolNode['tool']): { readonly run: string; readonly cwd: string } | null {
  return tool.kind === 'script' ? { run: tool.run, cwd: tool.cwd ?? '.' } : null;
}

function permissionFullRefusal(node: ToolNodeUnderRule): ToolNodeRefusal | null {
  if (node.permission !== 'full') return null;
  return {
    rule: 'permission-full',
    code: 'TOOL_PERMISSION_UNSCHEDULABLE',
    reason: 'safety.permission-unschedulable',
    key: 'full',
    // The repair comes **before** the rationale, and that ordering is load
    // bearing rather than a taste: `singleLine()` caps a diagnostic message at
    // 400 characters, `FULL_IS_NOT_A_SANDBOX` is 167 of them, and a node id may
    // be 63 more. When a long id pushes the line over, what `toSingleLine`
    // trims is the tail — so the tail is the sentence the planner can act on
    // least, and the level it should have asked for survives every id.
    message: toSingleLine(
      `tool node '${node.id}' asks for permission level 'full', which is refused at validation ` +
        "— ask for the least level the work needs: 'read', 'worktree' or 'worktree+net'. " +
        `Nothing authorises full on a tool node today: ${FULL_IS_NOT_A_SANDBOX}`,
    ),
    detail: { node: node.id, permission: node.permission },
  };
}

function kindRefusal(
  node: ToolNodeUnderRule,
  performableKinds: readonly ToolKind[],
): ToolNodeRefusal | null {
  const kind = node.tool.kind;
  if (performableKinds.includes(kind)) return null;
  return {
    rule: 'kind-unperformable',
    code: 'TOOL_KIND_UNPERFORMABLE',
    reason: 'adapter.capability-missing',
    key: kind,
    // Verbatim from KAR-23.9's `performableDiagnostics`, which is the whole
    // point of the move: the sentence a planner has already been trained on
    // by three runs of diagnostics does not get reworded because it changed
    // files. `validate-plan.test.ts` pins it.
    message: toSingleLine(
      `tool node '${node.id}' is of kind '${kind}', and this daemon can run tool nodes of ` +
        `kind ${[...performableKinds].join(', ')} only. Express the call as a script node, or ` +
        'drop it.',
    ),
    detail: { node: node.id, kind },
  };
}

function destructiveRefusal(node: ToolNodeUnderRule): ToolNodeRefusal | null {
  const script = scriptOf(node.tool);
  if (script === null) return null;
  const root = PLAN_TIME_COMMAND_CONTEXT_ROOT;
  const reason = destructiveShellLine(script.run, {
    worktree: root,
    cwd: resolvePosix(root, script.cwd),
    scrubbedEnv: [],
  });
  if (reason === null) return null;
  // The rule's own name (`terraform-apply`, `git-push-force`), which is what
  // the performer already puts in `NodeFailure.detail.rule` — so the plan-time
  // key and the run-time detail are the same word and a ledger grep finds both
  // ends of one incident. `reasonCode` is the renderable pair and stays out of
  // the join for that reason.
  const rule = reason.detail ?? reason.code;
  const quoted =
    script.run.length <= RUN_LINE_IN_MESSAGE
      ? script.run
      : `${script.run.slice(0, RUN_LINE_IN_MESSAGE)}…`;
  return {
    rule: 'destructive-run-line',
    code: 'TOOL_COMMAND_REFUSED',
    reason: 'safety.execution-boundary',
    key: rule,
    message: toSingleLine(
      `tool node '${node.id}' would run '${quoted}', which the F5.6 deny list refuses as ` +
        `${rule}: a plan script is not a licence to run an infrastructure action. Plan a ` +
        "'human' node that asks for it instead of a script that performs it.",
    ),
    detail: { node: node.id, rule },
  };
}

/**
 * Every static refusal `node` earns, in the order `perform()` checks them —
 * so `[0]` is the one the performer would have thrown.
 *
 * Pure, total, no I/O, and it returns **all** of them rather than the first,
 * for the reason `validatePlan` returns all of its diagnostics: a plan whose
 * node is both `full` *and* `terraform apply` must not cost two planner turns
 * to repair, and §3.5 allows exactly one retry.
 */
export function toolNodeRefusals(
  node: ToolNodeUnderRule,
  performableKinds: readonly ToolKind[],
): readonly ToolNodeRefusal[] {
  return [
    permissionFullRefusal(node),
    kindRefusal(node, performableKinds),
    destructiveRefusal(node),
  ].filter((refusal): refusal is ToolNodeRefusal => refusal !== null);
}
