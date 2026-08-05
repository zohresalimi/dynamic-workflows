/**
 * KAR-03.4 AC7 — a payload over ~256 KiB never reaches `event.payload`.
 *
 * The spill itself is KAR-03.9's content-addressed blob store, and
 * `appendEvents` performs it whenever it is given a `spillTo` data directory —
 * `test/integration/blob-spill.test.ts` is that half. These specs cover the
 * other half: a caller that has *not* wired the store gets the row refused
 * rather than written. `event` is append-only, so a 4 MB tool transcript
 * written into it is permanent, is read by every replay for the life of the
 * run, and is exactly the thing the control-plane / data-plane split exists to
 * keep out. Refusing is recoverable; writing is not.
 *
 * Verifies: EPIC-03-S11 (scenario 1) · AC7
 */
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  appendEvents,
  MAX_INLINE_PAYLOAD_BYTES,
  openLedger,
  PayloadTooLarge,
  readRange,
} from '../../src/index.ts';
import { draft, RUN_A } from './support/events.ts';

/** A payload whose canonical JSON encoding is `bytes` long, near enough. */
const sized = (bytes: number): Record<string, unknown> => ({ text: 'q'.repeat(bytes) });

suite('the inline payload ceiling (AC7)', () => {
  it('is 256 KiB, as one exported constant', () => {
    expect(MAX_INLINE_PAYLOAD_BYTES).toBe(256 * 1024);
  });

  it('accepts a payload just under the ceiling', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [draft({ payload: sized(MAX_INLINE_PAYLOAD_BYTES - 1024) })]);
      expect(readRange(db, RUN_A, 0, 10).events).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('refuses one over it, names KAR-03.9 as the spill path, and writes none of the batch', ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const oversize = [draft(), draft({ payload: sized(MAX_INLINE_PAYLOAD_BYTES + 1) })];
      expect(() => appendEvents(db, oversize)).toThrow(PayloadTooLarge);
      expect(() => appendEvents(db, oversize)).toThrow(/KAR-03\.9/);
      expect(readRange(db, RUN_A, 0, 10).events).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('measures the encoded payload, not the object graph', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      // 40,000 short keys: small strings, large encoding. A check on
      // JSON.stringify(payload).length would agree; a check on a field count
      // or a shallow byteLength would not.
      const wide = Object.fromEntries(
        Array.from({ length: 40_000 }, (_unused, index) => [`k${index}`, index]),
      );
      expect(() => appendEvents(db, [draft({ payload: wide })])).toThrow(PayloadTooLarge);
      expect(readRange(db, RUN_A, 0, 10).events).toEqual([]);
    } finally {
      db.close();
    }
  });
});
