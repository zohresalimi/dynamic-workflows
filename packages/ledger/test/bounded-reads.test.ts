/**
 * KAR-03.4 — every read over `event` or `io_chunk` in this package is bounded.
 *
 * This is a guard rather than a review note because better-sqlite3 is **fully
 * synchronous**: one unbounded scan on the write connection does not make one
 * endpoint slow, it stops the event loop, and every in-flight SSE stream and
 * HTTP request waits behind it. The failure looks like "the UI froze", which is
 * the hardest possible symptom to trace back to a missing `LIMIT`.
 *
 * Verifies: EPIC-03-S13 (scenario 3) · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { checkLedgerReadsAreBounded, describe as render } from '../../../test/support/guards.ts';
import { productionSources } from '../../../test/support/workspace.ts';

const sources = productionSources('packages/ledger');

suite('reads on the write connection are bounded (AC5, EPIC-03-S13)', () => {
  it('has no SELECT over event or io_chunk without a LIMIT', () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(render(checkLedgerReadsAreBounded(sources))).toBe('');
  });

  it('and that is a real result, not an empty scan', () => {
    // Strip the bound off every statement and the guard must object; a guard
    // that never matched anything would pass the suite above for ever.
    const mutated = sources.map((file) => ({
      ...file,
      text: file.text.replaceAll(/\bLIMIT\b/g, 'ORDER BY seq --'),
    }));
    expect(checkLedgerReadsAreBounded(mutated).length).toBeGreaterThan(0);
  });
});
