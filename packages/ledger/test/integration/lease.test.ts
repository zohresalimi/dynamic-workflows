/**
 * KAR-03.7 — the single-instance lease (docs/05-durable-execution.md §12).
 *
 * The second daemon is a real forked process every time. The lease is a lock
 * the kernel holds against an open file descriptor, so a same-process test
 * would be asserting on our own bookkeeping rather than on the mechanism —
 * and the mechanism is the entire story: a pid file is trivial to write and
 * is wrong exactly when it matters, after a `SIGKILL`.
 *
 * Verifies: EPIC-03-S21 (scenarios 1 and 3) · AC1, AC2, AC3
 */
import { it } from '@DeFlow/testkit';
import { fork } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { acquireLease, DaemonAlreadyRunning, type Lease } from '../../src/index.ts';

const HOLDER = fileURLToPath(new URL('./support/hold-lease.ts', import.meta.url));

let holder: ReturnType<typeof fork> | undefined;
let mine: Lease | undefined;

afterEach(() => {
  holder?.kill('SIGKILL');
  holder = undefined;
  mine?.release();
  mine = undefined;
});

interface Held {
  readonly pid: number;
  readonly file: string;
}

/** Forks a process that takes the lease on `dataDir` and holds it. */
async function leaseHeldByAnotherProcess(dataDir: string): Promise<Held> {
  // execArgv is cleared deliberately: the child must not inherit the test
  // runner's loader flags, only Node's own type stripping.
  const child = fork(HOLDER, [dataDir], { execArgv: [], stdio: 'pipe' });
  holder = child;
  return await new Promise<Held>((resolve, reject) => {
    child.once('message', (message) => resolve(message as Held));
    child.once('exit', (code) => {
      reject(new Error(`the lease holder exited early with code ${code}`));
    });
  });
}

/** Resolves when the forked holder is gone, so its lock cannot still be held. */
function exited(child: ReturnType<typeof fork>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

suite('a second daemon against the same data directory (EPIC-03-S21 scenario 1, AC2)', () => {
  it('fails with the pid holding the lease and the data directory', async ({ tmp }) => {
    const held = await leaseHeldByAnotherProcess(tmp);

    let thrown: unknown;
    try {
      acquireLease(tmp);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DaemonAlreadyRunning);
    const error = thrown as DaemonAlreadyRunning;
    expect(error.pid).toBe(held.pid);
    expect(error.dataDir).toBe(tmp);
    expect(error.message).toBe(`DeFlowd is already running (pid ${held.pid}) — data dir ${tmp}`);
  });

  it('fails inside a second, and does not wait on the lock', async ({ tmp }) => {
    await leaseHeldByAnotherProcess(tmp);

    const started = Date.now();
    expect(() => acquireLease(tmp)).toThrow(DaemonAlreadyRunning);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('leaks no errno into the message a user reads', async ({ tmp }) => {
    await leaseHeldByAnotherProcess(tmp);

    let message = '';
    try {
      acquireLease(tmp);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toMatch(/EWOULDBLOCK|SQLITE_BUSY|EAGAIN|errno/i);
    // One sentence. A stack trace reaching the terminal is the failure this
    // whole story exists to avoid.
    expect(message.split('\n')).toHaveLength(1);
  });
});

suite('the lease is held for the process lifetime and no longer (AC1, AC3)', () => {
  it('is released by the kernel on SIGKILL, with no manual cleanup', async ({ tmp }) => {
    await leaseHeldByAnotherProcess(tmp);
    const child = holder;
    if (child === undefined) throw new Error('no holder was forked');

    // SIGKILL, not SIGTERM: no handler runs, nothing is flushed, nothing is
    // unlinked. Only the kernel closing the fd can release this.
    child.kill('SIGKILL');
    await exited(child);

    mine = acquireLease(tmp);
    expect(mine.pid).toBe(process.pid);
    // The file is still there — the point is that it is not in the way.
    expect(readdirSync(tmp)).toContain('DeFlow.lock');
  });

  it('is released by release(), so a caller can hand the data dir on', async ({ tmp }) => {
    const first = acquireLease(tmp);
    expect(() => acquireLease(tmp)).toThrow();
    first.release();

    mine = acquireLease(tmp);
    expect(mine.file).toBe(first.file);
  });

  it('writes one file into the data directory and nothing else', async ({ tmp }) => {
    mine = acquireLease(tmp);
    expect(readdirSync(tmp)).toEqual(['DeFlow.lock']);
  });
});
