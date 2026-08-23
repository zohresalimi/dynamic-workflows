/**
 * KAR-19.4 AC1 / KAR-19.5 — the composition root's half of node execution: the
 * `RunExecutionResolver` `deflow up` hands `createRunExecution`.
 *
 * This is the second and last unbound port of the 2026-08-12 failure.
 * `run-execution.ts` gave `executeRun` a shipped caller and `boot()` has taken
 * `executeNodes` since KAR-19.1 — but neither composition root supplied one, so
 * `drive.ts` skipped every run that had a plan and an operator watched a
 * compiled plan sit there. What was missing between them was a `NodePerformer`
 * over a real vendor process, which is this file.
 *
 * Five decisions are load-bearing.
 *
 * **The route is read, never assumed (KAR-23.5).** `chooseProvider` answers
 * *which provider*; `providerRoutes` answers *which route this machine can
 * open*, and the second question was simply never asked here. On 2026-08-24 a
 * fully-installed machine resolved claude with the **shim** route and this
 * performer spoke ACP JSON-RPC at the plain vendor CLI regardless: the children
 * never handshook, the ledger went silent, `run.stalled` fired as a false
 * positive, and — with no `processes` port wired — the kill switch could not
 * reach them, so three of them outlived the run. Both runners now exist behind
 * one branch on `providerRoutes`, both are given the `process` row the kill
 * switch reads, and a route this machine cannot serve is a `NodeFailureError`
 * before a worktree is provisioned rather than a child nobody can name.
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
 * Verifies: EPIC-19-S24, EPIC-19-S33 · KAR-19.4 AC1, AC8 · KAR-19.5 AC1 ·
 * KAR-23.5
 */
import type {
  CapabilityRequirement,
  LedgerSink,
  ProcessRegistry,
  ScopeAudit,
  ShimNodeOutcome,
} from '@DeFlow/adapters';
import {
  ADAPTER_REQUIREMENT_CAPABILITIES,
  binaryForRoute,
  providerRoutes,
  providerSpec,
  runAcpNode,
  runShimNode,
  shimCapabilityRow,
  spawnPlan,
  vendorSessionIdFor,
} from '@DeFlow/adapters';
import type {
  Clock,
  Handle,
  NodeId,
  PlanNode,
  ProviderRoute,
  RunId,
  RunState,
  SchemaId,
  StartNode,
  TaskSpec,
} from '@DeFlow/core';
import {
  buildPacket,
  NodeFailureError,
  renderPacket,
  runSchemaFileName,
  SchemaIdSchema,
  WAKE_REASONS,
} from '@DeFlow/core';
import type { GateDefinition } from '@DeFlow/gates';
import { discoverGateDefinitions } from '@DeFlow/gates';
import { putBlob, readRange, scheduleWakeIfChanged } from '@DeFlow/ledger';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createEffectRunner } from '../effects/durable.ts';
import { sqliteLedgerSink } from '../exec/ledger-sink.ts';
import { sqliteProcessRegistry } from '../exec/process-registry.ts';
import type { ExecContext, NodePerformer } from '../exec/run-executor.ts';
import { seenShimUuids } from '../exec/shim-replay.ts';
import { byNodeType, gateNodePerformer } from '../gates/gate-performer.ts';
import { nodeBranch, runRef, salvageBranch } from '../git/branch-name.ts';
import { Git } from '../git/git.ts';
import { worktreePathFor } from '../git/worktree-args.ts';
import { WorkspaceManager } from '../git/worktree-manager.ts';
import { log } from '../logging.ts';
import { buildChildEnv, createRunTmpdir } from '../proc/env.ts';
import { discoverConnectorServers } from '../providers/connector-servers.ts';
import { writeRunSchemas } from '../run-schemas.ts';
import { createScopeAudit } from '../services/scope-diff.ts';
import { o200kTokenizer } from '../tokens/tokenizer.ts';
import type { Chosen } from './live-chain.ts';
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
 * The row is in the file, the SSE stream drops it, and `deflow run` never
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
 * KAR-23.5 — the route this node's attempt will be run down, or `null`.
 *
 * ACP wherever it is open, because that is `TURN_ROUTES['node execution']`'s
 * own answer and the reason for it: streaming, permission negotiation and
 * cancellation are all session concerns, and a turn driven through a one-shot
 * CLI invocation has none of them. The shim is the degradation KAR-05.8 built,
 * not a preference — and, per `shimCapabilityRow`, it serves `read` nodes and
 * refuses everything above that before a process exists.
 *
 * Read off `providerRoutes`, the one reducer `doctor`, `admitRun` and the
 * picker also read. A second opinion about the same machine is what produced
 * the 2026-08-24 incident: selection said `shim`, execution assumed `acp`, and
 * neither was written down anywhere the other could see.
 */
function routeFor(chosen: Chosen): ProviderRoute | null {
  const routes = providerRoutes(chosen.resolution);
  if (routes.acp === 'available') return 'acp';
  if (routes.shim === 'available') return 'shim';
  return null;
}

/** What both routes share, so the branch below decides a route and not a set
 * of ports. */
interface TurnPorts {
  readonly ledger: LedgerSink;
  readonly processes: ProcessRegistry;
  readonly captureEvidence: (evidence: string | Uint8Array) => Handle;
  readonly scopeAudit: ScopeAudit;
}

interface ShimTurnInput {
  readonly options: LiveExecutionOptions;
  readonly ctx: ExecContext;
  readonly command: StartNode;
  readonly chosen: Chosen;
  /** `binaryForRoute(resolution, 'shim')` — the vendor's own CLI. */
  readonly binaryPath: string;
  readonly worktree: string;
  readonly prompt: string;
  readonly outputSchemaId: SchemaId | null;
  readonly env: Readonly<Record<string, string>>;
  /** `buildChildEnv`'s dropped names, for the vendor's own scrub flag. */
  readonly scrubbed: readonly string[];
  readonly ports: TurnPorts;
}

/**
 * KAR-23.5 — one node attempt through the vendor's own CLI.
 *
 * The runner is `runShimNode`, complete and tested in `@DeFlow/adapters` since
 * KAR-05.8 and — until this story — imported by no daemon module at all. That
 * is the entire wiring gap: on a machine whose only open route was the shim,
 * DeFlow held a finished implementation of what to do and did the other thing.
 *
 * Three decisions here are not obvious and are load-bearing.
 *
 * **The capability row is the minted shim row, not `chosen.row`.**
 * `chosen.row` describes the probed ACP bridge; on this path DeFlow is not
 * mediating anything, and the honest row says so (`mediatedExecution: false`,
 * `transport: 'exec-shim'`). That is also what makes a `worktree`-level node
 * refuse here with `safety.permission-unschedulable` **before a process
 * exists** rather than run at a level DeFlow cannot enforce — the silent
 * escalation KAR-05.8 AC8 forbids. Passing `chosen.row` instead would turn a
 * loud refusal into exactly that escalation, so it must not be "fixed" that
 * way.
 *
 * **The session id is derived, per attempt.** `vendorSessionIdFor` with
 * `ResumeByReplay` keeps the attempt in the tuple, so a retry presents a fresh
 * uuid — claude's `--session-id` is create-only (KAR-19.13), and a retry that
 * re-presented the first attempt's id would exit 1 on "already in use".
 *
 * **The schema is read before anything is spawned.** `--json-schema` carries
 * the *document* for claude (KAR-19.11 AC1), the registry decides which of the
 * path and the document reaches the argv, and an unreadable file has to be a
 * typed refusal rather than a turn that runs with no contract.
 *
 * Deliberately not passed, each a documented absence rather than an invented
 * value: `authMode`, `compaction`, `costCeilingUsd`, `preflight` and
 * `transcripts`. The ACP call above carries none of them either; a value made
 * up here would be recorded as a measurement.
 */
async function runShimTurn(input: ShimTurnInput): Promise<ShimNodeOutcome> {
  const { options, ctx, command, chosen, ports } = input;
  const runDir = join(options.dataDir, 'runs', ctx.runId);
  const vendorSha = binarySha256(input.binaryPath);

  if (input.outputSchemaId === null) {
    throw new NodeFailureError(
      `${command.node} declares no return contract, so there is nothing to hand the vendor CLI ` +
        'on its structured-output flag',
      { reason: 'adapter.capability-missing', class: 'permanent', detail: { node: command.node } },
    );
  }

  // Idempotent re-emit: the run's own copy of the contracts, so what the child
  // is handed and what DeFlow validates against are the same bytes (NF8).
  const schemasDir = writeRunSchemas(runDir);
  const schemaPath = join(schemasDir, runSchemaFileName(input.outputSchemaId));
  let schemaDocument: string;
  try {
    schemaDocument = readFileSync(schemaPath, 'utf8');
  } catch (error) {
    throw new NodeFailureError(
      `the schema ${schemaPath} ${command.node} is contracted to return could not be read ` +
        `(${(error as NodeJS.ErrnoException).code ?? 'unknown'}), so ${chosen.provider} cannot ` +
        'be told what to return',
      {
        reason: 'adapter.capability-missing',
        class: 'permanent',
        detail: { node: command.node, schemaPath },
      },
    );
  }

  // The names this machine's vendor CLI is actually connected to. Cached per
  // daemon life per binary; the pre-execution turns already pass them, and an
  // execution node that did not would deny every connector call it was
  // otherwise allowed to make.
  const connectorServers = await discoverConnectorServers({
    binaryPath: input.binaryPath,
    env: input.env,
  });

  try {
    return await runShimNode(
      {
        runId: ctx.runId,
        nodeId: command.node,
        attempt: command.attempt,
        provider: chosen.row.provider,
        permission: command.permission,
        worktree: input.worktree,
        binary: { path: input.binaryPath, version: chosen.row.version, sha256: vendorSha },
        prompt: input.prompt,
        sessionId: vendorSessionIdFor({
          runId: ctx.runId,
          nodeId: command.node,
          attempt: command.attempt,
          strategy: 'ResumeByReplay',
        }),
        outputSchemaId: input.outputSchemaId,
        schemaPath,
        schemaDocument,
        env: { ...input.env },
        pathScope: [...command.pathScopes.write],
        sandbox: {
          // The **detected** version the probed row records, never a default:
          // a gate compared against an assumed version silently stops applying.
          version: chosen.row.version,
          platform: process.platform,
          roots: options.providerRoots,
          configDir: join(runDir, 'sandbox', command.node, String(command.attempt)),
          secretEnvVars: input.scrubbed,
          connectorServers,
        },
      },
      {
        clock: ctx.clock,
        ledger: ports.ledger,
        processes: ports.processes,
        captureEvidence: ports.captureEvidence,
        scopeAudit: ports.scopeAudit,
        // Minted, not probed — see the note above.
        capabilityRow: shimCapabilityRow({
          provider: chosen.row.provider,
          version: chosen.row.version,
          binaryPath: input.binaryPath,
          binarySha256: vendorSha,
          probedAt: ctx.clock.now(),
        }),
        // A provider-side quota limit becomes a durable `node_wake` row, never
        // a timer (NF9) and never an immediate retry.
        //
        // The reason is *found* in `WAKE_REASONS` rather than cast to it: the
        // adapter port types it as a plain string, and a reason the scheduler
        // does not recognise would leave the node asleep for ever under a word
        // nothing wakes on. Unrecognised is a throw, which becomes a
        // `node.failed` — loud, and in the ledger.
        wakes: {
          schedule: (row) => {
            const reason = WAKE_REASONS.find((known) => known === row.reason);
            if (reason === undefined) {
              throw new Error(
                `${chosen.provider} asked for a node wake with reason "${row.reason}", which no ` +
                  `scheduler recognises (${WAKE_REASONS.join(', ')}); the node would sleep for ever`,
              );
            }
            scheduleWakeIfChanged(ctx.db, {
              runId: row.runId,
              nodeId: row.nodeId,
              wakeAt: row.wakeAt,
              reason,
            });
            return Promise.resolve();
          },
        },
        // What a crash-replay of this attempt has already made durable, so the
        // transcript is appended once (KAR-05.8 AC4).
        seenUuids: seenShimUuids(ctx.db, ctx.runId, command.node, command.attempt),
      },
    );
  } finally {
    // `runShimNode` writes the row at `node.started` and never clears it —
    // clearing belongs to whoever knows the attempt is over, which is here, and
    // only *after* the outcome resolved (the runner observed `exited`).
    // `runAcpNode` clears its own, which is why this has no ACP counterpart.
    await ports.processes.clear({
      runId: ctx.runId,
      nodeId: command.node,
      attempt: command.attempt,
    });
  }
}

/**
 * The agent performer: one node attempt, in its own worktree, on a real
 * process.
 *
 * Everything it appends — `node.started`, the `io_chunk` bytes and the event
 * that ends the attempt — is appended by the runner (`runAcpNode` or
 * `runShimNode`) through the ledger sink, because only the adapter knows what
 * the turn was. This function's whole job is to decide *which route*, *where*
 * and *with what*.
 */
function liveAgentPerformer(options: LiveExecutionOptions, cwd: string): NodePerformer {
  return async (command: StartNode, ctx: ExecContext): Promise<void> => {
    const setting = settingFor(command, ctx);
    // KAR-19.10 AC8 — the run's own recorded choice, on the node path too.
    // `--provider` that held for framing and then quietly stopped holding at
    // the first agent node would be the announced-then-drifted failure this
    // story exists to make impossible.
    const chosen = chooseProvider(ctx.db, options.providerRoots, ctx.runId);
    if (chosen === null) {
      throw new NodeFailureError(
        `no adapter on this machine both resolves on the operator's PATH and has a probed ` +
          `capability row, so ${command.node} cannot be run; 'deflow doctor' reports what this ` +
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

    // KAR-23.5 — decided **before** the worktree exists, so a machine that can
    // serve neither route refuses in the ledger without leaving a branch and a
    // directory behind for an attempt that never spawned anything. A route
    // this machine cannot open must be a loud `node.failed`, never a child
    // being spoken to in a protocol it does not answer.
    const route = routeFor(chosen);
    const binaryPath = route === null ? null : binaryForRoute(chosen.resolution, route);
    if (route === null || binaryPath === null) {
      const routes = providerRoutes(chosen.resolution);
      throw new NodeFailureError(
        `${chosen.provider} is installed on this machine but can open neither route for ` +
          `${command.node} (acp: ${routes.acp} at ${chosen.resolution.adapterBin}, shim: ` +
          `${routes.shim} at ${chosen.resolution.vendorBin}), so nothing is spawned; ` +
          "'deflow doctor' reports which binary is missing",
        {
          reason: 'adapter.capability-missing',
          class: 'permanent',
          detail: {
            node: command.node,
            provider: chosen.provider,
            acp: routes.acp,
            shim: routes.shim,
          },
        },
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

      const { env, scrubbed } = buildChildEnv({
        base: options.daemonEnv,
        loginPath: options.providerRoots.join(':'),
        tmpdir: await createRunTmpdir(),
      });

      // The contract the node's own result is filed under. An agent node
      // always declares one (`AgentNode.returns` is required), so this is
      // read once here rather than defensively at each call.
      const outputSchemaId =
        setting.node.type === 'agent' ? SchemaIdSchema.parse(setting.node.returns.schemaId) : null;

      const ledger = sqliteLedgerSink({
        db: ctx.db,
        runId: ctx.runId,
        epoch: ctx.epoch,
        dataDir: options.dataDir,
      });
      // KAR-23.5 — the row `cancelNode`, `killRun` and the boot reaper read.
      // Passed on **both** routes: without it an execution child is a pid
      // nothing in the daemon can name, which is why the kill switch answered
      // `nothing-running` on 2026-08-24 while three vendor children were alive.
      const processes = sqliteProcessRegistry({
        db: ctx.db,
        runId: ctx.runId,
        epoch: ctx.epoch,
        dataDir: options.dataDir,
      });
      const captureEvidence = (evidence: string | Uint8Array) =>
        putBlob(
          options.dataDir,
          typeof evidence === 'string' ? Buffer.from(evidence, 'utf8') : evidence,
          'text/plain',
        );
      // KAR-08.7 AC3's completion-time backstop, wired rather than declared.
      // Both runners refuse a node that declares a path scope with no auditor
      // behind it — *"a declared scope with nothing behind it reads exactly
      // like an agent that behaved"* — and every agent node the planner emits
      // declares one, so this is the difference between a run that executes
      // and a run that refuses itself.
      //
      // No `env` override: DeFlowd passes nothing and the auditor's `git` gets
      // the user's own configuration, which is the only environment their
      // repository actually works in (`run-git.ts`).
      const scopeAudit = createScopeAudit();
      const prompt = renderPacket({ segments: built.packet.segments });

      const outcome =
        route === 'shim'
          ? await runShimTurn({
              options,
              ctx,
              command,
              chosen,
              binaryPath,
              worktree: provisioned.path,
              prompt,
              outputSchemaId,
              env,
              scrubbed,
              ports: { ledger, processes, captureEvidence, scopeAudit },
            })
          : await (async () => {
              const plan = spawnPlan(spec, {
                resolved: { provider: spec.id, path: binaryPath },
                worktree: provisioned.path,
              });
              return await runAcpNode(
                {
                  runId: ctx.runId,
                  nodeId: command.node,
                  attempt: command.attempt,
                  provider: chosen.row.provider,
                  permission: command.permission,
                  worktree: provisioned.path,
                  // KAR-23.5 — `spec.bin`, the ACP bridge, and not
                  // `chosen.binaryPath`. The probed row's own `binaryPath` is
                  // the bridge (the boot probe resolves `spec.bin`), so after
                  // this the sha on `node.started` finally names the binary the
                  // row that admitted the node was taken from.
                  binary: {
                    path: binaryPath,
                    version: chosen.row.version,
                    sha256: binarySha256(binaryPath),
                  },
                  argv: plan.argv,
                  env: { ...env, ...plan.env },
                  mcpServers: [],
                  requires: requirementsOf(setting.node),
                  prompt,
                  pins: built.packet.segments.filter((segment) => segment.pinned),
                  pathScope: [...command.pathScopes.write],
                  ...(outputSchemaId === null ? {} : { outputSchemaId }),
                },
                {
                  clock: ctx.clock,
                  capabilityRow: chosen.row,
                  ledger,
                  processes,
                  scopeAudit,
                  captureEvidence,
                },
              );
            })();

      if (outcome.status === 'failed') {
        wiring.warn(
          { runId: ctx.runId, node: command.node, route, reason: outcome.failure.reason },
          `${command.node} failed on ${chosen.provider} (${route}): ${outcome.failure.message}`,
        );
      }
    } finally {
      // Not swallowed and not a second outcome: the runner has already recorded
      // what happened to the attempt, and a worktree that cannot go
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
