/**
 * KAR-12.5 AC4 — running one fix node, and reading its ordering off the branch
 * (docs/10-verification-gates.md §7).
 *
 * §7's three steps — write a failing test, make it pass, stop — are an
 * *instruction* in the fix node's brief, and an instruction is not a guarantee.
 * The only thing that knows whether they happened is `DeFlow/<runId>__<nodeId>`
 * and the gate's answer at each commit on it, so that is what this module reads:
 *
 *     runAcpNode → commits since base → gate at each commit → repairOrdering
 *
 * Three decisions carry the design.
 *
 * **The turn goes through the real node runner.** `runAcpNode` writes
 * `node.scheduled`, `node.started` and the terminal event, mediates every file
 * write and every command through the daemon's own services, and journals the
 * spend. A repair path with its own miniature runner beside it would be a second
 * place for the permission model, the transcript and the accounting to be
 * subtly different, and the difference would show up first in the one node type
 * whose whole purpose is to edit code.
 *
 * **The gate is re-run at each commit, in the node's own worktree.** Not `git
 * show`, not a diff heuristic: the claim is *"the gate re-run at that commit
 * fails"*, and the only thing that can answer it is the gate. The worktree is
 * left back on its branch tip afterwards — a node left detached at `HEAD~1`
 * would hand the re-run gate a tree with no fix in it, which is exactly §5.2's
 * stale green with the sign flipped.
 *
 * **A branch that does not show the ordering is an outcome, not an error.**
 * `repair.no_failing_test` is the arm §7 cares about, and the caller routes it
 * to a human. Throwing here would put it through the retry ladder instead,
 * which spends another attempt proving the same thing.
 *
 * Time enters through the injected `Clock` (NF9).
 */
import type { AcpNodeRequest, LedgerSink } from '@DeFlow/adapters';
import { runAcpNode } from '@DeFlow/adapters';
import type {
  Clock,
  Handle,
  NodeFailure,
  NodeId,
  PermissionLevel,
  ProviderId,
  RunId,
} from '@DeFlow/core';
import type { GateDefinition, RepairCommit, RepairOrdering } from '@DeFlow/gates';
import { assertRepairScope, repairOrdering, runGate } from '@DeFlow/gates';
import { runGit } from '../git/run-git.ts';

export interface FixNodeRequest {
  readonly runId: RunId;
  /** The fix node's own id — `fix-<findingId>`. */
  readonly nodeId: NodeId;
  /** 0-based, matching the event envelope. */
  readonly attempt: number;
  readonly provider: ProviderId;
  readonly permission: PermissionLevel;
  /** The node's worktree, already checked out on `DeFlow/<runId>__<nodeId>`. */
  readonly worktree: string;
  /** The commit the branch started from: everything after it is this attempt's. */
  readonly baseSha: string;
  readonly binary: AcpNodeRequest['binary'];
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** The assembled repair packet, as text. */
  readonly prompt: string;
  /** The gate whose failure this node repairs, re-run at each commit it made. */
  readonly gate: GateDefinition;
  /** The pinned spec the re-judged verdicts are about. */
  readonly specHash: string;
  /** Whose work failed — what the re-judged verdicts name. */
  readonly evaluatedNode: NodeId;
  /** The plan's own idea of where tests live. Defaults to `DEFAULT_TEST_PATHS`. */
  readonly testPaths?: readonly string[];
  /** The fix node's declared `pathScopes.write` — what §6.2 measures against. */
  readonly declared: readonly string[];
  /** The run's protected set. Defaults to `DEFAULT_PROTECTED_PATHS`. */
  readonly protectedPaths?: readonly string[];
  /** Test files the plan marked as a contract — AC10's second half. */
  readonly contractPaths?: readonly string[];
}

export interface FixNodePorts {
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** The data directory whose `blobs/` receives the captured gate output. */
  readonly dataDir: string;
  readonly ledger: LedgerSink;
  readonly captureEvidence: (evidence: string | Uint8Array) => Handle;
  /** The ACP client methods the agent may call — the `fs/*` and `terminal/*`
   * fronts over the daemon's real services. */
  readonly handlers: Record<string, (params: never) => unknown>;
  /** Variable names KAR-08.4 removed from the child environment. */
  readonly scrubbedEnv?: readonly string[];
  /** The hermetic environment `git` children get. Absent inherits the daemon's. */
  readonly gitEnv?: Readonly<Record<string, string>>;
}

export type FixNodeOutcome =
  | {
      readonly status: 'repaired';
      readonly ordering: Extract<RepairOrdering, { ok: true }>;
      readonly commits: readonly RepairCommit[];
    }
  | {
      readonly status: 'unordered';
      readonly ordering: Extract<RepairOrdering, { ok: false }>;
      readonly commits: readonly RepairCommit[];
    }
  | {
      readonly status: 'failed';
      /** The turn's own ending — `failed`, `cancelled`, `refused`, … */
      readonly turn: string;
      /**
       * The failure `runAcpNode` recorded, when the turn ended in one.
       *
       * `null` for the other non-completed endings rather than a
       * `NodeFailureReason` invented to fill the field: a cancelled turn is not
       * a failure, and the closed taxonomy has no entry that would be true of
       * it (docs/04-domain-model.md §8).
       */
      readonly failure: NodeFailure | null;
    };

/** The commits the fix node added, oldest first. */
async function commitsSince(
  worktree: string,
  baseSha: string,
  env: Readonly<Record<string, string>> | undefined,
): Promise<readonly { sha: string; paths: readonly string[] }[]> {
  const options = env === undefined ? {} : { env };
  const listed = await runGit(worktree, ['rev-list', '--reverse', `${baseSha}..HEAD`], options);
  if (listed.exitCode !== 0) {
    throw new Error(`git rev-list ${baseSha}..HEAD failed: ${listed.stderr}`);
  }

  const commits: { sha: string; paths: readonly string[] }[] = [];
  for (const sha of listed.stdout.split('\n').filter((line) => line !== '')) {
    const shown = await runGit(
      worktree,
      ['show', '--name-only', '--format=', '--no-renames', sha],
      options,
    );
    if (shown.exitCode !== 0) throw new Error(`git show ${sha} failed: ${shown.stderr}`);
    commits.push({ sha, paths: shown.stdout.split('\n').filter((line) => line !== '') });
  }
  return commits;
}

/**
 * Runs one fix node's attempt end to end, and answers what its branch shows.
 *
 * The gate is run once per commit, which is `n` compiler invocations for `n`
 * commits and is the price of the guarantee: a cheaper check — the diff, the
 * commit message, the agent's own word — is a check of the thing being
 * claimed rather than of the claim.
 */
export async function runFixNode(
  request: FixNodeRequest,
  ports: FixNodePorts,
): Promise<FixNodeOutcome> {
  const gitOptions = ports.gitEnv === undefined ? {} : { env: ports.gitEnv };

  const turn = await runAcpNode(
    {
      runId: request.runId,
      nodeId: request.nodeId,
      attempt: request.attempt,
      provider: request.provider,
      permission: request.permission,
      worktree: request.worktree,
      binary: request.binary,
      mcpServers: [],
      prompt: request.prompt,
      ...(request.argv === undefined ? {} : { argv: request.argv }),
      ...(request.env === undefined ? {} : { env: request.env }),
    },
    {
      clock: ports.clock,
      ledger: ports.ledger,
      captureEvidence: ports.captureEvidence,
      handlers: ports.handlers,
    },
  );

  if (turn.status !== 'completed') {
    // `runAcpNode` has already appended the terminal event; a throw here would
    // add a second failure for one attempt.
    return {
      status: 'failed',
      turn: turn.status,
      failure: turn.status === 'failed' ? turn.failure : null,
    };
  }

  const branch = (
    await runGit(request.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'], gitOptions)
  ).stdout.trim();
  const made = await commitsSince(request.worktree, request.baseSha, ports.gitEnv);

  // AC10, and the ordering is the requirement: a node that wrote the gate
  // definition must fail **before** anything is judged, because a verdict
  // formed in a run where the check was edited is a verdict about nothing.
  // Everything the branch touched is measured, not only the last commit: a
  // repair that edited the check and then reverted it still ran the gate it
  // wrote.
  assertRepairScope(
    {
      gate: request.gate.id,
      worktree: request.worktree,
      declared: request.declared,
      changed: [...new Set(made.flatMap((commit) => commit.paths))],
      ...(request.protectedPaths === undefined ? {} : { protectedPaths: request.protectedPaths }),
      ...(request.contractPaths === undefined ? {} : { contractPaths: request.contractPaths }),
    },
    request.nodeId,
  );

  const commits: RepairCommit[] = [];
  try {
    for (const commit of made) {
      const checkout = await runGit(
        request.worktree,
        ['checkout', '--detach', commit.sha],
        gitOptions,
      );
      if (checkout.exitCode !== 0) {
        throw new Error(`git checkout ${commit.sha} failed: ${checkout.stderr}`);
      }
      const judged = await runGate({
        definition: request.gate,
        worktree: request.worktree,
        repoRoot: request.worktree,
        node: request.nodeId,
        evaluatedNode: request.evaluatedNode,
        specHash: request.specHash,
        dataDir: ports.dataDir,
        clock: ports.clock,
        scrubbedEnv: ports.scrubbedEnv ?? [],
      });
      commits.push({ sha: commit.sha, paths: commit.paths, outcome: judged.outcome });
    }
  } finally {
    // Back to the tip, whatever happened: the re-run gate judges the tree the
    // fix node left, and a detached worktree would hand it the wrong one.
    if (branch !== '' && branch !== 'HEAD') {
      await runGit(request.worktree, ['checkout', branch], gitOptions);
    }
  }

  const ordering = repairOrdering(
    commits,
    request.testPaths === undefined ? {} : { testPaths: request.testPaths },
  );

  return ordering.ok
    ? { status: 'repaired', ordering, commits }
    : { status: 'unordered', ordering, commits };
}
