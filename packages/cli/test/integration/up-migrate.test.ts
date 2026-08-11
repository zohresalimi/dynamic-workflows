/**
 * KAR-18.2 AC5 — step 2 of the boot sequence: the cheap safety net, and the
 * refusal to serve a half-migrated ledger.
 *
 * File-backed SQLite throughout, and that is a rule rather than a habit
 * (docs/14-testing-strategy.md §3.4): `VACUUM INTO` writes a *file*, and a
 * migration that fails and is then re-run against a reopened database is a
 * sequence `:memory:` cannot express at all.
 *
 * The failing migration is injected through `runUp`'s `migrations` port. It has
 * to be: shipped migrations are append-only and are never edited once released
 * (docs/05-durable-execution.md §7.2), so the only honest way to exercise the
 * failure path is to hand the runner a migration that fails.
 *
 * Verifies: EPIC-18-S11, EPIC-18-S12 · AC5
 */
import { MIGRATIONS, type Migration, openLedger } from '@DeFlow/ledger';
import { makeTempDir, openTestDatabase, removeTempDir } from '@DeFlow/testkit';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { runUp, type UpResult } from '../../src/up.ts';
import { upEnv } from './support/up-fixture.ts';

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

/** The `user_version` a freshly-migrated ledger sits at. */
const SHIPPED = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.id), 0);
const NEXT = SHIPPED + 1;

/** Creates the ledger at the shipped schema version, then lets go of it. */
function seedLedger(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  openLedger(dataDir).close();
}

function userVersion(dataDir: string): number {
  const db = openTestDatabase(join(dataDir, 'ledger.db'));
  try {
    return db.pragma('user_version', { simple: true }) as number;
  } finally {
    db.close();
  }
}

function tableExists(dataDir: string, name: string): boolean {
  const db = openTestDatabase(join(dataDir, 'ledger.db'));
  try {
    return (
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
      undefined
    );
  } finally {
    db.close();
  }
}

const addsATable: Migration = {
  id: NEXT,
  name: `${String(NEXT).padStart(4, '0')}_spec-only-extra`,
  up: (db) => db.exec('CREATE TABLE spec_only_extra (id INTEGER PRIMARY KEY)'),
};

const failsHalfway: Migration = {
  id: NEXT,
  name: `${String(NEXT).padStart(4, '0')}_spec-only-failing`,
  up: (db) => {
    db.exec('CREATE TABLE half_applied (id INTEGER PRIMARY KEY)');
    throw new Error('deliberate failure, half a migration in');
  },
};

suite('a backup exists before user_version moves (EPIC-18-S11, AC5)', () => {
  it('leaves a verifiable pre-migrate-<version>.db and no sidecars beside it', async () => {
    const dataDir = join(tmp, 'data');
    seedLedger(dataDir);
    expect(userVersion(dataDir)).toBe(SHIPPED);

    const result = await runUp({
      env: upEnv({ dataDir }),
      port: 0,
      open: false,
      timings: false,
      migrations: [...MIGRATIONS, addsATable],
    });
    started.push(result);

    expect(result.kind).toBe('started');
    const backup = join(dataDir, `pre-migrate-${SHIPPED}.db`);
    expect(existsSync(backup)).toBe(true);

    // The backup is a whole database, not a torn page: VACUUM INTO produces a
    // compacted copy with the transaction already applied, which is why it has
    // no -wal or -shm beside it to be restored along with.
    const copy = openTestDatabase(backup);
    try {
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(copy.pragma('user_version', { simple: true })).toBe(SHIPPED);
    } finally {
      copy.close();
    }
    expect(existsSync(`${backup}-wal`)).toBe(false);
    expect(existsSync(`${backup}-shm`)).toBe(false);

    // And the migration it protected actually ran.
    expect(userVersion(dataDir)).toBe(NEXT);
  });
});

suite('a failed migration rolls back and nothing is served (EPIC-18-S12, AC5)', () => {
  it('leaves the ledger where it was, binds no port, and names the migration', async () => {
    const dataDir = join(tmp, 'data');
    seedLedger(dataDir);

    const refused = await runUp({
      env: upEnv({ dataDir }),
      port: 0,
      open: false,
      timings: false,
      migrations: [...MIGRATIONS, failsHalfway],
    });
    started.push(refused);

    expect(refused.kind).toBe('refused');
    if (refused.kind !== 'refused') return;

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain(failsHalfway.name);
    // One sentence for the operator, not a stack trace.
    expect(refused.stderr).not.toMatch(/\bat .*:\d+:\d+/);

    // SQLite's DDL is transactional, so the half-applied table went with it.
    expect(userVersion(dataDir)).toBe(SHIPPED);
    expect(tableExists(dataDir, 'half_applied')).toBe(false);
    expect(existsSync(join(dataDir, `pre-migrate-${SHIPPED}.db`))).toBe(true);

    // Nothing was served: no daemon file, and therefore no port for a UI to
    // reach a half-migrated ledger on.
    expect(existsSync(join(dataDir, 'daemon.json'))).toBe(false);

    // And the fix is a boot away: same data directory, working migration.
    const fixed = await runUp({
      env: upEnv({ dataDir }),
      port: 0,
      open: false,
      timings: false,
      migrations: [...MIGRATIONS, addsATable],
    });
    started.push(fixed);

    expect(fixed.kind).toBe('started');
    expect(userVersion(dataDir)).toBe(NEXT);
    expect(tableExists(dataDir, 'spec_only_extra')).toBe(true);
  });
});
