/**
 * KAR-05.1 — one ACP client, driving one node's turn.
 *
 * The shape of this function is the story: `initialize` → `node.started` →
 * `session/new` → `session/prompt` → **the `nextUpdate()` pull loop** →
 * a terminal event. Five vendors cost one integration because everything
 * vendor-specific is above it (which binary, which argv — KAR-05.3) or beside
 * it (which policy answers a permission request — EPIC-08).
 *
 * Three rules hold it together.
 *
 * **The append happens before the next pull.** The loop closes the transport's
 * gate, appends the frame to `io_chunk` and the progress row to `event`, and
 * only then opens the gate and asks for more. The ledger is the source of
 * truth for resume, so an event that is not durable yet is an event a crash
 * loses while the agent has already moved on (docs/05-durable-execution.md).
 *
 * **A cancel does not tear the reader down.** Per §2.5 the client keeps
 * accepting `session/update` after sending `session/cancel`; the agent flushes
 * its tail and then answers the prompt with `stopReason: 'cancelled'`. A
 * client that stops reading loses the tail and can deadlock waiting for the
 * prompt response. Only when the agent ignores the protocol cancel — measured
 * on the injected `Clock` — does the process group get signalled.
 *
 * **Nothing leaves here as a thrown `Error`.** Every exit is a `NodeFailure`
 * through `toAdapterFailure`, with a closed reason, a class chosen where the
 * failure happened, a one-line message and evidence as handles (AC7).
 *
 * KAR-09.4 adds one loop around that shape and nothing else. A node with no
 * `turns` budget still sends exactly one `session/prompt`; one with a budget
 * continues for as long as the agent answers `stopReason: 'max_turn_requests'`,
 * which is ACP's *"I have more to do"*. Every `pinReinjectTurns` of those turns
 * the pinned set is appended again, verbatim, on adapters that advertise
 * mid-session steering — because prohibitions decay with turn depth even when
 * nothing was compacted (docs/08-context-and-memory.md §4.2). On adapters that
 * do not advertise it, nothing is attempted: the honest mitigation there is the
 * packet builder's planning warning and keeping nodes short.
 */

import {
  afterTurn,
  type CompletedNodeResult,
  contentHash,
  type EventSeq,
  findPinViolations,
  type Handle,
  ikey,
  type NodeFailure,
  NodeFailureError,
  PinIntegrityViolation,
  type ReinjectCounter,
  SchemaIdSchema,
  startReinjection,
  type TimerHandle,
  type TokenUsage,
} from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as acp from '@agentclientprotocol/sdk';
import { admit } from './admission.ts';
import { budgetConsumed } from './budget-consumed.ts';
import { CAPABILITY_PATHS, supportsSteering } from './capabilities.ts';
import { CLIENT_CAPABILITIES, CLIENT_INFO } from './client-capabilities.ts';
import {
  ACP_PROTOCOL_VERSION,
  advertisedButUnimplemented,
  agentExited,
  agentTimedOut,
  handshakeMismatch,
  isMethodNotFound,
  NotImplementedOnWin32,
  offendingFrameHead,
  spawnRefused,
  toAdapterFailure,
} from './failures.ts';
import { DEFAULT_MAX_FRAME_BYTES, parseFrameLimit } from './frame-guard.ts';
import { killTree, processStartTime, sweepTree } from './kill-tree.ts';
import { type AcpNodeRequest, type AcpPorts, type EventRecord, eventVersion } from './ports.ts';
import { providerTokenAccounting } from './provider-registry.ts';
import { openTransportRecorder, type TransportRecorder } from './recorder.ts';
import { auditCompletionScope, scopeAuditRefusal } from './scope-audit.ts';
import { agentTransport } from './transport.ts';
import { describeUpdate, toolCallContentText } from './updates.ts';

/** What a plain agent turn produces when the node declares no schema of its
 * own. EPIC-09/EPIC-12 own structured output; this is the honest default. */
export const AGENT_TURN_SCHEMA_ID = SchemaIdSchema.parse('DeFlow.agentturn.v1');

/**
 * How much of a turn's text may live inside the `node.completed` event.
 *
 * The control plane is re-read by every replay, so anything above this becomes
 * a handle into the blob store and the event keeps the handle. The ledger's own
 * ceiling is 256 KiB and it refuses a batch above it; a quarter of that is the
 * budget an *ordinary* turn is allowed to cost every future daemon start.
 * A flooding agent is not a rare case — a trivial turn already emits 16 KiB.
 */
export const OUTPUT_INLINE_LIMIT_BYTES = 64 * 1024;

/**
 * How large a tool result may be before its bytes leave the ledger for the
 * content-addressed blob store (KAR-05.4 AC5).
 *
 * 256 KiB, the same figure as `@DeFlow/ledger`'s `MAX_INLINE_PAYLOAD_BYTES` and
 * for the same reason — it is the ceiling docs/04-domain-model.md §10 sets on
 * anything that lands in an append-only table every replay re-reads. It is
 * restated here rather than imported because @DeFlow/adapters depends on
 * @DeFlow/core alone (docs/16-repo-layout.md R2), and
 * `test/integration/blob-spill.test.ts` is where the number is pinned.
 */
export const CONTENT_SPILL_BYTES = 256 * 1024;

/**
 * KAR-09.4 — what a continuation turn says when the caller supplies no text.
 *
 * Content-free on purpose. The node's instruction is in the packet and the
 * constraints are in the pinned block; a continuation that restated either
 * would be a second copy of pinned bytes that nothing hashes, which is the
 * drift the whole epic exists to prevent.
 */
export const CONTINUATION_PROMPT = 'Continue.';

/** Default cancellation grace, on the injected clock (§9.4 stage 1 → 2). */
export const CANCEL_GRACE_MS = 5_000;
/** Default SIGTERM → SIGKILL gap (§9.4 stage 2 → 3). */
export const KILL_GRACE_MS = 2_000;

/** Everything about a turn that only becomes known while it is running. */
interface TurnState {
  protocolVersion: number | null;
  newSessionRequest: acp.NewSessionRequest | null;
  sessionId: string | null;
  stopReason: acp.StopReason | null;
  /** The concatenated text of every `agent_message_chunk`. */
  agentText: string;
  /**
   * Every prompt this node sent, joined — the packet, each continuation and
   * each re-injection turn (KAR-09.4).
   *
   * Accumulated rather than taken from `request.prompt` because a multi-turn
   * node's input cost is every turn's input, and reporting only the first would
   * under-count a twenty-turn node by nineteen turns. A single-turn node's
   * value is byte-identical to `request.prompt`.
   */
  promptText: string;
  /** Handles for the oversized tool results this turn spilled, in order and
   * without repeats — the same log twice is one artifact, not two. */
  artifacts: Handle[];
  /** Whether *DeFlow* asked for the cancel, which is what makes it `by: 'user'`. */
  cancelRequested: boolean;
  /** Whether the cooperative cancel went unanswered and the group was signalled. */
  escalated: boolean;
  escalation: TimerHandle | null;
  killTimer: TimerHandle | null;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * What the pull loop needs of a session, and nothing more.
 *
 * The SDK's `ActiveSession` satisfies it structurally, which is the point:
 * KAR-05.5's resumed session cannot be one — `attachSession` is private and
 * `SessionBuilder` only ever sends `session/new` — so the loop is written
 * against the four members both can offer rather than duplicated per path. A
 * resumed node that ran a *different* loop would be a second implementation of
 * backpressure, spilling and the durable-append rule, and the two would drift.
 */
interface TurnSession {
  readonly sessionId: string;
  prompt(text: string): Promise<unknown>;
  nextUpdate(): Promise<acp.ActiveSessionMessage>;
  dispose(): void;
}

/**
 * The one-slot handover between the `session/update` handler and the loop.
 *
 * Deliberately unbounded on the push side and awaited on the take side: the
 * transport's gate is what applies backpressure (§2.3), and a second queue
 * with its own policy here would quietly undo it.
 */
interface UpdateQueue {
  push(message: acp.ActiveSessionMessage): void;
  take(): Promise<acp.ActiveSessionMessage>;
}

function updateQueue(): UpdateQueue {
  const buffered: acp.ActiveSessionMessage[] = [];
  let waiting: ((message: acp.ActiveSessionMessage) => void) | null = null;
  return {
    push(message) {
      const waiter = waiting;
      if (waiter === null) {
        buffered.push(message);
        return;
      }
      waiting = null;
      waiter(message);
    },
    take() {
      const next = buffered.shift();
      if (next !== undefined) return Promise.resolve(next);
      return new Promise<acp.ActiveSessionMessage>((resolve) => {
        waiting = resolve;
      });
    },
  };
}

/**
 * A session the client did not create, wrapped so the pull loop cannot tell.
 *
 * The stop message is queued from the prompt's own resolution, exactly as
 * `ActiveSession` does it, so `nextUpdate()` ends the turn on both paths.
 */
function resumedSession(
  ctx: acp.ClientContext,
  sessionId: string,
  updates: UpdateQueue,
): TurnSession {
  return {
    sessionId,
    prompt(text: string): Promise<unknown> {
      const response = ctx.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
      void (async () => {
        try {
          const settled = await response;
          updates.push({ kind: 'stop', response: settled, stopReason: settled.stopReason });
        } catch {
          // A rejected prompt reaches the loop through `stranded`; pushing an
          // error here as well would race two failures for one cause.
        }
      })();
      return response;
    },
    nextUpdate: () => updates.take(),
    dispose: () => {},
  };
}

/** What every arm of the outcome can say about the session that produced it. */
interface OutcomeCommon {
  readonly protocolVersion: number | null;
  readonly clientCapabilities: typeof CLIENT_CAPABILITIES;
  readonly newSessionRequest: acp.NewSessionRequest | null;
  readonly sessionId: string | null;
  readonly exit: ProcessExit | null;
  /** The child's process group. `detached: true` makes the child its leader,
   * which is what makes the group reachable at all (§9.3). */
  readonly pgid: number;
}

export type AcpNodeOutcome = OutcomeCommon &
  (
    | {
        readonly status: 'completed';
        readonly stopReason: acp.StopReason;
        readonly result: CompletedNodeResult;
      }
    | {
        readonly status: 'cancelled';
        readonly stopReason: acp.StopReason;
        readonly by: 'user' | 'policy';
      }
    | { readonly status: 'failed'; readonly failure: NodeFailure }
  );

/**
 * A character-count estimate, explicitly labelled as one.
 *
 * This is §7's `heuristic` tier: characters over four, and nothing more. The
 * real Tier-2 count is `gpt-tokenizer`'s `o200k_base` behind core's `Tokenizer`
 * port, implemented in `@DeFlow/daemon` (KAR-09.7) — it lives there and not
 * here because a BPE table is two megabytes of data and this package depends on
 * `@DeFlow/core` alone (docs/16-repo-layout.md R2). A caller that has a
 * tokenizer should count with it and label the figure
 * `gpt-tokenizer/o200k_base`; a caller that does not gets this, honestly
 * labelled.
 *
 * What must not change either way is `source: 'estimated'`. Vendor-reported
 * figures are the billing truth and estimates carry a known 15–20% undercount
 * on prose, so a total that mixed them would be a number with no meaning
 * (docs/04-domain-model.md §8).
 */
export function estimateUsage(promptText: string, outputText: string): TokenUsage {
  return {
    inputTokens: Math.ceil(promptText.length / 4),
    outputTokens: Math.ceil(outputText.length / 4),
    source: 'estimated',
  };
}

/**
 * Moves an oversized tool result out of the event and into the blob store, or
 * returns `null` when it is small enough to stay where it is (AC5).
 *
 * `note` is what the `node.progress` row says instead of the bytes: the digest
 * handle and the size, which is enough to fetch the artifact, enough to see
 * that two attempts produced the same one, and around a hundred characters.
 * `NodeProgressSchema` is a `strictObject` with a single-line `message`, so
 * this is the row *pointing at* the output rather than carrying it — the rule
 * `io_chunk`'s module doc states, and the one that keeps replay fast.
 */
function spillOversizeResult(
  update: acp.SessionUpdate,
  capture: (evidence: string | Uint8Array) => Handle,
): { handle: Handle; note: string } | null {
  const text = toolCallContentText(update);
  if (text === '') return null;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= CONTENT_SPILL_BYTES) return null;
  const handle = capture(text);
  return { handle, note: `${bytes} bytes spilled to ${handle}` };
}

/**
 * Signals the child's whole process group through the one abstraction that is
 * allowed to send a signal (KAR-05.9 AC5), and says nothing if it is gone.
 *
 * The pid guard is here rather than swallowed inside `killTree`: a `pgid` of 0
 * is what a spawn that never got a pid leaves behind, and `kill(-0)` is
 * `kill(0)` — DeFlowd signalling its own process group.
 */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  if (pgid <= 1) return;
  try {
    killTree(pgid, signal);
  } catch (error) {
    // A platform with no kill switch is a bug to surface, not to swallow: it
    // is the one case where continuing would report a stopped agent that is
    // still running. Anything else is an errno about a group that is on its
    // way out, and nothing here is going to fix it.
    if (error instanceof NotImplementedOnWin32) throw error;
  }
}

/**
 * Marks the `process` row terminal once the child's exit has been observed.
 *
 * Deliberately after `await exited` at every call site and never on a timer: a
 * row cleared before the process is really gone is an orphan no reaper will
 * look for, which is the failure this whole story exists to prevent.
 */
async function clearProcessRow(request: AcpNodeRequest, ports: AcpPorts): Promise<void> {
  await ports.processes?.clear({
    runId: request.runId,
    nodeId: request.nodeId,
    attempt: request.attempt,
  });
}

function spawnAgent(request: AcpNodeRequest): {
  child: ChildProcessWithoutNullStreams;
  started: Promise<void>;
  exited: Promise<ProcessExit>;
} {
  const child = spawn(request.binary.path, [...(request.argv ?? [])], {
    cwd: request.worktree,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Mandatory (§9.3): the child leads its own group, so a wedged agent and
    // everything it spawned can be reached with one signal.
    detached: true,
    ...(request.env === undefined ? {} : { env: request.env }),
  });

  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => {
      reject(spawnRefused(request.binary.path, error));
    });
  });

  // Registered at spawn time rather than when it is awaited: an exit that
  // landed in between would otherwise never be observed, and the turn would
  // wait for a stop frame that can no longer arrive.
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  return { child, started, exited };
}

export async function runAcpNode(
  request: AcpNodeRequest,
  ports: AcpPorts,
): Promise<AcpNodeOutcome> {
  const { clock, ledger } = ports;
  const key = ikey(request.runId, request.nodeId, request.attempt, 0);

  const event = (kind: string, payload: unknown, withIkey = false): EventRecord => ({
    kind,
    v: eventVersion(kind),
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
      ...(request.model === undefined ? {} : { model: request.model }),
      permission: request.permission,
    }),
  );

  // Validated before anything is spawned, and refused the same way an
  // inadmissible node is. A cap of 0 or `Infinity` is a misconfiguration of
  // DeFlow rather than a fact about the agent (EPIC-05-S15), and finding out an
  // hour into a turn — or after starting a process that then has to be killed —
  // helps nobody. It leaves as a `NodeFailure` and not as a throw, because a
  // scheduler that expected an outcome does not have a `catch` here.
  let maxFrameBytes = DEFAULT_MAX_FRAME_BYTES;
  let capRefusal: NodeFailureError | null = null;
  try {
    maxFrameBytes = parseFrameLimit(ports.maxFrameBytes);
  } catch (error) {
    capRefusal = error as NodeFailureError;
  }

  // KAR-05.7 AC1/AC6 — opened here, beside the frame cap and for the same
  // reason: `DeFlow_RECORD=1` against a binary whose version is `latest` is a
  // misconfiguration of DeFlow, and the honest moment to say so is before a
  // process exists and before a quota has been spent. A capture that silently
  // landed in a moving directory would look exactly like a good golden until
  // the day the vendor shipped.
  let recorder: TransportRecorder | null = null;
  let recordingRefusal: NodeFailureError | null = null;
  try {
    recorder = openTransportRecorder(ports.record ?? {}, {
      provider: request.provider,
      version: request.binary.version,
      case: request.nodeId,
      command: request.binary.path,
      args: request.argv ?? [],
      cwd: request.worktree,
      frameCapBytes: maxFrameBytes,
    });
  } catch (error) {
    // Already a tagged `NodeFailureError` (./failures.ts): the tee refuses a
    // moving version key rather than writing under one, and the refusal is
    // handled here exactly like the frame cap's — before a process exists.
    recordingRefusal = error as NodeFailureError;
  }

  // KAR-09.3 AC5/AC6 — the F6.6 integrity check, and the reason it is *here*
  // and not in the packet builder: the failure it exists to catch is a
  // rendering path nobody expected, so it has to run against the bytes that
  // are about to go out rather than against the manifest they were built from.
  // Checking the manifest against itself would be a tautology.
  //
  // First among the refusals below, because it is the only one that is about
  // what the agent will be *told*: a prompt whose safety constraints went
  // missing must not be sent whatever else is or is not misconfigured.
  const pinRefusal =
    request.pins === undefined || request.pins.length === 0
      ? null
      : await findPinViolations({ segments: request.pins }, request.prompt).then((violations) =>
          violations.length === 0 ? null : new PinIntegrityViolation(violations),
        );

  // KAR-05.2 AC7 — admission, and the reason it is *here*: before `spawn`,
  // after the scheduling decision is durable. A node whose requirements the
  // probed row does not satisfy is refused as a plan-time fact; discovering it
  // at runtime means a spawned process, a consumed quota and a failure hours
  // from the decision that caused it. `node.scheduled` above is what the
  // refusal points at — the decision it refused.
  const refusal =
    pinRefusal ??
    capRefusal ??
    recordingRefusal ??
    // KAR-08.7 AC3 — a declared path scope with no auditor behind it is
    // refused here, beside the other two misconfigurations, and for the same
    // reason: the completion-time backstop could never fire, and a node that
    // completed without it looks exactly like a node that behaved.
    scopeAuditRefusal(request.pathScope, ports.scopeAudit) ??
    admit(
      {
        node: request.nodeId,
        requires: request.requires ?? [],
        permission: request.permission,
      },
      ports.capabilityRow ?? null,
    );
  if (refusal !== null) {
    // KAR-08.1 AC4 / EPIC-08-S3. The `node.failed` below is where the node
    // ended; this is why it never began, and only one of the two answers "which
    // provider, and which capability". Appended *before* the failure so a
    // reader walking the timeline meets the cause before the effect, and only
    // for the mediation refusal — a missing `session.fork` is a capability
    // story, not a safety one.
    // KAR-09.3 AC6 — the same shape, for the same reason: `node.failed` says
    // the node ended, and this says which pinned segments were not in the
    // prompt. Without it the ledger records that a node failed on a safety
    // reason and nothing about which bytes went missing, which is the one
    // question a human woken by this failure needs answered.
    if (refusal instanceof PinIntegrityViolation) {
      lastSeq = await ledger.append(
        event('pin.integrity_violated', {
          node: request.nodeId,
          attempt: request.attempt,
          missingDigests: [...refusal.missingDigests],
          segmentIds: [...refusal.segmentIds],
        }),
      );
    }
    if (refusal.deflowFailure.reason === 'safety.permission-unschedulable') {
      const row = ports.capabilityRow;
      lastSeq = await ledger.append(
        event('node.unschedulable', {
          node: request.nodeId,
          provider: row?.provider ?? request.provider,
          version: row?.version ?? request.binary.version,
          permission: request.permission,
          reason: 'mediatedExecution:false',
        }),
      );
    }
    const failure = toAdapterFailure(refusal, {
      occurredAtEvent: lastSeq,
      attempt: request.attempt,
      captureEvidence: ports.captureEvidence,
    });
    await ledger.append(
      event('node.failed', { node: request.nodeId, attempt: request.attempt, failure }),
    );
    return {
      status: 'failed',
      failure,
      protocolVersion: null,
      clientCapabilities: CLIENT_CAPABILITIES,
      newSessionRequest: null,
      sessionId: null,
      exit: null,
      pgid: 0,
    };
  }

  const { child, started, exited } = spawnAgent(request);
  const pgid = child.pid ?? 0;
  const transport = agentTransport(child, {
    maxFrameBytes,
    ...(recorder === null ? {} : { recorder }),
  });

  /** The exit status is a fact about the process, so it is written once the
   * process has been observed to leave — never when the turn resolved. */
  const closeRecording = (exit: ProcessExit): void => {
    recorder?.exit(exit);
    recorder?.close();
  };

  // One mutable object rather than seven `let`s: every one of these is
  // assigned from inside a callback or the connection closure, and a `let` in
  // that position reads to the compiler's control-flow analysis as never
  // having changed — which is not merely a lint complaint, it is the compiler
  // telling you it cannot see the assignment either.
  const turn: TurnState = {
    protocolVersion: null,
    newSessionRequest: null,
    sessionId: null,
    stopReason: null,
    agentText: '',
    promptText: '',
    artifacts: [],
    cancelRequested: false,
    escalated: false,
    escalation: null,
    killTimer: null,
  };

  /** Stage 2 and 3 of §9.4, armed only once a cooperative cancel went unanswered. */
  const armEscalation = (): void => {
    turn.escalation = clock.setTimer(ports.cancelGraceMs ?? CANCEL_GRACE_MS, () => {
      turn.escalated = true;
      signalGroup(pgid, 'SIGTERM');
      turn.killTimer = clock.setTimer(ports.killGraceMs ?? KILL_GRACE_MS, () => {
        signalGroup(pgid, 'SIGKILL');
      });
    });
  };

  const disarm = (): void => {
    turn.escalation?.cancel();
    turn.killTimer?.cancel();
  };

  try {
    await started;

    let app = acp.client({ name: CLIENT_INFO.name });
    // Registered only on the resume path. The fresh path's `ActiveSession`
    // does its own `session/update` routing, and a second handler for the same
    // method is one implementation detail away from stealing its notifications.
    const resumedUpdates = updateQueue();
    if (request.resume !== undefined) {
      app = app.onNotification('session/update', ({ params }) => {
        if (params.sessionId !== request.resume?.sessionId) return;
        resumedUpdates.push({
          kind: 'session_update',
          notification: params,
          update: params.update,
        });
      });
    }
    for (const [method, handler] of Object.entries(ports.handlers ?? {})) {
      // Registered as data: these are the daemon's thin fronts, and ACP v2
      // deletes `fs/*` and `terminal/*` from the client entirely (§3). The
      // three-argument overload is the one that takes a method name computed
      // at runtime; the parser is the identity because the front is what
      // unwraps, and validating here would put a second opinion about the
      // wire shape in the one place that must not have one.
      app = app.onRequest<unknown, unknown>(
        method,
        (params: unknown) => params,
        ({ params }) => handler(params as never),
      );
    }

    // Raced with the connection, not merely with the pull loop: the frame
    // guard can trip on the `initialize` response, before a session exists and
    // before anything is awaiting `nextUpdate()`. Without this the turn would
    // sit on a handshake that can no longer be answered.
    await Promise.race([
      transport.failed,
      app.connectWith(transport.stream, async (ctx) => {
        const initialized = await ctx.request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { ...CLIENT_INFO },
        });

        const offered: unknown = initialized.protocolVersion;
        // The type as well as the value: MCP's protocol version is a date string
        // and `'1' === 1` is false only if you look. No downgrade, ever.
        if (typeof offered !== 'number' || offered !== ACP_PROTOCOL_VERSION) {
          throw handshakeMismatch(offered);
        }
        turn.protocolVersion = offered;

        // Written *before* the side effect. This record is what makes
        // at-least-once recovery possible at all.
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
        // AC6 — and the *same transaction* is the whole point. `detached: true`
        // means this child outlives DeFlowd, so the row below is the only
        // handle the next daemon has on it; a row written after the event can
        // be lost to a crash in the window between the two writes, and that
        // window is the moment a daemon is most likely to die, because it has
        // just started a child process.
        lastSeq =
          ports.processes === undefined
            ? await ledger.append(startedEvent)
            : await ports.processes.appendWithProcess(startedEvent, {
                runId: request.runId,
                nodeId: request.nodeId,
                attempt: request.attempt,
                pid: pgid,
                pgid,
                // Read from the OS while the process is alive; `null` when it
                // could not be read, which leaves the row unverifiable and so
                // never something a later daemon may signal.
                startedAt: processStartTime(pgid),
                binarySha256: request.binary.sha256,
                worktree: request.worktree,
                spawnedAt: clock.now(),
              });

        const driveTurn = async (session: TurnSession): Promise<void> => {
          turn.sessionId = session.sessionId;
          // AC3: the sessionId is durable against the node before a single
          // update can refer to it.
          lastSeq = await ledger.append(
            event('node.progress', {
              node: request.nodeId,
              attempt: request.attempt,
              phase: 'session.opened',
              message: `sessionId=${session.sessionId}`,
            }),
          );

          if (ports.signal !== undefined) {
            const onAbort = (): void => {
              turn.cancelRequested = true;
              // Protocol first, signals later: this is the only stage that
              // produces a clean transcript.
              void ctx.notify('session/cancel', { sessionId: session.sessionId });
              armEscalation();
            };
            if (ports.signal.aborted) onAbort();
            else ports.signal.addEventListener('abort', onAbort, { once: true });
          }

          // The child died before the stop frame arrived. Whether that is a
          // crash or a cancellation the agent slept through is decided once, at
          // the boundary below, from `escalated`. Registered once for the whole
          // session rather than per turn: the process exits at most once, and a
          // second listener per continuation would leak one per turn.
          const died = exited.then(({ code, signal }) => {
            throw agentExited(code, signal);
          });
          died.catch(() => {});

          /** One `session/prompt`, driven to its stop frame. */
          const pumpTurn = async (text: string): Promise<void> => {
            turn.promptText += turn.promptText === '' ? text : `\n\n${text}`;
            const prompt = session.prompt(text);
            // The stop is delivered through `nextUpdate()`; this promise exists
            // only so a rejected prompt ends the loop instead of stranding it.
            const stranded = prompt.then(
              () => new Promise<never>(() => {}),
              (error: unknown) => Promise.reject(error),
            );
            stranded.catch(() => {});

            for (let pull = 0; ; pull += 1) {
              ports.onPull?.(pull, transport.bytesRead());
              const message = await Promise.race([
                session.nextUpdate(),
                stranded,
                died,
                transport.failed,
              ]);

              if (message.kind === 'stop') {
                turn.stopReason = message.stopReason;
                disarm();
                return;
              }

              // Nothing is read off the child while this is in flight, which is
              // what turns "await the append" into real backpressure.
              transport.gate.close();
              try {
                const ioChunkSeq = await ledger.appendIo({
                  nodeId: request.nodeId,
                  attempt: request.attempt,
                  stream: 'agent_json',
                  ts: clock.now(),
                  data: Buffer.from(
                    `${JSON.stringify({ method: 'session/update', params: message.notification })}\n`,
                    'utf8',
                  ),
                });
                const described = describeUpdate(message.update);
                if (message.update.sessionUpdate === 'agent_message_chunk') {
                  const content = message.update.content;
                  if (content.type === 'text') turn.agentText += content.text;
                }

                // AC5. A tool result over the ceiling leaves the control plane for
                // the blob store, and the row keeps a reference to it. The write is
                // deliberately inside the closed gate: it is filesystem I/O, and
                // doing it while the reader was free to run would be the read-ahead
                // this loop exists to prevent.
                const spilled = spillOversizeResult(message.update, ports.captureEvidence);
                if (spilled !== null && !turn.artifacts.includes(spilled.handle)) {
                  turn.artifacts.push(spilled.handle);
                }
                const progressMessage = [described.message, spilled?.note]
                  .filter(Boolean)
                  .join(' · ');

                lastSeq = await ledger.append(
                  event('node.progress', {
                    node: request.nodeId,
                    attempt: request.attempt,
                    phase: described.phase,
                    ...(progressMessage === '' ? {} : { message: progressMessage }),
                    ioChunkSeq,
                  }),
                );
              } finally {
                transport.gate.open();
              }
            }
          };

          /**
           * The appended turn that carries the pinned segments verbatim (AC5).
           *
           * The text is the pinned slice joined exactly as `renderPacket` joins
           * segments, so it is byte-identical to the block that went out in the
           * packet — KAR-09.3 AC4 applies to it, and `findPinViolations` runs
           * against it before it is sent rather than being trusted because it
           * was derived. The progress row carries the digest of what was sent,
           * which is the positive evidence that the re-injection happened *and*
           * that the bytes were the right ones: "it ran and passed" and "it
           * never ran" are otherwise indistinguishable in the ledger.
           */
          const reinjectPins = async (afterTurnNumber: number): Promise<void> => {
            const pins = request.pins ?? [];
            const text = pins.map((pin) => pin.text).join('\n\n');
            const violations = await findPinViolations({ segments: pins }, text);
            if (violations.length > 0) throw new PinIntegrityViolation(violations);

            // Written before the side effect, like every other record of what
            // DeFlow is about to tell the agent.
            lastSeq = await ledger.append(
              event('node.progress', {
                node: request.nodeId,
                attempt: request.attempt,
                phase: 'pin.reinjected',
                message:
                  `turn ${afterTurnNumber} · re-injected ${pins.length} pinned segments ` +
                  `verbatim · ${await contentHash(text)}`,
              }),
            );
            await pumpTurn(text);
          };

          // ── KAR-09.4: the turn loop, and the interval re-injection in it ──
          //
          // Turn 1 is the packet. Everything after it exists only because the
          // agent asked for it: `max_turn_requests` is ACP's *"I have more to
          // do"*, and DeFlow answers with a continuation until the node's turn
          // budget runs out. A node with no budget is one prompt, exactly as
          // before this story.
          const budget = request.turns;
          const continuation = budget?.continuation ?? CONTINUATION_PROMPT;
          // Only a *grant* delivers (EPIC-09-S24's outline): `false` and
          // "never advertised" both mean no injection turn is attempted, and
          // the honest mitigation on that path is the packet builder's
          // planning warning plus keeping nodes short.
          // An unprobed provider has advertised nothing, which is the same
          // answer as a refusal here: nothing is attempted.
          const probed = ports.capabilityRow ?? null;
          const steerable = probed !== null && supportsSteering(probed) === true;
          let counter: ReinjectCounter | null =
            request.reinject !== undefined && (request.pins ?? []).length > 0 && steerable
              ? startReinjection(request.reinject.everyTurns)
              : null;

          let turnsRun = 0;
          /** True when the interval came due at the end of the turn just run. */
          const runWorkTurn = async (text: string): Promise<boolean> => {
            await pumpTurn(text);
            turnsRun += 1;
            if (counter === null) return false;
            const tick = afterTurn(counter);
            counter = tick.counter;
            return tick.reinject;
          };

          let due = await runWorkTurn(request.prompt);
          while (
            budget !== undefined &&
            turnsRun < budget.max &&
            turn.stopReason === 'max_turn_requests' &&
            !turn.cancelRequested
          ) {
            if (due) await reinjectPins(turnsRun);
            due = await runWorkTurn(continuation);
          }
        };

        // KAR-05.5 — the one branch a resume adds, and the only one. A fresh
        // node opens a session; a resumed one is handed the id a previous
        // daemon life journalled and re-enters the *same* pull loop, because
        // "the node completes" has to mean the same thing on both paths.
        if (request.resume === undefined) {
          const builder = ctx.buildSession({
            cwd: request.worktree,
            // KAR-08.2 AC6 — present and empty, at every level. DeFlow's own
            // mediation is what enforces the boundary (EPIC-08), and this is
            // the defence in depth beside it: a vendor that honours the field
            // has been told that nothing outside the worktree is in scope,
            // even nominally. Omitting it means the same thing to a compliant
            // agent and nothing at all to a reader of the transcript.
            additionalDirectories: [],
            mcpServers: [...request.mcpServers],
          });
          turn.newSessionRequest = builder.toRequest();
          await builder.withSession(driveTurn);
        } else {
          try {
            await ctx.request('session/resume', {
              sessionId: request.resume.sessionId,
              cwd: request.worktree,
            });
          } catch (error) {
            // EPIC-05-S27. Reaching this line at all means the probed row said
            // `resume` — ./resume.ts is the only thing that selects the native
            // strategy, and it reads that row and nothing else. So a `-32601`
            // here is not a protocol accident: it is the manifest the router
            // trusted being wrong, and it deserves a reason that says so.
            if (!isMethodNotFound(error)) throw error;
            throw advertisedButUnimplemented(
              'session.resume',
              'session/resume',
              CAPABILITY_PATHS.resume,
            );
          }
          const session = resumedSession(ctx, request.resume.sessionId, resumedUpdates);
          try {
            await driveTurn(session);
          } finally {
            session.dispose();
          }
        }
      }),
    ]);
  } catch (caught) {
    disarm();
    signalGroup(pgid, 'SIGKILL');
    const exit = await exited;
    closeRecording(exit);
    await clearProcessRow(request, ports);
    // Whatever unwound first — the prompt's rejection, the closed connection,
    // the reader — an escalated cancel is a timeout and nothing else. Reading
    // the reason off the race would make it a coin toss between three
    // plausible-looking failures for one cause.
    const thrown = turn.escalated
      ? agentTimedOut('the agent ignored session/cancel and was signalled after the grace window', {
          transcript: 'incomplete',
          code: exit.code,
          signal: exit.signal,
        })
      : caught;
    const mapped = toAdapterFailure(thrown, {
      occurredAtEvent: lastSeq,
      attempt: request.attempt,
      captureEvidence: ports.captureEvidence,
    });
    // AC1: a frame-cap abort carries a second handle — the first 4 KiB of the
    // line that broke it. The diagnostic handle every failure gets says where
    // the throw happened; only these bytes say what the agent was sending.
    const head = offendingFrameHead(thrown);
    const failure: NodeFailure =
      head === null
        ? mapped
        : { ...mapped, evidence: [...mapped.evidence, ports.captureEvidence(head)] };
    await ledger.append(
      event('node.failed', {
        node: request.nodeId,
        attempt: request.attempt,
        failure,
      }),
    );
    return {
      status: 'failed',
      failure,
      protocolVersion: turn.protocolVersion,
      clientCapabilities: CLIENT_CAPABILITIES,
      newSessionRequest: turn.newSessionRequest,
      sessionId: turn.sessionId,
      exit,
      pgid,
    };
  }

  child.stdin.end();
  const exit = await exited;
  closeRecording(exit);
  // AC6: cleared once the exit has been *observed*. A row still saying `live`
  // is one a future daemon's reaper will act on, against a pid that by then may
  // belong to somebody else entirely.
  await clearProcessRow(request, ports);

  const common: OutcomeCommon = {
    protocolVersion: turn.protocolVersion,
    clientCapabilities: CLIENT_CAPABILITIES,
    newSessionRequest: turn.newSessionRequest,
    sessionId: turn.sessionId,
    exit,
    pgid,
  };

  if (turn.stopReason === 'cancelled') {
    // Stages 2 and 3 of §9.4, run **because** stage 1 succeeded rather than
    // instead of it.
    //
    // A clean `stopReason: 'cancelled'` ends the *turn*: the agent flushed its
    // tail and exited politely. It says nothing about what the agent
    // backgrounded, and those processes are now reparented to init with the
    // dead agent's pgid as the only thing still naming them together. AC8 is
    // the measurement — five cancelled agents must leave zero non-`Z`
    // processes in any of the five groups — and it is only true if the sweep
    // happens on the successful path too.
    //
    // Sent after the child's own exit was observed, which is what keeps
    // `outcome.exit` the agent's real exit rather than a signal DeFlow sent.
    // The SIGKILL is left pending on the injected clock rather than awaited:
    // an operator's cancel must not take two seconds to report.
    if (pgid > 1) sweepTree(pgid, { clock, killGraceMs: ports.killGraceMs ?? KILL_GRACE_MS });

    // A `node.progress`, and deliberately still not the *terminal* record.
    //
    // `node.completed`'s payload is `Extract<NodeResult, {status:'completed'}>`
    // (docs/04-domain-model.md §9), so recording a cancellation there would be
    // a lie the ledger keeps for ever. The terminal event is `node.cancelled`,
    // added by KAR-06.7 and appended by the **orchestrator's** cancel driver
    // (packages/daemon/src/cancel.ts), because a node's terminal state is a
    // scheduling fact: it is what makes the next `decide()` reclaim the locks
    // this attempt held. This line stays a progress note about the turn — what
    // the adapter saw — which is the honest thing for an adapter to claim.
    await ledger.append(
      event('node.progress', {
        node: request.nodeId,
        attempt: request.attempt,
        phase: 'cancelled',
        message: `cancelled by ${turn.cancelRequested ? 'user' : 'policy'}`,
      }),
    );
    return {
      ...common,
      status: 'cancelled',
      stopReason: turn.stopReason,
      by: turn.cancelRequested ? 'user' : 'policy',
    };
  }

  // The transcript is already durable, verbatim, in `io_chunk`. What the event
  // carries is the text itself only while it is small enough to be worth
  // re-reading on every replay, and a handle to it otherwise — never a
  // truncated string, which reads like the whole answer and is not.
  const bytes = Buffer.byteLength(turn.agentText, 'utf8');
  const oversize = bytes > OUTPUT_INLINE_LIMIT_BYTES;
  const handle = oversize ? ports.captureEvidence(turn.agentText) : null;

  const result: CompletedNodeResult = {
    status: 'completed',
    output: handle === null ? { text: turn.agentText } : { textHandle: handle, bytes },
    outputSchemaId: request.outputSchemaId ?? AGENT_TURN_SCHEMA_ID,
    usage: estimateUsage(turn.promptText, turn.agentText),
    // No price list is installed at M1; EPIC-14 supplies one. Zero is what
    // this run actually cost the user, and `usage.source` is what says the
    // number beside it is an estimate.
    costUsd: 0,
    producedFacts: [],
    // Every oversized tool result this turn spilled, plus the turn's own text
    // when that spilled too. These are the node's artifacts in the domain
    // sense: addressable, deduplicated, and reachable from the event log.
    artifacts: handle === null ? turn.artifacts : [...turn.artifacts, handle],
  };
  // KAR-08.7 AC3 — the backstop, and this is the only moment it can run: the
  // child has exited, so the worktree is final, and the node has not been
  // declared finished yet. A **warning** and nothing else — the completion
  // below is unconditional, whatever the diff says (D14, §6.3).
  await auditCompletionScope(
    {
      node: request.nodeId,
      attempt: request.attempt,
      worktree: request.worktree,
      declared: request.pathScope,
    },
    ports,
  );
  // KAR-14.1 AC1 — the spend and the completion in one `BEGIN IMMEDIATE`.
  //
  // `reported: null` on this path is the honest answer, not a gap: whether ACP
  // surfaces token usage at all is **Unverified** and rated High (roadmap
  // A0-3), so nothing here is a vendor figure. What the record carries is
  // DeFlow's own Tier-2 count of the prompt it rendered and the text it read
  // back, labelled `estimated`, and a blank cost — a `0` would chart the turn
  // as free. The provider therefore appears in the rollup's `unaccounted`
  // list, which is exactly the signal an operator needs before setting a cost
  // ceiling on this path.
  await ledger.appendAll([
    event(
      'budget.consumed',
      budgetConsumed({
        node: request.nodeId,
        attempt: request.attempt,
        provider: request.provider,
        accounting: providerTokenAccounting(request.provider),
        authMode: request.authMode ?? 'subscription',
        reported: null,
        estimate: result.usage,
      }),
    ),
    event('node.completed', { node: request.nodeId, attempt: request.attempt, result }),
  ]);

  return { ...common, status: 'completed', stopReason: turn.stopReason ?? 'end_turn', result };
}
