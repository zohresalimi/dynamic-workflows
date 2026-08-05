/**
 * KAR-02.1 — the effect journal's idempotency key is `(runId, nodeId,
 * attempt, ordinal)` (docs/04-domain-model.md §1.1). `ikey()` is the only
 * legal constructor: AC4 requires that there is no way to build an
 * `IdempotencyKey` from a free string, so the schema for it is deliberately
 * not exported alongside it.
 *
 * Verifies: EPIC-02-S2 (idempotency-key half) · AC4
 */
import { expect, it, describe as suite } from 'vitest';
import { NodeIdSchema, RunIdSchema } from './ids.ts';
import { ikey, parseIkey } from './ikey.ts';
import * as core from './index.ts';

const runId = RunIdSchema.parse('run_20260802T141133Z_9f2a1c');
const nodeId = NodeIdSchema.parse('migrate-header-component');

suite('ikey / parseIkey', () => {
  it.each(Array.from({ length: 101 }, (_, ordinal) => ordinal))(
    'round-trips through parseIkey for ordinal %i',
    (ordinal) => {
      const key = ikey(runId, nodeId, 1, ordinal);
      const parsed = parseIkey(key);
      expect(parsed).toEqual({ runId, nodeId, attempt: 1, ordinal });
    },
  );

  it('encodes as runId/nodeId/attempt/ordinal', () => {
    expect(ikey(runId, nodeId, 1, 0)).toBe(
      'run_20260802T141133Z_9f2a1c/migrate-header-component/1/0',
    );
  });

  /**
   * KAR-06.3 test plan #1. `-` and `_` are both legal inside the components —
   * `_` in a RunId, `-` in a NodeId — and neither may be mistaken for the
   * separator. The golden strings are written out rather than computed so a
   * change to the separator is a diff here, not a silent re-keying of every
   * effect journal in the field.
   */
  it.each([
    ['run_20260802T141133Z_9f2a1c', 'implement', 0, 0],
    ['run_20260802T141133Z_9f2a1c', 'migrate-header-component', 1, 7],
    ['run_20991231T235959Z_ffffff', 'a', 12, 340],
  ] as const)('is the golden string for %s/%s/%i/%i', (run, node, attempt, ordinal) => {
    expect(ikey(RunIdSchema.parse(run), NodeIdSchema.parse(node), attempt, ordinal)).toBe(
      `${run}/${node}/${attempt}/${ordinal}`,
    );
  });

  it('rejects a malformed key rather than silently mis-parsing it', () => {
    expect(() => parseIkey('not-an-ikey' as never)).toThrow();
  });

  it('rejects a negative or non-integer attempt or ordinal', () => {
    expect(() => ikey(runId, nodeId, -1, 0)).toThrow();
    expect(() => ikey(runId, nodeId, 1.5, 0)).toThrow();
    expect(() => ikey(runId, nodeId, 1, -1)).toThrow();
  });

  it('is the sole way to construct an IdempotencyKey: the package exports no schema for it', () => {
    const exported = Object.keys(core);
    expect(exported).toContain('ikey');
    expect(exported).not.toContain('IdempotencyKeySchema');
  });
});
