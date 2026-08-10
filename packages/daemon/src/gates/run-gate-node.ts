/**
 * KAR-12.1 — running one gate as a **node of a run**
 * (docs/10-verification-gates.md §1, §2; docs/05-durable-execution.md §8.3).
 *
 * `@DeFlow/gates` owns what a gate *says*: which command, which parser, which
 * severity floor, and the `Verdict` that comes out. It owns no database, no
 * clock beyond the one it is handed and no idea that runs exist. This module is
 * the other half — the one that makes a gate a node the scheduler can admit,
 * retry and read back:
 *
 *     node.started → [ effect journal → runGate ] → gate.evaluated + node.completed
 *
 * It is shaped like `runShimNode` in @DeFlow/adapters and for the same reason:
 * one function, one attempt, every exit an event. Nothing here decides *when* a
 * gate runs — `decide()` does, through the ladder in @DeFlow/core — and nothing
 * here decides what the verdict is.
 *
 * **A gate is the `pure` arm of the shell effect.** §8.3 splits side effects
 * into the two cases with honest answers, and a gate is the easy one by
 * construction: `effect: mutating` is a *load* error (AC3) precisely so that
 * re-running a gate to confirm a fix is always safe. So the journal row is
 * `kind: 'shell'`, the reconcile probe answers `not-started` for an inherited
 * `pending` row — re-running the command is cheaper and more truthful than
 * guessing what a half-observed one concluded — and the memoisation that
 * matters is *within* one attempt: a resume that re-enters the same ikey gets
 * the recorded verdict back rather than paying for tsc twice.
 *
 * **A refusal is not a verdict.** A command the F5.6 deny list turns away never
 * ran, so there is nothing to have an opinion about: the node fails with
 * `safety.execution-boundary` and the ledger carries no `gate.evaluated` at all
 * (AC11). It is appended as a plain `node.failed` rather than through the retry
 * ladder because the deny list is a pure function of the command — a second
 * attempt would be refused identically, and a backoff row would be a wake
 * nobody can act on.
 *
 * **A deterministic gate spends nothing.** `costUsd: 0` and no
 * `budget.consumed`, which is what lets AC2's zero-delta assertion be a fact
 * about the result rather than a hope about the absence of log lines.
 *
 * Time enters through the injected `Clock` (NF9).
 */
import {
  type Clock,
  type Db,
  EVENT_CURRENT_VERSIONS,
  type EventSeq,
  ikey as makeIkey,
  type NodeFailure,
  type NodeId,
  type RunId,
  sha256Hex,
  type VerdictV4,
} from '@DeFlow/core';
import {
  type GateDefinition,
  GateExecutionRefused,
  type GateRun,
  runGate,
  splitCommandLine,
} from '@DeFlow/gates';
import { appendEvents, type EventDraft } from '@DeFlow/ledger';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import process from 'node:process';
import type { Effect, EffectCtx, EffectRunner, ReconcileProbe } from '../effects/durable.ts';

/**
 * What a gate node's `node.completed` carries as its output document.
 *
 * The verdict itself is on `gate.evaluated`, which is the event every
 * projection reads; this is the node-shaped summary, so a timeline that only
 * folds `node.completed` still says which gate ran and how it came out.
 */
export const GATE_NODE_SCHEMA_ID = 'DeFlow.verdict.v4';

export interface GateNodeRequest {
  readonly runId: RunId;
  /** The gate's own node. */
  readonly nodeId: NodeId;
  /** 0-based, matching the event envelope. */
  readonly attempt: number;
  /** Whose work is being judged. */
  readonly evaluatedNode: NodeId;
  readonly definition: GateDefinition;
  /** The node's worktree, absolute. */
  readonly worktree: string;
  /** The repository root, absolute. Findings are made relative to it. */
  readonly repoRoot: string;
  /** The pinned spec this verdict is about. */
  readonly specHash: string;
  /**
   * The journal position to re-enter, when the caller is resuming a known one.
   *
   * Omitted on a first run, where `nextOrdinal` derives it from the journal —
   * the same rule every other effect follows.
   */
  readonly ordinal?: number;
  /**
   * The bytes KAR-12.6 hashed into the run manifest for this definition, when
   * the caller discovered it from disk.
   *
   * Used as the gate's *version* in `node.started`, which is the honest answer
   * for a node whose "binary" is a command from the repository: what changes a
   * gate's behaviour is its definition, and that is the thing worth pinning in
   * the provenance record.
   */
  readonly definitionSha256?: string;
}

export interface GateNodePorts {
  readonly db: Db;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** This daemon life's epoch, stamped on every event appended here. */
  readonly epoch: number;
  /** The data directory whose `blobs/` receives the captured gate output. */
  readonly dataDir: string;
  /** ms epoch this daemon life began at, for the journal's fourth branch. */
  readonly daemonStartedAt: number;
  readonly effects: EffectRunner;
  /** Variable names KAR-08.4 removed from the child environment. */
  readonly scrubbedEnv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Called with the gate command's pid the moment it exists. */
  readonly onSpawn?: (pid: number) => void;
}

export type GateNodeOutcome =
  | {
      readonly status: 'completed';
      readonly run: GateRun;
      readonly verdict: VerdictV4;
      /** The `seq` of `gate.evaluated` — what the milestone rule compares. */
      readonly evaluatedAt: EventSeq;
    }
  | { readonly status: 'failed'; readonly failure: NodeFailure };

const eventVersionOf = (kind: string): number =>
  (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)[kind] ?? 1;

/** sha256 of a file's bytes, or `null` when it cannot be read. */
async function fileSha256(path: string): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/**
 * The gate command's executable, as an absolute path.
 *
 * `PATH` *is* consulted here, unlike the provider binary resolver, and the
 * difference is not an oversight: a provider binary is configuration DeFlow
 * persists and re-resolves, whereas a gate command is a line of a file in the
 * repository whose whole point is that it runs the way the developer's own
 * `pnpm exec tsc` runs. What is recorded is the path that was actually found,
 * so the provenance is exact even though the lookup was not pinned.
 */
async function resolveCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (command.includes('/')) return isAbsolute(command) ? command : join(cwd, command);
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Next candidate. A command that resolves nowhere is `gate-tool-missing`
      // from the runner itself, which is a far better message than one
      // invented here.
    }
  }
  return command;
}

/** The provenance block `node.started` requires, for a node whose binary is a
 * command from the repository rather than a vendor CLI. */
async function gateBinary(
  request: GateNodeRequest,
  env: NodeJS.ProcessEnv,
): Promise<{ path: string; version: string; sha256: string }> {
  const [command] = splitCommandLine(request.definition.run);
  const path = await resolveCommand(command ?? '', request.worktree, env);
  const sha256 =
    (await fileSha256(path)) ??
    // A command that could not be hashed still needs a well-formed record, and
    // the honest stand-in is the hash of the line that named it: it identifies
    // *what DeFlow tried to run*, which is the question the field answers.
    (await sha256Hex(request.definition.run));
  const version =
    request.definitionSha256 ?? (await sha256Hex(request.definition.run)).slice(0, 12);
  return { path, version: `${request.definition.id}@${version.slice(0, 12)}`, sha256 };
}

/**
 * The journalled effect: one real gate command, performed at most once per
 * ikey, ever.
 *
 * `reconcile` answers `not-started` rather than probing, and that is the
 * `pure` branch of §8.3 rather than a gap. A gate mutates nothing — AC3 makes
 * that a load error to violate — so the cost of re-running an inherited
 * `pending` row is time, and the alternative (concluding something about a
 * command whose output was never captured) would be inventing a verdict.
 */
function gateEffect(
  request: GateNodeRequest,
  ports: GateNodePorts,
  requestHash: string,
): Effect<GateRun> {
  return {
    runId: request.runId,
    nodeId: request.nodeId,
    attempt: request.attempt,
    ...(request.ordinal === undefined ? {} : { ordinal: request.ordinal }),
    kind: 'shell',
    requestHash,
    perform(_ctx: EffectCtx): Promise<GateRun> {
      return runGate({
        definition: request.definition,
        worktree: request.worktree,
        repoRoot: request.repoRoot,
        node: request.nodeId,
        evaluatedNode: request.evaluatedNode,
        specHash: request.specHash,
        dataDir: ports.dataDir,
        clock: ports.clock,
        scrubbedEnv: ports.scrubbedEnv ?? [],
        ...(ports.env === undefined ? {} : { env: ports.env }),
        ...(ports.onSpawn === undefined ? {} : { onSpawn: ports.onSpawn }),
      });
    },
    reconcile(_ctx: EffectCtx): Promise<ReconcileProbe<GateRun>> {
      return Promise.resolve({ status: 'not-started' });
    },
  };
}

/**
 * Runs one gate node's attempt end to end, and returns what the ledger now
 * says about it.
 *
 * The two terminal events are appended in **one transaction**: a ledger that
 * records a verdict but not that the node finished is a run that re-admits the
 * gate for ever, and one that records the completion without the verdict is a
 * milestone advanced on evidence nobody can read.
 */
export async function runGateNode(
  request: GateNodeRequest,
  ports: GateNodePorts,
): Promise<GateNodeOutcome> {
  const { db, clock, epoch } = ports;
  const env = ports.env ?? process.env;
  const key = makeIkey(request.runId, request.nodeId, request.attempt, request.ordinal ?? 0);

  const draft = (kind: string, payload: unknown, extra: Partial<EventDraft> = {}): EventDraft => ({
    runId: request.runId,
    ts: clock.now(),
    kind,
    v: eventVersionOf(kind),
    epoch,
    nodeId: request.nodeId,
    attempt: request.attempt,
    payload,
    ...extra,
  });

  appendEvents(db, [
    draft(
      'node.started',
      {
        node: request.nodeId,
        attempt: request.attempt,
        ikey: key,
        binary: await gateBinary(request, env),
      },
      { ikey: key },
    ),
  ]);

  const requestHash = `sha256-${await sha256Hex(
    `${request.definition.id} ${request.definition.run} ${request.worktree} ${request.evaluatedNode}`,
  )}`;

  let run: GateRun;
  try {
    run = await ports.effects.durable(gateEffect(request, ports, requestHash));
  } catch (error) {
    if (!(error instanceof GateExecutionRefused)) throw error;
    const failure: NodeFailure = {
      reason: 'safety.execution-boundary',
      // Permanent, and deliberately not routed through the retry ladder: the
      // deny list is a pure function of the command, so a second attempt is
      // refused identically and a backoff row would be a wake nobody can act
      // on.
      class: 'permanent',
      message: error.message,
      detail: { gate: error.gate, rule: error.rule },
      evidence: [],
      occurredAtEvent: 0 as EventSeq,
      attempt: request.attempt,
    };
    const [seq] = appendEvents(db, [
      draft('node.failed', { node: request.nodeId, attempt: request.attempt, failure }),
    ]);
    return {
      status: 'failed',
      failure: { ...failure, occurredAtEvent: (seq ?? 1) as EventSeq },
    };
  }

  const verdict = run.verdict as VerdictV4;
  const seqs = db.transaction(() =>
    appendEvents(db, [
      draft('gate.evaluated', {
        gate: request.definition.id,
        node: request.evaluatedNode,
        verdict,
      }),
      draft('node.completed', {
        node: request.nodeId,
        attempt: request.attempt,
        result: {
          status: 'completed',
          output: {
            gate: request.definition.id,
            outcome: run.outcome,
            findings: run.findings.length,
            ...(run.reason === null ? {} : { reason: run.reason }),
          },
          outputSchemaId: GATE_NODE_SCHEMA_ID,
          // A deterministic gate consumes no model at all. `vendor-reported`
          // rather than `estimated` because zero here is *measured* — nothing
          // was sent to anything — and calling it an estimate would put it on
          // the wrong side of the one distinction token accounting refuses to
          // blur.
          usage: { inputTokens: 0, outputTokens: 0, source: 'vendor-reported' },
          costUsd: 0,
          producedFacts: [],
          artifacts: run.evidence === null ? [] : [run.evidence.handle],
        },
      }),
    ]),
  );

  return {
    status: 'completed',
    run,
    verdict,
    evaluatedAt: (seqs[0] ?? 1) as EventSeq,
  };
}
