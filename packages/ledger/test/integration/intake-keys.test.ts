/**
 * KAR-10.1 AC6 / KAR-15.5 AC5 — the API-level `Idempotency-Key`, journalled in
 * the `effect` table.
 *
 * File-backed and reopened, because the claim is a durability one: a retried
 * `POST` arriving after a daemon restart must still find the original run *and*
 * the original response body.
 *
 * The storage claim is the one KAR-15.5 added — §11.3's *"stored in the
 * `effect` journal alongside engine-level idempotency keys, not in a separate
 * table"* — so it is asserted directly here rather than inferred from the
 * lookup working.
 *
 * Verifies: EPIC-15-S35, EPIC-15-S38 · KAR-10.1 AC6, KAR-15.5 AC5, AC8
 */
import type { RunId } from '@DeFlow/core';
import { ikey, parseIkey } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  INTAKE_NODE_ID,
  intakeIkey,
  lookupIntakeKey,
  nextOrdinal,
  openLedger,
  readEffects,
  recordIntakeKey,
} from '../../src/index.ts';

const RUN_A = 'run_20260806T090000Z_aaaaaa' as RunId;
const RUN_B = 'run_20260806T090001Z_bbbbbb' as RunId;

const HASH_A = `sha256-${'a'.repeat(64)}`;
const T0 = 1_754_470_000_000;

const bodyFor = (runId: RunId, seq: number): string =>
  `{"runId":"${runId}","seq":${seq},"status":"awaiting-spec-approval"}`;

const record = (
  db: Parameters<typeof recordIntakeKey>[0],
  key: string,
  runId: RunId,
  seq = 1,
): void =>
  recordIntakeKey(db, {
    key,
    runId,
    requestHash: HASH_A,
    response: bodyFor(runId, seq),
    at: T0,
  });

suite('lookupIntakeKey answers nothing for a key never recorded', () => {
  it('returns null', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(lookupIntakeKey(db, 'k-never-seen')).toBeNull();
    } finally {
      db.close();
    }
  });
});

suite('recordIntakeKey then lookupIntakeKey', () => {
  it('finds the run the key minted, and the response it answered with', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      record(db, 'k-1', RUN_A, 41);
      expect(lookupIntakeKey(db, 'k-1')).toEqual({
        runId: RUN_A,
        response: bodyFor(RUN_A, 41),
      });
    } finally {
      db.close();
    }
  });

  it('keeps two keys apart', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      record(db, 'k-1', RUN_A);
      record(db, 'k-2', RUN_B);
      expect(lookupIntakeKey(db, 'k-1')?.runId).toBe(RUN_A);
      expect(lookupIntakeKey(db, 'k-2')?.runId).toBe(RUN_B);
    } finally {
      db.close();
    }
  });

  it('refuses to record the same key twice', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      record(db, 'k-1', RUN_A);
      expect(() => record(db, 'k-1', RUN_B)).toThrow();
    } finally {
      db.close();
    }
  });

  it('survives the process that wrote it', async ({ tmp }) => {
    const first = openLedger(tmp);
    try {
      record(first, 'k-1', RUN_A, 7);
    } finally {
      first.close();
    }

    const second = openLedger(tmp);
    try {
      expect(lookupIntakeKey(second, 'k-1')?.response).toBe(bodyFor(RUN_A, 7));
    } finally {
      second.close();
    }
  });
});

suite('KAR-15.5 AC5 — the row lives in the effect journal', () => {
  it('writes one terminal effect row and no table of its own', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      record(db, 'k-1', RUN_A, 41);

      const tables = db
        .prepare<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((row) => row.name);
      expect(tables).not.toContain('intake_key');

      const row = db
        .prepare<{ state: string; kind: string; node_id: string; request_hash: string }>(
          'SELECT state, kind, node_id, request_hash FROM effect WHERE ikey = ?',
        )
        .get(intakeIkey('k-1'));
      // Terminal on the way in: a `pending` row would be inherited by the next
      // daemon life and reconciled as an ambiguous effect for a node that does
      // not exist.
      expect(row).toEqual({
        state: 'done',
        kind: 'intake',
        node_id: INTAKE_NODE_ID,
        request_hash: HASH_A,
      });
    } finally {
      db.close();
    }
  });

  it('is invisible to the reads that ask about a node’s attempts', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      record(db, 'k-1', RUN_A);

      expect(readEffects(db, RUN_A)).toEqual([]);
      // And it cannot skew the ordinal of any node, because no plan can name a
      // node whose id starts with a colon.
      expect(nextOrdinal(db, { runId: RUN_A, nodeId: INTAKE_NODE_ID, attempt: 0 })).toBe(1);
      expect(nextOrdinal(db, { runId: RUN_A, nodeId: 'impl-auth', attempt: 0 })).toBe(0);
    } finally {
      db.close();
    }
  });

  it('journals it under a namespace no engine idempotency key can produce (AC8)', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      // A header value shaped exactly like an engine key still lands in the
      // intake namespace, so a client cannot address an engine row.
      const engineShaped = ikey(RUN_A, 'impl-auth' as never, 0, 0);
      record(db, engineShaped, RUN_A);

      const stored = intakeIkey(engineShaped);
      expect(stored).not.toBe(engineShaped);
      expect(() => parseIkey(stored)).toThrow();
      expect(lookupIntakeKey(db, engineShaped)?.runId).toBe(RUN_A);
      // The engine's own key for that triple is untouched by the write.
      expect(
        db
          .prepare<{ n: number }>('SELECT count(*) AS n FROM effect WHERE ikey = ?')
          .get(engineShaped)?.n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});
