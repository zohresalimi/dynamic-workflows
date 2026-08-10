/**
 * KAR-12.1 — the `NodePerformer` that runs a `gate` node.
 *
 * The join between the run executor, which knows *when* a node may start, and
 * `runGateNode`, which knows how to run one gate. It carries exactly one piece
 * of knowledge of its own: which gate definition, worktree and producer a given
 * gate node refers to — and even that arrives through the injected `resolve`,
 * because gate discovery is KAR-12.6's (`.DeFlow/gates/*.yaml`, hashed into the
 * run manifest) and re-deriving it here would give a run two answers about
 * which bytes it ran.
 *
 * A node the resolver does not recognise is a **throw**, never a silent skip.
 * A gate that quietly does not run is a milestone that advances on a verdict
 * nobody produced, which is the one failure mode §2 exists to prevent.
 */
import type { NodeId, RunState, StartNode } from '@DeFlow/core';
import type { GateDefinition } from '@DeFlow/gates';
import type { ExecContext, NodePerformer } from '../exec/run-executor.ts';
import { type GateNodeOutcome, runGateNode } from './run-gate-node.ts';

/** Everything about a gate node the plan does not carry on the node itself. */
export interface GateNodeResolution {
  readonly definition: GateDefinition;
  /** The worktree the gate runs in, absolute. */
  readonly worktree: string;
  /** The repository root, absolute. Findings are made relative to it. */
  readonly repoRoot: string;
  /** Whose work this gate is judging. */
  readonly evaluatedNode: NodeId;
  /** The pinned spec the verdict is about. */
  readonly specHash: string;
  /** The hash of the definition's bytes, when it was discovered from disk. */
  readonly definitionSha256?: string;
}

export interface GatePerformerOptions {
  /** The data directory whose `blobs/` receives the captured gate output. */
  readonly dataDir: string;
  /** Variable names KAR-08.4 removed from the child environment. */
  readonly scrubbedEnv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly onSpawn?: (pid: number) => void;
  /** Called with each gate node's outcome, in order, for observability. */
  readonly onVerdict?: (node: NodeId, outcome: GateNodeOutcome) => void;
  /**
   * Which definition, worktree and producer this gate node names.
   *
   * `null` means "this is not a gate this performer owns", which is an error
   * rather than a skip — see the module note.
   */
  resolve(node: NodeId, state: RunState): GateNodeResolution | null;
}

/** A performer that runs `gate` nodes and refuses everything else. */
export function gateNodePerformer(options: GatePerformerOptions): NodePerformer {
  return async (command: StartNode, ctx: ExecContext): Promise<void> => {
    if (command.nodeType !== 'gate') {
      throw new Error(
        `${command.node} is a ${command.nodeType} node; the gate performer runs gate nodes only`,
      );
    }

    const resolved = options.resolve(command.node, ctx.state);
    if (resolved === null) {
      throw new Error(
        `no gate definition resolved for ${command.node} — a gate that does not run is a ` +
          'milestone advancing on a verdict nobody produced',
      );
    }

    const outcome = await runGateNode(
      {
        runId: ctx.runId,
        nodeId: command.node,
        attempt: command.attempt,
        evaluatedNode: resolved.evaluatedNode,
        definition: resolved.definition,
        worktree: resolved.worktree,
        repoRoot: resolved.repoRoot,
        specHash: resolved.specHash,
        ...(resolved.definitionSha256 === undefined
          ? {}
          : { definitionSha256: resolved.definitionSha256 }),
      },
      {
        db: ctx.db,
        clock: ctx.clock,
        epoch: ctx.epoch,
        dataDir: options.dataDir,
        daemonStartedAt: ctx.daemonStartedAt,
        effects: ctx.effects,
        ...(options.scrubbedEnv === undefined ? {} : { scrubbedEnv: options.scrubbedEnv }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
      },
    );

    options.onVerdict?.(command.node, outcome);
  };
}

/**
 * Routes a `StartNode` to the performer that owns its node type.
 *
 * A run of anything but gates needs an agent performer beside this one, and the
 * daemon composes them here rather than inside the executor so the executor
 * keeps knowing nothing about node types at all.
 */
export function byNodeType(
  performers: Readonly<Partial<Record<StartNode['nodeType'], NodePerformer>>>,
): NodePerformer {
  return (command: StartNode, ctx: ExecContext): Promise<void> => {
    const performer = performers[command.nodeType];
    if (performer === undefined) {
      return Promise.reject(
        new Error(`nothing in this daemon knows how to perform a ${command.nodeType} node`),
      );
    }
    return performer(command, ctx);
  };
}
