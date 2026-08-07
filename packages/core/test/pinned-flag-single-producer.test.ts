/**
 * KAR-09.3 AC1 — "no other segment kind may set the flag, enforced by a
 * type-level constraint on the builder rather than a review convention."
 *
 * The type-level half lives in `pinned-set.ts`: `contextSegment` has no
 * `pinned` parameter and its `kind` cannot name a `pinned.*` kind, so the
 * invalid combination is unrepresentable. This is the half a type cannot
 * reach — a module somewhere that assembles a `Segment` object literal by hand
 * and writes `pinned: true` into it.
 *
 * Worth a structural test for the same reason the scheduler's is: the
 * violation is cheap to write, invisible at review, and expensive only much
 * later. A sixth pinned content type is never compacted, always rendered
 * first, and hash-checked before every dispatch — and nothing about it looks
 * wrong until a packet stops fitting or an unexpected string turns up in a
 * prompt.
 *
 * Verifies: EPIC-09-S14 (first scenario), EPIC-09-S15 (second scenario) · AC1
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkPinnedFlagHasOneProducer,
  describe as render,
  type SourceFile,
} from '../../../test/support/guards.ts';
import { allWorkspaceSources } from '../../../test/support/workspace.ts';

/** The one module allowed to write the flag. */
const PRODUCER = ['packages/core/src/pinned-set.ts'];

const sources = (): SourceFile[] => allWorkspaceSources();

suite('the pinned flag has one producer (AC1)', () => {
  it('scans a workspace that really contains the producer', () => {
    expect(sources().map((file) => file.path)).toContain(PRODUCER[0]);
  });

  it('finds no other module setting pinned: true', () => {
    expect(render(checkPinnedFlagHasOneProducer(sources(), PRODUCER))).toBe('');
  });

  it('and that is a real result, not an empty scan', () => {
    const mutated = sources().map((file) => ({
      ...file,
      text: `${file.text}\nconst smuggled = { kind: 'fact', pinned: true };\n`,
    }));

    expect(checkPinnedFlagHasOneProducer(mutated, PRODUCER).length).toBe(mutated.length - 1);
  });
});
