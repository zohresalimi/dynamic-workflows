/**
 * The agent side of ACP, built on `acp.agent({…})` from
 * `@agentclientprotocol/sdk@1.3.0`.
 *
 * Three decisions are worth stating.
 *
 * **`protocolVersion` is the integer 1, never a string.** MCP's protocol
 * version is a date string (`'2025-11-25'`) and the two look similar enough
 * that a shared negotiation helper is a real temptation;
 * docs/07-provider-adapter-layer.md §2.2 forbids it. A client asking for any
 * other version gets an error, not a downgrade: a client that believes it
 * negotiated version 2 and is silently answered in version 1 finds out at the
 * first frame whose shape changed, somewhere far away from the handshake.
 *
 * **`authMethods: []`**, mirroring what `claude-agent-acp@0.64.1` actually
 * returned. The mock needs nothing from DeFlow and says so, rather than
 * omitting the key and leaving a client to guess.
 *
 * **`session/close` closes the session, not the process.** The process ends
 * when stdin reaches EOF, which is the only signal that means "no further
 * request is coming". Exiting on `session/close` would race the write of its
 * own response and truncate the last frame — the failure AC6 is about.
 */
import * as acp from '@agentclientprotocol/sdk';
import type { DishonestMethod, MockAgentOptions } from './cli.ts';
import { createSyntheticClock } from './clock.ts';
import { createIdFactory } from './ids.ts';
import { createProcessPorts, type MockAgentPorts } from './ports.ts';
import type { Scenario } from './scenario.ts';
import { realSleep, runScenario } from './scripted.ts';

export const AGENT_NAME = 'DeFlow-mock-agent';
export const AGENT_VERSION = '0.0.0';

/**
 * What this binary advertises when no `--capabilities` / `--capabilities-file`
 * is given — unchanged by KAR-04.4, which adds selection rather than replacing
 * this default. Every field is stated rather than omitted, because "absent"
 * and "false" are different answers and the five real adapters disagree about
 * which they use.
 */
export const DEFAULT_AGENT_CAPABILITIES: acp.AgentCapabilities = {
  loadSession: false,
  promptCapabilities: { image: false, audio: false, embeddedContext: false },
  mcpCapabilities: { http: false, sse: false },
};

/** The JSON-RPC code for a request whose params the agent will not accept. */
const INVALID_PARAMS = -32602;

/**
 * KAR-04.4 — what `initialize` returns, and which single method (if any)
 * this run is dishonest about.
 */
export interface CapabilitiesOptions {
  /** AC1: returned verbatim, so this is `unknown`, not `acp.AgentCapabilities`. */
  readonly agentCapabilities: unknown;
  /** AC4: this method answers -32601 "Method not found" despite being advertised. */
  readonly dishonestMethod: DishonestMethod | null;
}

export const DEFAULT_CAPABILITIES_OPTIONS: CapabilitiesOptions = {
  agentCapabilities: DEFAULT_AGENT_CAPABILITIES,
  dishonestMethod: null,
};

/**
 * AC4's lie, worded to be distinguishable from the SDK's own fallback for an
 * unregistered method (`"Method not found": <method>`, with the method name
 * appended) — the whole point is telling apart "refused on purpose" from
 * "never implemented".
 */
function refuseAsDishonest(): never {
  throw new acp.RequestError(-32601, 'Method not found');
}

/**
 * Whether the block this run advertises grants `path` — the mock's own,
 * deliberately small reading of what it was told to say.
 *
 * KAR-05.5 needs an agent that implements exactly what it advertises: one
 * advertising `sessionCapabilities.resume` must answer `session/resume` for a
 * session **this process never created**, the way a restarted vendor CLI does
 * after reading its own session file, and one that does not must answer
 * -32601. Registering the handlers unconditionally would make "DeFlow did not
 * send the frame" and "the agent had no handler" indistinguishable in exactly
 * the specs that need to tell them apart.
 *
 * `{}` counts as granted, matching the wire: one probed adapter answered
 * `sessionCapabilities: { list: {} }`, which advertises the capability while
 * claiming nothing further about it.
 */
function advertises(agentCapabilities: unknown, path: readonly string[]): boolean {
  let cursor: unknown = agentCapabilities;
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null) return false;
    if (!Object.hasOwn(cursor, segment)) return false;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor === true || (typeof cursor === 'object' && cursor !== null);
}

/** The text blocks of a prompt, concatenated. Non-text blocks are ignored. */
function promptText(blocks: readonly acp.ContentBlock[]): string {
  return blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
}

/**
 * The built-in turn: a greeting, then the prompt read back.
 *
 * It is a function of the request alone, so the same prompt at the same seed
 * produces the same bytes, and reading the prompt back gives a test something
 * to assert that proves the agent parsed the request rather than replaying a
 * canned line. The scripted vocabulary — cadence, tool calls, permissions — is
 * KAR-04.2's.
 */
export function turnChunks(prompt: readonly acp.ContentBlock[]): string[] {
  return [`Hello from ${AGENT_NAME}.`, ` You said: ${promptText(prompt)}`];
}

export function createMockAgent(
  options: MockAgentOptions,
  scenario: Scenario | null = null,
  ports: MockAgentPorts = createProcessPorts(),
  capabilities: CapabilitiesOptions = DEFAULT_CAPABILITIES_OPTIONS,
): acp.AgentApp {
  const ids = createIdFactory(options.seed);
  const clock = createSyntheticClock(options.seed);
  /**
   * The open sessions, and the cwd each was opened against.
   *
   * A `Map` rather than the `Set` this used to be because `session/list` has
   * to answer with a `SessionInfo`, and `SessionInfo` requires `cwd` — an
   * agent that advertised `sessionCapabilities.list` and could only produce
   * session ids would answer a shape Layer A rejects, which is a subtler
   * version of the same dishonesty.
   */
  const sessions = new Map<string, { cwd: string }>();
  /**
   * The in-flight turn's cancel hook, per session.
   *
   * `session/cancel` is a notification, and the SDK dispatches inbound
   * messages without awaiting the previous handler, so it really does arrive
   * while `session/prompt` is still pending. That is the only reason a wedged
   * turn can be cancelled at all — and per adapter layer §2.5 the answer is a
   * prompt *response* with `stopReason: 'cancelled'`, not a teardown.
   */
  const cancels = new Map<string, () => void>();
  /**
   * What the client said it could do, remembered from the handshake.
   *
   * A scripted `clientCall` step is skipped when the capability behind it was
   * never advertised — ACP v2 removes all seven client methods and pushes them
   * onto MCP, and an agent that called them anyway would hide that migration
   * behind a stub that answers regardless.
   */
  let clientCapabilities: acp.ClientCapabilities = {};

  const agent = acp
    .agent()
    .onRequest('initialize', ({ params }) => {
      if (params.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new acp.RequestError(
          INVALID_PARAMS,
          `protocol version mismatch: ${AGENT_NAME} speaks protocol version ` +
            `${acp.PROTOCOL_VERSION}, the client asked for ${params.protocolVersion}`,
          { supported: [acp.PROTOCOL_VERSION], requested: params.protocolVersion },
        );
      }
      clientCapabilities = params.clientCapabilities ?? {};
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        // AC1: whatever was selected on argv, returned exactly as given — a
        // named profile, an arbitrary --capabilities-file block, or (absent
        // either) the fixed built-in default this replaces nothing about.
        agentCapabilities: capabilities.agentCapabilities as acp.AgentCapabilities,
        authMethods: [],
        agentInfo: { name: AGENT_NAME, version: AGENT_VERSION },
      };
    })
    .onRequest('session/new', ({ params }) => {
      // AC4's additionalDirectories case: session/new is the request that
      // capability qualifies, so it is the one a dishonest run refuses.
      if (capabilities.dishonestMethod === 'session/new') refuseAsDishonest();
      const sessionId = ids.session();
      sessions.set(sessionId, { cwd: params.cwd });
      return { sessionId };
    })
    .onRequest('session/prompt', async ({ params, client }) => {
      if (!sessions.has(params.sessionId)) {
        throw new acp.RequestError(INVALID_PARAMS, `unknown session "${params.sessionId}"`);
      }

      if (scenario !== null) {
        let cancelled = (): void => {};
        const waitForCancel = new Promise<void>((resolve) => {
          cancelled = resolve;
        });
        cancels.set(params.sessionId, cancelled);

        try {
          const turn = await runScenario(scenario, {
            sessionId: params.sessionId,
            client,
            ids,
            clock,
            capabilities: clientCapabilities,
            prompt: promptText(params.prompt),
            sleep: realSleep,
            ports,
            waitForCancel: () => waitForCancel,
          });
          // The trace rides back on `_meta` so a spec can assert what the agent
          // *saw* — that it received the client's rejection — rather than only
          // that a request went out.
          return { stopReason: turn.stopReason, _meta: { trace: turn.trace } };
        } finally {
          cancels.delete(params.sessionId);
        }
      }

      for (const text of turnChunks(params.prompt)) {
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
          _meta: { timestampMs: clock.now() },
        });
      }
      return { stopReason: 'end_turn' };
    })
    .onNotification('session/cancel', ({ params }) => {
      // Unknown session, or no turn in flight: nothing to cancel, and
      // certainly nothing to fail over. A cancel that raced the end of a turn
      // is normal client behaviour, not an error.
      cancels.get(params.sessionId)?.();
    })
    .onRequest('session/close', ({ params }) => {
      sessions.delete(params.sessionId);
      return {};
    });

  // KAR-05.5 — the two lifecycle methods a resume spec needs, each registered
  // only when this run's profile advertises it. An honest agent implements
  // what it advertised and refuses what it did not.
  if (
    capabilities.dishonestMethod !== 'session/resume' &&
    advertises(capabilities.agentCapabilities, ['sessionCapabilities', 'resume'])
  ) {
    agent.onRequest('session/resume', ({ params }) => {
      // Deliberately accepted for an id this process never issued: that is the
      // whole operation. A vendor CLI restarted after a crash has no memory of
      // the session either until it reads its own file, and a mock that
      // insisted on having created it could only ever test a resume inside one
      // process — which is not the case that breaks.
      sessions.set(params.sessionId, { cwd: params.cwd });
      return {};
    });
  }

  // The three lifecycle methods an honest agent owes its own manifest.
  //
  // Registered on exactly the same rule as `session/resume` above — advertised
  // means implemented — because that rule is what makes conformance assertion
  // 6 able to fail at all. KAR-05.7's battery is what found these missing:
  // the mock advertised fork, list and delete out of the measured capability
  // matrix and answered all three with -32601, which is the precise lie the
  // battery exists to catch.
  if (
    capabilities.dishonestMethod !== 'session/list' &&
    advertises(capabilities.agentCapabilities, ['sessionCapabilities', 'list'])
  ) {
    agent.onRequest('session/list', ({ params }) => ({
      sessions: [...sessions.entries()]
        .filter(([, info]) => params.cwd == null || info.cwd === params.cwd)
        .map(([sessionId, info]) => ({ sessionId, cwd: info.cwd })),
    }));
  }

  if (
    capabilities.dishonestMethod !== 'session/fork' &&
    advertises(capabilities.agentCapabilities, ['sessionCapabilities', 'fork'])
  ) {
    agent.onRequest('session/fork', ({ params }) => {
      if (!sessions.has(params.sessionId)) {
        throw new acp.RequestError(INVALID_PARAMS, `unknown session "${params.sessionId}"`);
      }
      // A fork is a *new* session that leaves the original open — that is the
      // whole operation, and an implementation that returned the same id would
      // pass a -32601 check while breaking every caller.
      const sessionId = ids.session();
      sessions.set(sessionId, { cwd: params.cwd });
      return { sessionId };
    });
  }

  if (
    capabilities.dishonestMethod !== 'session/delete' &&
    advertises(capabilities.agentCapabilities, ['sessionCapabilities', 'delete'])
  ) {
    agent.onRequest('session/delete', ({ params }) => {
      sessions.delete(params.sessionId);
      return {};
    });
  }

  if (advertises(capabilities.agentCapabilities, ['loadSession'])) {
    agent.onRequest('session/load', async ({ params, client }) => {
      sessions.set(params.sessionId, { cwd: params.cwd });
      // The behaviour the design rule warns about, reproduced honestly:
      // `session/load` streams the *entire* conversation history back as
      // `session/update` notifications before it answers. For a days-long run
      // this is tens of thousands of frames nobody asked for.
      for (let index = 0; index < options.loadHistory; index += 1) {
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `replayed frame ${index}` },
          },
          _meta: { timestampMs: clock.now(), replayed: true },
        });
      }
      return {};
    });
  }

  // AC4, the four lifecycle methods this mock does not otherwise implement:
  // registered only when named as the one dishonest capability, so an honest
  // run's `session/resume` etc. still falls through to the SDK's own
  // unregistered-method fallback exactly as it did before this story.
  if (capabilities.dishonestMethod === 'session/resume') {
    agent.onRequest('session/resume', refuseAsDishonest);
  }
  if (capabilities.dishonestMethod === 'session/fork') {
    agent.onRequest('session/fork', refuseAsDishonest);
  }
  if (capabilities.dishonestMethod === 'session/list') {
    agent.onRequest('session/list', refuseAsDishonest);
  }
  if (capabilities.dishonestMethod === 'session/delete') {
    agent.onRequest('session/delete', refuseAsDishonest);
  }

  return agent;
}
