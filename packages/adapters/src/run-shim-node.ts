/**
 * KAR-05.8 — one node's turn, driven through a vendor CLI's own flags.
 *
 * This is the fallback for an agent with no ACP path, or an ACP adapter broken
 * by a vendor release: it degrades rather than blocks. What it gives up is not
 * the parsing — it is **mediation**. On this path DeFlow no longer sits in
 * front of every file access and every command execution, so the node's
 * permission level is expressed through the vendor's own flags and nothing
 * DeFlow does can enforce it mid-turn.
 *
 * That is why the module starts by refusing. `shimCapabilityRow` reports
 * `mediatedExecution: false` about itself, `admit` turns that into
 * `safety.permission-unschedulable` for every level above `read`, and the flag
 * table refuses a level the vendor has no flag for at all. Both refusals
 * happen before a process exists. A shim that quietly ran the node at whatever
 * the vendor defaults to would be ODW's binary permission model wearing a
 * ladder's clothes, which is the thing F5.4 exists to avoid.
 *
 * Four rules hold the rest of it together, and each is one that the ACP path
 * already keeps — deliberately the same ones, because a second set would drift.
 *
 * **The frame cap is KAR-05.4's, not a new one.** `frameGuard` counts bytes
 * since the last newline, upstream of any parse, and this file imports it
 * rather than restating 8 MiB. A vendor CLI is if anything more likely to emit
 * one enormous line than an ACP agent is: it has no framing discipline at all.
 *
 * **The append happens before the next read.** stdout stays paused and is read
 * one chunk at a time from inside the loop, so while DeFlow is writing to
 * SQLite nothing is read, the 64 KiB pipe fills, and the agent blocks in
 * `write()`.
 *
 * **The line's `uuid` is the dedup key.** A line whose uuid is already durable
 * is *interpreted* — its text still counts towards this turn's output, its
 * result envelope still decides the outcome — and *not appended*. That
 * distinction is the whole of AC4: replaying an output after a crash must
 * produce one set of ledger rows, not two, while still producing an answer.
 *
 * **Nothing leaves here as a thrown `Error`.** Every exit is a `NodeFailure`
 * through `toAdapterFailure`, exactly as `run-node.ts` does it.
 *
 * Verifies: EPIC-05-S29 · KAR-05.8 AC2–AC8
 */
import {
  assertIndependentReview,
  type Clock,
  type CompactionLever,
  type CompletedNodeResult,
  compactionLever,
  type EventSeq,
  type Handle,
  ikey,
  type NodeFailure,
  NodeFailureError,
  type NodeId,
  type PermissionLevel,
  type PreflightEstimate,
  type ProducerNodeView,
  type ProviderAuthMode,
  type ProviderId,
  QUOTA_WAKE_REASON,
  type RateLimit,
  type ResumeRequest,
  type RunId,
  rateLimitFailureTag,
  rateLimitMessage,
  type SchemaId,
  type StructuredOutput,
  type TokenUsage,
  vendorCompaction,
} from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import type { Readable } from 'node:stream';
import { admit } from './admission.ts';
import { argumentRefused, rejectedArgument } from './argument-refusal.ts';
import { budgetConsumed } from './budget-consumed.ts';
import type { CapabilityRow } from './capabilities.ts';
import { compactionEnv } from './compaction.ts';
import {
  agentExited,
  frameTooLarge,
  NotImplementedOnWin32,
  offendingFrameHead,
  protocolError,
  registryRefused,
  spawnRefused,
  toAdapterFailure,
} from './failures.ts';
import { frameGuard, parseFrameLimit } from './frame-guard.ts';
import { killTree, processStartTime } from './kill-tree.ts';
import { STDERR_TAIL_BYTES } from './launch.ts';
import {
  type AgentBinary,
  type EventRecord,
  eventVersion,
  type LedgerSink,
  type ProcessRegistry,
  type WakeRegistry,
} from './ports.ts';
import {
  type ProviderSpec,
  providerSpec,
  providerTokenAccounting,
  type ShimFormat,
} from './provider-registry.ts';
import {
  AGENT_TURN_SCHEMA_ID,
  CONTENT_SPILL_BYTES,
  estimateUsage,
  OUTPUT_INLINE_LIMIT_BYTES,
  type ProcessExit,
} from './run-node.ts';
import { type SandboxedShimPlan, type SandboxInvocation, sandboxedShimPlan } from './sandbox.ts';
import { auditCompletionScope, type ScopeAudit, scopeAuditRefusal } from './scope-audit.ts';
import {
  parseShimLine,
  type ShimFailureContext,
  shimCompactBoundary,
  shimRateLimit,
  shimResultCostUsd,
  shimResultFailure,
  shimResultUsage,
  shimStructuredOutput,
  shimText,
} from './shim-frames.ts';

/**
 * KAR-14.2 AC9 — what the vendor's own refusal is measured against, when
 * DeFlow armed one. Absent leaves the failure a `gate` carrying no numbers,
 * which is the honest answer for a ceiling nobody here set.
 */
const vendorCeiling = (request: ShimNodeRequest): ShimFailureContext =>
  request.costCeilingUsd === undefined
    ? {}
    : { ceiling: { node: request.nodeId, limitUsd: request.costCeilingUsd } };

/**
 * The lever a node runs with when its own resolution was refused.
 *
 * Only reachable on the refusal path, where the spawn never happens — it exists
 * so the spawn expression has no `null` to branch on rather than as a default
 * anybody gets.
 */
const NO_LEVER: CompactionLever = { autocompactPct: null, autoCompactDisabled: false };

/**
 * KAR-14.4 AC1, AC9, EPIC-14-S27 — a rate limit signalled only by an exit code.
 *
 * `null` unless the caller declared this code, which is the whole guard: an
 * undeclared non-zero exit stays `agent.nonzero-exit`, because DeFlow does not
 * invent a rate limit any more than it invents a reset time. The two halves of
 * the honesty are the same rule read in both directions.
 *
 * `raw` is the exit itself, verbatim, so a later parser has the same bytes this
 * build had — and `resetsAt` is simply not there, which is what
 * `describeRateLimit` renders as *"rate limited, reset time unknown"*.
 */
function blindRateLimit(
  request: ShimNodeRequest,
  exit: ProcessExit,
): { readonly thrown: NodeFailureError; readonly raw: unknown } | null {
  const declared = request.rateLimitExitCodes ?? [];
  if (exit.code === null || !declared.includes(exit.code)) return null;

  const raw = { exitCode: exit.code, signal: exit.signal };
  const limit: RateLimit = { provider: request.provider, resetsAt: null, raw };
  return { raw, thrown: new NodeFailureError(rateLimitMessage(limit), rateLimitFailureTag(limit)) };
}

/**
 * The `node_wake.reason` a provider-side quota limit writes.
 *
 * Core's literal under this package's name, rather than a second `'quota'`:
 * the ACP path writes the same row from ./run-node.ts, and `decide()` restates
 * the reason on every tick, so a copy that drifted would leave a node asleep
 * under a reason no scheduler recognises.
 */
export const WAKE_REASON_QUOTA = QUOTA_WAKE_REASON;

/**
 * The capability row for an exec-shim adapter.
 *
 * Minted rather than probed, and that is honest: there is no handshake on this
 * path to probe, and the one bit that matters is not something the vendor
 * could tell DeFlow anyway. `mediatedExecution: false` is DeFlow's own
 * statement about its own position — it is not in the path — and it is stated
 * **explicitly** because KAR-05.2 treats an absent `mediatedExecution` as "not
 * advertised" rather than as a denial. A row that merely omitted it would be
 * admitted at every level, which is the silent escalation AC8 forbids.
 *
 * Everything else is left unadvertised on purpose. A shim has no `session/*`
 * methods to advertise, and claiming otherwise here would be exactly the
 * per-vendor capability constant `test/no-capability-table.test.ts` refuses.
 */
export function shimCapabilityRow(identity: {
  readonly provider: ProviderId;
  readonly version: string;
  readonly binaryPath: string;
  readonly binarySha256: string;
  readonly probedAt: number;
}): CapabilityRow {
  return {
    provider: identity.provider,
    version: identity.version,
    binaryPath: identity.binaryPath,
    binarySha256: identity.binarySha256,
    probedAt: identity.probedAt,
    // The path `capabilities.ts` reads is `agentCapabilities._meta
    // .mediatedExecution` — ACP v1 has no field for it, and `_meta` is the
    // extension point the protocol reserves. Writing it anywhere else would
    // produce a row that reads as "not advertised", which is admitted.
    capsJson: JSON.stringify({
      agentCapabilities: { _meta: { mediatedExecution: false, transport: 'exec-shim' } },
    }),
  };
}

/** What the node needs to run through the shim, as the scheduler decided it. */
export interface ShimNodeRequest {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** 0-based, matching the event envelope. */
  readonly attempt: number;
  readonly provider: ProviderId;
  /**
   * KAR-08.8's effective auth mode for this attempt, from
   * `resolveProviderAuth`. Absent means `'subscription'` — the default that
   * function itself uses, and the only honest one, because `'api_key'` is
   * reached solely by an explicit opt-in and DeFlow never invents it.
   *
   * It is on the request rather than derived here because KAR-14.1 AC3 turns
   * on it: subscription quota and real currency are two figures and must never
   * be summed, so the accounting record has to carry which one it is.
   */
  readonly authMode?: ProviderAuthMode;
  readonly permission: PermissionLevel;
  readonly worktree: string;
  readonly binary: AgentBinary;
  readonly prompt: string;
  /** Client-chosen, and the id every emitted frame is expected to carry back. */
  readonly sessionId: string;
  /**
   * KAR-12.2 — present on a review gate node, absent on everything else.
   *
   * Its presence is what scopes docs/10-verification-gates.md §3.2's
   * precondition to reviews. Forking and resuming stay legitimate for
   * continuation work, so a node with no `review` block is admitted exactly as
   * it was before this field existed — and a node *with* one is checked
   * **before spawn**, which on this path is the last point before the reviewer
   * receives any input, because DeFlow mints the uuid itself.
   */
  readonly review?: {
    /** The nodes named in the gate's `independence.notSessionOf`, with the
     * sessions they actually resolved to. */
    readonly producers: readonly ProducerNodeView[];
    /** What this node asked to resume, if anything. A `fork` or a resume of a
     * producer is refused however capable the adapter is. */
    readonly resume?: ResumeRequest;
  };
  /** Omitted means the vendor's richest streaming format. */
  readonly format?: ShimFormat;
  readonly outputSchemaId?: SchemaId;
  /**
   * KAR-09.9 AC2 — the emitted JSON Schema document this node's return is
   * contracted to, as an absolute path under the run's `.DeFlow/schemas/`.
   *
   * Present only where the vendor has a flag for it — `structuredOutputContract`
   * is what decides that, and a prompt-only adapter is handed the schema in its
   * prompt instead. Passing it to a vendor with no flag changes nothing about
   * the argv, which is safe precisely because the mechanism is also recorded in
   * the manifest rather than assumed.
   */
  readonly schemaPath?: string;
  /**
   * KAR-19.11 AC1 — the schema document's own bytes, for a vendor whose entry
   * declares its structured-output argument `inline-json`.
   *
   * Claude Code 2.1.220 parses the value of `--json-schema` as JSON and exits 1
   * when it does not parse. The caller reads the file — this package performs
   * no I/O — and the registry decides from the entry's declared form whether
   * the path or the document reaches the command line. Omitting it for a vendor
   * that wants the document is a construction-time refusal, never a fallback to
   * the path: falling back is the defect.
   */
  readonly schemaDocument?: string;
  /**
   * KAR-14.2 AC9 — this node's own cost ceiling in USD, armed on the vendor's
   * own budget flag as defence in depth *below* DeFlow's admission check.
   *
   * Two things follow from passing it. The vendor stops the turn itself rather
   * than running to the end of a plan DeFlow would have paused anyway, and the
   * refusal that comes back can carry a `limit` — the envelope reports what was
   * spent and never what the ceiling was, so a run that armed nothing gets a
   * `gate` with no numbers rather than invented ones.
   */
  readonly costCeilingUsd?: number;
  /**
   * KAR-14.3 AC8 — what this attempt was estimated to cost **before** it was
   * admitted, echoed onto the accounting record so the estimate and the actual
   * can be reconciled without a join.
   *
   * Supplied by the caller because the estimator needs a real tokenizer and the
   * learned calibration, and this package has neither: @DeFlow/adapters depends
   * on @DeFlow/core alone, and the BPE table and the ledger both live elsewhere.
   * Absent means nobody estimated the attempt, which is a fact, and is recorded
   * as an absence rather than as a zero.
   */
  readonly preflight?: PreflightEstimate;
  /** The child's whole environment. Absent inherits the daemon's. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * KAR-14.4 AC1, EPIC-14-S27 — the exit codes this provider is known to use
   * to mean *"rate limited"*, when it says so no other way.
   *
   * Data supplied by the caller, and **empty by default** — which is a claim
   * rather than an omission. As of the 2026-08-02 probe no vendor has published
   * an exit code that means a rate limit, so DeFlow declares none and guesses
   * none: an invented table would classify an ordinary crash as a limit and
   * back a run off for five minutes against a provider that is simply broken.
   * The mechanism exists because the degradation path has to be real code
   * rather than a plan, and it becomes live the day a vendor documents a code.
   *
   * No vendor is named here, and none may be: which codes a provider uses is a
   * fact about invocation and belongs to the registry
   * (`test/no-capability-table.test.ts` greps this directory).
   */
  readonly rateLimitExitCodes?: readonly number[];
  /**
   * KAR-08.5 — everything the node's sandbox policy depends on that is not the
   * vendor's invocation: the detected CLI version, the platform, the roots the
   * sandbox prerequisites are looked for on, and where a wrapper config goes.
   *
   * **Required, not optional.** The whole story is that a level DeFlow cannot
   * enforce must fail before a process exists; an optional field would make
   * "the caller forgot" indistinguishable from "there is nothing to enforce",
   * and the compiler is the only reviewer that never forgets.
   */
  readonly sandbox: SandboxInvocation;
  /**
   * KAR-08.7 — the write globs the plan declared for this node.
   *
   * It matters *more* here than on the ACP path, not less: this is the
   * unmediated path, so DeFlow is not in front of the vendor's file access at
   * all and the completion-time diff is the only detection there is. Absent is
   * a node that declared none; present with no `ShimPorts.scopeAudit` behind
   * it is refused before the spawn.
   */
  readonly pathScope?: readonly string[];
  /** KAR-23.11 — the commit this node's worktree was provisioned from, so the
   * completion audit can tell an agent that committed its own work from one
   * that produced nothing. See `AcpNodeRequest.baseOid`. */
  readonly baseOid?: string;
  /**
   * KAR-09.6 AC7, AC8 — what the operator configured about this vendor's own
   * auto-compaction, before the node's permission level is applied to it.
   *
   * The *policy* (70% for write-capable nodes, the opt-out scoped to `read`)
   * is `compactionLever` in `@DeFlow/core`; what arrives here is the raw
   * `providers.<id>` slice, so the refusal of a write-capable opt-out happens
   * in one place rather than at every caller.
   */
  readonly compaction?: {
    readonly autocompactPct?: number;
    readonly disableAutoCompact?: boolean;
  };
}

export interface ShimPorts {
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  readonly ledger: LedgerSink;
  readonly captureEvidence: (evidence: string | Uint8Array) => Handle;
  /** The shim adapter's own row. `shimCapabilityRow` is what mints it. */
  readonly capabilityRow?: CapabilityRow | null;
  readonly processes?: ProcessRegistry;
  /** Where a rate limit's `resetsAt` becomes a durable wake (AC6). */
  readonly wakes?: WakeRegistry;
  readonly maxFrameBytes?: number;
  /** KAR-08.7 AC3 — the completion-time scope backstop, the same port
   * `AcpPorts` takes and for the same reason: the answer comes from `git`, and
   * the daemon owns the one place a `git` child is spawned. */
  readonly scopeAudit?: ScopeAudit;
  /**
   * The line uuids this node attempt has already made durable.
   *
   * Read from the ledger by the caller, because this package owns no database.
   * Absent means "nothing is durable yet", which is the honest answer for a
   * first attempt and the wrong one for a replay — a replay that passed
   * nothing here would append the whole transcript a second time.
   */
  readonly seenUuids?: Iterable<string>;
  /**
   * KAR-09.6 AC6 — §6.3's transcript snapshot, behind a port for the reason
   * every port here is one: the bytes go into `@DeFlow/ledger`'s blob store and
   * this package owns no store. Absent means no snapshot is attempted, which
   * is `originalHandle: null` — the documented degradation, not an error.
   */
  readonly transcripts?: TranscriptSnapshots;
}

/** Copies the vendor's own session transcript into the run's artifact store. */
export interface TranscriptSnapshots {
  /** The handle, or `null` when there was nothing to copy. Never throws for an
   * absent file — the path convention is Unverified (AC6). */
  snapshot(input: {
    readonly sessionId: string;
    readonly node: NodeId;
    readonly attempt: number;
  }): Promise<Handle | null>;
}

interface ShimOutcomeCommon {
  /** The argv the child was actually spawned with. Empty on a refusal. */
  readonly argv: readonly string[];
  readonly format: ShimFormat | null;
  readonly sessionId: string;
  readonly exit: ProcessExit | null;
  /** The child's process group; 0 when nothing was spawned. */
  readonly pgid: number;
  /** The tail of the child's stderr — where a vendor prints a flag refusal. */
  readonly stderr: string;
  /**
   * KAR-09.9 AC2 — the parsed object the `result` envelope carried, or
   * `{ present: false }` when it carried none.
   *
   * On the common arm rather than only on `completed`, because "the turn
   * failed *and* produced no structured output" and "the turn failed after
   * producing one" are different diagnoses, and the second one is the case
   * where the schema is fine and something else broke.
   */
  readonly structuredOutput: StructuredOutput;
}

export type ShimNodeOutcome = ShimOutcomeCommon &
  (
    | { readonly status: 'completed'; readonly result: CompletedNodeResult }
    | { readonly status: 'failed'; readonly failure: NodeFailure }
  );

/** Signals the child's whole group through the one abstraction allowed to. */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  if (pgid <= 1) return;
  try {
    killTree(pgid, signal);
  } catch (error) {
    if (error instanceof NotImplementedOnWin32) throw error;
  }
}

/** Resolves with the next available chunk, or `null` at end of stream. */
function readChunk(stream: Readable): Promise<Uint8Array | null> {
  const ready = stream.read() as Buffer | null;
  if (ready !== null) return Promise.resolve(new Uint8Array(ready));

  return new Promise<Uint8Array | null>((resolve) => {
    const settle = (value: Uint8Array | null): void => {
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onEnd);
      resolve(value);
    };
    function onReadable(): void {
      const chunk = stream.read() as Buffer | null;
      // A 'readable' with nothing to read happens at EOF and after a partial
      // read; the next event settles it.
      if (chunk !== null) settle(new Uint8Array(chunk));
    }
    function onEnd(): void {
      settle(null);
    }
    stream.on('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
    stream.once('error', onEnd);
  });
}

/** Splits a buffer into complete lines plus whatever is still growing. */
function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts, rest };
}

export async function runShimNode(
  request: ShimNodeRequest,
  ports: ShimPorts,
): Promise<ShimNodeOutcome> {
  const { clock, ledger } = ports;
  const key = ikey(request.runId, request.nodeId, request.attempt, 0);
  const stderrChunks: Buffer[] = [];
  const stderrTail = (): string => {
    const joined = Buffer.concat(stderrChunks);
    return joined.subarray(Math.max(0, joined.byteLength - STDERR_TAIL_BYTES)).toString('utf8');
  };

  const event = (kind: string, payload: unknown, withIkey = false): EventRecord => ({
    kind,
    v: eventVersion(kind),
    ts: clock.now(),
    nodeId: request.nodeId,
    attempt: request.attempt,
    ...(withIkey ? { ikey: key } : {}),
    payload,
  });

  // KAR-09.6 AC7, AC8. Resolved *before* the scheduling event so the event can
  // carry it: a lever that only existed in the child's environment would leave
  // a mid-node context exhaustion unattributable, which is the whole reason AC8
  // asks for it to be recorded rather than merely set.
  //
  // A refused combination (a write-capable node asking to disable
  // auto-compaction) is held rather than thrown, so the scheduling event still
  // exists to attribute the refusal to. It is re-raised below with the rest of
  // what is decided without a process.
  let lever: CompactionLever | null = null;
  let leverRefusal: unknown = null;
  try {
    lever = compactionLever({
      permission: request.permission,
      ...(request.compaction?.autocompactPct === undefined
        ? {}
        : { autocompactPct: request.compaction.autocompactPct }),
      ...(request.compaction?.disableAutoCompact === undefined
        ? {}
        : { disableAutoCompact: request.compaction.disableAutoCompact }),
    });
  } catch (error) {
    leverRefusal = error;
  }

  let lastSeq: EventSeq = await ledger.append(
    event('node.scheduled', {
      node: request.nodeId,
      provider: request.provider,
      permission: request.permission,
      ...(lever === null ? {} : { compaction: lever }),
    }),
  );

  const refuse = async (
    thrown: unknown,
    common: Partial<ShimOutcomeCommon> = {},
    /**
     * KAR-14.1 AC5 — what this attempt spent before it failed, when a `result`
     * envelope had already reported something.
     *
     * Absent for every refusal that happens before a process exists: there is
     * nothing to account for, and appending a zero would put a free turn on a
     * chart for a turn that never ran.
     */
    spent = false,
    /** KAR-23.11 — evidence only the caller can name, appended to whatever the
     * mapping already gathered. The work-product refusal uses it to keep the
     * agent's own account of the turn. */
    extraEvidence: readonly Handle[] = [],
  ): Promise<ShimNodeOutcome> => {
    const mapped = toAdapterFailure(thrown, {
      occurredAtEvent: lastSeq,
      attempt: request.attempt,
      captureEvidence: ports.captureEvidence,
    });
    const head = offendingFrameHead(thrown);
    const failure: NodeFailure = {
      ...mapped,
      evidence: [
        ...mapped.evidence,
        ...(head === null ? [] : [ports.captureEvidence(head)]),
        ...extraEvidence,
      ],
    };
    const failed = event('node.failed', {
      node: request.nodeId,
      attempt: request.attempt,
      failure,
    });
    // The same one-transaction rule the completion path keeps: a failed
    // attempt's spend is still spend, and a crash between the two events would
    // lose it exactly as it would lose a successful one.
    if (spent) await ledger.appendAll([event('budget.consumed', spendPayload()), failed]);
    else await ledger.append(failed);
    return {
      status: 'failed',
      failure,
      argv: [],
      format: null,
      sessionId: request.sessionId,
      exit: null,
      pgid: 0,
      stderr: stderrTail(),
      // Nothing was spawned, so nothing came back — and absent is the answer,
      // not a gap (KAR-09.9 AC2).
      structuredOutput: { present: false },
      ...common,
    };
  };

  // Everything that can be decided without a process is decided here, in one
  // place, and in the order that costs least: the cap, then the vendor's own
  // flag table, then admission. Each of the three is a plan-time fact, and
  // finding one out an hour into a turn helps nobody.
  let maxFrameBytes: number;
  let plan: SandboxedShimPlan;
  let spec: ProviderSpec;
  try {
    // KAR-09.6 AC8's refusal, raised here so it is refused the same way every
    // other plan-time fact is: before a process exists, and as a `NodeFailure`.
    if (leverRefusal !== null) {
      throw registryRefused(
        leverRefusal instanceof Error ? leverRefusal.message : 'the compaction lever was refused',
        { provider: request.provider, permission: request.permission },
      );
    }

    maxFrameBytes = parseFrameLimit(ports.maxFrameBytes);

    // KAR-08.7 AC3 — a declared scope with no auditor wired behind it, refused
    // with the rest of what can be decided without a process. Completing a node
    // whose backstop was never there is indistinguishable from an agent that
    // stayed inside its scope, and on this path there is no second mechanism.
    const unwired = scopeAuditRefusal(request.pathScope, ports.scopeAudit);
    if (unwired !== null) throw unwired;

    const resolved = providerSpec(request.provider);
    if (resolved === undefined) {
      throw registryRefused(
        `no invocation is registered for provider ${request.provider}, so the exec shim has no ` +
          'flags to drive it with; the registry is the one place a vendor is named',
        { provider: request.provider },
      );
    }
    spec = resolved;

    // AC3, the permission refusal and KAR-08.5's missing-sandbox refusal all
    // raise from in here, before a spawn.
    plan = sandboxedShimPlan(
      spec,
      {
        resolved: { provider: request.provider, path: request.binary.path },
        worktree: request.worktree,
        prompt: request.prompt,
        sessionId: request.sessionId,
        permission: request.permission,
        ...(request.format === undefined ? {} : { format: request.format }),
        ...(request.schemaPath === undefined ? {} : { schemaPath: request.schemaPath }),
        ...(request.schemaDocument === undefined ? {} : { schemaDocument: request.schemaDocument }),
        ...(request.costCeilingUsd === undefined ? {} : { costCeilingUsd: request.costCeilingUsd }),
      },
      request.sandbox,
    );
  } catch (error) {
    return refuse(error);
  }

  // AC8 — the row says `mediatedExecution: false` about itself, and every
  // level above `read` is refused rather than run at a level DeFlow cannot
  // enforce.
  const refusal = admit(
    { node: request.nodeId, requires: [], permission: request.permission },
    ports.capabilityRow ?? null,
  );
  if (refusal !== null) return refuse(refusal);

  // KAR-12.2 AC4 — the last point before the reviewer receives any input on
  // this path. The uuid was minted above and travels on the argv, so there is
  // nothing left to learn about the session: everything after this line spawns
  // a process and writes a prompt into it. A refusal here therefore leaves no
  // `node.started`, no argv and no pgid, which is what EPIC-12-S12's *"zero
  // `session/prompt` frames"* looks like on a path that has no such method.
  if (request.review !== undefined) {
    try {
      assertIndependentReview(
        {
          id: request.nodeId,
          resolvedSessionId: request.sessionId,
          ...(request.review.resume === undefined ? {} : { resume: request.review.resume }),
        },
        request.review.producers,
      );
    } catch (error) {
      return refuse(error);
    }
  }

  // KAR-08.5 — the sandbox wrapper reads its policy from a file, so the file
  // has to exist before the wrapper does. Written into a directory DeFlow
  // made, never into the operator's `~/.srt-settings.json`, and written here
  // rather than inside the plan builder so that `sandboxedShimPlan` stays a
  // pure, construction-time refusal.
  if (plan.runtimeConfig !== null) {
    try {
      await mkdir(dirname(plan.runtimeConfig.path), { recursive: true });
      await writeFile(plan.runtimeConfig.path, JSON.stringify(plan.runtimeConfig.document), 'utf8');
    } catch (error) {
      return refuse(spawnRefused(plan.command, error));
    }
  }

  const child: ChildProcessWithoutNullStreams = spawn(plan.command, [...plan.argv], {
    cwd: request.worktree,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Mandatory (§9.3): the child leads its own group, so a wedged CLI and
    // everything it spawned can be reached with one signal.
    detached: true,
    // KAR-09.6 AC7, AC8 — the compaction lever, merged over whatever
    // environment the daemon built. It is applied here rather than by the
    // caller so that "the lever recorded on node.scheduled is the lever the
    // child got" is true by construction; `compactionEnv` answers `{}` for a
    // vendor with no such variables, which is every vendor but one.
    env: { ...(request.env ?? process.env), ...compactionEnv(spec, lever ?? NO_LEVER) },
  });
  const pgid = child.pid ?? 0;

  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => {
      reject(spawnRefused(plan.command, error));
    });
  });
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  child.stderr.on('readable', () => {
    for (;;) {
      const chunk = child.stderr.read() as Buffer | null;
      if (chunk === null) return;
      stderrChunks.push(chunk);
    }
  });

  // KAR-09.9 AC2 — absent until a `result` envelope says otherwise, and absent
  // is a real answer rather than a missing one (see `shimStructuredOutput`).
  let structuredOutput: StructuredOutput = { present: false };

  const common = (exit: ProcessExit | null): ShimOutcomeCommon => ({
    argv: plan.argv,
    format: plan.format,
    sessionId: request.sessionId,
    exit,
    pgid,
    stderr: stderrTail(),
    structuredOutput,
  });

  /**
   * Refuses a frame that names a session DeFlow did not open.
   *
   * `null` passes: not every line carries `session_id`, and an absent field is
   * the vendor saying nothing rather than saying something else. Both ids are
   * named in the message because *"the session id was wrong"* is not a
   * diagnosis anybody can act on.
   */
  const assertSessionId = (frameSession: string | null): void => {
    if (frameSession === null || frameSession === request.sessionId) return;
    throw protocolError(
      `${request.provider} answered on session ${frameSession}, but DeFlow opened ` +
        `${request.sessionId} and passed it on the argv. A frame naming another session was not ` +
        'produced by the session this node was admitted on',
      { node: request.nodeId, opened: request.sessionId, frame: frameSession },
    );
  };

  const seen = new Set(ports.seenUuids ?? []);
  const artifacts: Handle[] = [];
  let agentText = '';
  let usage: TokenUsage | null = null;
  let costUsd = 0;
  let resultFailure: NodeFailureError | null = null;
  let sawResult = false;

  /**
   * KAR-14.1 — this attempt's accounting record, judged against the manifest.
   *
   * `providerTokenAccounting` is what decides whether the envelope's figures
   * may be priced at all: a provider whose fidelity nobody has verified
   * (roadmap A4-3) contributes a blank cost and its name to the rollup's
   * `unaccounted` list, rather than a number that would be charted as truth.
   *
   * The fallback is DeFlow's own count of the prompt it sent and the text it
   * read back, never zero: a turn that produced megabytes of output did not
   * read and write nothing, and the estimate is the only figure left once the
   * vendor's is refused.
   */
  const spendPayload = (): unknown =>
    budgetConsumed({
      node: request.nodeId,
      attempt: request.attempt,
      provider: request.provider,
      accounting: providerTokenAccounting(request.provider),
      authMode: request.authMode ?? 'subscription',
      reported: usage === null ? null : { usage, costUsd },
      estimate: estimateUsage(request.prompt, agentText),
      preflight: request.preflight,
    });

  /**
   * Files one already-parsed line: the raw bytes into the data plane, one
   * progress row into the control plane, and — for a rate limit — the durable
   * wake DeFlow schedules against instead of retrying.
   *
   * Returns without writing anything when the uuid is already durable. The
   * caller has already interpreted the line by then, which is the point: a
   * replay produces the same *answer* and no second set of rows.
   */
  const fileLine = async (text: string, uuid: string | null, type: string): Promise<void> => {
    if (uuid !== null && seen.has(uuid)) return;
    if (uuid !== null) seen.add(uuid);

    const ioChunkSeq = await ledger.appendIo({
      nodeId: request.nodeId,
      attempt: request.attempt,
      stream: 'stdout',
      ts: clock.now(),
      data: Buffer.from(`${text}\n`, 'utf8'),
    });

    // A line whose payload is over the ceiling leaves the control plane for the
    // blob store and the row keeps a handle to it (KAR-05.4 AC5). The event is
    // the row *pointing at* the output; carrying it would make every replay
    // re-read a megabyte for ever.
    const bytes = Buffer.byteLength(text, 'utf8');
    let note = '';
    if (bytes > CONTENT_SPILL_BYTES) {
      const handle = ports.captureEvidence(text);
      if (!artifacts.includes(handle)) artifacts.push(handle);
      note = ` · ${bytes} bytes spilled to ${handle}`;
    }

    lastSeq = await ledger.append(
      event('node.progress', {
        node: request.nodeId,
        attempt: request.attempt,
        phase: `shim.${type === '' ? 'line' : type}`,
        message: `uuid=${uuid ?? 'none'}${note}`,
        ioChunkSeq,
      }),
    );
  };

  /**
   * Files one vendor compaction: §6.3's transcript snapshot first, then the
   * event that points at it.
   *
   * In that order because the handle is only honest if the bytes are already
   * in the store — an event naming a snapshot a later crash lost is exactly the
   * dangling reference content addressing cannot repair. The snapshot is
   * best-effort by construction: `snapshot` answers `null` for an absent file,
   * and a *thrown* error is swallowed here for the same reason, because the
   * path convention is Unverified and a node must not die of it (AC6).
   *
   * What it never does is fill in what the vendor did not say. `after`,
   * `droppedSegments` and `demotedToHandles` are typed empty on this arm of
   * `Compaction`, so there is no expression that could put a number there.
   */
  const recordCompaction = async (boundary: {
    readonly trigger: 'auto' | 'manual';
    readonly preTokens: number;
  }): Promise<void> => {
    let originalHandle: Handle | null = null;
    try {
      originalHandle =
        (await ports.transcripts?.snapshot({
          sessionId: request.sessionId,
          node: request.nodeId,
          attempt: request.attempt,
        })) ?? null;
    } catch {
      originalHandle = null;
    }

    lastSeq = await ledger.append(
      event('context.compacted', {
        node: request.nodeId,
        ...vendorCompaction({ ...boundary, originalHandle }),
      }),
    );
  };

  try {
    await started;

    const startedEvent = event(
      'node.started',
      {
        node: request.nodeId,
        attempt: request.attempt,
        ikey: key,
        binary: {
          path: request.binary.path,
          version: request.binary.version,
          sha256: request.binary.sha256,
        },
        // KAR-12.2 AC1 — on this path DeFlow chose the uuid, so it is known
        // before the process is, and `minted` says which of the two adapter
        // paths produced it.
        session: { id: request.sessionId, origin: 'minted' },
      },
      true,
    );
    lastSeq =
      ports.processes === undefined
        ? await ledger.append(startedEvent)
        : await ports.processes.appendWithProcess(startedEvent, {
            runId: request.runId,
            nodeId: request.nodeId,
            attempt: request.attempt,
            pid: pgid,
            pgid,
            startedAt: processStartTime(pgid),
            binarySha256: request.binary.sha256,
            worktree: request.worktree,
            spawnedAt: clock.now(),
          });

    // One guard for the whole invocation, so "bytes since the last newline"
    // spans reads: a line that arrives in a hundred chunks is one line, and a
    // counter per chunk would never see it.
    const guard = frameGuard(maxFrameBytes);
    let pending = '';

    for (;;) {
      const chunk = await readChunk(child.stdout);
      if (chunk === null) break;

      // Before any parse, and before the line is buffered: a cap applied after
      // the buffer has grown is not a cap. This is KAR-05.4's counter, imported
      // rather than restated — a second implementation of the same number is
      // two numbers waiting to disagree.
      const report = guard.inspect(chunk);
      // Thrown rather than handled here: the catch below is the one place that
      // signals the group and files the failure, so the frame cap exits the
      // same way a malformed line and a refused spawn do.
      if (report !== null) throw frameTooLarge(report);

      pending += Buffer.from(chunk).toString('utf8');
      const taken = takeLines(pending);
      pending = taken.rest;

      for (const text of taken.lines) {
        const line = parseShimLine(text);
        if (line === null) continue;

        // KAR-12.2 AC5 — the vendor honours the client-chosen `--session-id`
        // verbatim in every emitted frame (**verified 2026-08-02**), which is
        // what lets DeFlow assert on the uuid it minted rather than parse one
        // back out. Asserted rather than assumed: a frame answering on some
        // other session was not produced by the session the independence check
        // cleared, and on a review node that is the whole guarantee. Thrown, so
        // it exits through the one catch that signals the group and files the
        // failure, and thrown *before* the line contributes to the answer.
        assertSessionId(line.sessionId);

        // Interpreted first, filed second. A line the ledger already holds
        // still counts towards this turn's answer — that separation is what
        // makes a replay idempotent without making it silent.
        agentText += shimText(line);

        const limit = shimRateLimit(line);
        if (
          limit !== null &&
          limit.resetsAt !== null &&
          !(line.uuid !== null && seen.has(line.uuid))
        ) {
          await ledger.append(
            event('provider.rate_limited', {
              provider: request.provider,
              resetsAt: limit.resetsAt,
              raw: line.raw,
            }),
          );
          // Scheduled around, not retried into: a durable row at the instant
          // the vendor named.
          await ports.wakes?.schedule({
            runId: request.runId,
            nodeId: request.nodeId,
            wakeAt: limit.resetsAt,
            reason: WAKE_REASON_QUOTA,
          });
        }

        // KAR-09.6 AC2 — the vendor compacted its own session. Gated on the
        // dedup key like every other append: a replayed transcript must produce
        // one compaction event, not one per replay.
        const boundary = shimCompactBoundary(line);
        if (boundary !== null && !(line.uuid !== null && seen.has(line.uuid))) {
          await recordCompaction(boundary);
        }

        if (line.type === 'result') {
          sawResult = true;
          usage = shimResultUsage(line);
          costUsd = shimResultCostUsd(line);
          structuredOutput = shimStructuredOutput(line);
          resultFailure = shimResultFailure(line, vendorCeiling(request));
        }

        await fileLine(text, line.uuid, line.type);
      }
    }

    if (pending.trim() !== '') {
      const line = parseShimLine(pending);
      if (line !== null) {
        assertSessionId(line.sessionId);
        agentText += shimText(line);
        if (line.type === 'result') {
          sawResult = true;
          usage = shimResultUsage(line);
          costUsd = shimResultCostUsd(line);
          structuredOutput = shimStructuredOutput(line);
          resultFailure = shimResultFailure(line, vendorCeiling(request));
        }
        await fileLine(pending, line.uuid, line.type);
      }
    }
  } catch (caught) {
    signalGroup(pgid, 'SIGKILL');
    const exit = await exited;
    return refuse(caught, common(exit));
  }

  child.stdin.end();
  const exit = await exited;

  // The vendor's own verdict wins over the exit code: a `result` envelope
  // naming its subtype says *why*, and the exit code that follows it says only
  // that something went wrong.
  if (resultFailure !== null) return refuse(resultFailure, common(exit), true);

  if (!sawResult) {
    // KAR-14.4 AC1, EPIC-14-S27 — the honest degradation. The vendor said
    // nothing machine-readable, but the caller declared this exit code to mean
    // a rate limit, so the failure is recorded as one: `transient`, retryable,
    // and with `resetsAt` **absent** rather than invented. A fabricated reset
    // is worse than an honest gap for the reason a fabricated compaction figure
    // is — the operator schedules their afternoon around it — so this path
    // writes no `node_wake` row at all and the retry ladder's full jitter is
    // what schedules the next attempt.
    const blind = blindRateLimit(request, exit);
    if (blind !== null) {
      await ledger.append(
        event('provider.rate_limited', { provider: request.provider, raw: blind.raw }),
      );
      return refuse(blind.thrown, common(exit));
    }

    // KAR-19.8 AC5, AC6 — the child refused an argument *DeFlow* chose. That
    // is a different diagnosis from "the turn went wrong": it names the flag
    // and the value in the failure, and it is `permanent`, because an argument
    // this vendor refuses now is one it refuses on every attempt. The
    // 2026-08-13 log — the same error at 11:07:13, 11:07:44, 11:08:14 — is what
    // classifying it `transient` looks like from the outside.
    const rejected = rejectedArgument({ argv: plan.argv, stderr: stderrTail(), spec });
    if (rejected !== null) {
      return refuse(
        argumentRefused({
          provider: request.provider,
          rejected,
          stderr: stderrTail(),
          code: exit.code,
          signal: exit.signal,
        }),
        common(exit),
      );
    }

    // Exit without a result envelope, whatever the code. The worst outcome in
    // the conformance battery is the *quiet* one — a node that looks successful
    // and carries nothing — so an absent envelope fails rather than completing
    // with whatever text arrived.
    return refuse(agentExited(exit.code, exit.signal), common(exit));
  }

  const bytes = Buffer.byteLength(agentText, 'utf8');
  const handle = bytes > OUTPUT_INLINE_LIMIT_BYTES ? ports.captureEvidence(agentText) : null;

  const result: CompletedNodeResult = {
    status: 'completed',
    output: handle === null ? { text: agentText } : { textHandle: handle, bytes },
    outputSchemaId: request.outputSchemaId ?? AGENT_TURN_SCHEMA_ID,
    // The billing truth, from the vendor's own envelope. Never an estimate on
    // this path — the vendor already counted, and mixing the two produces a
    // total with no meaning (docs/04-domain-model.md §8).
    usage: usage ?? { inputTokens: 0, outputTokens: 0, source: 'vendor-reported' },
    costUsd,
    producedFacts: [],
    artifacts: handle === null ? artifacts : [...artifacts, handle],
  };
  // KAR-08.7 AC3 — the same backstop the ACP path runs, at the same moment and
  // through the same chokepoint: the vendor has exited, so the worktree is
  // final, and the node is not finished until the line below.
  const audited = await auditCompletionScope(
    {
      node: request.nodeId,
      attempt: request.attempt,
      worktree: request.worktree,
      declared: request.pathScope,
      ...(request.baseOid === undefined ? {} : { baseOid: request.baseOid }),
      artifacts: result.artifacts.length,
    },
    ports,
  );

  // KAR-23.11 — the work-product gate, on this route for the same reason it is
  // on the other: a node that declared a write scope and finished having
  // changed no file and made no commit did not do the work the plan promised.
  // `spent = true`, so the spend and the failure land in one transaction — the
  // twenty-two minutes the 2026-08-24 nodes burned are still spend.
  if (audited.refusal !== null) {
    // The agent's own account of the turn, kept as a handle rather than parsed.
    // DeFlow does not sniff for apologies — it measures the worktree — and it
    // keeps the text so the human reading the failure sees what the incident's
    // investigator had to go looking for.
    return refuse(audited.refusal, common(exit), true, [ports.captureEvidence(agentText)]);
  }
  // KAR-14.1 AC1 — the spend and the completion in one `BEGIN IMMEDIATE`, so a
  // crash cannot leave a node that finished and a run that does not know what
  // it cost. Ordered spend-first, so any reader that has seen the completion
  // has already seen what it was paid for.
  await ledger.appendAll([
    event('budget.consumed', spendPayload()),
    event('node.completed', { node: request.nodeId, attempt: request.attempt, result }),
  ]);

  return { ...common(exit), status: 'completed', result };
}
