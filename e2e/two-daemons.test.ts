/**
 * KAR-03.7 — the mandated two-daemons scenario, with two real DeFlowd
 * processes on one data directory.
 *
 * "It's a single-user local daemon, so locking is unnecessary" is wrong, and
 * the failure is common rather than exotic: a user runs `npx deflow up` in two
 * terminals, and it happens the first week. Everything below is asserted from
 * outside the processes — exit codes, stderr, listening sockets, the epoch
 * over HTTP — because that is all the user has.
 *
 * Verifies: EPIC-03-S21 (scenarios 1 and 3) · AC1, AC2, AC3
 */
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  bindable,
  type DaemonProcess,
  freePort,
  makeDataDir,
  removeDataDir,
  spawnDaemon,
  waitForHealth,
} from './support/daemon.ts';

let dataDir: string;
const running: DaemonProcess[] = [];

const start = async (port: number): Promise<DaemonProcess> => {
  const daemon = spawnDaemon({ dataDir, port });
  running.push(daemon);
  return daemon;
};

beforeEach(async () => {
  dataDir = await makeDataDir();
});

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  await removeDataDir(dataDir);
});

suite('two DeFlowd processes against one data directory (EPIC-03-S21 scenario 1)', () => {
  it('lets exactly one bind, and the other exits with one sentence', async () => {
    const first = await start(await freePort());
    const health = await waitForHealth(first);
    expect(health.daemonEpoch).toBe(1);

    const secondPort = await freePort();
    const startedAt = Date.now();
    const second = await start(secondPort);
    const { code } = await second.exited;
    const tookMs = Date.now() - startedAt;

    expect(code).not.toBe(0);
    expect(code).toBe(2);
    // A node process takes a moment to start at all; the 1 s in AC2 is about
    // the daemon not *waiting* on the lock, which a spawn cost cannot hide
    // past this bound.
    expect(tookMs).toBeLessThan(5_000);

    // The whole of stderr: the sentence, naming the live pid and the data dir.
    expect(second.stderr().trim()).toBe(
      `DeFlowd is already running (pid ${health.pid}) — data dir ${dataDir}`,
    );
    // No stack trace, no raw errno.
    expect(second.stderr()).not.toMatch(/\bat .*:\d+:\d+/);
    expect(second.stderr()).not.toMatch(/EWOULDBLOCK|SQLITE_BUSY|Error:/);

    // It bound nothing…
    expect(await bindable(secondPort)).toBe(true);
    // …and it did not take an epoch: the first daemon is still epoch 1.
    const after = await waitForHealth(first);
    expect(after.daemonEpoch).toBe(1);
    expect(after.pid).toBe(health.pid);
  });
});

suite('a SIGKILLed daemon releases the lease (EPIC-03-S21 scenario 3, AC3)', () => {
  it('lets the next start take it with no manual cleanup', async () => {
    const first = await start(await freePort());
    const health = await waitForHealth(first);

    // SIGKILL: no handler runs, no shutdown, nothing is unlinked. Only the
    // kernel closing the file descriptor can release this lease.
    first.child.kill('SIGKILL');
    await first.exited;

    const second = await start(await freePort());
    const resumed = await waitForHealth(second);

    expect(resumed.pid).not.toBe(health.pid);
    // A fresh daemon life, and the epoch says so.
    expect(resumed.daemonEpoch).toBe(2);
  });
});
