#!/usr/bin/env node
/**
 * A real ACP-shaped agent binary, spawned as a real child process, that
 * produces the four behaviours a vendor cannot be asked for on demand:
 *
 *   --mode flood      a 10 MB line with no newline (EPIC-00-S8)
 *   --mode deadlock   accepts session/cancel and never answers (EPIC-00-S10)
 *   --mode trailing   answers cancelled, then flushes two more updates
 *   --mode divergent  advertises a capability its snapshot row denies (S5)
 *
 * It is a binary, not a mock: the harness spawns it exactly the way it spawns
 * `npx @agentclientprotocol/claude-agent-acp`, over the same pipes, through
 * the same framer. Nothing in the client knows the difference, which is the
 * only reason these assertions mean anything.
 */
const mode = process.argv[process.argv.indexOf('--mode') + 1] ?? 'trailing';

const state = {
  sessionId: 'fake-session',
  turn: 0,
  promptIdTurnOne: 0,
  promptIdTurnTwo: 0,
  cancelled: false,
};

const PERMISSION_REQUEST_ID = 900;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function update(payload: unknown): void {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: state.sessionId, update: payload },
  });
}

function chunk(text: string): void {
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
}

function capabilities(): unknown {
  return {
    loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    // The divergent agent claims resume and list, which its row in
    // SNAPSHOT_2026_08_02 denies. The harness must write what it saw.
    sessionCapabilities: mode === 'divergent' ? { resume: {}, list: {} } : {},
  };
}

/** Turn one: three spread-out chunks, a tool call, and a permission request. */
async function permissionTurn(): Promise<void> {
  for (const [index, text] of ['I', ' will', ' write it'].entries()) {
    await sleep(index === 0 ? 10 : 300);
    chunk(text);
  }
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'fake-tool-1',
    status: 'pending',
    title: 'Write',
    kind: 'edit',
  });
  send({
    jsonrpc: '2.0',
    id: PERMISSION_REQUEST_ID,
    method: 'session/request_permission',
    params: {
      sessionId: state.sessionId,
      toolCall: { toolCallId: 'fake-tool-1' },
      options: [
        { kind: 'reject_once', name: 'Deny', optionId: 'reject' },
        { kind: 'allow_once', name: 'Allow Once', optionId: 'allow' },
      ],
    },
  });
}

/** Turn two: stream until the client cancels. */
async function cancelTurn(): Promise<void> {
  for (const [index, text] of ['1', ' 2', ' 3', ' 4', ' 5'].entries()) {
    await sleep(index === 0 ? 10 : 200);
    if (state.cancelled) return;
    chunk(text);
  }
}

function onPermissionAnswer(optionId: string | undefined): void {
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'fake-tool-1',
    status: optionId === 'reject' ? 'failed' : 'completed',
  });
  send({
    jsonrpc: '2.0',
    id: state.promptIdTurnOne,
    result: { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2 } },
  });
}

function handle(message: { id?: number; method?: string }): void {
  const { id, method } = message;
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: capabilities(),
          agentInfo: { name: `fake-${mode}`, version: '9.9.9' },
          authMethods: [],
        },
      });
      return;
    case 'session/new':
      if (mode === 'flood') {
        // No newline, ever — the exact shape that grows the SDK's LineBuffer
        // until the daemon dies.
        process.stdout.write('x'.repeat(10 * 1024 * 1024));
        return;
      }
      state.sessionId = `fake-session-${String(id)}`;
      send({ jsonrpc: '2.0', id, result: { sessionId: state.sessionId } });
      return;
    case 'session/prompt':
      state.turn += 1;
      if (state.turn === 1) {
        state.promptIdTurnOne = id ?? 0;
        void permissionTurn();
      } else {
        state.promptIdTurnTwo = id ?? 0;
        void cancelTurn();
      }
      return;
    case 'session/cancel':
      if (mode === 'deadlock') return; // ignored, on purpose
      state.cancelled = true;
      send({ jsonrpc: '2.0', id: state.promptIdTurnTwo, result: { stopReason: 'cancelled' } });
      // The prompt promise resolving is not permission for the agent to stop
      // talking, and the client has to survive exactly this.
      update({ sessionUpdate: 'usage_update', used: 10, size: 1000 });
      update({ sessionUpdate: 'session_info_update', title: 'cancelled turn' });
      return;
    default:
      if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
  }
}

let buffer = '';
process.stdin.on('data', (raw: Buffer) => {
  buffer += raw.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() !== '') {
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        result?: { outcome?: { optionId?: string } };
      };
      if (message.id === PERMISSION_REQUEST_ID && message.method === undefined) {
        onPermissionAnswer(message.result?.outcome?.optionId);
      } else {
        handle(message);
      }
    }
    index = buffer.indexOf('\n');
  }
});
