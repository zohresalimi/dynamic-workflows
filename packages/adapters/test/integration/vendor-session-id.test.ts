/**
 * KAR-19.8 AC3, AC4, AC6 / EPIC-19-S54, EPIC-19-S55 — the vendor's id is
 * carried **beside** DeFlow's, never instead of it; a second attempt that
 * resumes natively reaches the vendor on the session its first attempt opened;
 * and an argument the vendor refuses is permanent on the node path too.
 *
 * The trap the 2026-08-13 fix had to avoid is satisfying the vendor by changing
 * DeFlow's own identity. `run_20260813T110608Z_379fc8` sorts by time, reads in
 * a directory listing and is what NF8's *"inspectable on disk"* is mostly
 * about; rewriting it into a uuid would make every log line, every directory
 * name and every support conversation worse in order to please one flag. So the
 * ledger is read back here, out of a real file-backed SQLite database, and the
 * assertion is that every event still names the run and the node DeFlow minted
 * — with the vendor's uuid in exactly one place, the session field a transcript
 * lookup needs (`session: { id, origin: 'minted' }`).
 *
 * Verifies: EPIC-19-S54, EPIC-19-S55 · KAR-19.8 AC3, AC4, AC6
 */
import type { NodeId, ProviderId, RunId } from '@DeFlow/core';
import { ProviderIdSchema } from '@DeFlow/core';
import { CLAUDE_INVALID_SESSION_ID, it, linkFakeAgent } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import {
  isUuid,
  runShimNode,
  type ShimNodeOutcome,
  type ShimNodeRequest,
  type ShimPorts,
  shimCapabilityRow,
  vendorSessionId,
  vendorSessionIdFor,
} from '../../src/index.ts';
import { NODE_ID, openTestLedger, RUN_ID, type TestLedger } from './support/harness.ts';

const CLAUDE: ProviderId = ProviderIdSchema.parse('claude');
const NOW = 1_800_000_000_000;
const SCENARIO = fileURLToPath(
  new URL('../../../testkit/scenarios/claude-turn.json', import.meta.url),
);

const RUN: RunId = RUN_ID;
const NODE: NodeId = NODE_ID;

interface Harness {
  readonly ledger: TestLedger;
  run(overrides?: Partial<ShimNodeRequest>): Promise<ShimNodeOutcome>;
}

async function harness(tmp: string, binary: string): Promise<Harness> {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const worktree = join(tmp, 'wt');
  await mkdir(worktree, { recursive: true });
  const ledger = openTestLedger(dataDir);
  const sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');

  const request: ShimNodeRequest = {
    runId: RUN,
    nodeId: NODE,
    attempt: 0,
    provider: CLAUDE,
    permission: 'read',
    worktree,
    prompt: 'say ok',
    sessionId: vendorSessionId({ runId: RUN, nodeId: NODE, attempt: 0 }),
    binary: { path: binary, version: '2.1.220', sha256 },
    // KAR-08.5. The same choice `./exec-shim.test.ts` makes and for the same
    // reason: Seatbelt needs nothing installed, which keeps this file about the
    // session id rather than about the sandbox's own prerequisites.
    sandbox: {
      version: '2.1.220',
      platform: 'darwin',
      roots: [join(tmp, 'bin')],
      configDir: join(tmp, 'sandbox'),
    },
    env: {
      ...process.env,
      DeFlow_FAKE_DIALECT: 'claude-stream-json',
      DeFlow_FAKE_SCENARIO: SCENARIO,
      DeFlow_FAKE_SEED: '42',
      DeFlow_FAKE_NOW: String(NOW),
    },
  };

  const ports: ShimPorts = {
    clock: { now: () => NOW, setTimer: () => ({ cancel: () => {} }) },
    ledger: ledger.sink,
    captureEvidence: ledger.captureEvidence,
    capabilityRow: shimCapabilityRow({
      provider: CLAUDE,
      version: '2.1.220',
      binaryPath: binary,
      binarySha256: sha256,
      probedAt: NOW,
    }),
  };

  return {
    ledger,
    run: (overrides = {}) => runShimNode({ ...request, ...overrides }, ports),
  };
}

suite('KAR-19.8 AC3 — DeFlow’s own ids are still what the ledger names', () => {
  it('keeps the run and node ids, and files the vendor id in the session field', async ({
    tmp,
  }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary);
    const expected = vendorSessionId({ runId: RUN, nodeId: NODE, attempt: 0 });

    const outcome = await test.run();
    try {
      expect(outcome.status).toBe('completed');

      const started = test.ledger.events().find((event) => event.kind === 'node.started');
      expect(started?.payload.node).toBe(NODE);
      expect(started?.payload.session).toEqual({ id: expected, origin: 'minted' });
      expect(isUuid(expected)).toBe(true);

      // The run id is nowhere rewritten into a uuid: every event is filed under
      // the run DeFlow minted, and the serialised payloads never carry a
      // different one.
      const serialised = JSON.stringify(test.ledger.events());
      expect(serialised).not.toContain(`${expected}/`);
      expect(RUN).toMatch(/^run_\d{8}T\d{6}Z_[0-9a-f]{6}$/);
    } finally {
      test.ledger.close();
    }
  });
});

suite('KAR-19.8 AC4 — a second attempt reaches the session the first one opened', () => {
  it('derives one id for every attempt where the strategy is native', () => {
    const first = vendorSessionIdFor({
      runId: RUN,
      nodeId: NODE,
      attempt: 0,
      strategy: 'ResumeNative',
    });
    const second = vendorSessionIdFor({
      runId: RUN,
      nodeId: NODE,
      attempt: 1,
      strategy: 'ResumeNative',
    });

    expect(second).toBe(first);
  });

  it('derives a fresh one per attempt where the strategy is replay', () => {
    const first = vendorSessionIdFor({
      runId: RUN,
      nodeId: NODE,
      attempt: 0,
      strategy: 'ResumeByReplay',
    });
    const second = vendorSessionIdFor({
      runId: RUN,
      nodeId: NODE,
      attempt: 1,
      strategy: 'ResumeByReplay',
    });

    // A replay rebuilds the conversation from the ledger, which *is* a new
    // session — and two attempts sharing one transcript would make the second
    // one unfindable from the first's handle.
    expect(second).not.toBe(first);
  });

  it('puts the first attempt’s id on the second attempt’s argv', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary);
    const native = { runId: RUN, nodeId: NODE, strategy: 'ResumeNative' } as const;

    const first = await test.run({
      attempt: 0,
      sessionId: vendorSessionIdFor({ ...native, attempt: 0 }),
    });
    const second = await test.run({
      attempt: 1,
      sessionId: vendorSessionIdFor({ ...native, attempt: 1 }),
    });
    try {
      const idOf = (outcome: ShimNodeOutcome): string | undefined =>
        outcome.argv[outcome.argv.lastIndexOf('--session-id') + 1];

      expect(idOf(second)).toBe(idOf(first));
      expect(isUuid(idOf(first) ?? '')).toBe(true);
      expect(second.status).toBe('completed');
    } finally {
      test.ledger.close();
    }
  });
});

suite('KAR-19.8 AC6 — the node path classes a refused argument permanent too', () => {
  it('fails with the flag, the value and the vendor’s own words', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await harness(tmp, agent.binary);
    // The value the 2026-08-13 build put on the flag, on the node path.
    const refused = `${RUN}-implement`;

    const outcome = await test.run({ sessionId: refused });
    try {
      expect(outcome.status).toBe('failed');
      if (outcome.status !== 'failed') throw new Error('unreachable');
      expect(outcome.failure.class).toBe('permanent');
      expect(outcome.failure.detail?.flag).toBe('--session-id');
      expect(outcome.failure.detail?.value).toBe(refused);
      expect(String(outcome.failure.detail?.stderr)).toContain(CLAUDE_INVALID_SESSION_ID);
    } finally {
      test.ledger.close();
    }
  });
});
