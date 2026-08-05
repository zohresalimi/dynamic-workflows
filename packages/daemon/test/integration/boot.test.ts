/**
 * KAR-03.7 — the boot sequence, in the order the scenario names it:
 * resolve the data dir → take the lease → migrate → probe providers → bind.
 *
 * The order is the acceptance criterion, not an implementation detail. A
 * second daemon that gets as far as probing providers has already spawned
 * vendor CLIs before failing, and one that gets as far as opening the ledger
 * for writing has already contended for the write lock this whole story exists
 * to make unnecessary.
 *
 * Real ports, real tmpdirs, real SQLite files. `dev: false` throughout: Vite
 * has nothing to do with boot ordering and costs seconds to start.
 *
 * Verifies: EPIC-03-S21 (scenarios 1 and 2) · AC1, AC2, AC4
 */
import {
  acquireLease,
  DaemonAlreadyRunning,
  HOLDER_FILE,
  type Lease,
  LOCK_FILE,
} from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { BOOT_STEPS, type Booted, type BootStep, boot } from '../../src/boot.ts';

let booted: Booted | undefined;
let lease: Lease | undefined;

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
  lease?.release();
  lease = undefined;
});

/** A port nothing is listening on right now. */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** Resolves true when this process can bind `port` — i.e. nobody else did. */
function bindable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

suite('the boot sequence takes its steps in order (EPIC-03-S21 scenario 2)', () => {
  it('resolves the data dir, then leases, then migrates, then probes, then binds', async ({
    tmp,
  }) => {
    const steps: BootStep[] = [];
    booted = await boot({
      dataDir: tmp,
      port: await freePort(),
      dev: false,
      onStep: (step) => steps.push(step),
    });

    expect(steps).toEqual([...BOOT_STEPS]);
    expect(BOOT_STEPS).toEqual([
      'resolve-data-dir',
      'lease',
      'migrate',
      'probe-providers',
      'bind-port',
    ]);
  });

  it('bumps the epoch once per daemon life and reports it', async ({ tmp }) => {
    const port = await freePort();
    const first = await boot({ dataDir: tmp, port, dev: false });
    expect(first.epoch).toBe(1);
    await first.shutdown();

    booted = await boot({ dataDir: tmp, port, dev: false });
    expect(booted.epoch).toBe(2);
  });
});

suite('a second daemon stops at the lease (EPIC-03-S21 scenario 1, AC2)', () => {
  it('never opens the ledger, never probes, never binds', async ({ tmp }) => {
    // Somebody else already holds it. The data directory is otherwise empty,
    // so anything boot creates is visible.
    lease = acquireLease(tmp);
    const port = await freePort();
    const steps: BootStep[] = [];

    let thrown: unknown;
    try {
      await boot({ dataDir: tmp, port, dev: false, onStep: (step) => steps.push(step) });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DaemonAlreadyRunning);
    // It stopped at the lease: the two steps after it never ran.
    expect(steps).toEqual(['resolve-data-dir']);
    // No ledger was opened for writing — not even created.
    expect(existsSync(join(tmp, 'ledger.db'))).toBe(false);
    // The lock and the holder's pid, both put there by the lease this test
    // took itself. The refused boot added nothing at all.
    expect(readdirSync(tmp).sort()).toEqual([HOLDER_FILE, LOCK_FILE].sort());
    // And nothing is listening on the port it would have taken.
    expect(await bindable(port)).toBe(true);
  });

  it('fails inside a second', async ({ tmp }) => {
    lease = acquireLease(tmp);
    const port = await freePort();

    const started = Date.now();
    await expect(boot({ dataDir: tmp, port, dev: false })).rejects.toThrow(DaemonAlreadyRunning);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
