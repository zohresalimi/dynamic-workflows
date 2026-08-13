/**
 * KAR-18.1 AC6, test plan #6 — the provider detection pass `DeFlow init`
 * runs: PATH is searched for real, a found binary is probed for real (a real
 * ACP `initialize`, over a real pipe), and the result lands only in the
 * global probe cache — never anywhere `init` writes into the repository.
 *
 * The mock agent stands in for an installed adapter exactly as it does for
 * `providers-doctor-api.test.ts`: a real ACP process, spawned the way a
 * vendor CLI would be, symlinked onto a temp `PATH` under the name the
 * `claude` provider spec resolves (`claude-agent-acp`) rather than mocked.
 *
 * Verifies: EPIC-18-S6 · AC6
 */
import type { CapabilityStore } from '@DeFlow/adapters';
import { mintRunId, ProviderIdSchema } from '@DeFlow/core';
import {
  openLedger,
  readEpoch,
  readProviderCapabilities,
  recordProviderCapabilities,
} from '@DeFlow/ledger';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { sqliteLedgerSink } from '../../src/exec/ledger-sink.ts';
import { detectProviders } from '../../src/providers/detect.ts';

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

let dir = '';
let clock: TestClock;

beforeEach(async () => {
  dir = await makeTempDir();
  clock = new TestClock(1_754_900_000_000);
});

afterEach(async () => {
  await removeTempDir(dir);
});

/** The port over `db`, exactly as `providers/detect.ts` needs it. */
function capabilityStoreOf(db: ReturnType<typeof openLedger>): CapabilityStore {
  return {
    record: (row) => recordProviderCapabilities(db, row),
    read: (provider) =>
      readProviderCapabilities(db, provider).map((row) => ({
        ...row,
        provider: ProviderIdSchema.parse(row.provider),
      })),
  };
}

suite('detectProviders', () => {
  it('resolves and probes a provider found on PATH, and records only in the ledger passed in', async () => {
    const binDir = join(dir, 'bin');
    await mkdir(binDir, { recursive: true });
    await symlink(MOCK_AGENT_BIN, join(binDir, 'claude-agent-acp'));

    const dataDir = join(dir, 'data');
    await mkdir(dataDir, { recursive: true });
    const db = openLedger(dataDir);
    try {
      const entries = await detectProviders({
        roots: [binDir],
        clock,
        capabilities: capabilityStoreOf(db),
        ledger: sqliteLedgerSink({
          db,
          runId: mintRunId(clock.now(), () => 'aaaaaa'),
          epoch: readEpoch(db),
          dataDir,
        }),
        scratchDir: join(dataDir, 'scratch'),
      });

      const claude = entries.find((entry) => entry.provider === 'claude');
      expect(claude?.status).toBe('detected');
      expect(claude?.binaryPath).toBe(join(binDir, 'claude-agent-acp'));
      expect(claude?.version).toBeTruthy();

      // Every other registered provider is genuinely absent from this PATH,
      // and each is told how to get it. The bundled agent's sentence is the one
      // exception and it is the point of KAR-19.7 AC8: it ships in the same
      // tarball as the command the operator just ran, so "npm install -g" would
      // send them to fetch a package they already have. What it needs is to be
      // on PATH, which is a different action and therefore a different line.
      const others = entries.filter((entry) => entry.provider !== 'claude');
      expect(others.length).toBeGreaterThan(0);
      for (const other of others) {
        expect(other.status).toBe('not-installed');
        expect(other.detail, other.provider).toContain(
          other.provider === 'mock' ? 'ships with DeFlow' : 'npm install -g',
        );
        if (other.provider === 'mock') expect(other.detail).not.toContain('npm install -g');
      }

      // The probe cache — the ledger's own provider_capabilities table — holds
      // exactly the row this probe recorded.
      const stored = readProviderCapabilities(db, 'claude');
      expect(stored).toHaveLength(1);
      expect(stored[0]?.binaryPath).toBe(join(binDir, 'claude-agent-acp'));
    } finally {
      db.close();
    }
  });

  it('reports every provider not-installed, with an install hint, on an empty PATH — never throws', async () => {
    const dataDir = join(dir, 'data');
    await mkdir(dataDir, { recursive: true });
    const db = openLedger(dataDir);
    try {
      const entries = await detectProviders({
        roots: [],
        clock,
        capabilities: capabilityStoreOf(db),
        ledger: sqliteLedgerSink({
          db,
          runId: mintRunId(clock.now(), () => 'bbbbbb'),
          epoch: readEpoch(db),
          dataDir,
        }),
        scratchDir: join(dataDir, 'scratch'),
      });

      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.status).toBe('not-installed');
        expect(entry.binaryPath).toBeNull();
        expect(entry.detail.length).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });
});
