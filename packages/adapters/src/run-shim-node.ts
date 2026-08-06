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
  type Clock,
  type CompletedNodeResult,
  type EventSeq,
  type Handle,
  ikey,
  type NodeFailure,
  type NodeFailureError,
  type NodeId,
  type PermissionLevel,
  type ProviderId,
  type RunId,
  type SchemaId,
  type TokenUsage,
} from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { admit } from './admission.ts';
import type { CapabilityRow } from './capabilities.ts';
import {
  agentExited,
  frameTooLarge,
  NotImplementedOnWin32,
  offendingFrameHead,
  registryRefused,
  spawnRefused,
  toAdapterFailure,
} from './failures.ts';
import { frameGuard, parseFrameLimit } from './frame-guard.ts';
import { killTree, processStartTime } from './kill-tree.ts';
import { STDERR_TAIL_BYTES } from './launch.ts';
import type { AgentBinary, EventRecord, LedgerSink, ProcessRegistry } from './ports.ts';
import { providerSpec, type ShimFormat } from './provider-registry.ts';
import {
  AGENT_TURN_SCHEMA_ID,
  CONTENT_SPILL_BYTES,
  OUTPUT_INLINE_LIMIT_BYTES,
  type ProcessExit,
} from './run-node.ts';
import { type SandboxedShimPlan, type SandboxInvocation, sandboxedShimPlan } from './sandbox.ts';
import {
  parseShimLine,
  shimRateLimit,
  shimResultCostUsd,
  shimResultFailure,
  shimResultUsage,
  shimText,
} from './shim-frames.ts';

/**
 * A durable timer row (`node_wake`), as the adapter needs to write one.
 *
 * A port rather than a direct dependency, for the reason every port in
 * ./ports.ts is one: the SQL lives in @DeFlow/ledger and this package depends
 * on @DeFlow/core alone (docs/16-repo-layout.md R2). It is a *row* and not a
 * `setTimeout` because Node's maximum timer delay is 2^31−1 ms and passing
 * more fires the callback after 1 ms — verified — which would turn a
 * fifteen-minute quota wait into an immediate retry, i.e. exactly the blind
 * retry this exists to replace.
 */
export interface NodeWakeRow {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** ms epoch. An instant, so it survives a restart that outlives the wait. */
  readonly wakeAt: number;
  readonly reason: string;
}

export interface WakeRegistry {
  schedule(row: NodeWakeRow): Promise<void>;
}

/** The `node_wake.reason` a provider-side quota limit writes. */
export const WAKE_REASON_QUOTA = 'quota';

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
  readonly permission: PermissionLevel;
  readonly worktree: string;
  readonly binary: AgentBinary;
  readonly prompt: string;
  /** Client-chosen, and the id every emitted frame is expected to carry back. */
  readonly sessionId: string;
  /** Omitted means the vendor's richest streaming format. */
  readonly format?: ShimFormat;
  readonly outputSchemaId?: SchemaId;
  /** The child's whole environment. Absent inherits the daemon's. */
  readonly env?: NodeJS.ProcessEnv;
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
  /**
   * The line uuids this node attempt has already made durable.
   *
   * Read from the ledger by the caller, because this package owns no database.
   * Absent means "nothing is durable yet", which is the honest answer for a
   * first attempt and the wrong one for a replay — a replay that passed
   * nothing here would append the whole transcript a second time.
   */
  readonly seenUuids?: Iterable<string>;
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
    v: 1,
    ts: clock.now(),
    nodeId: request.nodeId,
    attempt: request.attempt,
    ...(withIkey ? { ikey: key } : {}),
    payload,
  });

  let lastSeq: EventSeq = await ledger.append(
    event('node.scheduled', {
      node: request.nodeId,
      provider: request.provider,
      permission: request.permission,
    }),
  );

  const refuse = async (
    thrown: unknown,
    common: Partial<ShimOutcomeCommon> = {},
  ): Promise<ShimNodeOutcome> => {
    const mapped = toAdapterFailure(thrown, {
      occurredAtEvent: lastSeq,
      attempt: request.attempt,
      captureEvidence: ports.captureEvidence,
    });
    const head = offendingFrameHead(thrown);
    const failure: NodeFailure =
      head === null
        ? mapped
        : { ...mapped, evidence: [...mapped.evidence, ports.captureEvidence(head)] };
    await ledger.append(
      event('node.failed', { node: request.nodeId, attempt: request.attempt, failure }),
    );
    return {
      status: 'failed',
      failure,
      argv: [],
      format: null,
      sessionId: request.sessionId,
      exit: null,
      pgid: 0,
      stderr: stderrTail(),
      ...common,
    };
  };

  // Everything that can be decided without a process is decided here, in one
  // place, and in the order that costs least: the cap, then the vendor's own
  // flag table, then admission. Each of the three is a plan-time fact, and
  // finding one out an hour into a turn helps nobody.
  let maxFrameBytes: number;
  let plan: SandboxedShimPlan;
  try {
    maxFrameBytes = parseFrameLimit(ports.maxFrameBytes);

    const spec = providerSpec(request.provider);
    if (spec === undefined) {
      throw registryRefused(
        `no invocation is registered for provider ${request.provider}, so the exec shim has no ` +
          'flags to drive it with; the registry is the one place a vendor is named',
        { provider: request.provider },
      );
    }

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
    ...(request.env === undefined ? {} : { env: request.env }),
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

  const common = (exit: ProcessExit | null): ShimOutcomeCommon => ({
    argv: plan.argv,
    format: plan.format,
    sessionId: request.sessionId,
    exit,
    pgid,
    stderr: stderrTail(),
  });

  const seen = new Set(ports.seenUuids ?? []);
  const artifacts: Handle[] = [];
  let agentText = '';
  let usage: TokenUsage | null = null;
  let costUsd = 0;
  let resultFailure: NodeFailureError | null = null;
  let sawResult = false;

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

        if (line.type === 'result') {
          sawResult = true;
          usage = shimResultUsage(line);
          costUsd = shimResultCostUsd(line);
          resultFailure = shimResultFailure(line);
        }

        await fileLine(text, line.uuid, line.type);
      }
    }

    if (pending.trim() !== '') {
      const line = parseShimLine(pending);
      if (line !== null) {
        agentText += shimText(line);
        if (line.type === 'result') {
          sawResult = true;
          usage = shimResultUsage(line);
          costUsd = shimResultCostUsd(line);
          resultFailure = shimResultFailure(line);
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
  if (resultFailure !== null) return refuse(resultFailure, common(exit));

  if (!sawResult) {
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
  await ledger.append(
    event('node.completed', { node: request.nodeId, attempt: request.attempt, result }),
  );

  return { ...common(exit), status: 'completed', result };
}
