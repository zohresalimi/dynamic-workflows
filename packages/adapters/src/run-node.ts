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
 */

import {
  type CompletedNodeResult,
  type EventSeq,
  ikey,
  type NodeFailure,
  SchemaIdSchema,
  type TimerHandle,
  type TokenUsage,
} from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import process from 'node:process';
import * as acp from '@agentclientprotocol/sdk';
import { CLIENT_CAPABILITIES, CLIENT_INFO } from './client-capabilities.ts';
import {
  ACP_PROTOCOL_VERSION,
  agentExited,
  agentTimedOut,
  handshakeMismatch,
  spawnRefused,
  toAdapterFailure,
} from './failures.ts';
import type { AcpNodeRequest, AcpPorts, EventRecord } from './ports.ts';
import { agentTransport } from './transport.ts';
import { describeUpdate } from './updates.ts';

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
 * EPIC-14 replaces the arithmetic with `gpt-tokenizer`'s `o200k_base`
 * encoding; what must not change is `source: 'estimated'`. Vendor-reported
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

/** Signals the child's whole process group, and says nothing if it is gone. */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already reaped. Nothing to do, and nothing to report.
  }
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
      ...(request.model === undefined ? {} : { model: request.model }),
      permission: request.permission,
    }),
  );

  const { child, started, exited } = spawnAgent(request);
  const pgid = child.pid ?? 0;
  const transport = agentTransport(child);

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

    await app.connectWith(transport.stream, async (ctx) => {
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
      lastSeq = await ledger.append(
        event(
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
        ),
      );

      const builder = ctx.buildSession({
        cwd: request.worktree,
        mcpServers: [...request.mcpServers],
      });
      turn.newSessionRequest = builder.toRequest();

      await builder.withSession(async (session) => {
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

        const prompt = session.prompt(request.prompt);
        // The stop is delivered through `nextUpdate()`; this promise exists
        // only so a rejected prompt ends the loop instead of stranding it.
        const stranded = prompt.then(
          () => new Promise<never>(() => {}),
          (error: unknown) => Promise.reject(error),
        );
        stranded.catch(() => {});
        // The child died before the stop frame arrived. Whether that is a
        // crash or a cancellation the agent slept through is decided once, at
        // the boundary below, from `escalated`.
        const died = exited.then(({ code, signal }) => {
          throw agentExited(code, signal);
        });
        died.catch(() => {});

        for (let pull = 0; ; pull += 1) {
          ports.onPull?.(pull, transport.bytesRead());
          const message = await Promise.race([session.nextUpdate(), stranded, died]);

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
            lastSeq = await ledger.append(
              event('node.progress', {
                node: request.nodeId,
                attempt: request.attempt,
                phase: described.phase,
                ...(described.message === undefined ? {} : { message: described.message }),
                ioChunkSeq,
              }),
            );
          } finally {
            transport.gate.open();
          }
        }
      });
    });
  } catch (caught) {
    disarm();
    signalGroup(pgid, 'SIGKILL');
    const exit = await exited;
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
    const failure = toAdapterFailure(thrown, {
      occurredAtEvent: lastSeq,
      attempt: request.attempt,
      captureEvidence: ports.captureEvidence,
    });
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

  const common: OutcomeCommon = {
    protocolVersion: turn.protocolVersion,
    clientCapabilities: CLIENT_CAPABILITIES,
    newSessionRequest: turn.newSessionRequest,
    sessionId: turn.sessionId,
    exit,
    pgid,
  };

  if (turn.stopReason === 'cancelled') {
    // The terminal record of a cancelled node.
    //
    // Deliberately a `node.progress` and not a `node.completed`:
    // `node.completed`'s payload is `Extract<NodeResult, {status:'completed'}>`
    // (docs/04-domain-model.md §9), so the domain has no terminal event that
    // can carry `{ status: 'cancelled', by }`. Recording it as a completion
    // would be a lie the ledger keeps for ever. See the follow-up noted on
    // MET-286: EPIC-06 owns the node's terminal states and should either add a
    // `node.cancelled` kind or widen `node.completed`.
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
    usage: estimateUsage(request.prompt, turn.agentText),
    // No price list is installed at M1; EPIC-14 supplies one. Zero is what
    // this run actually cost the user, and `usage.source` is what says the
    // number beside it is an estimate.
    costUsd: 0,
    producedFacts: [],
    artifacts: handle === null ? [] : [handle],
  };
  await ledger.append(
    event('node.completed', { node: request.nodeId, attempt: request.attempt, result }),
  );

  return { ...common, status: 'completed', stopReason: turn.stopReason ?? 'end_turn', result };
}
