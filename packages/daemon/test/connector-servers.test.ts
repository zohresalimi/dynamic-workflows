/**
 * Connector-server discovery: the vendor's own `mcp list`, asked once per
 * daemon life per binary — including when the answer was a failure, because
 * re-asking a wedged binary every tick is a spawn storm.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverConnectorServers,
  resetConnectorServerCache,
} from '../src/providers/connector-servers.ts';

const OUTPUT = [
  'Checking MCP server health…',
  '',
  'claude.ai Linear: https://mcp.linear.app/mcp - ✔ Connected',
  'scratch: /tmp/x.mjs - ⏸ Pending approval',
].join('\n');

/** A fake vendor CLI that counts its invocations, so the cache is observable. */
function fakeCli(dir: string, options: { readonly exitCode?: number } = {}): string {
  const path = join(dir, 'fake-vendor');
  const counter = join(dir, 'calls');
  writeFileSync(counter, '');
  writeFileSync(
    path,
    '#!/bin/sh\n' +
      `printf x >> ${counter}\n` +
      `cat << 'OUT'\n${OUTPUT}\nOUT\n` +
      `exit ${String(options.exitCode ?? 0)}\n`,
    { mode: 0o755 },
  );
  return path;
}

const calls = (dir: string): number => readFileSync(join(dir, 'calls'), 'utf8').length;

describe('discoverConnectorServers', () => {
  afterEach(() => {
    resetConnectorServerCache();
  });

  it('parses the connected servers out of the binary’s own listing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'DeFlow-connector-'));
    const bin = fakeCli(dir);

    await expect(discoverConnectorServers({ binaryPath: bin, env: {} })).resolves.toEqual([
      'claude.ai Linear',
    ]);
  });

  it('asks each binary once per daemon life, however many turns ask', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'DeFlow-connector-'));
    const bin = fakeCli(dir);

    await discoverConnectorServers({ binaryPath: bin, env: {} });
    await discoverConnectorServers({ binaryPath: bin, env: {} });
    await discoverConnectorServers({ binaryPath: bin, env: {} });

    expect(calls(dir)).toBe(1);
  });

  it('a reset makes the next call ask again — the test seam and shutdown hygiene', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'DeFlow-connector-'));
    const bin = fakeCli(dir);

    await discoverConnectorServers({ binaryPath: bin, env: {} });
    resetConnectorServerCache();
    await discoverConnectorServers({ binaryPath: bin, env: {} });

    expect(calls(dir)).toBe(2);
  });

  it('a binary that exits non-zero answers empty rather than failing the turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'DeFlow-connector-'));
    const bin = fakeCli(dir, { exitCode: 1 });

    await expect(discoverConnectorServers({ binaryPath: bin, env: {} })).resolves.toEqual([]);
  });

  it('a binary that does not exist answers empty rather than throwing', async () => {
    await expect(
      discoverConnectorServers({ binaryPath: '/nonexistent/deflow-no-such-bin', env: {} }),
    ).resolves.toEqual([]);
  });
});
