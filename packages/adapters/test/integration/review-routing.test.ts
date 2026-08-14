/**
 * KAR-12.2 AC6, AC7, AC8, AC9 — reviewer routing over rows a real handshake
 * produced.
 *
 * `test/pick-reviewer.test.ts` proves the rule over synthetic rows. This file
 * proves the input is real: two `deflow-mock-agent` binaries are spawned under
 * different names with different `--capabilities` profiles, their `initialize`
 * responses are persisted by the real probe into a real file-backed table, and
 * the routing decision is read back out of those rows.
 *
 * That is the whole content of AC9, and A0-9 is why it is worth a subprocess:
 * the measured capability matrix is a snapshot against five specific versions,
 * two of them published the same day they were probed. A router that consulted
 * a table would keep working here and route a review onto an incapable adapter
 * the week a vendor ships. Rewriting the persisted row — nothing else — has to
 * change the answer, so that is exactly what the last scenario does.
 *
 * No assertion below names a capability a vendor has. Every one names a
 * capability *this row* advertised.
 *
 * Verifies: EPIC-12-S11, EPIC-12-S14, EPIC-12-S15 · AC6-AC9 · test plan #5, #6
 */
import { type PermissionLevel, ProviderIdSchema } from '@DeFlow/core';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type CapabilityRow,
  NO_CAPABLE_REVIEWER,
  pickReviewer,
  probeProvider,
  type ReviewerCandidate,
} from '../../src/index.ts';
import { MOCK_AGENT_BIN, openTestLedger, type TestLedger } from './support/harness.ts';

let dir = '';
let ledger: TestLedger;
let clock: TestClock;

beforeEach(async () => {
  dir = await makeTempDir();
  await mkdir(join(dir, 'bin'), { recursive: true });
  ledger = openTestLedger(dir);
  clock = new TestClock(1_754_313_093_000);
});

afterEach(async () => {
  ledger.close();
  await removeTempDir(dir);
});

/** Spawns the mock agent under `provider`, wearing `profile`'s advertised
 * capabilities, and returns the row the probe persisted. */
async function probe(provider: string, profile: string): Promise<CapabilityRow> {
  const outcome = await probeProvider(
    {
      provider: ProviderIdSchema.parse(provider),
      binaryPath: MOCK_AGENT_BIN,
      argv: ['--capabilities', profile],
    },
    { clock, ledger: ledger.sink, capabilities: ledger.capabilities },
  );
  return outcome.row;
}

const candidateOf = (
  row: CapabilityRow,
  overrides: Partial<ReviewerCandidate> = {},
): ReviewerCandidate => ({
  provider: row.provider,
  row,
  health: 'healthy',
  structuredOutput: true,
  permissionLevels: ['read', 'worktree'] as readonly PermissionLevel[],
  maxContext: 200_000,
  ...overrides,
});

const routing = (candidates: readonly ReviewerCandidate[], extra = {}) => ({
  producer: ProviderIdSchema.parse('producer-adapter'),
  permission: 'read' as PermissionLevel,
  packetTokens: 12_000,
  requires: [],
  candidates,
  ...extra,
});

suite('two capable providers, both really probed (AC6 · test plan #5)', () => {
  it('routes the review off the producer, with no weakening', async () => {
    const producer = await probe('producer-adapter', 'mock-full');
    const other = await probe('reviewer-adapter', 'mock-full');

    const decision = pickReviewer(routing([candidateOf(producer), candidateOf(other)]));

    expect(decision.kind).toBe('routed');
    if (decision.kind !== 'routed') return;
    expect(decision.provider).toBe(other.provider);
    expect(decision.provider).not.toBe(producer.provider);
    expect(decision.weakened).toBeUndefined();
  });

  it('reads two distinct persisted rows, not one row twice', async () => {
    const producer = await probe('producer-adapter', 'mock-full');
    const other = await probe('reviewer-adapter', 'mock-full');

    // Each row came back out of the real table under its own provider name,
    // which is what makes "route to a different provider" a decision about two
    // handshakes rather than about two labels on one.
    expect(ledger.capabilities.read(producer.provider)).toHaveLength(1);
    expect(ledger.capabilities.read(other.provider)).toHaveLength(1);
    expect(producer.provider).not.toBe(other.provider);
  });
});

suite('one capable provider, and it is the producer (AC7 · test plan #6)', () => {
  it('routes onto it in a fresh session, marked weakened', async () => {
    const producer = await probe('producer-adapter', 'mock-full');

    const decision = pickReviewer(routing([candidateOf(producer)]));

    expect(decision.kind).toBe('routed');
    if (decision.kind !== 'routed') return;
    expect(decision.provider).toBe(producer.provider);
    expect(decision.weakened).toBe('same-provider');
    // Never a fork, however forkable the probed row says the adapter is.
    expect(decision.session).toBe('session/new');
  });
});

suite('the persisted row is the input, never a constant (AC9)', () => {
  const requires = ['session.resume', 'session.list'] as const;

  it('changes the routing decision when the row is rewritten, with no code change', async () => {
    const producer = await probe('producer-adapter', 'mock-full');
    const other = await probe('reviewer-adapter', 'mock-full');

    const capable = pickReviewer(
      routing([candidateOf(producer), candidateOf(other)], { requires: [...requires] }),
    );
    expect(capable.kind === 'routed' && capable.provider).toBe(other.provider);

    // The identical call. The only thing that moved is the row's own bytes,
    // rewritten to a profile that answers `false` to both questions.
    const rewritten: CapabilityRow = {
      ...other,
      capsJson: JSON.stringify({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: false, list: false } },
        authMethods: [],
      }),
    };

    const fallback = pickReviewer(
      routing([candidateOf(producer), candidateOf(rewritten)], { requires: [...requires] }),
    );

    expect(fallback.kind === 'routed' && fallback.weakened).toBe('same-provider');
    const failed =
      fallback.excluded.find((entry) => entry.provider === other.provider)?.failed ?? [];
    expect(failed.map((entry) => entry.requirement)).toEqual(['session.resume', 'session.list']);
  });
});

suite('no capable reviewer at all (AC8 · EPIC-12-S15)', () => {
  it('refuses with no-capable-reviewer and names what each row failed', async () => {
    const producer = await probe('producer-adapter', 'mock-full');
    const other = await probe('reviewer-adapter', 'mock-full');

    const decision = pickReviewer(
      routing([
        candidateOf(producer, { structuredOutput: false }),
        candidateOf(other, { health: 'unavailable' }),
      ]),
    );

    expect(decision.kind).toBe('needs-human');
    if (decision.kind !== 'needs-human') return;
    expect(decision.reason).toBe(NO_CAPABLE_REVIEWER);

    const byProvider = new Map(decision.excluded.map((entry) => [entry.provider, entry.failed]));
    expect(byProvider.get(producer.provider)?.map((entry) => entry.requirement)).toEqual([
      'structuredOutput',
    ]);
    expect(byProvider.get(other.provider)?.map((entry) => entry.requirement)).toEqual(['health']);
  });
});
