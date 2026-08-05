/**
 * KAR-03.3 — the append boundary validates the envelope, and it does so
 * **before** it touches the database.
 *
 * Unit level, and the `FakeDb` is what makes the claim testable: it speaks a
 * tiny subset of SQL and throws `FakeDbUnsupportedSql` on anything else, so a
 * rejection that had already prepared the insert would fail here with the
 * wrong error rather than pass quietly. Validation at read time only would
 * leave a malformed row in an append-only table, where nothing can ever fix it.
 *
 * Verifies: EPIC-03-S9 (cursor contract, via readRange's guards) · AC6
 */

import { RunIdSchema } from '@DeFlow/core';
import { FakeDb } from '@DeFlow/testkit';
import { expect, it, describe as suite } from 'vitest';
import { appendEvents, type EventDraft, InvalidEventEnvelope, readRange } from './index.ts';

const RUN_A = RunIdSchema.parse('run_20260802T141133Z_9f2a1c');

const valid = (): EventDraft => ({
  runId: RUN_A,
  ts: 1_754_308_293_000,
  kind: 'run.created',
  v: 1,
  epoch: 1,
  payload: {},
});

const reject = (draft: unknown): InvalidEventEnvelope => {
  let thrown: unknown;
  try {
    appendEvents(new FakeDb(), [draft as EventDraft]);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(InvalidEventEnvelope);
  return thrown as InvalidEventEnvelope;
};

suite('append rejects an envelope EventEnvelopeSchema would reject (AC6)', () => {
  it('rejects one missing epoch, naming the field', () => {
    const { epoch: _dropped, ...withoutEpoch } = valid();
    const error = reject(withoutEpoch);
    expect(error.issues.join('\n')).toMatch(/epoch/);
    expect(error.index).toBe(0);
  });

  it('rejects a null epoch — the column is NOT NULL and so is the contract', () => {
    expect(reject({ ...valid(), epoch: null }).issues.join('\n')).toMatch(/epoch/);
  });

  it('rejects a missing or non-positive v', () => {
    const { v: _dropped, ...withoutV } = valid();
    expect(reject(withoutV).issues.join('\n')).toMatch(/\bv\b/);
    expect(reject({ ...valid(), v: 0 }).issues.join('\n')).toMatch(/\bv\b/);
  });

  it('rejects a runId that is not a RunId', () => {
    expect(reject({ ...valid(), runId: 'run_1' }).issues.join('\n')).toMatch(/runId/);
  });

  it('rejects an empty kind', () => {
    expect(reject({ ...valid(), kind: '' }).issues.join('\n')).toMatch(/kind/);
  });

  it('rejects an unknown field rather than dropping it', () => {
    expect(reject({ ...valid(), surprise: 1 }).issues.join('\n')).toMatch(/surprise/);
  });

  it('rejects a caller-supplied seq: the ledger assigns it, nothing else may', () => {
    expect(reject({ ...valid(), seq: 7 }).issues.join('\n')).toMatch(/seq/);
  });

  it('names the offending event by index in a batch', () => {
    let thrown: unknown;
    try {
      appendEvents(new FakeDb(), [valid(), valid(), { ...valid(), epoch: -1 }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidEventEnvelope);
    expect((thrown as InvalidEventEnvelope).index).toBe(2);
  });

  it('accepts an unknown kind: an unknown kind is data to be skipped, not a bad envelope', () => {
    // The envelope, not the payload, is what the append boundary polices — the
    // reducer's tolerance for an unknown kind (KAR-03.5) is the other half of
    // the downgrade story, and it needs the row to have been written at all.
    // The fake has no `event` table, so getting as far as a failing INSERT is
    // exactly the evidence wanted: validation passed and the write was tried.
    let thrown: unknown;
    try {
      appendEvents(new FakeDb(), [{ ...valid(), kind: 'from.the.future' }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(InvalidEventEnvelope);
  });
});

suite('readRange guards its window before it queries (AC4)', () => {
  it.each([
    ['a zero limit', 0],
    ['a negative limit', -1],
    ['a fractional limit', 2.5],
  ])('refuses %s', (_name, limit) => {
    expect(() => readRange(new FakeDb(), RUN_A, 0, limit)).toThrow(RangeError);
  });

  it.each([
    ['a negative cursor', -1],
    ['a fractional cursor', 1.5],
  ])('refuses %s', (_name, afterSeq) => {
    expect(() => readRange(new FakeDb(), RUN_A, afterSeq, 10)).toThrow(RangeError);
  });
});
