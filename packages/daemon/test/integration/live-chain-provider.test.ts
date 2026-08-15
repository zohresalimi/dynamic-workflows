/**
 * KAR-19.10 AC5, AC8 — the run takes the route it announced, and never a
 * different provider than the one it was admitted onto.
 *
 * Test plan #5 and #8's daemon half. The red is the shape of the 2026-08-13
 * defect one layer down from where it was noticed: admission reduced the
 * machine and announced a provider, and then `chooseProvider` reduced the
 * machine **again** on a later tick and took the first survivor. Two reductions
 * of the same input agree right up until they do not — a binary appearing on
 * `PATH` between the 201 and the first turn is enough — and when they disagree
 * the run silently spawns an agent nobody was told about, which is the whole
 * story.
 *
 * So the choice is *recorded* at admission and *obeyed* afterwards. This spec
 * stages a machine where the two reductions would visibly differ: two providers
 * resolve and both have probed rows, so a fresh reduction takes the one the
 * registry orders first, while the ledger says the run was admitted onto the
 * other. Obeying the record is the assertion.
 *
 * A file-backed ledger rather than `:memory:`, because the record surviving to
 * a later tick is the property under test.
 *
 * Verifies: EPIC-19-S65, EPIC-19-S70 · AC5, AC8
 */
import type { RunId } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import { appendEvents, openLedger, recordProviderCapabilities } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { chmodSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { chooseProvider } from '../../src/pipeline/live-chain.ts';

const RUN_ID: RunId = RunIdSchema.parse('run_20260813T120000Z_aaaaaa');

/** A file that resolves and is executable. Nothing spawns it here — this spec
 * is about which path is *selected*, not about what it says when run. */
async function executable(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** A probed capability row, so a candidate is not skipped for want of one. */
function probed(db: Parameters<typeof recordProviderCapabilities>[0], provider: string): void {
  recordProviderCapabilities(db, {
    provider: provider as never,
    version: '1.0.0',
    binaryPath: `/unused/${provider}`,
    binarySha256: 'a'.repeat(64),
    capsJson: '{}',
    probedAt: 1_755_000_000_000,
  });
}

/** The `provider.probed` row admission writes when it admits a run. */
function recordChoice(
  db: Parameters<typeof appendEvents>[0],
  choice: { provider: string; binaryPath: string; route: 'acp' | 'shim' },
): void {
  appendEvents(db, [
    {
      runId: RUN_ID,
      ts: 1_755_000_000_000,
      kind: 'provider.probed',
      v: 1,
      epoch: 1,
      payload: {
        provider: choice.provider,
        admission: 'installed',
        vendorBin: choice.provider,
        vendorPath: choice.binaryPath,
        adapterBin: choice.provider,
        adapterPath: choice.binaryPath,
        package: 'deflow',
        chosen: {
          route: choice.route,
          binaryPath: choice.binaryPath,
          routes: { acp: 'available', shim: 'available' },
          unserved: [],
        },
      },
    },
  ]);
}

suite('the run obeys the provider it was admitted onto (AC8)', () => {
  it('takes the recorded choice, not whatever a second reduction would pick', async ({ tmp }) => {
    const bin = join(tmp, 'bin');
    // Both resolve, and both have a probed row — so a fresh reduction has a
    // real choice to make, and would not make this one.
    await executable(bin, 'claude');
    await executable(bin, 'claude-agent-acp');
    const mockPath = await executable(bin, 'deflow-mock-agent');

    await mkdir(join(tmp, 'data'), { recursive: true });
    const db = openLedger(join(tmp, 'data'));
    probed(db, 'claude');
    probed(db, 'mock');

    // Without a run, selection is what KAR-19.7 AC8 ordered it to be: a real
    // adapter ahead of the bundled one.
    expect(chooseProvider(db, [bin])?.provider).toBe('claude');

    recordChoice(db, { provider: 'mock', binaryPath: mockPath, route: 'shim' });

    const chosen = chooseProvider(db, [bin], RUN_ID);
    expect(chosen?.provider).toBe('mock');
    // AC5 — and the binary is the one that was announced, not one re-resolved
    // from a `PATH` that has moved since.
    expect(chosen?.binaryPath).toBe(mockPath);
  });

  it('falls back to the ordinary reduction for a run that recorded no choice', async ({ tmp }) => {
    const bin = join(tmp, 'bin');
    await executable(bin, 'claude');
    await executable(bin, 'claude-agent-acp');

    await mkdir(join(tmp, 'data'), { recursive: true });
    const db = openLedger(join(tmp, 'data'));
    probed(db, 'claude');

    // A daemon booted without `providerRoots` records nothing, and a run
    // submitted to it has no choice to obey. That is not a reason to refuse —
    // it is the pre-KAR-19.10 behaviour, unchanged (AC3).
    expect(chooseProvider(db, [bin], RUN_ID)?.provider).toBe('claude');
  });
});
