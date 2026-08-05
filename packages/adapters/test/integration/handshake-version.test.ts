/**
 * EPIC-05-S2 — `protocolVersion` is the integer 1, and anything else is a
 * clean permanent failure rather than a downgrade.
 *
 * A downgrade would be worse than an error: the client would carry on
 * believing it had negotiated the version it asked for and would only find out
 * at the first frame whose shape changed, arbitrarily far from the handshake.
 *
 * The `"2025-11-25"` case is not padding. MCP's protocol version is a date
 * string and ACP's is an integer; a shared negotiation helper is the obvious
 * mistake, and this is the example that makes it fail a test.
 *
 * Verifies: EPIC-05-S2 · AC1, AC7 · test plan #2
 */

import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { runAcpNode } from '../../src/index.ts';
import {
  eventOf,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  type TestLedger,
} from './support/harness.ts';

const LIAR = fileURLToPath(new URL('./support/version-liar.ts', import.meta.url));

let dir = '';
let worktree = '';
let ledger: TestLedger;

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  await mkdir(worktree, { recursive: true });
  ledger = openTestLedger(dir);
});

afterEach(async () => {
  ledger.close();
  await removeTempDir(dir);
});

async function handshakeWith(version: string): Promise<{
  outcome: Awaited<ReturnType<typeof runAcpNode>>;
  methods: string[];
}> {
  const methodLog = join(dir, `methods-${version.replaceAll(/\W/g, '')}.log`);
  const outcome = await runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: 'read',
      worktree,
      // The liar is run through the current Node binary so the fixture needs
      // no execute bit to be a real child process.
      binary: { path: process.execPath, version: process.version, sha256: 'a'.repeat(64) },
      argv: [LIAR, '--protocol-version', version],
      env: { ...process.env, DeFlow_LIAR_LOG: methodLog },
      mcpServers: [],
      prompt: 'hello',
    },
    { clock: new TestClock(), ledger: ledger.sink, captureEvidence: ledger.captureEvidence },
  );
  const methods = readFileSync(methodLog, 'utf8').split('\n').filter(Boolean);
  return { outcome, methods };
}

suite.for(['2', '0', '"2025-11-25"'])('initialize answered with %s', (version) => {
  it('fails the node permanently and never opens a session', async () => {
    const { outcome, methods } = await handshakeWith(version);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;

    expect(outcome.failure.reason).toBe('adapter.handshake-failed');
    expect(outcome.failure.class).toBe('permanent');
    expect(outcome.failure.detail).toEqual({ offered: JSON.parse(version), expected: 1 });
    expect(outcome.failure.message).not.toContain('\n');
    // AC7: the diagnostic is a handle into the blob store, never the payload.
    expect(outcome.failure.evidence).toHaveLength(1);

    // The one assertion a "no downgrade" claim rests on.
    expect(methods).toEqual(['initialize']);
    expect(methods).not.toContain('session/new');

    const events = ledger.events();
    expect(events.map((event) => event.kind)).toEqual(['node.scheduled', 'node.failed']);
    expect(eventOf(events, 'node.failed')).toMatchObject({
      node: NODE_ID,
      attempt: 0,
      failure: { reason: 'adapter.handshake-failed', class: 'permanent' },
    });

    // And the child is not left behind.
    expect(outcome.exit).not.toBeNull();
  });
});

suite('the negotiated version of a healthy handshake', () => {
  it('is the integer 1, asserted as a type and not only as a value', async () => {
    const { outcome } = await handshakeWith('1');
    // The liar answers `initialize` and refuses everything after it, so the
    // turn fails — but only *after* the version was accepted, which is what
    // separates "negotiated 1" from "rejected everything".
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.reason).not.toBe('adapter.handshake-failed');
    expect(outcome.protocolVersion).toBe(1);
    expect(typeof outcome.protocolVersion).toBe('number');
  });
});
