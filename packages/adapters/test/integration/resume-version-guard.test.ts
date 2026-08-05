/**
 * EPIC-05-S20 — a vendor version change invalidates a resume.
 *
 * Session-file formats and resume semantics are internal vendor details that
 * change without notice. Resuming a session started under one build under a
 * different build is not a supported operation by anyone, and the failure mode
 * is not a clean error — it is a subtly corrupted context that poisons the
 * rest of a multi-hour run. So the guard refuses by default, asks a human, and
 * records the answer either way.
 *
 * The version under test is read out of a real subprocess (`<bin> --version`,
 * with `$DeFlow_MOCK_VERSION` staging the bump) rather than typed into the
 * request, because "the resolver reported a different string this time" is the
 * event being simulated.
 *
 * Verifies: EPIC-05-S20 · AC5 · test plan #5, #6
 */
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type AgentBinary,
  RESUME_OVERRIDE_OPTION_ID,
  RESUME_REFUSE_OPTION_ID,
  resumeAcpNode,
  runAcpNode,
} from '../../src/index.ts';
import {
  MOCK_AGENT_BIN,
  mockAgentBinary,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  scenario,
  type TestLedger,
} from './support/harness.ts';
import { capabilityRowFor, seedContextBuilt, wireMethods } from './support/resume-fixture.ts';

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

/** What `<bin> --version` prints when the environment stages `version`. */
function reportedVersion(version: string): string {
  return execFileSync(MOCK_AGENT_BIN, ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, DeFlow_MOCK_VERSION: version },
  }).trim();
}

async function interruptedFirstLife(binary: AgentBinary): Promise<void> {
  const fixture = await seedContextBuilt({
    dataDir: dir,
    ledger,
    runId: RUN_ID,
    nodeId: NODE_ID,
    attempt: 0,
    provider: PROVIDER,
  });

  const outcome = await runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: 'worktree',
      worktree,
      binary,
      argv: ['--capabilities', 'claude', '--scenario', scenario('exit-mid-turn.jsonc')],
      mcpServers: [],
      prompt: fixture.prompt,
    },
    {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      capabilityRow: capabilityRowFor('claude', binary),
    },
  );
  expect(outcome.status).toBe('failed');
  ledger.close();
}

async function resumeWith(
  binary: AgentBinary,
  wire: string,
  override?: { readonly optionId: string; readonly at: string },
) {
  ledger = openTestLedger(dir);
  return await resumeAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: 'worktree',
      worktree,
      binary,
      argv: ['--capabilities', 'claude', '--wire-log', wire],
      mcpServers: [],
      ...(override === undefined ? {} : { override }),
    },
    {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      capabilityRow: capabilityRowFor('claude', binary),
      history: async () => ledger.events(),
      readSegmentText: ledger.readSegmentText,
    },
  );
}

const at = (kind: string, events: ReturnType<TestLedger['events']>) =>
  events.find((event) => event.kind === kind);

suite('a version bump between crash and resume refuses by default', () => {
  it('sends no frame at all, suspends the node, and asks the operator', async () => {
    const recorded: AgentBinary = { ...mockAgentBinary(), version: reportedVersion('0.146.0') };
    await interruptedFirstLife(recorded);

    const current: AgentBinary = { ...mockAgentBinary(), version: reportedVersion('0.150.0') };
    const wire = join(dir, 'wire-refused.ndjson');
    const outcome = await resumeWith(current, wire);

    expect(outcome.status).toBe('refused');
    expect(outcome.strategy).toBeNull();
    // Nothing was spawned, so nothing was sent: the log does not exist.
    expect(wireMethods(wire)).toEqual([]);

    const events = ledger.events();
    const requested = at('human.requested', events);
    expect(requested).toBeDefined();
    expect(requested?.payload.prompt).toContain('0.146.0');
    expect(requested?.payload.prompt).toContain('0.150.0');
    expect(requested?.payload.prompt).toMatch(/corrupt/i);
    // Refuse is the first option, which is what makes it the default answer.
    const options = requested?.payload.options as { id: string; effect: string }[];
    expect(options[0]).toMatchObject({ id: RESUME_REFUSE_OPTION_ID, effect: 'reject' });

    expect(at('node.suspended', events)?.payload.until).toMatchObject({ kind: 'human' });
    // The typed failure the scheduler reads, and a durable line explaining it.
    expect(outcome.failure.reason).toBe('provider.unavailable');
    expect(outcome.failure.class).toBe('gate');
    expect(outcome.failure.detail).toMatchObject({ drift: ['version'] });
  });

  it('takes the same path when only the sha256 moved', async () => {
    const recorded = mockAgentBinary();
    await interruptedFirstLife(recorded);

    const current: AgentBinary = { ...recorded, sha256: 'f'.repeat(64) };
    const outcome = await resumeWith(current, join(dir, 'wire-sha.ndjson'));

    expect(outcome.status).toBe('refused');
    expect(outcome.failure.detail).toMatchObject({ drift: ['sha256'] });
    expect(at('human.requested', ledger.events())).toBeDefined();
  });
});

suite('the operator opts in explicitly', () => {
  it('records the override and resumes with session/resume', async () => {
    const recorded: AgentBinary = { ...mockAgentBinary(), version: reportedVersion('0.146.0') };
    await interruptedFirstLife(recorded);

    const current: AgentBinary = { ...mockAgentBinary(), version: reportedVersion('0.150.0') };
    const wire = join(dir, 'wire-override.ndjson');
    const outcome = await resumeWith(current, wire, {
      optionId: RESUME_OVERRIDE_OPTION_ID,
      at: '2026-08-05T10:15:00.000Z',
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.strategy).toBe('ResumeNative');
    expect(wireMethods(wire)).toContain('session/resume');

    const events = ledger.events();
    expect(at('human.responded', events)?.payload).toMatchObject({
      optionId: RESUME_OVERRIDE_OPTION_ID,
    });
    // The run's own record that a cross-version resume was permitted — what
    // the run header renders, and what a reader three hours later needs.
    const permitted = events.find(
      (event) =>
        event.kind === 'node.progress' && event.payload.phase === 'resume.cross-version-permitted',
    );
    expect(permitted?.payload.message).toContain('0.150.0');
  });

  it('refuses an option id that is not the override', async () => {
    const recorded: AgentBinary = { ...mockAgentBinary(), version: reportedVersion('0.146.0') };
    await interruptedFirstLife(recorded);

    const current: AgentBinary = { ...mockAgentBinary(), version: reportedVersion('0.150.0') };
    const outcome = await resumeWith(current, join(dir, 'wire-refuse-option.ndjson'), {
      optionId: RESUME_REFUSE_OPTION_ID,
      at: '2026-08-05T10:15:00.000Z',
    });
    expect(outcome.status).toBe('refused');
  });
});

suite('the guard does not fire on a matching binary', () => {
  it('resumes without a human gate', async () => {
    const binary = mockAgentBinary();
    await interruptedFirstLife(binary);

    const outcome = await resumeWith(binary, join(dir, 'wire-match.ndjson'));
    expect(outcome.status).toBe('completed');
    expect(at('human.requested', ledger.events())).toBeUndefined();
    expect(at('node.suspended', ledger.events())).toBeUndefined();
  });
});
