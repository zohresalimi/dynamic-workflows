/**
 * KAR-23.9 — the `NodePerformer` that runs a `tool` node of kind `script`.
 *
 * **The half of the 2026-08-24 incident nothing else closed.** With the route
 * bug fixed (KAR-23.5), `run_20260824T110147Z_f21769` still died in under a
 * second: `byNodeType` composed `agent` and `gate`, its `branch-off-main` tool
 * node failed `internal`/`permanent` with *"nothing in this daemon knows how to
 * perform a tool node"*, and fifteen dependants followed it down as
 * `dependency.failed` — correct DAG behaviour behind a permanently dead
 * dependency. Nothing in `packages/daemon/src` ran a plan script at all.
 *
 * ## A tool script is untrusted plan content
 *
 * This is the load-bearing sentence of the whole module, and every decision
 * below follows from it. A `run` line is a string a **planner** wrote. It is
 * not a gate definition (a file in the repository, authored by the owner,
 * hashed into the run manifest), and it is not `workspace.setup` (a line in
 * `DeFlow.config.ts`, run before any agent exists to prompt-inject). It is
 * model output, and it gets exactly the confinement an agent node gets:
 *
 *  1. **It is wrapped.** `sandboxStrategy`'s own default-deny rule answers the
 *     question a non-vendor child raises — anything that is not a *known*
 *     self-sandboxing CLI is wrapped by `@anthropic-ai/sandbox-runtime`, at the
 *     node's declared level, against the node's own worktree. Verified on a
 *     real wrapper 2026-08-24: an out-of-worktree write, a read of `~/.ssh` and
 *     an egress attempt are all refused (`../../test/integration/
 *     tool-node-sandbox.test.ts` is the spec that keeps saying so).
 *  2. **A level that cannot be enforced is a refusal, never an unconfined
 *     run.** Missing bwrap/socat, missing wrapper: `safety.permission-
 *     unschedulable`, before a worktree exists.
 *  3. **`full` is refused outright.** `fullPermissionIssues`
 *     (`@DeFlow/core`'s full-permission.ts) has no production caller — F5.4's
 *     per-run opt-in is not wired to anything — so a `full` tool node today is
 *     arbitrary shell as the operator, authorised by a sentence a planner
 *     wrote. Wiring the opt-in is a named follow-on; until then the honest
 *     answer is no.
 *  4. **One shell, chosen by DeFlow.** `/bin/sh -c <run>`, with the run line as
 *     a **single argv element** — never interpolated into another command line,
 *     never `env.SHELL` (which would run the operator's rc files), never `-l`.
 *     `srt` offers a `-c <string>` form of its own; it is not used, because it
 *     would put the plan's string through a second layer of quoting DeFlow does
 *     not own.
 *  5. **The shell inherits nothing.** `env` is `buildChildEnv()`'s allowlist
 *     output (KAR-08.4); DeFlowd's own environment never reaches it. `stdin` is
 *     `ignore`, so a script that reads it fails fast instead of wedging.
 *  6. **The wrapper comes from the operator's `PATH` or from DeFlow's own
 *     pinned dependency** (`resolveSandboxRuntime`) — never from the worktree,
 *     never from a path the plan names.
 *  7. **`tool.cwd` is resolved inside the worktree** and refused if it escapes.
 *  8. **The F5.6 deny list applies before spawn**, and a hit is a refusal
 *     rather than a verdict — the same argument `runGateNode` makes: a deny-list
 *     verdict is a pure function of the command, so a backoff row would be a
 *     wake nobody can act on.
 *
 * Two costs of that posture, written down rather than left to be discovered:
 *
 * - **`read` cannot write its own worktree.** `sandboxRuntimeConfig` gives the
 *   level `allowWrite: []`. That is correct — a `read` node reads — and it is
 *   stated here so nobody "fixes" it.
 * - **Reads are deny-then-allow.** The wrapper's read default is *allow*, so a
 *   `read`/`worktree` script can still read most of the disk minus the
 *   credential paths. Same posture as an agent at the same level; not a gap
 *   this module invented.
 * - **The verb allowlist arm of `decidePermission` is deliberately not
 *   applied.** `sh` is on no repository's verb allowlist, so applying it would
 *   gate every tool node — and there is no interactive gate on this path (that
 *   is a `human` node, which the planner must author). A tool node's binary
 *   allowlist is enforced by the sandbox's filesystem and network rows, not by
 *   the verb list.
 * - **The `scrubbed-env` arm of the deny list is inert here**, and it is passed
 *   `[]` rather than left to look like it is doing something. That arm reports
 *   a command that names a variable KAR-08.4 removed, so it can say so instead
 *   of failing confusingly in the child — but the environment is built *after*
 *   the refusal point (it needs a per-run `TMPDIR`, and creating one for a node
 *   that is about to be refused would leak a directory per refusal). A tool
 *   node declares no environment variables today, so the list would be the
 *   same for every node in a run; when one does, the honest fix is to hoist
 *   `buildChildEnv` above the check, not to reconstruct the scrubbed set here.
 *
 * ## Everything refusable is decided before a worktree exists
 *
 * The order of `perform()` is the specification, and it is the same shape
 * `liveAgentPerformer` uses: refuse, provision, run, and let the `finally`
 * return the worktree loudly.
 *
 * ## The journal, and why `effectClass` is carried rather than inferred
 *
 * `shellEffect` (KAR-06.4) already *is* this effect and has had no production
 * caller for its `mutating` arm since it was written. The node's `effectClass`
 * is the plan-time classification `ToolNodeSchema` exists to record, handed
 * straight through: `pure` re-runs an inherited `pending` row (the cost is
 * time), `mutating` journals `git status --porcelain` before and after and
 * reconciles by re-hashing — and an `unknown` verdict escalates to a human
 * instead of ever being auto-retried, which is the EPIC-06 promise the field
 * was put on the node for.
 *
 * `ordinal: 0` is supplied explicitly. One effect per tool attempt, so the
 * position is known; deriving it would give a resumed attempt ordinal 1 and
 * re-run a mutating command instead of reconciling it. It is also the key
 * `executeRun`'s own `closeEffect` looks at, so the two agree by construction.
 * This is `durable()`'s documented legitimate use of the field, and it is a
 * constant rather than a counter.
 *
 * ## Ordering: `node.started`, then the journal, then the pid
 *
 * `node.started` is appended **before** `durable()`, exactly as `runGateNode`
 * does it, and the reason is measured rather than aesthetic:
 * `effect.started`'s reducer raises the node's `attempts` count (`attemptOf` in
 * `@DeFlow/core`'s reduce.ts). A node whose `attempts` has moved and whose
 * status is still `pending` is *ready* on the very next tick, so `decide()`
 * admits it again as attempt 1 — two live children in one worktree, a second
 * `workspace.worktree_reused`, and a salvage that then fails on the first one's
 * commit. That is what the first green draft of this module actually did.
 *
 * Nothing in `node.started` needs a pid: the binary is the wrapper, resolved
 * before the spawn. The pid rides on a `node.progress` inside `perform()`,
 * committed in one transaction with the `process` row (KAR-05.9 AC6) — so the
 * row and the event that records the spawn still land together, which is the
 * guarantee that rule is about. The write-ahead property `durable()` exists for
 * is untouched: the effect's intent row is still committed before the child is
 * spawned.
 *
 * Time enters through the injected `Clock` (NF9). The deadline is
 * `clock.setTimer` rather than `spawn`'s own `timeout`, and that is a
 * deliberate deviation: `spawn`'s timeout signals the **leader only**, and a
 * `detached` script's children survive it — precisely the orphan class the
 * 2026-08-24 incident produced. `killTree` is the one kill seam.
 *
 * Verifies: KAR-23.9 · docs/05-durable-execution.md §8.3 ·
 * docs/09-workspace-and-safety.md §10.4, §10.5
 */
import type { AgentProcessRecord, LedgerSink, ProcessRegistry } from '@DeFlow/adapters';
import {
  awaitGroupDrained,
  killTree,
  processStartTime,
  SWEEP_KILL_GRACE_MS,
  sandboxedCommand,
} from '@DeFlow/adapters';
import type { Clock, Handle, NodeId, PlanNode, StartNode, ToolNode } from '@DeFlow/core';
import {
  destructiveShellLine,
  EVENT_CURRENT_VERSIONS,
  FULL_IS_NOT_A_SANDBOX,
  ikey as makeIkey,
  NodeFailureError,
  pathIsInside,
  reasonCode,
  requestHash,
  resolvePosix,
  sha256Hex,
  TOOL_RESULT_SCHEMA_ID,
} from '@DeFlow/core';
import { putBlob } from '@DeFlow/ledger';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { shellEffect } from '../effects/shell-effect.ts';
import { sqliteLedgerSink } from '../exec/ledger-sink.ts';
import { PERFORMABLE_TOOL_KINDS } from '../exec/performable.ts';
import { sqliteProcessRegistry } from '../exec/process-registry.ts';
import type { ExecContext, NodePerformer } from '../exec/run-executor.ts';
import { nodeBranch, runRef, salvageBranch } from '../git/branch-name.ts';
import { Git } from '../git/git.ts';
import { worktreePathFor } from '../git/worktree-args.ts';
import { WorkspaceManager } from '../git/worktree-manager.ts';
import { binarySha256 } from '../proc/binary-digest.ts';
import { buildChildEnv, createRunTmpdir } from '../proc/env.ts';
import type { LiveExecutionOptions } from './live-nodes.ts';

/**
 * The wall clock a script gets when its node declares no budget of its own.
 *
 * Fifteen minutes: long enough for a real build or migration, short enough that
 * a wedged script is a failed node within one coffee rather than holding a
 * worktree lock until somebody notices.
 */
export const TOOL_NODE_TIMEOUT_MS = 15 * 60_000;

/** The shell DeFlow chooses. Never `env.SHELL`, never `-l` — see the note. */
const TOOL_SHELL = '/bin/sh';

/** How much of each stream is kept in memory for the failure message. The
 * whole of it lives in the data plane; this is the tail a human reads. */
const TAIL_BYTES = 8 * 1024;

const eventVersionOf = (kind: string): number =>
  (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)[kind] ?? 1;

/** The plan node this command names — the same lookup `settingFor` does, minus
 * the pinned spec a tool node has no use for. */
function toolNodeOf(command: StartNode, ctx: ExecContext): ToolNode {
  const node: PlanNode | undefined = (ctx.state.plan?.nodes ?? []).find(
    (candidate) => candidate.id === command.node,
  );
  if (node === undefined) {
    throw new NodeFailureError(
      `${command.node} is not a node of run ${ctx.runId}'s active plan, so there is nothing to ` +
        'perform — the executor and the projection disagree about what this run is running',
      { reason: 'internal', class: 'permanent', detail: { node: command.node } },
    );
  }
  if (node.type !== 'tool') {
    throw new NodeFailureError(
      `${command.node} is a ${node.type} node; the tool performer runs tool nodes only`,
      { reason: 'internal', class: 'permanent', detail: { node: command.node, type: node.type } },
    );
  }
  return node;
}

/**
 * The `run` line of a node this daemon can perform, or a refusal.
 *
 * Exhaustive over `ToolKind`, so adding a fourth kind to `ToolNodeSchema` is a
 * compile error here until somebody decides what it means. The `mcp` and `http`
 * arms are the **run-time backstop** for the plan-time diagnostic
 * (`TOOL_KIND_UNPERFORMABLE`): `byNodeType` routes on node *type*, so a plan
 * compiled by an older build, a patch path or a hand-written document would
 * otherwise fall straight into the script spawn path below.
 */
function scriptOf(node: ToolNode, at: NodeId): { readonly run: string; readonly cwd: string } {
  const tool = node.tool;
  switch (tool.kind) {
    case 'script':
      return { run: tool.run, cwd: tool.cwd ?? '.' };
    case 'mcp':
    case 'http':
      throw new NodeFailureError(
        `tool node ${at} is of kind '${tool.kind}', and this daemon runs tool nodes of kind ` +
          `${PERFORMABLE_TOOL_KINDS.join(', ')} only — nothing here knows how to perform it, so ` +
          'it is refused before anything is provisioned',
        {
          reason: 'adapter.capability-missing',
          class: 'permanent',
          detail: { node: at, kind: tool.kind },
        },
      );
  }
}

interface ChildOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: Uint8Array[];
  readonly stderr: Uint8Array[];
}

/** The last `TAIL_BYTES` of a stream, as text — for a failure message and for
 * nothing else. The whole stream is in the blob store. */
function tailOf(chunks: readonly Uint8Array[]): string {
  const joined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return joined.subarray(Math.max(0, joined.byteLength - TAIL_BYTES)).toString('utf8');
}

/** The last non-empty line of a captured stream, for a failure message. */
const lastLine = (text: string): string => text.trim().split('\n').at(-1)?.trim() ?? '';

export interface ToolNodeSpawnInput {
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly clock: Clock;
  /** Called once, the moment the process group exists, with its pgid. Awaited:
   * `node.started` and the `process` row commit here, and a spawn whose row is
   * not durable is a pid nothing in the daemon can name. */
  onSpawn(pgid: number): Promise<void>;
  /** Called per chunk, in order. */
  onChunk(stream: 'stdout' | 'stderr', chunk: Uint8Array): void;
}

/**
 * One child, in its own process group, streamed and bounded.
 *
 * `detached` buys a group led by the child, so a wedged script *and everything
 * it went on to spawn* are reachable with one signal — and that signal does not
 * also reach DeFlowd. The ladder on the deadline is §11.1's, on the injected
 * clock: SIGTERM to the group, SIGKILL after the grace, then verify the group
 * really emptied.
 */
function runChild(input: ToolNodeSpawnInput): Promise<ChildOutcome> {
  return new Promise<ChildOutcome>((resolve, reject) => {
    let child;
    try {
      child = spawn(input.command, [...input.argv], {
        cwd: input.cwd,
        env: { ...input.env },
        detached: true,
        // A plan script gets no stdin: one that reads it fails fast rather
        // than wedging behind a pipe nobody will ever write to.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error as Error);
      return;
    }

    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let timedOut = false;
    let settled = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(new Uint8Array(chunk));
      input.onChunk('stdout', new Uint8Array(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(new Uint8Array(chunk));
      input.onChunk('stderr', new Uint8Array(chunk));
    });

    const pgid = child.pid;
    const started = pgid === undefined ? Promise.resolve() : input.onSpawn(pgid);
    started.catch((error: unknown) => {
      if (settled) return;
      settled = true;
      if (pgid !== undefined) killTree(pgid, 'SIGKILL');
      reject(error as Error);
    });

    const timer = input.clock.setTimer(input.timeoutMs, () => {
      if (settled || pgid === undefined) return;
      timedOut = true;
      killTree(pgid, 'SIGTERM');
      input.clock.setTimer(SWEEP_KILL_GRACE_MS, () => {
        killTree(pgid, 'SIGKILL');
        void awaitGroupDrained(pgid, { clock: input.clock });
      });
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      timer.cancel();
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      timer.cancel();
      void (async () => {
        // The `node.started`/`process` write, if it is still in flight. Its own
        // rejection has already settled this promise above; awaiting it here is
        // only so the row is durable before the attempt is reported over.
        await started.catch(() => undefined);
        // The child is gone; the group may not be. Answer only once the group
        // has really emptied, so a survivor is not silently left behind.
        if (timedOut && pgid !== undefined) {
          await awaitGroupDrained(pgid, { clock: input.clock }).catch(() => undefined);
        }
        resolve({ exitCode: code, signal, timedOut, stdout, stderr });
      })();
    });
  });
}

/**
 * `runChild`, with a spawn that never happened typed as one.
 *
 * A missing wrapper, a missing `/bin/sh`, a worktree that vanished under the
 * `cwd`: all of them are `ENOENT` out of `spawn`, and all of them are permanent
 * — the same binary at the same path fails identically on a retry. Left
 * untyped they become `internal`, which tells an operator nothing and puts the
 * fault on DeFlow rather than on the machine.
 */
async function spawnOrRefuse(
  at: NodeId,
  binary: string,
  input: ToolNodeSpawnInput,
): Promise<ChildOutcome> {
  try {
    return await runChild(input);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined) throw error;
    throw new NodeFailureError(
      `tool node ${at} could not spawn ${binary} (${code}); nothing ran, so nothing has to be ` +
        'reconciled',
      {
        reason: 'adapter.spawn-failed',
        class: 'permanent',
        detail: { node: at, binary, code },
      },
    );
  }
}

/**
 * The performer: one tool-node attempt, in its own worktree, wrapped.
 *
 * Every event it appends it appends itself, because only this layer knows what
 * the node was — `runGateNode`'s argument, applied to the other node type whose
 * work is a process.
 */
export function toolNodePerformer(options: LiveExecutionOptions, cwd: string): NodePerformer {
  return async (command: StartNode, ctx: ExecContext): Promise<void> => {
    const node = toolNodeOf(command, ctx);
    const script = scriptOf(node, command.node);

    // The path the worktree *will* have, so everything refusable is decided
    // against the real level and the real root without provisioning anything.
    const worktree = worktreePathFor(cwd, ctx.runId, command.node);

    // SECURITY (3): `full` has no enforcement and no authorisation path today.
    if (command.permission === 'full') {
      throw new NodeFailureError(
        `tool node ${command.node} asks for permission level 'full', and a tool node's run line ` +
          `is plan content: ${FULL_IS_NOT_A_SANDBOX} No run-level opt-in authorises it today, so ` +
          'it is refused rather than run as the operator',
        {
          reason: 'safety.permission-unschedulable',
          class: 'permanent',
          detail: { node: command.node, permission: command.permission },
        },
      );
    }

    // SECURITY (8): the F5.6 deny list, before a spawn and before a worktree.
    // A refusal, not a retry: the verdict is a pure function of the command.
    const refusal = destructiveShellLine(
      script.run,
      { worktree, cwd: worktree, scrubbedEnv: [] },
      TOOL_SHELL,
    );
    if (refusal !== null) {
      throw new NodeFailureError(
        `tool node ${command.node} was refused before spawn: ${reasonCode(refusal)} — a plan ` +
          'script is not a licence to run infrastructure actions',
        {
          reason: 'safety.execution-boundary',
          class: 'permanent',
          detail: { node: command.node, rule: refusal.detail ?? refusal.code },
        },
      );
    }

    // SECURITY (1, 2, 6): the wrapper, the level's prerequisites and the policy
    // document — all decided here, all throwing a permanent refusal when this
    // machine cannot enforce what the node asked for.
    const configDir = join(
      options.dataDir,
      'runs',
      ctx.runId,
      'sandbox',
      command.node,
      String(command.attempt),
    );
    const wrapped = sandboxedCommand({
      command: TOOL_SHELL,
      // One argv element. `spawn` without a shell is what makes that a single
      // word regardless of what the planner put in it.
      args: ['-c', script.run],
      permission: command.permission,
      worktree,
      platform: process.platform,
      roots: options.providerRoots,
      configDir,
    });

    const git = new Git(cwd);
    const workspace = new WorkspaceManager({
      git: { run: (args, opts) => git.run(args, opts) },
      db: ctx.db,
      clock: ctx.clock,
      epoch: ctx.epoch,
    });

    const provisioned = await workspace.provision(
      command.permission === 'read'
        ? { mode: 'read', runId: ctx.runId, nodeId: command.node, path: worktree, baseRef: 'HEAD' }
        : {
            mode: 'write',
            runId: ctx.runId,
            nodeId: command.node,
            path: worktree,
            baseRef: 'HEAD',
            branch: nodeBranch(runRef(ctx.runId), command.node),
          },
    );

    const ledger: LedgerSink = sqliteLedgerSink({
      db: ctx.db,
      runId: ctx.runId,
      epoch: ctx.epoch,
      dataDir: options.dataDir,
    });
    const processes: ProcessRegistry = sqliteProcessRegistry({
      db: ctx.db,
      runId: ctx.runId,
      epoch: ctx.epoch,
      dataDir: options.dataDir,
    });

    try {
      // SECURITY (7): `tool.cwd` is the plan's, so it is resolved against the
      // worktree and refused if it leaves it. `"."` — the incident's own value
      // — resolves to the worktree root.
      const resolvedCwd = resolvePosix(provisioned.path, script.cwd);
      if (!pathIsInside(provisioned.path, resolvedCwd)) {
        throw new NodeFailureError(
          `tool node ${command.node} would run in ${resolvedCwd}, which is outside its worktree ` +
            `${provisioned.path}; a plan script runs in the node's own tree or it does not run`,
          {
            reason: 'safety.pathscope-violation',
            class: 'permanent',
            detail: { node: command.node, cwd: script.cwd, resolved: resolvedCwd },
          },
        );
      }

      // SECURITY (5): the allowlist, and nothing of DeFlowd's own environment.
      const { env } = buildChildEnv({
        base: options.daemonEnv,
        loginPath: options.providerRoots.join(':'),
        tmpdir: await createRunTmpdir(),
      });

      // The wrapper reads its policy from a file, so the file exists before the
      // spawn does. Same convention the shim's own config uses.
      if (wrapped.runtimeConfig !== null) {
        await mkdir(configDir, { recursive: true });
        await writeFile(
          wrapped.runtimeConfig.path,
          `${JSON.stringify(wrapped.runtimeConfig.document, null, 2)}\n`,
          'utf8',
        );
      }

      const key = makeIkey(ctx.runId, command.node, command.attempt, 0);
      const startedAt = ctx.clock.now();

      // `node.started` **before** the journal, and the ordering is load-bearing
      // rather than a taste. `effect.started`'s reducer calls `attemptOf`, which
      // raises the node's `attempts` count; a node whose `attempts` has moved
      // and whose status is still `pending` is *ready* on the very next tick,
      // and `decide()` admits it again as attempt 1 — measured here, two live
      // children in one worktree, before the ordering was fixed. `node.started`
      // is what makes the node `running`, so it goes first.
      //
      // Nothing here needs a pid: the binary is the wrapper, resolved before the
      // spawn. The pid rides on the `node.progress` inside `run()`, in one
      // transaction with the `process` row (KAR-05.9 AC6).
      await ledger.append({
        ts: ctx.clock.now(),
        kind: 'node.started',
        v: eventVersionOf('node.started'),
        nodeId: command.node,
        attempt: command.attempt,
        ikey: key,
        payload: {
          node: command.node,
          attempt: command.attempt,
          ikey: key,
          binary: {
            path: wrapped.command,
            // What changes a tool node's behaviour is its run line, so that is
            // what the version pins — the argument `gateBinary` makes about a
            // gate command, applied to a script.
            version: `script@${(await sha256Hex(script.run)).slice(0, 12)}`,
            sha256: binarySha256(wrapped.command),
          },
          // No `session`: a tool node holds none, and `NodeStartedSchema`
          // documents absence as the answer rather than as a gap.
        },
      });
      // A holder rather than a bare `let`, because what `run()` observed is
      // read *after* `durable()` returns — and on a memoised `done` row nothing
      // ran at all, which is exactly the `null` this has to be able to say.
      const captured: { child: ChildOutcome | null } = { child: null };

      // io is serialised through a promise chain, so the order the child
      // produced its bytes in is the order the data plane records them in.
      let io: Promise<unknown> = Promise.resolve();

      const result = await ctx.effects.durable(
        shellEffect(
          {
            runId: ctx.runId,
            nodeId: command.node,
            attempt: command.attempt,
            // Explicit, and a constant: see the module note.
            ordinal: 0,
            requestHash: await requestHash({
              brief: `script:${script.run}@${resolvedCwd}`,
              provider: null,
              model: null,
              permission: command.permission,
              pathScopes: command.pathScopes,
              reads: node.reads,
              writes: node.writes,
            }),
            classification: node.effectClass,
          },
          {
            run: async () => {
              const child = await spawnOrRefuse(command.node, wrapped.command, {
                command: wrapped.command,
                argv: wrapped.argv,
                cwd: resolvedCwd,
                env,
                timeoutMs: node.budget.maxWallClockMs ?? TOOL_NODE_TIMEOUT_MS,
                clock: ctx.clock,
                onSpawn: async (pgid) => {
                  const row: AgentProcessRecord = {
                    runId: ctx.runId,
                    nodeId: command.node,
                    attempt: command.attempt,
                    pid: pgid,
                    pgid,
                    startedAt: processStartTime(pgid),
                    binarySha256: binarySha256(wrapped.command),
                    worktree: provisioned.path,
                    spawnedAt: ctx.clock.now(),
                  };
                  // KAR-05.9 AC6 — the row and the event that records the spawn
                  // land in **one** transaction. Split, a crash between them
                  // leaves either a pid nothing will ever reclaim or a spawn
                  // nothing can reach, and both are silent.
                  //
                  // The event is `node.progress` and not `node.started` — see
                  // the module note's ordering paragraph. `node.started` was
                  // appended before the journal, because it is what makes the
                  // node `running`, and this one carries the pid, which does not
                  // exist until now.
                  await processes.appendWithProcess(
                    {
                      ts: ctx.clock.now(),
                      kind: 'node.progress',
                      v: eventVersionOf('node.progress'),
                      nodeId: command.node,
                      attempt: command.attempt,
                      payload: {
                        node: command.node,
                        attempt: command.attempt,
                        phase: 'tool.spawned',
                        message: `process group ${String(pgid)}`,
                      },
                    },
                    row,
                  );
                },
                onChunk: (stream, chunk) => {
                  io = io.then(() =>
                    ledger.appendIo({
                      nodeId: command.node,
                      attempt: command.attempt,
                      stream,
                      ts: ctx.clock.now(),
                      data: chunk,
                    }),
                  );
                },
              });
              captured.child = child;
              await io;
              return {
                exitCode: child.exitCode ?? -1,
                stdout: tailOf(child.stdout),
                stderr: tailOf(child.stderr),
              };
            },
            // Through the `Git` wrapper, never a second spawn.
            porcelain: async () =>
              (await git.run(['status', '--porcelain'], { cwd: provisioned.path })).stdout,
          },
        ),
      );

      const durationMs = Math.max(0, ctx.clock.now() - startedAt);
      const child = captured.child;

      const spill = (chunks: readonly Uint8Array[]): Handle | null => {
        if (chunks.length === 0) return null;
        const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        if (bytes.byteLength === 0) return null;
        return putBlob(options.dataDir, bytes, 'text/plain');
      };

      // A memoised `done` row has no child of its own to describe; its journalled
      // result is what the effect concluded, and that is what the node reports.
      const stdout = child === null ? null : spill(child.stdout);
      const stderr = child === null ? null : spill(child.stderr);
      const timedOut = child?.timedOut ?? false;

      if (timedOut) {
        throw new NodeFailureError(
          `tool node ${command.node} was still running after ` +
            `${String(node.budget.maxWallClockMs ?? TOOL_NODE_TIMEOUT_MS)}ms and its process ` +
            `group was killed${node.effectClass === 'mutating' ? ', and it is a mutating command, so no retry is scheduled' : ''}`,
          {
            reason: 'timeout',
            // A mutating command killed mid-flight may have half-applied. The
            // ladder must not re-run it; a human decides.
            class: node.effectClass === 'mutating' ? 'permanent' : 'transient',
            detail: { node: command.node, kind: 'script', durationMs },
          },
        );
      }

      if (result.exitCode !== 0) {
        throw new NodeFailureError(
          `tool node ${command.node} exited ${String(result.exitCode)}: ` +
            (lastLine(result.stderr) || lastLine(result.stdout) || 'it printed nothing'),
          {
            // `agent.nonzero-exit` rather than a new `tool.nonzero-exit`: the
            // taxonomy is a ledger enum with an upcaster cost, and the *class*
            // is what the scheduler reads. Agent-flavoured on purpose.
            reason: 'agent.nonzero-exit',
            class: node.effectClass === 'mutating' ? 'permanent' : 'transient',
            detail: {
              node: command.node,
              kind: 'script',
              exitCode: result.exitCode,
              signal: child?.signal ?? null,
            },
          },
        );
      }

      await ledger.append({
        ts: ctx.clock.now(),
        kind: 'node.completed',
        v: eventVersionOf('node.completed'),
        nodeId: command.node,
        attempt: command.attempt,
        payload: {
          node: command.node,
          attempt: command.attempt,
          result: {
            status: 'completed',
            output: {
              kind: 'script',
              exitCode: result.exitCode,
              signal: child?.signal ?? null,
              durationMs,
              timedOut: false,
              stdout,
              stderr,
            },
            outputSchemaId: TOOL_RESULT_SCHEMA_ID,
            // Measured, not estimated: nothing was sent to any model at all.
            usage: { inputTokens: 0, outputTokens: 0, source: 'vendor-reported' },
            costUsd: 0,
            producedFacts: [],
            artifacts: [stdout, stderr].filter((handle): handle is Handle => handle !== null),
          },
        },
      });
    } finally {
      // The row `cancelNode`, `killRun` and the boot reaper read. Cleared only
      // once the attempt is over.
      await processes.clear({ runId: ctx.runId, nodeId: command.node, attempt: command.attempt });
      // Not swallowed and not a second outcome: a worktree that cannot go back
      // is a fact about the machine that has to reach the ledger loudly.
      await workspace.remove({
        runId: ctx.runId,
        nodeId: command.node,
        path: provisioned.path,
        ...(provisioned.branch === null ? {} : { branch: provisioned.branch }),
        salvageBranch: salvageBranch(runRef(ctx.runId), command.node),
      });
    }
  };
}
