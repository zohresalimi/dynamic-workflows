/**
 * KAR-23.10 — the three mediation fronts, composed for one node attempt.
 *
 * This is the module that was missing on 2026-08-24. `acpPermissionHandlers`,
 * `acpFsHandlers` and `acpTerminalHandlers` were complete, tested and exported
 * from `../index.ts`, and **nothing imported any of them**. `runAcpNode` takes
 * `handlers` as data and no daemon call site supplied it, so
 * `session/request_permission` was answered with `-32601 Method not found` and
 * the whole EPIC-08/EPIC-13 stack behind it — `permission-ladder.ts`,
 * `permission-service.ts`, `command-mediation.ts`, `path-mediation.ts`,
 * `scope-diff.ts`, `human/escalation.ts` — was unreachable from the execution
 * path. Four implementation nodes ran twenty-two minutes and wrote zero files,
 * and every one of them completed: an agent that gets `-32601` concludes the
 * client is read-only, because that is exactly what `-32601` means. The same
 * shape as KAR-23.5's `runShimNode` and KAR-23.9's `tool` performer — built,
 * exported, never called.
 *
 * **A composition root, not a policy.** Every decision below this line already
 * exists and is already tested: which level allows what is `@DeFlow/core`'s
 * `decidePermission`, what a path resolves to is `createPathMediator`'s, which
 * commands are allowed is `createCommandMediator`'s, who gets asked is
 * `createPermissionEscalations`'. This file wires them, once, per attempt.
 * `packages/daemon/test/integration/permission-escalation.test.ts` has proved
 * that exact wiring end to end against a real agent since KAR-13.4 — which is
 * the strongest argument available that the stack was complete and the only
 * thing missing was a production caller.
 *
 * It lives here rather than under `../services/fronts/` on purpose:
 * `../../test/acp-fronts-shape.test.ts` holds those files to a line count and
 * a no-policy rule so that ACP v2's deletion of `fs/*` and `terminal/*` stays a
 * deletion. Composition is legitimately policy-shaped, so it belongs one
 * directory up, beside the performer that needs it.
 *
 * **The shim route needs no equivalent, and adding one would be a mistake.**
 * `runShimNode` has no client and therefore no client methods to mediate: it is
 * a one-shot vendor CLI invocation with no JSON-RPC client side, so there is no
 * `session/request_permission` to answer. Its containment is the OS sandbox
 * (`sandbox: { … }` on the `runShimNode` request, `@anthropic-ai/sandbox-runtime`).
 * And it never runs above `read` at all: `runShimTurn` passes the **minted**
 * `shimCapabilityRow` with `mediatedExecution: false`, so `admit()` refuses a
 * `worktree`-level node with `safety.permission-unschedulable` before a process
 * exists. The asymmetry is the design, not an oversight.
 *
 * **`CommandsConfig` is `{ allow: [] }` here, and that is a stated gap.**
 * `DeFlowConfigSchema` has no `commands:` block — docs/09 §10.3 specifies one on
 * `DeFlow.config.ts` and it was never implemented — so a repository cannot
 * declare the verbs it trusts. The consequence, stated rather than discovered:
 * **every `terminal/create` and every `execute`-kind permission request gates to
 * the operator** (`not-allowlisted` → `escalatesPermission` → `human.requested`).
 * That is loud, safe, auditable and answerable through the approvals API, and it
 * is a strict improvement on twenty-two minutes of `-32601`. It is not the end
 * state: §10.5's own frequency argument — *"a gate that fires 200 times in a run
 * is auto-clicked"* — says a repository must be able to declare its verbs, and
 * that is a plan change (README §9) with its own story. Shipping a hard-coded
 * default allowlist here is explicitly rejected: it would be DeFlow deciding
 * which binaries a repository trusts.
 *
 * Verifies: KAR-23.10
 */
import type { ClientHandlers } from '@DeFlow/adapters';
import type { Clock, CommandsConfig, Db, NodeId, PermissionLevel, RunId } from '@DeFlow/core';
import { EVENT_CURRENT_VERSIONS, permissionScopeFrom } from '@DeFlow/core';
import { appendEvents } from '@DeFlow/ledger';
import { createPermissionEscalations } from '../human/escalation.ts';
import { createCommandMediator, worktreeCommandPolicy } from '../services/command-mediation.ts';
import { acpFsHandlers } from '../services/fronts/acp-fs.ts';
import { acpPermissionHandlers } from '../services/fronts/acp-permission.ts';
import { acpTerminalHandlers } from '../services/fronts/acp-terminal.ts';
import { createFsService } from '../services/fs-service.ts';
import { createPathMediator, permissionDeniedPayload } from '../services/path-mediation.ts';
import { ladderDecider, ladderDeniedPayload } from '../services/permission-ladder.ts';
import { createPermissionService } from '../services/permission-service.ts';
import { createTerminalService } from '../services/terminal-service.ts';

/**
 * The repository's declared verbs.
 *
 * Empty until a `commands:` block exists to read one from — see the module doc
 * for why that is a plan change rather than a default invented here.
 */
export const UNDECLARED_COMMANDS: CommandsConfig = { allow: [], readOnly: [], allowDomains: [] };

export interface NodeMediationInput {
  readonly db: Db;
  readonly runId: RunId;
  readonly epoch: number;
  /** Time enters here and nowhere else (NF9) — the performer's own `ctx.clock`. */
  readonly clock: Clock;
  readonly nodeId: NodeId;
  readonly attempt: number;
  /** The node's declared permission level, off its `StartNode`. */
  readonly level: PermissionLevel;
  /**
   * The node's **provisioned worktree**, never the repository cwd.
   *
   * The same value `runAcpNode` is given as `worktree` and passes as
   * `session/new`'s `cwd`, so `contain()`, `relativeToWorktree` and
   * `pathScopeMatches` all resolve against one root. A cwd here would make the
   * scope check answer about a directory the agent is not working in.
   */
  readonly worktree: string;
  /** The node's declared write globs (`pathScopes.write`). */
  readonly pathScopes: readonly string[];
  /** `buildChildEnv()`'s dropped names, so a scrubbed variable is nameable. */
  readonly scrubbedEnv: readonly string[];
  /** `buildChildEnv()`'s environment, for anything the terminal front spawns. */
  readonly childEnv: Readonly<Record<string, string>>;
  /** The repository's declared verbs. See `UNDECLARED_COMMANDS`. */
  readonly commands?: CommandsConfig;
  /** The node's brief, so an approval queue row reads without opening the plan. */
  readonly brief?: string | undefined;
  /** Aborts an outstanding escalation when nobody is going to answer it. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * The `ClientHandlers` map for one node attempt: `fs/*`, `terminal/*` and
 * `session/request_permission`, each in front of the service that decides it.
 *
 * One escalation service across all three, deliberately: an `_always` chosen on
 * one surface is read by the others, because the run-scoped policy lives in the
 * ledger rather than in a closure (KAR-13.4 AC4).
 */
export function nodeClientHandlers(input: NodeMediationInput): ClientHandlers {
  const { db, runId, nodeId, attempt, epoch, clock, level, worktree } = input;

  const scope = permissionScopeFrom(input.commands ?? UNDECLARED_COMMANDS, {
    worktree,
    scrubbedEnv: input.scrubbedEnv,
  });

  const append = (kind: string, payload: unknown): void => {
    appendEvents(db, [
      {
        runId,
        ts: clock.now(),
        kind,
        v: (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)[kind] ?? 1,
        epoch,
        nodeId,
        attempt,
        payload,
      },
    ]);
  };

  // KAR-13.4's port: the `human.requested` and its `node_wake` in one
  // transaction, the poll for an answer that arrives on a different call
  // entirely, and a `permission.decided` for **every** decision including the
  // ones nobody saw (AC9).
  //
  // `sessionId` is deliberately absent: it is unknown until `session/new`
  // answers, which is inside `runAcpNode` and after these handlers are built.
  // It is optional on `EscalationPorts`, and an invented one would be a
  // recorded measurement of something nobody measured.
  const escalations = createPermissionEscalations({
    db,
    runId,
    nodeId,
    attempt,
    epoch,
    clock,
    level,
    worktree,
    pathScopes: input.pathScopes,
    ...(input.brief === undefined ? {} : { brief: input.brief }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const fs = createFsService({
    root: worktree,
    policy: escalations.pathPolicy(createPathMediator({ level, scope })),
  });

  const terminal = createTerminalService({
    root: worktree,
    childEnv: input.childEnv,
    policy: worktreeCommandPolicy(
      createCommandMediator({
        level,
        scope,
        escalates: escalations.escalates,
        escalate: escalations.askAboutCommand,
        record: escalations.recordCommand,
      }),
      {
        onDenied: (denial) =>
          append('permission.denied', permissionDeniedPayload(denial, { node: nodeId, attempt })),
      },
    ),
  });

  const permission = createPermissionService(
    ladderDecider({
      level,
      scope,
      pathScope: input.pathScopes,
      escalates: escalations.escalates,
      escalate: escalations.askAboutRequest,
      record: (decision) => {
        escalations.recordLadder(decision);
        // KAR-08.7 AC2 — the row the node inspector renders `requested` beside
        // `declared` from. `null` for anything that is not a plain,
        // communicated denial, which is why the ladder's own record above is
        // unconditional and this one is not.
        const denied = ladderDeniedPayload(decision, { node: nodeId, attempt });
        if (denied !== null) append('permission.denied', denied);
      },
    }),
  );

  return {
    ...acpFsHandlers(fs),
    ...acpTerminalHandlers(terminal),
    ...acpPermissionHandlers(permission),
  };
}
