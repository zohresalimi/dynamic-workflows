/**
 * KAR-05.1 AC2 — what DeFlow advertises at `initialize`, and what it must not.
 *
 * `mcp/*` and `elicitation/*` are absent on purpose: `mcpCapabilities.acp` was
 * not advertised true by a single probed agent (docs/07-provider-adapter-layer.md
 * §2.4, §7), so advertising them would be a promise DeFlow cannot keep and an
 * agent that believed it would call a method nothing answers.
 *
 * Verifies: EPIC-05-S1 (capability half) · AC2
 */
import { expect, it, describe as suite } from 'vitest';
import { CLIENT_CAPABILITIES, CLIENT_INFO } from './client-capabilities.ts';

suite('the advertised client capability set', () => {
  it('is exactly fs.readTextFile, fs.writeTextFile and terminal', () => {
    expect(CLIENT_CAPABILITIES).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    });
  });

  it('advertises no mcp and no elicitation capability at M1', () => {
    const keys = Object.keys(CLIENT_CAPABILITIES);
    expect(keys).toEqual(['fs', 'terminal']);
    // Spelled as a serialised scan as well as a key check: a nested
    // `mcpCapabilities` would satisfy the top-level key assertion and still
    // reach the wire.
    expect(JSON.stringify(CLIENT_CAPABILITIES)).not.toMatch(/mcp|elicitation/i);
  });

  it('is frozen, so a caller cannot add a capability on the way to the handshake', () => {
    expect(Object.isFrozen(CLIENT_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(CLIENT_CAPABILITIES.fs)).toBe(true);
  });

  it('names DeFlow as the client, because the agent logs whatever it is told', () => {
    expect(CLIENT_INFO.name).toBe('DeFlow');
    expect(CLIENT_INFO.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
