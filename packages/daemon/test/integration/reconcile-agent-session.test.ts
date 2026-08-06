/**
 * EPIC-06-S12 (agent rows) — the session id is journalled unbuffered, and the
 * capability matrix decides what a restart does with it
 * (KAR-06.4 AC2, AC3).
 *
 * The first suite is the one that cannot be faked. A **real** mock agent
 * process advertises a session id in its first frame and then dies mid-turn;
 * the daemon life that was driving it closes its database; a second life opens
 * the same file and looks for the id. Only a real child and a real file-backed
 * ledger can distinguish "written the instant it arrived" from "written when
 * the turn completed" — and the second is the version that loses the id in
 * exactly the crash it was needed for.
 *
 * The second suite is the five-adapter matrix at the seam where it decides
 * something: the `node.progress` row that records what a restart cost. Copilot
 * and gemini cannot resume at all, so their nodes re-send the whole context
 * packet, and a run whose bill is 40% higher than the last one should be able
 * to say why.
 *
 * Verifies: EPIC-06-S12 (agent rows) · AC2, AC3
 */
import { runAcpNode } from '@DeFlow/adapters';
import type { NodeId, ProviderId, RunId } from '@DeFlow/core';
import { NodeIdSchema, ProviderIdSchema, RunIdSchema } from '@DeFlow/core';
import { openLedger, readRange } from '@DeFlow/ledger';
import { CAPABILITY_PROFILES } from '@DeFlow/mock-agent';
import { it, TestClock } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import {
  RESUME_PHASE,
  readSessionId,
  reconcileAgent,
  resumeProgress,
  SESSION_OPENED_PHASE,
} from '../../src/index.ts';
import { openTestLedger } from './support/ledger.ts';

const RUN: RunId = RunIdSchema.parse('run_20260805T141133Z_9f2a1c');
const NODE: NodeId = NodeIdSchema.parse('implement');
const PROVIDER: ProviderId = ProviderIdSchema.parse('mock');

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);
const SCENARIO = fileURLToPath(
  new URL('../../../mock-agent/scenarios/exit-mid-turn.jsonc', import.meta.url),
);

const binary = () => ({
  path: MOCK_AGENT_BIN,
  version: '0.0.0',
  sha256: createHash('sha256').update(readFileSync(MOCK_AGENT_BIN)).digest('hex'),
});

const rowFor = (profile: keyof typeof CAPABILITY_PROFILES) => ({
  provider: PROVIDER,
  version: '0.0.0',
  binarySha256: 'a'.repeat(64),
  binaryPath: MOCK_AGENT_BIN,
  capsJson: JSON.stringify({
    protocolVersion: 1,
    agentCapabilities: CAPABILITY_PROFILES[profile],
    authMethods: [],
  }),
  probedAt: 1_754_313_093_000,
});

suite('the session id is journalled unbuffered (EPIC-06-S12, AC2)', () => {
  it('survives the crash of the agent that advertised it', async ({ tmp }) => {
    const worktree = join(tmp, 'wt');
    await mkdir(worktree, { recursive: true });

    // ── life one: a real agent, a real session id, a real death mid-turn.
    const first = openTestLedger(tmp, RUN);
    let advertised: string | null = null;
    try {
      const outcome = await runAcpNode(
        {
          runId: RUN,
          nodeId: NODE,
          attempt: 0,
          provider: PROVIDER,
          permission: 'worktree',
          worktree,
          binary: binary(),
          argv: ['--capabilities', 'claude', '--scenario', SCENARIO],
          mcpServers: [],
          prompt: 'implement the thing',
        },
        {
          clock: new TestClock(1_754_313_000_000),
          ledger: first.sink,
          captureEvidence: (evidence: string | Uint8Array) =>
            `artifact://${createHash('sha256').update(evidence).digest('hex')}` as never,
        },
      );

      // The agent really died with the turn unfinished.
      expect(outcome.status).toBe('failed');
      advertised = outcome.sessionId;
      expect(advertised).not.toBeNull();
    } finally {
      first.close();
    }

    // ── life two: a different connection to the same file, which is all that
    // survived. Nothing in memory carried over.
    const second = openLedger(tmp);
    try {
      expect(readSessionId(second, { runId: RUN, nodeId: NODE, attempt: 0 })).toBe(advertised);

      // It is its own event, appended before the turn ended — not folded into
      // a completion payload that a crash would have taken with it.
      const progress = readRange(second, RUN, 0, 500).events.filter(
        (event) => event.kind === 'node.progress',
      );
      const opened = progress.filter(
        (event) => (event.payload as { phase: string }).phase === SESSION_OPENED_PHASE,
      );
      expect(opened).toHaveLength(1);
      expect((opened[0]?.payload as { message: string }).message).toBe(
        `sessionId=${advertised ?? ''}`,
      );
      // And it landed before the failure it had to outlive.
      const failed = readRange(second, RUN, 0, 500).events.filter(
        (event) => event.kind === 'node.failed',
      );
      expect(opened[0]?.seq).toBeLessThan(failed[0]?.seq ?? Number.MAX_SAFE_INTEGER);
    } finally {
      second.close();
    }
  });

  it('is null for a node that never opened one', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(readSessionId(db, { runId: RUN, nodeId: NODE, attempt: 0 })).toBeNull();
    } finally {
      db.close();
    }
  });
});

suite('the matrix decides what the restart costs (EPIC-06-S12, AC3)', () => {
  it('resumes natively on claude and records nothing to replay', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const outcome = reconcileAgent({
        turn: 'incomplete',
        sessionId: 'sess_1',
        capabilities: rowFor('claude'),
      });
      expect(outcome).toEqual({
        verdict: 'done',
        strategy: 'ResumeNative',
        sessionId: 'sess_1',
      });

      const progress = resumeProgress({
        node: NODE,
        attempt: 0,
        strategy: outcome.strategy as 'ResumeNative',
        sessionId: outcome.sessionId,
      });
      expect(progress.phase).toBe(RESUME_PHASE);
      expect(progress.message).toContain('resumeStrategy: native');
    } finally {
      db.close();
    }
  });

  for (const profile of ['copilot', 'gemini'] as const) {
    it(`restarts clean on ${profile} and records resumeStrategy: replay`, () => {
      const outcome = reconcileAgent({
        turn: 'incomplete',
        sessionId: 'sess_1',
        capabilities: rowFor(profile),
      });
      expect(outcome).toEqual({
        verdict: 'not-started',
        strategy: 'ResumeByReplay',
        sessionId: 'sess_1',
      });

      // AC3: the cost is visible in the timeline, not inferred from a bill.
      const progress = resumeProgress({
        node: NODE,
        attempt: 0,
        strategy: outcome.strategy as 'ResumeByReplay',
        sessionId: outcome.sessionId,
      });
      expect(progress.phase).toBe(RESUME_PHASE);
      expect(progress.message).toContain('resumeStrategy: replay');
    });
  }
});
