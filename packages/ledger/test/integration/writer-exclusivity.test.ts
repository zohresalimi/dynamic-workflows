/**
 * KAR-03.1 — one writer, N readers, proved across two real processes.
 *
 * The second writer is a forked `node`, not a second connection in this
 * process: the lock SQLite takes is a file lock held by the OS, and asserting
 * on it from one process would be asserting on our own bookkeeping. The 5 s
 * this spec spends waiting is the point of the assertion — the failure this
 * guards against is a writer that hangs for ever, and the only way to see the
 * difference is to wait for the timeout to expire.
 *
 * Verifies: EPIC-03-S3 (scenarios 1 and 2) · AC5
 */

import { it } from '@DeFlow/testkit';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { openRead, openWrite } from '../../src/index.ts';

const HOLDER = fileURLToPath(new URL('./support/hold-write-lock.ts', import.meta.url));
const CREATE_FIXTURE =
  'CREATE TABLE fixture (seq INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL) STRICT';

let holder: ReturnType<typeof fork> | undefined;

afterEach(() => {
  holder?.kill('SIGKILL');
  holder = undefined;
});

/** Seeds the ledger, then forks a process that takes and holds the write lock. */
async function ledgerHeldByAnotherProcess(tmp: string): Promise<string> {
  const file = join(tmp, 'ledger.db');
  const seed = openWrite(file);
  seed.exec(CREATE_FIXTURE);
  seed.prepare('INSERT INTO fixture (label) VALUES (?)').run('before');
  seed.close();

  // execArgv is cleared deliberately: the child must not inherit the test
  // runner's loader flags, only Node's own type stripping.
  const child = fork(HOLDER, [file], { execArgv: [], stdio: 'pipe' });
  holder = child;
  await new Promise<void>((resolve, reject) => {
    child.once('message', () => {
      resolve();
    });
    child.once('exit', (code) => {
      reject(new Error(`the lock holder exited early with code ${code}`));
    });
  });
  return file;
}

suite("a second process's BEGIN IMMEDIATE (EPIC-03-S3 scenario 1, AC5)", () => {
  it('fails with SQLITE_BUSY after the busy timeout rather than hanging', async ({ tmp }) => {
    const file = await ledgerHeldByAnotherProcess(tmp);

    const db = openWrite(file);
    const started = Date.now();
    try {
      let thrown: unknown;
      try {
        db.transaction(() => {
          db.prepare('INSERT INTO fixture (label) VALUES (?)').run('second-writer');
        });
      } catch (error) {
        thrown = error;
      }
      const waited = Date.now() - started;

      expect((thrown as { code?: string } | undefined)?.code).toBe('SQLITE_BUSY');
      // It waited for the timeout — a connection with no busy_timeout fails in
      // milliseconds, which is the flaky-under-load failure this guards.
      expect(waited).toBeGreaterThanOrEqual(5000);
      // …and it did not hang: the slice's own timeout is 30 s.
      expect(waited).toBeLessThan(20_000);
    } finally {
      db.close();
    }
  });
});

suite('readers are unaffected (EPIC-03-S3 scenario 2)', () => {
  it('returns the pre-transaction snapshot promptly instead of blocking', async ({ tmp }) => {
    const file = await ledgerHeldByAnotherProcess(tmp);

    const reader = openRead(file);
    try {
      const started = Date.now();
      const rows = reader
        .prepare<{ label: string }>('SELECT label FROM fixture ORDER BY seq')
        .all();
      const waited = Date.now() - started;

      expect(rows.map((row) => row.label)).toEqual(['before']);
      expect(waited).toBeLessThan(1000);
    } finally {
      reader.close();
    }
  });
});
