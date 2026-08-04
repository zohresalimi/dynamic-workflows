#!/usr/bin/env node
/**
 * DeFlow's own stdio MCP server, in its minimum honest form.
 *
 * AC3 asks whether the agent accepts DeFlow's MCP server in the `mcpServers`
 * argument of `session/new`. "It answered session/new without an error" is not
 * an answer to that — an agent could ignore the argument entirely and still
 * succeed. So this is a real MCP server that really speaks the handshake, and
 * it appends every method it is asked for to `$DEFLOW_SPIKE_MCP_LOG`. That log
 * is the evidence that the server was launched and spoken to, and it is
 * committed next to the recording.
 *
 * The real one is EPIC-06's; this exists only for as long as the spike does.
 */
import { appendFileSync } from 'node:fs';

const logPath = process.env['DEFLOW_SPIKE_MCP_LOG'];

function log(method: string): void {
  if (logPath !== undefined) appendFileSync(logPath, `${method}\n`);
}

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

let buffer = '';
process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() !== '') handle(JSON.parse(line) as { id?: unknown; method?: string });
    index = buffer.indexOf('\n');
  }
});

function handle(message: { id?: unknown; method?: string; params?: unknown }): void {
  const method = message.method ?? '';
  log(method);
  if (method === 'initialize') {
    reply(message.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'deflow-spike-mcp', version: '0.0.0' },
    });
    return;
  }
  if (method === 'tools/list') {
    reply(message.id, {
      tools: [
        {
          name: 'deflow_spike_echo',
          description: 'Echoes the text it is given. Exists only to prove the MCP wiring.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      ],
    });
    return;
  }
  if (method === 'tools/call') {
    const args = (message.params as { arguments?: { text?: string } } | undefined)?.arguments;
    reply(message.id, { content: [{ type: 'text', text: `echo: ${String(args?.text)}` }] });
    return;
  }
  if (message.id !== undefined) reply(message.id, {});
}
