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
import type { MockAgentOptions } from './cli.ts';
import { createSyntheticClock } from './clock.ts';
import { createIdFactory } from './ids.ts';

export const AGENT_NAME = 'DeFlow-mock-agent';
export const AGENT_VERSION = '0.0.0';

/**
 * What this binary advertises until KAR-04.4 makes it selectable. Every field
 * is stated rather than omitted, because "absent" and "false" are different
 * answers and the five real adapters disagree about which they use.
 */
export const DEFAULT_AGENT_CAPABILITIES: acp.AgentCapabilities = {
  loadSession: false,
  promptCapabilities: { image: false, audio: false, embeddedContext: false },
  mcpCapabilities: { http: false, sse: false },
};

/** The JSON-RPC code for a request whose params the agent will not accept. */
const INVALID_PARAMS = -32602;

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

export function createMockAgent(options: MockAgentOptions): acp.AgentApp {
  const ids = createIdFactory(options.seed);
  const clock = createSyntheticClock(options.seed);
  const sessions = new Set<string>();

  return acp
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
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: DEFAULT_AGENT_CAPABILITIES,
        authMethods: [],
        agentInfo: { name: AGENT_NAME, version: AGENT_VERSION },
      };
    })
    .onRequest('session/new', () => {
      const sessionId = ids.session();
      sessions.add(sessionId);
      return { sessionId };
    })
    .onRequest('session/prompt', async ({ params, client }) => {
      if (!sessions.has(params.sessionId)) {
        throw new acp.RequestError(INVALID_PARAMS, `unknown session "${params.sessionId}"`);
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
    .onRequest('session/close', ({ params }) => {
      sessions.delete(params.sessionId);
      return {};
    });
}
