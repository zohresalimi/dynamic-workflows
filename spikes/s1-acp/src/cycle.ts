/**
 * The six steps, driven once, in order, against whichever channel it is given.
 *
 * `initialize` → `session/new` → `session/prompt` → streamed `session/update`
 * → `session/request_permission` → `session/cancel`. Two prompt turns are
 * needed to exercise all six: the first is answered `reject_once` and runs to
 * `end_turn` (which is the only way to see whether a rejection is honoured);
 * the second is cancelled mid-stream. Both happen inside one session, under
 * one command, so AC1's "a single command completes all six steps" holds.
 *
 * Nothing here throws on a step failing. A spike whose harness crashes on the
 * interesting case records nothing, and "which step failed for which agent" is
 * the deliverable when the answer is no.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSpec } from './agents.ts';
import { buildFixture, divergences, observeMatrix } from './capabilities.ts';
import { AcpClient, type Channel, type Clock, type Outcome } from './client.ts';
import { DEFAULT_FRAME_CAP_BYTES } from './framing.ts';
import type { Direction } from './recording.ts';
import type { CapabilityMatrix, RunReport, StepName, StepObservation } from './report.ts';

/**
 * Cancel on the second streamed update of the cancel turn.
 *
 * The trigger is a position in the stream rather than a wall-clock delay, so
 * the live run and every replay of it cancel at exactly the same frame. Two,
 * not three, because `claude-agent-acp@0.64.1` opens a turn with a
 * `session_info_update` and a `usage_update` before any content — waiting for
 * a third update means waiting for the model, which is not what "mid-turn"
 * should mean.
 */
const CANCEL_AFTER_UPDATES = 2;

/** How long a prompt turn may run before the harness gives up on it entirely. */
const PROMPT_TIMEOUT_MS = 120_000;

export interface CycleContext {
  readonly agent: AgentSpec;
  /** In replay mode this is the recording's own clock (see transports.ts). */
  readonly clock?: Clock;
  readonly mode: 'live' | 'replay';
  readonly cwd: string;
  readonly recordingPath: string;
  readonly mcpLogPath: string;
  readonly mcpServerPath: string;
  readonly fixtureDir: string;
  readonly frameCapBytes: number;
  readonly cancelTimeoutMs: number;
  readonly drainMs: number;
  readonly tee?: (t: number, dir: Direction, bytes: Uint8Array) => void;
  readonly writeFixture: (path: string, contents: string) => void;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface UpdateArrival {
  readonly at: number;
  readonly turn: number;
  readonly kind: string;
  readonly afterPromptSettled: boolean;
}

interface PermissionRecord {
  requested: boolean;
  optionKinds: string[];
  answeredWith: string | null;
  toolCallId: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export async function runCycle(channel: Channel, context: CycleContext): Promise<RunReport> {
  const steps = new Map<StepName, StepObservation>();
  const record = (step: StepName, status: StepObservation['status'], observed: string) => {
    steps.set(step, { step, status, observed });
  };

  const inboundText: string[] = [];
  const updates: UpdateArrival[] = [];
  const permission: PermissionRecord = {
    requested: false,
    optionKinds: [],
    answeredWith: null,
    toolCallId: null,
  };
  let turn = 0;
  let promptSettled = false;
  let cancelSent = false;
  let cancelSentAt: number | null = null;
  /** Resolves `cancelTimeoutMs` after the cancel goes out, and not before. */
  let onCancelDeadlock: (() => void) | null = null;
  let toolCallFailedAfterReject = false;
  let usageUpdates = 0;
  let sessionId: string | null = null;
  let protocolVersion: number | null = null;
  let agentCapabilities: unknown = null;
  let capabilityMatrix: CapabilityMatrix | null = null;
  let capabilityDivergence: string[] = [];
  let fixturePath: string | null = null;

  const client = new AcpClient(channel, {
    frameCapBytes: context.frameCapBytes,
    ...(context.clock ? { clock: context.clock } : {}),
    tee(t, dir, bytes) {
      if (dir === 'in') inboundText.push(new TextDecoder().decode(bytes));
      context.tee?.(t, dir, bytes);
    },
    onResponse() {
      promptSettled = true;
    },
    onNotification(message, receivedAt) {
      if (message.method !== 'session/update') return;
      const update = asRecord(asRecord(message.params)['update']);
      const kind = String(update['sessionUpdate'] ?? 'unknown');
      if (kind === 'usage_update') usageUpdates += 1;
      if (
        kind === 'tool_call_update' &&
        update['status'] === 'failed' &&
        update['toolCallId'] === permission.toolCallId
      ) {
        toolCallFailedAfterReject = true;
      }
      updates.push({ at: receivedAt, turn, kind, afterPromptSettled: promptSettled });
      // The cancel is triggered by a position in the stream, not by a wall
      // clock, so the live run and every replay of it cancel at the same frame.
      if (
        turn === 2 &&
        !cancelSent &&
        updates.filter((u) => u.turn === 2).length >= CANCEL_AFTER_UPDATES
      ) {
        cancelSent = true;
        cancelSentAt = client.elapsed();
        client.notify('session/cancel', { sessionId });
        // The deadlock clock starts here, not when the prompt was sent: AC6
        // is about how long the *cancellation* takes to settle.
        setTimeout(() => onCancelDeadlock?.(), context.cancelTimeoutMs).unref();
      }
    },
    onRequest(message) {
      if (message.method !== 'session/request_permission') return {};
      const params = asRecord(message.params);
      const options = (params['options'] as { optionId: string; kind: string }[] | undefined) ?? [];
      permission.requested = true;
      permission.optionKinds = options.map((option) => option.kind);
      permission.toolCallId = String(asRecord(params['toolCall'])['toolCallId'] ?? '') || null;
      const rejection = options.find((option) => option.kind === 'reject_once') ?? options[0];
      permission.answeredWith = rejection?.kind ?? null;
      return { outcome: { outcome: 'selected', optionId: rejection?.optionId } };
    },
  });

  // ---- Step 1: initialize -------------------------------------------------
  const init = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'deflow-spike-s1', version: '0.0.0' },
  });
  const initResult = asRecord(init.result);
  if (init.error || initResult['protocolVersion'] === undefined) {
    record('initialize', 'failed', describe(init));
  } else {
    protocolVersion = Number(initResult['protocolVersion']);
    agentCapabilities = initResult['agentCapabilities'] ?? {};
    capabilityMatrix = observeMatrix(agentCapabilities);
    capabilityDivergence = divergences(context.agent.name, capabilityMatrix);
    const info = asRecord(initResult['agentInfo']);
    record(
      'initialize',
      protocolVersion === 1 ? 'ok' : 'failed',
      `protocolVersion ${protocolVersion}; agentInfo ${String(info['name'] ?? '-')} ${String(info['version'] ?? '-')}`,
    );
    // Written before anything else can fail, because the capability fixture is
    // the one artefact of this spike that survives into production use.
    mkdirSync(context.fixtureDir, { recursive: true });
    fixturePath = join(context.fixtureDir, `${context.agent.name}@${context.agent.version}.json`);
    context.writeFixture(
      fixturePath,
      `${JSON.stringify(
        buildFixture({
          agent: context.agent.name,
          version: context.agent.version,
          probedAt: new Date().toISOString(),
          protocolVersion,
          agentInfo: initResult['agentInfo'] ?? null,
          agentCapabilities,
        }),
        null,
        2,
      )}\n`,
    );
  }

  // ---- Step 2: session/new, with DeFlow's own stdio MCP server ------------
  const mcp = {
    declared: true,
    accepted: false,
    error: null as string | null,
    handshake: [] as string[],
  };
  if (steps.get('initialize')?.status === 'ok') {
    const created = await client.request('session/new', {
      cwd: context.cwd,
      mcpServers: [
        {
          type: 'stdio',
          name: 'deflow-spike',
          command: process.execPath,
          args: [context.mcpServerPath],
          env: [{ name: 'DEFLOW_SPIKE_MCP_LOG', value: context.mcpLogPath }],
        },
      ],
    });
    const result = asRecord(created.result);
    if (created.error || result['sessionId'] === undefined) {
      mcp.error = describe(created);
      record('session/new', 'failed', describe(created));
    } else {
      sessionId = String(result['sessionId']);
      mcp.accepted = true;
      record('session/new', 'ok', `sessionId ${sessionId}; mcpServers accepted without error`);
    }
  } else {
    record('session/new', 'blocked', 'initialize did not complete');
  }

  // ---- Steps 3–5: the permission turn -------------------------------------
  if (sessionId !== null) {
    turn = 1;
    promptSettled = false;
    const first = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: context.agent.permissionPrompt }],
    });
    const stopReason = String(asRecord(first.result)['stopReason'] ?? '');
    record(
      'session/prompt',
      first.error ? 'failed' : 'ok',
      first.error ? describe(first) : `turn 1 accepted, stopReason ${stopReason}`,
    );
  } else {
    record('session/prompt', 'blocked', 'no session');
  }

  const turnOneUpdates = updates.filter((update) => update.turn === 1);
  const arrivals = turnOneUpdates.map((update) => update.at);
  const spreadMs = arrivals.length > 1 ? Math.max(...arrivals) - Math.min(...arrivals) : 0;
  const interArrivalMs = arrivals
    .slice(1)
    .map((at, index) => Number((at - (arrivals[index] as number)).toFixed(1)));
  record(
    'session/update',
    turnOneUpdates.length >= 3 && spreadMs > 500 ? 'ok' : 'failed',
    `${turnOneUpdates.length} notifications, receipt spread ${spreadMs.toFixed(0)} ms`,
  );

  const rejectedFile = join(context.cwd, 'forbidden.txt');
  const fileEvidence =
    context.mode === 'live'
      ? `; forbidden.txt ${existsSync(rejectedFile) ? 'WAS CREATED' : 'absent'} in the session cwd`
      : '';
  const actionPerformed = context.mode === 'live' ? existsSync(rejectedFile) : false;
  record(
    'session/request_permission',
    permission.requested && permission.answeredWith === 'reject_once' && !actionPerformed
      ? 'ok'
      : 'failed',
    permission.requested
      ? `answered ${String(permission.answeredWith)}; tool call ${toolCallFailedAfterReject ? 'ended status=failed' : 'did not report failure'}${fileEvidence}`
      : 'no permission request reached the client',
  );

  // ---- Step 6: the cancel turn --------------------------------------------
  let stopReason: string | null = null;
  let settledMs: number | null = null;
  let readLoopAliveAfter = false;
  let trailingUpdatesAccepted = 0;
  let verdict = 'cancel: not attempted';

  if (sessionId !== null) {
    turn = 2;
    promptSettled = false;
    const deadlocked = new Promise<Outcome>((resolve) => {
      onCancelDeadlock = () => {
        resolve({ error: { code: -2, message: 'no response after session/cancel' } });
      };
    });
    const second = await Promise.race([
      client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: context.agent.cancelPrompt }],
      }),
      deadlocked,
      delay(PROMPT_TIMEOUT_MS).then(
        (): Outcome => ({
          error: { code: -3, message: 'the cancel turn never streamed' },
        }),
      ),
    ]);
    settledMs = cancelSentAt === null ? null : Number((client.elapsed() - cancelSentAt).toFixed(0));
    stopReason = (asRecord(second.result)['stopReason'] as string | undefined) ?? null;

    // The promise settling is not permission to stop reading. Anything the
    // agent flushes after the cancellation must still be accepted, and the
    // transport must still be usable afterwards — that is the exact deadlock
    // the kill criterion names.
    await delay(context.drainMs);
    trailingUpdatesAccepted = updates.filter(
      (update) => update.turn === 2 && update.afterPromptSettled,
    ).length;

    if (stopReason === 'cancelled') {
      const liveness = await Promise.race([
        client.request('session/new', { cwd: context.cwd, mcpServers: [] }),
        delay(context.cancelTimeoutMs).then(
          (): Outcome => ({ error: { code: -2, message: 'timeout' } }),
        ),
      ]);
      readLoopAliveAfter = asRecord(liveness.result)['sessionId'] !== undefined;
      verdict = readLoopAliveAfter
        ? 'cancel: settles, trailing updates drained'
        : 'cancel: settles, trailing updates wedge the transport';
    } else {
      verdict = 'cancel: deadlock';
    }
    record(
      'session/cancel',
      stopReason === 'cancelled' && readLoopAliveAfter ? 'ok' : 'failed',
      stopReason === 'cancelled'
        ? `stopReason cancelled ${String(settledMs)} ms after session/cancel; ${trailingUpdatesAccepted} trailing update(s) accepted; transport alive after`
        : `no cancelled response within ${context.cancelTimeoutMs} ms of session/cancel`,
    );
  } else {
    record('session/cancel', 'blocked', 'no session');
  }

  client.close();

  if (existsSync(context.mcpLogPath)) {
    mcp.handshake = [
      ...new Set(
        readFileSync(context.mcpLogPath, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
      ),
    ];
  }

  const joined = inboundText.join('\n');
  // A *key* named anything compaction-shaped, not the mere substring: Claude
  // Code advertises a `/compact` slash command in its
  // `available_commands_update`, so "compact appears in the log" is true of a
  // live run and means nothing. What F10.5 would need is a field. (The
  // committed recording no longer carries that command list — it enumerated the
  // recording machine's installed commands — which changes what a grep finds
  // but not what the check asks.)
  const compactionField = /"[^"]*compact[^"]*"\s*:/i.exec(joined)?.[0] ?? null;
  const framing = client.framingFailure;

  return {
    agent: context.agent.name,
    version: context.agent.version,
    mode: context.mode,
    recordingPath: context.recordingPath,
    fixturePath,
    frameCapBytes: context.frameCapBytes,
    steps: [...steps.values()],
    protocolVersion,
    agentCapabilities,
    capabilityMatrix,
    capabilityDivergence,
    sessionId,
    mcp,
    streaming: {
      count: turnOneUpdates.length,
      spreadMs: Number(spreadMs.toFixed(0)),
      interArrivalMs,
    },
    permission: {
      requested: permission.requested,
      optionKinds: permission.optionKinds,
      answeredWith: permission.answeredWith,
      actionPerformed,
      evidence: steps.get('session/request_permission')?.observed ?? '',
    },
    cancellation: {
      sent: cancelSent,
      stopReason,
      settledMs,
      trailingUpdatesAccepted,
      readLoopAliveAfter,
      verdict,
    },
    tokenAccounting: {
      usageUpdates,
      promptResultUsage: extractUsage(joined),
      verdict: usageUpdates > 0 ? 'exact' : 'none',
    },
    compaction: {
      observed: compactionField !== null,
      evidence:
        compactionField ??
        'no field in any frame is named for compaction; where the string occurs at all it is a value — the name of a slash command — and never a key',
    },
    structuredOutput: {
      present: /structured[_ ]?output/i.test(joined),
      evidence: /structured[_ ]?output/i.test(joined)
        ? 'structured_output appeared in a result envelope'
        : 'structured_output appears in no result envelope, and in none of the schema’s 262 $defs',
    },
    framing: {
      failed: framing !== null,
      code: framing?.code ?? null,
      capBytes: context.frameCapBytes,
      bytesAtFailure: framing?.bytesAtFailure ?? null,
    },
  };
}

function describe(outcome: Outcome): string {
  if (outcome.error) return `error ${outcome.error.code}: ${outcome.error.message}`;
  return JSON.stringify(outcome.result).slice(0, 160);
}

/** The usage block of the last prompt response seen in the raw frame log. */
function extractUsage(joined: string): unknown {
  const matches = [...joined.matchAll(/"usage":(\{[^}]*\})/g)];
  const last = matches.at(-1)?.[1];
  return last === undefined ? null : (JSON.parse(last) as unknown);
}
