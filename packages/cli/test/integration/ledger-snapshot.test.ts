/**
 * KAR-18.7 — `deflow ledger snapshot` against a live daemon with a **non-empty
 * WAL**.
 *
 * The named red is precise: an implementation that copies `ledger.db` passes a
 * casual look at the file and loses everything still in the write-ahead log —
 * which, on a running daemon, is the most recent and most relevant part of the
 * bug report. So this spec never checkpoints, asserts that `ledger.db-wal` is
 * non-empty *before* the snapshot, and then counts the run's events in the copy
 * with a reader that has never heard of DeFlow.
 *
 * `VACUUM INTO` is what makes that work, and it is also what makes the copy a
 * single file: the target comes out in rollback-journal mode, so there is no
 * `-wal` or `-shm` beside it to lose on the way to an issue tracker.
 *
 * Verifies: EPIC-18-S47 · AC1, AC2 · test plan #1
 */
import type { Db, RunId } from '@DeFlow/core';
import { appendEvents, type EventDraft, openRead, readRange } from '@DeFlow/ledger';
import { makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { runLedgerSnapshot } from '../../src/ledger-snapshot.ts';
import { runUp, type UpResult } from '../../src/up.ts';
import { upEnv } from './support/up-fixture.ts';

const FIXTURE_DB = fileURLToPath(
  new URL('../../../../test/fixtures/runs/gate-failure-repair/ledger.db', import.meta.url),
);
const FIXTURE_RUN = 'run_20260810T090000Z_9f31ab' as RunId;
const RUN_UNDER_TEST = 'run_20260810T090000Z_aaaaaa' as RunId;
const OTHER_RUN = 'run_20260810T090000Z_bbbbbb' as RunId;
const SEEDED_EVENTS = 18;

let tmp = '';
const started: UpResult[] = [];

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  for (const result of started.splice(0)) {
    if (result.kind === 'started') await result.stop();
  }
  await removeTempDir(tmp);
});

function seedRun(db: Db, runId: RunId, epoch: number, count: number): void {
  const source = openRead(FIXTURE_DB);
  try {
    const drafts: EventDraft[] = readRange(source, FIXTURE_RUN, 0, count).events.map((event) => {
      const { seq: _seq, ...draft } = event;
      return { ...draft, runId, epoch } as EventDraft;
    });
    appendEvents(db, drafts);
  } finally {
    source.close();
  }
}

/** `sqlite3` on this machine, or null — @see the assertions that use it. */
function sqlite3(): string | null {
  try {
    const path = execFileSync('/usr/bin/env', ['sh', '-c', 'command -v sqlite3'], {
      encoding: 'utf8',
    }).trim();
    return path === '' ? null : path;
  } catch {
    return null;
  }
}

interface Booted {
  readonly dataDir: string;
  readonly result: Extract<UpResult, { kind: 'started' }>;
}

async function bootWithRuns(): Promise<Booted> {
  const dataDir = join(tmp, 'data');
  const result = await runUp({ env: upEnv({ dataDir }), port: 0, open: false, timings: false });
  started.push(result);
  if (result.kind !== 'started') throw new Error(`deflow up refused: ${result.stderr}`);

  seedRun(result.daemon.db, RUN_UNDER_TEST, result.epoch, SEEDED_EVENTS);
  seedRun(result.daemon.db, OTHER_RUN, result.epoch, SEEDED_EVENTS);
  return { dataDir, result };
}

suite('EPIC-18-S47 — one consistent, sidecar-free file (AC1, AC2)', () => {
  it('carries what is still in the WAL, and the daemon keeps serving', async () => {
    const { dataDir, result } = await bootWithRuns();

    // The premise of the whole scenario: nothing has been checkpointed, so a
    // plain file copy would be missing every event this spec is about.
    const wal = join(dataDir, 'ledger.db-wal');
    expect(existsSync(wal)).toBe(true);
    expect(statSync(wal).size).toBeGreaterThan(0);

    // …and the premise proved rather than assumed: `cp ledger.db` — the
    // implementation this story's named red is about — carries none of it. On
    // a young ledger it does not even carry the *schema*, which is a fair
    // picture of how quietly that failure mode loses data.
    const naive = join(tmp, 'naive-copy.db');
    copyFileSync(join(dataDir, 'ledger.db'), naive);
    const copied = new Database(naive);
    try {
      const tables = copied
        .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'event'")
        .get() as { c: number };
      expect(tables.c).toBe(0);
    } finally {
      copied.close();
    }

    const out = join(tmp, 'DeFlow-bug-1234.db');
    const snapshot = runLedgerSnapshot({
      env: upEnv({ dataDir }),
      runId: RUN_UNDER_TEST,
      out,
      cwd: tmp,
    });

    expect(snapshot.stderr).toBe('');
    expect(snapshot.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
    // AC1 — one file. A `-wal` left beside it is a snapshot that is only whole
    // on the machine that made it.
    expect(existsSync(`${out}-wal`)).toBe(false);
    expect(existsSync(`${out}-shm`)).toBe(false);

    // AC2, with a reader that knows nothing about DeFlow: better-sqlite3
    // opened directly on the file, not through @DeFlow/ledger.
    const plain = new Database(out, { readonly: true, fileMustExist: true });
    try {
      expect(plain.pragma('integrity_check', { simple: true })).toBe('ok');
      const rows = plain
        .prepare(
          'SELECT seq, kind, node_id, attempt FROM event WHERE run_id = ? ORDER BY seq LIMIT 50',
        )
        .all(RUN_UNDER_TEST);
      expect(rows).toHaveLength(SEEDED_EVENTS);
      // The whole ledger, which is what VACUUM INTO copies — the other run is
      // in there too, and the report says so.
      const total = plain.prepare('SELECT count(*) AS c FROM event').get() as { c: number };
      expect(total.c).toBe(SEEDED_EVENTS * 2);
    } finally {
      plain.close();
    }

    // And still one file after a reader has been through it.
    expect(existsSync(`${out}-wal`)).toBe(false);

    // The same two one-liners the report hands over, run through the actual
    // `sqlite3` binary when this machine has one.
    const cli = sqlite3();
    if (cli !== null) {
      expect(execFileSync(cli, [out, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim()).toBe(
        'ok',
      );
      const listed = execFileSync(
        cli,
        [
          out,
          `SELECT seq, kind, node_id, attempt FROM event WHERE run_id='${RUN_UNDER_TEST}' ORDER BY seq LIMIT 50;`,
        ],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n');
      expect(listed).toHaveLength(SEEDED_EVENTS);
    }

    // The daemon was never asked to stop, pause or checkpoint for this.
    const health = await fetch(`http://127.0.0.1:${result.port}/api/health`);
    expect(health.status).toBe(200);
    expect(snapshot.stdout).toContain(out);
    expect(snapshot.stdout).toContain(RUN_UNDER_TEST);
    expect(snapshot.stdout).toContain('2 runs');
  });

  it('refuses a run this ledger does not hold, and writes nothing', async () => {
    const { dataDir } = await bootWithRuns();
    const out = join(tmp, 'never-written.db');

    const snapshot = runLedgerSnapshot({
      env: upEnv({ dataDir }),
      runId: 'run_20260810T090000Z_ffffff',
      out,
      cwd: tmp,
    });

    expect(snapshot.exitCode).not.toBe(0);
    expect(snapshot.stderr).toContain('run_20260810T090000Z_ffffff');
    expect(existsSync(out)).toBe(false);
  });

  it('refuses to overwrite a file that is already there', async () => {
    const { dataDir } = await bootWithRuns();
    const out = join(tmp, 'occupied.db');
    writeFileSync(out, 'not a database\n');

    const snapshot = runLedgerSnapshot({
      env: upEnv({ dataDir }),
      runId: RUN_UNDER_TEST,
      out,
      cwd: tmp,
    });

    expect(snapshot.exitCode).not.toBe(0);
    expect(snapshot.stderr).toContain(out);
    // Untouched: a diagnostic command that clobbers the operator's file is a
    // second incident on top of the one they were reporting.
    expect(statSync(out).size).toBe('not a database\n'.length);
  });
});
