/**
 * EPIC-05-S9 — a node is refused scheduling **before a process is spawned**.
 *
 * Integration rather than unit, because the claim is about the absence of a
 * subprocess and the only honest way to observe that is to give the binary a
 * way to say it ran: `$DeFlow_SIDE_EFFECT_LOG` is appended to synchronously by
 * the mock agent on *every* invocation, including one whose argv it cannot
 * parse. No file means no child, which is a stronger statement than "no
 * handshake was completed".
 *
 * The rows are probed for real too, rather than hand-built, so what admission
 * refuses on is a row a live `initialize` produced.
 *
 * Verifies: EPIC-05-S9 · AC7
 */
import { NodeIdSchema, ProviderIdSchema } from '@DeFlow/core';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type CapabilityRequirement,
  type CapabilityRow,
  probeProvider,
  runAcpNode,
} from '../../src/index.ts';
import {
  eventOf,
  MOCK_AGENT_BIN,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  type TestLedger,
} from './support/harness.ts';

let dir = '';
let worktree = '';
let ledger: TestLedger;
let clock: TestClock;

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  await mkdir(worktree, { recursive: true });
  ledger = openTestLedger(dir);
  clock = new TestClock(1_754_313_093_000);
});

afterEach(async () => {
  ledger.close();
  await removeTempDir(dir);
});

/** Probes the mock agent under `profile` and returns the row it wrote. */
async function probe(profile: string, argv: readonly string[]): Promise<CapabilityRow> {
  const outcome = await probeProvider(
    { provider: ProviderIdSchema.parse(profile), binaryPath: MOCK_AGENT_BIN, argv },
    { clock, ledger: ledger.sink, capabilities: ledger.capabilities },
  );
  return outcome.row;
}

/** Runs a node, with a log the mock agent appends to if it is ever invoked. */
async function schedule(options: {
  row: CapabilityRow | null;
  requires: readonly CapabilityRequirement[];
  permission?: 'read' | 'worktree' | 'worktree+net' | 'full';
}): Promise<{ outcome: Awaited<ReturnType<typeof runAcpNode>>; spawnLog: string }> {
  const spawnLog = join(dir, 'invocations.log');
  const outcome = await runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: options.permission ?? 'read',
      worktree,
      binary: { path: MOCK_AGENT_BIN, version: '0.0.0', sha256: 'a'.repeat(64) },
      env: { ...process.env, DeFlow_SIDE_EFFECT_LOG: spawnLog },
      mcpServers: [],
      prompt: 'hello',
      requires: options.requires,
    },
    {
      clock,
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      capabilityRow: options.row,
    },
  );
  return { outcome, spawnLog };
}

suite('a node whose requirements exceed the adapter is refused', () => {
  const examples: { profile: string; requirement: CapabilityRequirement }[] = [
    { profile: 'codex', requirement: 'session.fork' },
    { profile: 'gemini', requirement: 'session.list' },
    { profile: 'copilot', requirement: 'session.delete' },
    { profile: 'gemini', requirement: 'additionalDirectories' },
  ];

  for (const { profile, requirement } of examples) {
    it(`${profile} + ${requirement}: no child process, and a permanent node.failed`, async () => {
      const row = await probe(profile, ['--capabilities', profile]);
      const { outcome, spawnLog } = await schedule({ row, requires: [requirement] });

      // "Then no child process is spawned."
      expect(existsSync(spawnLog)).toBe(false);

      expect(outcome.status).toBe('failed');
      if (outcome.status !== 'failed') throw new Error('unreachable');
      expect(outcome.failure.reason).toBe('adapter.capability-missing');
      expect(outcome.failure.class).toBe('permanent');
      // "failure.detail names the requirement and the profile."
      expect(outcome.failure.detail).toMatchObject({ requirement, provider: profile });

      // `node.scheduled` is still written: the scheduler *did* consider this
      // node, and the refusal points at that decision as the event it
      // occurred at (a `NodeFailure.occurredAtEvent` is a real ledger
      // position, never a placeholder). What must not be there is anything
      // that implies a process ran.
      const events = ledger.events();
      expect(events.map((event) => event.kind)).toEqual([
        'provider.probed',
        'node.scheduled',
        'node.failed',
      ]);
      // Refused before the side effect, so there is no `node.started` to
      // reconcile and no session to explain.
      expect(eventOf(events, 'node.started')).toBeUndefined();
      const failed = eventOf(events, 'node.failed');
      expect(failed).toMatchObject({
        failure: { reason: 'adapter.capability-missing', class: 'permanent' },
      });
    });
  }

  it('runs the node when the row does satisfy what it asked for', async () => {
    const row = await probe('claude', ['--capabilities', 'claude']);
    const { outcome, spawnLog } = await schedule({
      row,
      requires: ['session.resume', 'session.fork'],
    });

    expect(outcome.status).toBe('completed');
    expect(existsSync(spawnLog)).toBe(true);
  });

  it('runs the node when it asked for nothing, even with no probed row', async () => {
    const { outcome } = await schedule({ row: null, requires: [] });
    expect(outcome.status).toBe('completed');
  });
});

suite('an adapter that cannot mediate execution is refused, not escalated', () => {
  it('fails with safety.permission-unschedulable and spawns nothing', async () => {
    const capsFile = join(dir, 'no-mediation.json');
    writeFileSync(
      capsFile,
      JSON.stringify({ loadSession: true, _meta: { mediatedExecution: false } }),
    );
    const row = await probe('mock', ['--capabilities-file', capsFile]);

    const { outcome, spawnLog } = await schedule({
      row,
      requires: [],
      permission: 'worktree',
    });

    expect(existsSync(spawnLog)).toBe(false);
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failure.reason).toBe('safety.permission-unschedulable');
    expect(outcome.failure.class).toBe('permanent');
    expect(outcome.failure.detail).toMatchObject({ permission: 'worktree' });
    // "the run is NOT silently escalated to a broader permission level" — and
    // it is not quietly narrowed either: nothing ran at all.
    expect(eventOf(ledger.events(), 'node.started')).toBeUndefined();
  });

  it('a row that never mentions mediatedExecution still schedules', async () => {
    const row = await probe('claude', ['--capabilities', 'claude']);
    const { outcome } = await schedule({ row, requires: [], permission: 'full' });
    expect(outcome.status).toBe('completed');
  });

  /**
   * KAR-08.1 AC4 / EPIC-08-S3. The refusal is already a `node.failed`, but a
   * failure is where a node *ended* and this is a fact about why it never
   * began. The operator's question is "which provider, and which bit", and the
   * answer has to be structured — the inspector renders it, and a run report
   * that says "one node was unschedulable" without naming the capability sends
   * the reader to the logs.
   */
  it('appends node.unschedulable naming the provider and the bit', async () => {
    const capsFile = join(dir, 'no-mediation.json');
    writeFileSync(capsFile, JSON.stringify({ _meta: { mediatedExecution: false } }));
    const row = await probe('mock', ['--capabilities-file', capsFile]);

    await schedule({ row, requires: [], permission: 'worktree+net' });

    const events = ledger.events();
    const unschedulable = eventOf(events, 'node.unschedulable');
    expect(unschedulable).toMatchObject({
      node: NodeIdSchema.parse('n1'),
      provider: 'mock',
      permission: 'worktree+net',
      reason: 'mediatedExecution:false',
    });

    // It precedes the failure it explains, so a reader walking the timeline
    // meets the cause before the effect.
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain('node.unschedulable');
    expect(kinds.indexOf('node.unschedulable')).toBeLessThan(kinds.indexOf('node.failed'));
  });

  it('does not append it for a refusal that has nothing to do with mediation', async () => {
    const row = await probe('codex', ['--capabilities', 'codex']);
    await schedule({ row, requires: ['session.fork'], permission: 'worktree' });

    expect(eventOf(ledger.events(), 'node.unschedulable')).toBeUndefined();
  });
});

suite('the refusal is a node the operator can act on', () => {
  it('names the node, the requirement and the version in one line', async () => {
    const row = await probe('codex', ['--capabilities', 'codex']);
    const { outcome } = await schedule({ row, requires: ['session.fork'] });
    if (outcome.status !== 'failed') throw new Error('unreachable');

    expect(outcome.failure.message).toContain(NodeIdSchema.parse('n1'));
    expect(outcome.failure.message).toContain('session.fork');
    expect(outcome.failure.message).toContain('codex');
    expect(outcome.failure.message).toContain(row.version);
    // One line, because it is rendered in a board cell.
    expect(outcome.failure.message).not.toContain('\n');
  });
});
