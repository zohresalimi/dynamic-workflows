/**
 * KAR-05.6 AC1 — the `mcpServers` entry DeFlowd puts in `session/new`.
 *
 * `McpServer` is a four-way union in the ACP schema and three of its arms
 * carry a `type` discriminant. The stdio arm is the **untagged** one, and it
 * is the only one every probed agent accepts without a capability flag — so
 * the absence of `type` is the assertion, not an incidental detail.
 *
 * That the entry arrives at a *real agent* in this shape is
 * `test/integration/mcp-session-new.test.ts`; this is the shape itself.
 *
 * Verifies: EPIC-05-S22 · AC1
 */
import process from 'node:process';
import { expect, it, describe as suite } from 'vitest';
import { MCP_SERVER_NAME, mcpServerEntry, RUN_TOKEN_ENV } from './server-entry.ts';

const entry = mcpServerEntry({
  entry: '/opt/DeFlow/bin/deflow-mcp.js',
  socketPath: '/tmp/DeFlow-abc/mcp/host.sock',
  runId: 'run_20260805T101500Z_ac0506',
  token: 'a'.repeat(64),
});

suite('the untagged stdio variant (AC1)', () => {
  it('carries no "type" discriminant', () => {
    expect(Object.keys(entry)).not.toContain('type');
  });

  it('is named DeFlow', () => {
    expect(entry.name).toBe(MCP_SERVER_NAME);
  });

  it('runs the exact node executing DeFlowd, never a bare name on PATH', () => {
    expect(entry.command).toBe(process.execPath);
  });

  it('passes the shim entry, the socket and the run id as argv', () => {
    expect(entry.args).toEqual([
      '/opt/DeFlow/bin/deflow-mcp.js',
      '--socket',
      '/tmp/DeFlow-abc/mcp/host.sock',
      '--run',
      'run_20260805T101500Z_ac0506',
    ]);
  });

  it('carries the run token as an environment variable and nothing else', () => {
    expect(entry.env).toEqual([{ name: RUN_TOKEN_ENV, value: 'a'.repeat(64) }]);
  });
});
