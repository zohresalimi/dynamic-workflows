/**
 * The scenario interpreter: a parsed script, executed against a live ACP
 * client.
 *
 * Three decisions worth stating.
 *
 * **Delays are real sleeps.** The whole point of a `delayMs` is that the frame
 * before it has already been flushed down a real pipe when the frame after it
 * is written. A virtual clock would satisfy the script and prove nothing, and
 * docs/14-testing-strategy.md §8 forbids fake timers around a live child
 * anyway. The mitigation for slowness is the scenario library keeping its
 * delays in the tens of milliseconds, not a faster clock.
 *
 * **Client calls are gated on advertised capabilities.** ACP v2 removes all
 * seven `fs/*` and `terminal/*` methods from the client and pushes them onto
 * MCP. An agent that called them regardless would let a client stub answer a
 * method the real client will not have, and the migration would surface as a
 * production bug rather than a red test.
 *
 * **Every client call is recorded.** The trace rides back on the
 * `PromptResponse._meta`, so a spec can assert what the agent *saw* — that it
 * received the rejection — rather than only that a request went out. A mock
 * that swallowed the client's answer could not be used to test a refusal path
 * at all.
 */
import type * as acp from '@agentclientprotocol/sdk';
import type { Clock } from './clock.ts';
import type { IdFactory } from './ids.ts';
import {
  hugeLineFrameParts,
  hugeLinePayloadBytes,
  invalidFrame,
  malformedLine,
  patternSlice,
  sizedToolContent,
  truncatedFrame,
} from './pathological.ts';
import type { MockAgentPorts } from './ports.ts';
import type { Branch, ClientMethod, Scenario, Step } from './scenario.ts';

/** One outbound call, and what came back. */
export interface TraceEntry {
  readonly method: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
  /** True when the client never advertised the capability the step needed. */
  readonly skipped?: boolean;
}

export interface TurnResult {
  readonly stopReason: acp.StopReason;
  readonly trace: readonly TraceEntry[];
}

export interface TurnIo {
  readonly sessionId: string;
  readonly client: acp.AgentContext;
  readonly ids: IdFactory;
  readonly clock: Clock;
  /** What the client said it could do at `initialize`. */
  readonly capabilities: acp.ClientCapabilities;
  sleep(ms: number): Promise<void>;
  /** Raw writes, process exit and grandchildren — the pathological effects. */
  readonly ports: MockAgentPorts;
  /**
   * Resolves when a `session/cancel` for this session arrives, and never
   * otherwise. A wedged turn is only observable if the process is still there
   * to receive the cancel, so this is a promise rather than a signal check.
   */
  waitForCancel(): Promise<void>;
}

/** A real sleep. Injected so a caller can say so explicitly, never faked. */
export const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The capability a method needs, spelled the way `clientCapabilities` spells
 * it, so the diagnostic names something the reader can find in the handshake.
 */
function requiredCapability(method: ClientMethod): string {
  if (method === 'fs/read_text_file') return 'fs.readTextFile';
  if (method === 'fs/write_text_file') return 'fs.writeTextFile';
  return 'terminal';
}

function advertises(method: ClientMethod, capabilities: acp.ClientCapabilities): boolean {
  // `=== true` rather than truthiness: "absent" and "false" are different
  // answers, and the five real adapters disagree about which they send.
  if (method === 'fs/read_text_file') return capabilities.fs?.readTextFile === true;
  if (method === 'fs/write_text_file') return capabilities.fs?.writeTextFile === true;
  return capabilities.terminal === true;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function runScenario(scenario: Scenario, io: TurnIo): Promise<TurnResult> {
  const trace: TraceEntry[] = [];
  /** The id the *client* minted, so later terminal calls address a real one. */
  let terminalId: string | null = null;
  let lastError = '';

  /**
   * The armed mid-turn crash, if a step armed one.
   *
   * It is a countdown over *notifications* rather than a step index, because
   * "die two frames from now" is the shape of the failure: the knife has to
   * land inside the frame the script is in the middle of writing, not between
   * two steps where every buffer happens to be clean.
   */
  let crash: { remaining: number; code: number; truncate: boolean } | null = null;
  /** JSON-RPC ids for raw frames, kept away from the SDK's own counter. */
  let rawRequestId = 9_000;

  async function detonate(armed: NonNullable<typeof crash>): Promise<never> {
    // Written and flushed *before* exiting: `process.exit` drops whatever is
    // still queued on a pipe, so a truncation that was not awaited would
    // sometimes not be on the wire at all and the spec would flake.
    if (armed.truncate) await io.ports.writeRaw(truncatedFrame(io.sessionId));
    return io.ports.exit(armed.code);
  }

  const notify = async (update: acp.SessionUpdate): Promise<void> => {
    await io.client.notify('session/update', {
      sessionId: io.sessionId,
      update,
      _meta: { timestampMs: io.clock.now() },
    });
    if (crash === null) return;
    crash.remaining -= 1;
    if (crash.remaining <= 0) await detonate(crash);
  };

  const say = (text: string): Promise<void> =>
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

  /** `{{error}}` is the only substitution: it is the one value a branch cannot know. */
  const fill = (text: string): string => text.replaceAll('{{error}}', lastError);

  const chunkText = (
    index: number,
    count: number,
    text: string,
    sizeBytes: number | null,
  ): string => {
    const head = `${index + 1}/${count} ${text}`;
    if (sizeBytes === null || head.length >= sizeBytes) return head;
    return head + '.'.repeat(sizeBytes - head.length);
  };

  /** Returns a stop reason when the step ends the turn, otherwise null. */
  async function runStep(step: Step): Promise<acp.StopReason | null> {
    if (step.type === 'plan') {
      await notify({ sessionUpdate: 'plan', entries: [...step.entries] });
      return null;
    }

    if (step.type === 'message') {
      await say(fill(step.text));
      return null;
    }

    if (step.type === 'chunks') {
      for (let index = 0; index < step.count; index += 1) {
        // Between them, not before the first: "N chunks delayMs apart" is
        // N - 1 gaps, and a leading sleep would make the turn's first frame
        // late for no reason.
        if (index > 0 && step.delayMs > 0) await io.sleep(step.delayMs);
        await say(chunkText(index, step.count, fill(step.text), step.sizeBytes));
      }
      return null;
    }

    if (step.type === 'toolCall') {
      const toolCallId = io.ids.toolCall();
      const locations = [{ path: step.path }];
      // The result rides on the *updates* rather than on the opening frame,
      // which is where a real agent puts it: a tool call announces itself
      // before it has any output to report.
      const content =
        step.contentBytes === null
          ? {}
          : { content: sizedToolContent(step.contentBytes) as acp.ToolCallContent[] };
      for (const [index, status] of step.statuses.entries()) {
        if (index > 0 && step.delayMs > 0) await io.sleep(step.delayMs);
        await notify(
          index === 0
            ? {
                sessionUpdate: 'tool_call',
                toolCallId,
                title: step.title,
                kind: step.toolKind,
                status,
                locations,
              }
            : { sessionUpdate: 'tool_call_update', toolCallId, status, locations, ...content },
        );
      }
      return null;
    }

    if (step.type === 'permission') {
      const toolCallId = io.ids.toolCall();
      const request: acp.RequestPermissionRequest = {
        sessionId: io.sessionId,
        toolCall: {
          toolCallId,
          title: step.title,
          kind: step.toolKind,
          status: 'pending',
          locations: [{ path: step.path }],
        },
        options: step.options.map((option) => ({ ...option })),
      };
      const response = await io.client.request('session/request_permission', request);

      const outcome = response.outcome;
      trace.push({ method: 'session/request_permission', ok: true, result: outcome });

      if (outcome.outcome === 'cancelled') return runBranch(step.onCancelled);
      // The branch is chosen from the *declared* kind of the option the client
      // picked, which is what makes "branches on the returned optionId"
      // expressible in data rather than in code.
      const chosen = step.options.find((option) => option.optionId === outcome.optionId);
      return runBranch(
        chosen?.kind.startsWith('allow') === true ? step.onAllowed : step.onRejected,
      );
    }

    if (step.type === 'hangForever') {
      // Nothing is written and nothing is closed. The turn simply stops here
      // until a cancel arrives — a wedge, not an EOF.
      await io.waitForCancel();
      return runBranch(step.onCancel);
    }

    if (step.type === 'hangForeverIgnoringCancel') {
      // A promise nothing resolves. The process stays up, stdin stays open,
      // and only a signal ends it: the target the SIGTERM escalation needs.
      await new Promise<never>(() => {});
      return null;
    }

    if (step.type === 'exit') {
      crash = {
        remaining: step.afterFrames,
        code: step.code,
        truncate: step.truncateMidFrame,
      };
      if (step.afterFrames === 0) await detonate(crash);
      return null;
    }

    if (step.type === 'malformedLine') {
      await io.ports.writeRaw(malformedLine(step.text));
      return null;
    }

    if (step.type === 'invalidFrame') {
      rawRequestId += 1;
      await io.ports.writeRaw(
        invalidFrame(step.variant, { sessionId: io.sessionId, requestId: rawRequestId }).line,
      );
      return null;
    }

    if (step.type === 'hugeLine') {
      const { prefix, suffix } = hugeLineFrameParts(io.sessionId);
      // `lineBytes` measures the line the *client* will see, framing included,
      // which is the only thing a byte cap can be asserted against.
      const totalBytes =
        step.lineBytes === null
          ? step.totalBytes
          : hugeLinePayloadBytes(prefix, suffix, step.lineBytes);
      await io.ports.writeRaw(prefix);
      for (let written = 0; written < totalBytes; ) {
        const size = Math.min(step.chunkBytes, totalBytes - written);
        await io.ports.writeRaw(patternSlice(written, size));
        written += size;
      }
      // The newline is what makes it *one line*: without it this would be the
      // noNewline hazard, which is a different failure with a different cause.
      await io.ports.writeRaw(`${suffix}\n`);
      return null;
    }

    if (step.type === 'noNewline') {
      for (let written = 0; step.totalBytes === null || written < step.totalBytes; ) {
        const remaining = step.totalBytes === null ? step.chunkBytes : step.totalBytes - written;
        const size = Math.min(step.chunkBytes, remaining);
        await io.ports.writeRaw(patternSlice(written, size));
        written += size;
        if (step.intervalMs > 0) await io.sleep(step.intervalMs);
      }
      return null;
    }

    if (step.type === 'spawnGrandchildren') {
      const pids = Array.from({ length: step.count }, () =>
        io.ports.spawnGrandchild(step.lifetimeMs),
      );
      // Announced on the wire because a test cannot otherwise learn the pids
      // of processes whose whole point is to outlive the process it spawned.
      await say(`grandchildren: ${pids.join(',')}`);
      return null;
    }

    // clientCall
    if (!advertises(step.method, io.capabilities)) {
      const capability = requiredCapability(step.method);
      trace.push({
        method: step.method,
        ok: false,
        skipped: true,
        error: `client did not advertise ${capability}`,
      });
      await say(`skipped ${step.method}: client did not advertise ${capability}`);
      return null;
    }

    const params: Record<string, unknown> = { sessionId: io.sessionId };
    if (
      terminalId !== null &&
      step.method.startsWith('terminal/') &&
      step.method !== 'terminal/create'
    ) {
      params.terminalId = terminalId;
    }
    Object.assign(params, step.params);

    try {
      const result = (await io.client.request(step.method, params as never)) as unknown;
      trace.push({ method: step.method, ok: true, result });
      if (step.method === 'terminal/create') {
        terminalId = (result as { terminalId?: string }).terminalId ?? null;
      }
      return null;
    } catch (error) {
      lastError = errorMessage(error);
      trace.push({ method: step.method, ok: false, error: lastError });
      if (step.onError === null) return null;
      return runBranch(step.onError);
    }
  }

  async function runBranch(branch: Branch): Promise<acp.StopReason | null> {
    for (const step of branch.steps) {
      const stop = await runStep(step);
      if (stop !== null) return stop;
    }
    return branch.stopReason;
  }

  for (const step of scenario.steps) {
    const stop = await runStep(step);
    if (stop !== null) return { stopReason: stop, trace };
  }
  return { stopReason: scenario.stopReason, trace };
}
