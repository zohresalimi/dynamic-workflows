/**
 * KAR-10.1 AC6 — `intake_key`, the map from an `Idempotency-Key` header to the
 * `RunId` it already minted.
 *
 * File-backed and reopened, because the claim is a durability one: a retried
 * POST arriving after a daemon restart must still find the original run.
 *
 * Verifies: KAR-10.1 AC6
 */
import type { RunId } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { lookupIntakeKey, openLedger, recordIntakeKey } from '../../src/index.ts';

const RUN_A = 'run_20260806T090000Z_aaaaaa' as RunId;
const RUN_B = 'run_20260806T090001Z_bbbbbb' as RunId;

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
  it('finds the run the key minted', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      recordIntakeKey(db, 'k-1', RUN_A, 1_754_470_000_000);
      expect(lookupIntakeKey(db, 'k-1')).toBe(RUN_A);
    } finally {
      db.close();
    }
  });

  it('keeps two keys apart', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      recordIntakeKey(db, 'k-1', RUN_A, 1_754_470_000_000);
      recordIntakeKey(db, 'k-2', RUN_B, 1_754_470_000_001);
      expect(lookupIntakeKey(db, 'k-1')).toBe(RUN_A);
      expect(lookupIntakeKey(db, 'k-2')).toBe(RUN_B);
    } finally {
      db.close();
    }
  });

  it('refuses to record the same key twice', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      recordIntakeKey(db, 'k-1', RUN_A, 1_754_470_000_000);
      expect(() => recordIntakeKey(db, 'k-1', RUN_B, 1_754_470_000_001)).toThrow();
    } finally {
      db.close();
    }
  });

  it('survives the process that wrote it', async ({ tmp }) => {
    const first = openLedger(tmp);
    try {
      recordIntakeKey(first, 'k-1', RUN_A, 1_754_470_000_000);
    } finally {
      first.close();
    }

    const second = openLedger(tmp);
    try {
      expect(lookupIntakeKey(second, 'k-1')).toBe(RUN_A);
    } finally {
      second.close();
    }
  });
});
