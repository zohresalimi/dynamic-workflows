/**
 * KAR-19.4 AC1 / KAR-19.5 — the composition root's half of node execution: the
 * `RunExecutionResolver` `DeFlow up` hands `createRunExecution`.
 *
 * This is the second and last unbound port of the 2026-08-12 failure.
 * `run-execution.ts` gave `executeRun` a shipped caller and `boot()` has taken
 * `executeNodes` since KAR-19.1 — but neither composition root supplied one, so
 * `drive.ts` skipped every run that had a plan and an operator watched a
 * compiled plan sit there. What was missing between them was a `NodePerformer`
 * over a real vendor process, which is this file.
 *
 * Four decisions are load-bearing.
 *
 * **The performer is composed, never a switch.** `byNodeType` routes an `agent`
 * node here and a `gate` node to `gateNodePerformer`, which has existed since
 * KAR-12.1 and had no production caller either. A node type nothing owns is a
 * throw, because a node that quietly does not run is a milestone advancing on
 * work nobody did.
 *
 * **One worktree per node attempt, provisioned and returned by the performer.**
 * `decide()` reads a node's worktree off `node.scheduled`, and nothing in the
 * shipped tree writes one — so `StartNode.worktree` is `null` on every node
 * today, and a performer that trusted it would spawn agents in the operator's
 * own checkout. The path and the branch are KAR-07.2/07.3's own
 * (`worktreePathFor`, `nodeBranch`), the removal is not in a `finally` for the
 * reason `runReconNode` records — a removal that fails must *change* the
 * outcome, because a locked worktree is immune to `prune` and leaking one is
 * permanent.
 *
 * **The packet is `buildPacket`'s, and the prompt is what it rendered.** The
 * pinned set is fill-order position 1, hash-checked before the spawn, and
 * carried down as `pins` so the F6.6 integrity check runs against the prompt
 * that is really about to be sent. A prompt assembled here by string
 * concatenation would be a second packet builder with no budget and no pins.
 *
 * **The child's environment is `buildChildEnv()`'s and the provider is the one
 * admission already chose.** Both for the same reasons `live-chain.ts` states:
 * one allowlist (KAR-08.4), and one capability answer read from the probed row
 * and nowhere else (KAR-05.2).
 *
 * What this file deliberately does **not** do yet is merge a node's branch back
 * — that is EPIC-07's integration loop, and inventing a second merge here would
 * give a run two answers about how work arrives on the integration branch.
 *
 * Verifies: EPIC-19-S24, EPIC-19-S33 · KAR-19.4 AC1, AC8 · KAR-19.5 AC1
 */
import type { CapabilityRequirement } from '@DeFlow/adapters';
import {
  ADAPTER_REQUIREMENT_CAPABILITIES,
  providerSpec,
  runAcpNode,
  spawnPlan,
} from '@DeFlow/adapters';
import type { Clock, NodeId, PlanNode, RunId, RunState, StartNode, TaskSpec } from '@DeFlow/core';
import { buildPacket, NodeFailureError, renderPacket, SchemaIdSchema } from '@DeFlow/core';
import type { GateDefinition } from '@DeFlow/gates';
import { discoverGateDefinitions } from '@DeFlow/gates';
import { putBlob, readRange } from '@DeFlow/ledger';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createEffectRunner } from '../effects/durable.ts';
import { sqliteLedgerSink } from '../exec/ledger-sink.ts';
import type { ExecContext, NodePerformer } from '../exec/run-executor.ts';
import { byNodeType, gateNodePerformer } from '../gates/gate-performer.ts';
import { nodeBranch, runRef, salvageBranch } from '../git/branch-name.ts';
import { Git } from '../git/git.ts';
import { worktreePathFor } from '../git/worktree-args.ts';
import { WorkspaceManager } from '../git/worktree-manager.ts';
import { log } from '../logging.ts';
import { buildChildEnv, createRunTmpdir } from '../proc/env.ts';
import { createScopeAudit } from '../services/scope-diff.ts';
import { o200kTokenizer } from '../tokens/tokenizer.ts';
import { ASSUMED_CONTEXT_FLOOR, chooseProvider, PROVIDER_DEFAULT_MODEL } from './live-chain.ts';
import type { RunExecution, RunExecutionContext } from './run-execution.ts';
import { createRunExecution } from './run-execution.ts';

const wiring = log.child({ mod: 'live-nodes' });

/** One per process: the estimator every packet on this path is measured with,
 * so one run never mixes two counting tiers (docs/08 §7). */
const tokenizer = o200kTokenizer();

/** Digested once per (path, mtime, size): an agent binary does not change
 * under a daemon, and hashing 60 MB per node would be a real cost. */
const digests = new Map<string, string>();

/**
 * The sha256 of the binary this attempt is about to spawn, hex and bare.
 *
 * **Not optional, and the reason is worth the paragraph.** `node.started`'s
 * payload requires a bare sha256 (`NodeStartedSchema`), and `appendEvents` does
 * not validate payloads on write — so a performer that passed `''` writes an
 * event the ledger stores happily and `parseEvent` then refuses on **read**.
 * The row is in the file, the SSE stream drops it, and `DeFlow run` never
 * learns the node started, so it never follows the node's `io_chunk` tail and
 * the operator sees a run with no agent output at all. That is precisely the
 * 2026-08-12 symptom, reproduced by a two-character shortcut, and it is what
 * KAR-19.5's smoke test caught on its first green chain.
 */
function binarySha256(path: string): string {
  const stat = statSync(path);
  const key = `${path}:${String(stat.mtimeMs)}:${String(stat.size)}`;
  const held = digests.get(key);
  if (held !== undefined) return held;
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  digests.set(key, digest);
  return digest;
}

/** A pre-execution run's whole log fits far inside this. */
const EVENT_PAGE = 5_000;

export interface LiveExecutionOptions {
  /** The daemon's data directory: run directories, blobs and the gate output. */
  readonly dataDir: string;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** The operator's own `PATH`, split — DeFlowd's is not theirs (§4.3). */
  readonly providerRoots: readonly string[];
  /** DeFlowd's environment, as `buildChildEnv()`'s **base**, never as a child's. */
  readonly daemonEnv: NodeJS.ProcessEnv;
}

/** What one node attempt needs that its command does not carry. */
interface NodeSetting {
  readonly node: PlanNode;
  readonly spec: TaskSpec;
  /** The `seq` the pinned spec was sealed at — the packet's provenance. */
  readonly pinnedAt: number;
}

/** The plan node this command names, plus the spec it is working against. */
function settingFor(command: StartNode, ctx: ExecContext): NodeSetting {
  const node = (ctx.state.plan?.nodes ?? []).find((candidate) => candidate.id === command.node);
  if (node === undefined) {
    throw new Error(
      `${command.node} is not a node of run ${ctx.runId}'s active plan, so there is nothing to ` +
        'perform — the executor and the projection disagree about what this run is running',
    );
  }

  const events = readRange(ctx.db, ctx.runId, 0, EVENT_PAGE).events;
  let spec: TaskSpec | null = null;
  let pinnedAt = 0;
  for (const event of events) {
    if (event.kind === 'run.created') {
      spec = (event.payload as { readonly spec: TaskSpec }).spec;
    }
    if (event.kind === 'spec.pinned') pinnedAt = event.seq;
  }
  if (spec === null) {
    throw new Error(
      `run ${ctx.runId} has a plan and no run.created carrying its spec, so a node's pinned set ` +
        'cannot be built; this ledger is not one this build can execute',
    );
  }
  return { node, spec, pinnedAt: pinnedAt === 0 ? 1 : pinnedAt };
}

/**
 * `AgentNode.provider.requires`, as admission's own questions.
 *
 * The object-shaped members (`{ minContext }`, `{ permission }`) are dropped
 * rather than guessed at: neither is a question an ACP handshake answers, which
 * is exactly what `ADAPTER_REQUIREMENT_CAPABILITIES` maps the four unanswerable
 * string members to `null` for. Admission does not refuse on a question it did
 * not ask.
 */
function requirementsOf(node: PlanNode): readonly CapabilityRequirement[] {
  if (node.type !== 'agent') return [];
  return node.provider.requires.flatMap((requirement) => {
    if (typeof requirement !== 'string') return [];
    const capability = ADAPTER_REQUIREMENT_CAPABILITIES[requirement];
    return capability === null || capability === undefined ? [] : [capability];
  });
}

/**
 * The agent performer: one node attempt, in its own worktree, on a real
 * process.
 *
 * Everything it appends — `node.started`, the `io_chunk` bytes and the event
 * that ends the attempt — is appended by `runAcpNode` through the ledger sink,
 * because only the adapter knows what the turn was. This function's whole job
 * is to decide *where* and *with what*.
 */
function liveAgentPerformer(options: LiveExecutionOptions, cwd: string): NodePerformer {
  return async (command: StartNode, ctx: ExecContext): Promise<void> => {
    const setting = settingFor(command, ctx);
    const chosen = chooseProvider(ctx.db, options.providerRoots);
    if (chosen === null) {
      throw new NodeFailureError(
        `no adapter on this machine both resolves on the operator's PATH and has a probed ` +
          `capability row, so ${command.node} cannot be run; 'DeFlow doctor' reports what this ` +
          'daemon found when it started',
        {
          reason: 'adapter.capability-missing',
          class: 'permanent',
          detail: { node: command.node },
        },
      );
    }

    const spec = providerSpec(chosen.provider);
    if (spec === undefined) {
      throw new NodeFailureError(
        `${chosen.provider} is not in PROVIDER_SPECS, so DeFlow does not know how to invoke it`,
        { reason: 'adapter.capability-missing', class: 'permanent', detail: {} },
      );
    }

    const git = new Git(cwd);
    const workspace = new WorkspaceManager({
      git: { run: (args, opts) => git.run(args, opts) },
      db: ctx.db,
      clock: ctx.clock,
      epoch: ctx.epoch,
    });

    const provisioned = await workspace.provision({
      mode: 'write',
      runId: ctx.runId,
      nodeId: command.node,
      path: worktreePathFor(cwd, ctx.runId, command.node),
      baseRef: 'HEAD',
      // `runRef` and not `ctx.runId`: a run id's `T` and `Z` are uppercase and
      // `BRANCH_SAFE` is not. See `runRef` for why the transformation belongs
      // to this caller rather than to `nodeBranch`.
      branch: nodeBranch(runRef(ctx.runId), command.node),
    });

    try {
      const built = await buildPacket({
        runId: ctx.runId,
        nodeId: command.node,
        attempt: command.attempt,
        builtAtEvent: setting.pinnedAt,
        target: {
          provider: chosen.provider,
          model: PROVIDER_DEFAULT_MODEL,
          maxContext: ASSUMED_CONTEXT_FLOOR,
        },
        pinned: {
          spec: setting.spec,
          node: { pathScopes: [...command.pathScopes.write], permission: command.permission },
          sourceEvent: setting.pinnedAt,
        },
        estimate: (text: string) => tokenizer.count(text),
      });
      for (const warning of built.warnings) wiring.warn({ runId: ctx.runId }, warning);

      const { env } = buildChildEnv({
        base: options.daemonEnv,
        loginPath: options.providerRoots.join(':'),
        tmpdir: await createRunTmpdir(),
      });

      const plan = spawnPlan(spec, {
        resolved: { provider: spec.id, path: chosen.binaryPath },
        worktree: provisioned.path,
      });

      const outcome = await runAcpNode(
        {
          runId: ctx.runId,
          nodeId: command.node,
          attempt: command.attempt,
          provider: chosen.row.provider,
          permission: command.permission,
          worktree: provisioned.path,
          binary: {
            path: chosen.binaryPath,
            version: chosen.row.version,
            sha256: binarySha256(chosen.binaryPath),
          },
          argv: plan.argv,
          env: { ...env, ...plan.env },
          mcpServers: [],
          requires: requirementsOf(setting.node),
          prompt: renderPacket({ segments: built.packet.segments }),
          pins: built.packet.segments.filter((segment) => segment.pinned),
          pathScope: [...command.pathScopes.write],
          // The contract the node's own result is filed under. An agent node
          // always declares one (`AgentNode.returns` is required), so this is
          // unconditional rather than defensive.
          ...(setting.node.type === 'agent'
            ? { outputSchemaId: SchemaIdSchema.parse(setting.node.returns.schemaId) }
            : {}),
        },
        {
          clock: ctx.clock,
          capabilityRow: chosen.row,
          ledger: sqliteLedgerSink({
            db: ctx.db,
            runId: ctx.runId,
            epoch: ctx.epoch,
            dataDir: options.dataDir,
          }),
          // KAR-08.7 AC3's completion-time backstop, wired rather than
          // declared. `runAcpNode` refuses a node that declares a path scope
          // with no auditor behind it — *"a declared scope with nothing behind
          // it reads exactly like an agent that behaved"* — and every agent
          // node the planner emits declares one, so this is the difference
          // between a run that executes and a run that refuses itself.
          //
          // No `env` override: DeFlowd passes nothing and the auditor's `git`
          // gets the user's own configuration, which is the only environment
          // their repository actually works in (`run-git.ts`).
          scopeAudit: createScopeAudit(),
          captureEvidence: (evidence) =>
            putBlob(
              options.dataDir,
              typeof evidence === 'string' ? Buffer.from(evidence, 'utf8') : evidence,
              'text/plain',
            ),
        },
      );

      if (outcome.status === 'failed') {
        wiring.warn(
          { runId: ctx.runId, node: command.node, reason: outcome.failure.reason },
          `${command.node} failed on ${chosen.provider}: ${outcome.failure.message}`,
        );
      }
    } finally {
      // Not swallowed and not a second outcome: `runAcpNode` has already
      // recorded what happened to the attempt, and a worktree that cannot go
      // back is a fact about the machine that has to reach the ledger loudly.
      await workspace.remove({
        runId: ctx.runId,
        nodeId: command.node,
        path: provisioned.path,
        ...(provisioned.branch === null ? {} : { branch: provisioned.branch }),
        // Composed here for the same reason the branch is: `remove` falls back
        // to composing one from the run id, which every run id refuses.
        salvageBranch: salvageBranch(runRef(ctx.runId), command.node),
      });
    }
  };
}

/**
 * The gates this repository declares, by id.
 *
 * Discovered from the repository rather than remembered, and through
 * `discoverGateDefinitions` — the one door (KAR-12.6) that parses, validates and
 * hashes them — so the bytes the verdict is stamped with are the bytes that ran.
 */
async function gatesOf(
  cwd: string,
): Promise<ReadonlyMap<string, GateDefinition & { sha256: string }>> {
  let scripts: Readonly<Record<string, string>> = {};
  try {
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    scripts = manifest.scripts ?? {};
  } catch {
    scripts = {};
  }

  const discovered = await discoverGateDefinitions({
    gatesDir: join(cwd, '.DeFlow', 'gates'),
    scripts,
  });
  return new Map(
    discovered.map((gate) => [gate.definition.id, { ...gate.definition, sha256: gate.sha256 }]),
  );
}

/** The node whose work a gate is judging: the first dependency it names. */
function evaluatedNodeOf(node: PlanNode, state: RunState): NodeId {
  const independence = node.type === 'gate' ? node.independence.notSessionOf : [];
  const candidate = independence[0] ?? node.deps[0];
  if (candidate !== undefined) return candidate;
  const first = (state.plan?.nodes ?? []).find((other) => other.id !== node.id);
  if (first === undefined) {
    throw new Error(`gate ${node.id} judges no node: it has no dependencies and the plan has none`);
  }
  return first.id;
}

/**
 * The executor one daemon life runs, bound to this machine.
 *
 * Stateless per turn, exactly as `run-execution.ts` requires: everything below
 * is re-derived from `(ledger, run, machine)` on every dispatch, so a second
 * daemon picks a run up with nothing inherited from the first.
 */
export function createLiveRunExecution(options: LiveExecutionOptions): RunExecution {
  return createRunExecution({
    resolve: async ({
      runId,
      db,
      cwd,
      epoch,
      daemonStartedAt,
    }): Promise<RunExecutionContext | null> => {
      const gates = await gatesOf(cwd);
      let specHash = '';
      for (const event of readRange(db, runId as RunId, 0, EVENT_PAGE).events) {
        if (event.kind === 'spec.pinned') {
          specHash = (event.payload as { readonly specHash?: string }).specHash ?? specHash;
        }
      }

      return {
        perform: byNodeType({
          agent: liveAgentPerformer(options, cwd),
          gate: gateNodePerformer({
            dataDir: options.dataDir,
            env: options.daemonEnv,
            resolve: (node, state) => {
              const planNode = (state.plan?.nodes ?? []).find((other) => other.id === node);
              if (planNode === undefined || planNode.type !== 'gate') return null;
              // Only the deterministic tier is resolvable from a definition
              // file. An adversarial gate is an agent turn against a brief, and
              // returning `null` here is what makes it a loud refusal rather
              // than a milestone advancing on a verdict nobody produced.
              if (planNode.gate.kind !== 'deterministic') return null;
              const definition = gates.get(planNode.gate.gateId);
              if (definition === undefined) return null;
              return {
                definition,
                worktree: cwd,
                repoRoot: cwd,
                evaluatedNode: evaluatedNodeOf(planNode, state),
                specHash,
                definitionSha256: definition.sha256,
              };
            },
          }),
        }),
        effects: createEffectRunner({
          db,
          clock: options.clock,
          daemonStartedAt,
          epoch,
          spillTo: options.dataDir,
        }),
        // Real time, on the system clock, because there are live children:
        // advancing an injected clock per tick would reach a node's own timeout
        // in simulated time while the child was still working.
        tickStepMs: 0,
        // A run of real agent turns is minutes, not the executor's one-minute
        // default; the wedge budget has to be longer than the work or every
        // long node is reported as a wedge.
        budgetMs: 30 * 60_000,
      };
    },
  });
}
