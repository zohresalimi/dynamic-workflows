/**
 * KAR-12.2 AC2, AC3 — the scheduling precondition, as a pure function.
 *
 * The two halves are separate refusals because they fail for different reasons
 * and an operator has to be able to tell them apart: a review that resolved to
 * the producer's session id is a *plumbing* mistake, and a review whose resume
 * is a fork is a *design* one — somebody decided the reviewer needed "context".
 *
 * The third row of the resume table is the one that keeps the mechanism from
 * being fixed the wrong way. Forking is legitimate for continuation work
 * (docs/10-verification-gates.md §3.2), so a global ban would trade one broken
 * guarantee for a broken feature; the refusal is scoped to review nodes and
 * `reviewIsIndependent` is what says so.
 *
 * Verifies: EPIC-12-S12, EPIC-12-S13 · AC2, AC3 · test plan #1, #2
 */
import { expect, it, describe as suite } from 'vitest';
import type { NodeId } from './ids.ts';
import {
  assertIndependentReview,
  isReviewRefusal,
  REVIEW_REFUSAL_CODES,
  type ResumeRequest,
  SchedulingRefused,
} from './independent-review.ts';

const REVIEW = 'review-1' as NodeId;
const PRODUCER = 'implement-1' as NodeId;
const OTHER = 'implement-2' as NodeId;

const PRODUCER_SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const REVIEW_SESSION = '9a7bfe10-3a0c-4e11-8c2f-1b7f2d5a44e8';

const producer = (sessionId: string | null = PRODUCER_SESSION) => ({
  id: PRODUCER,
  resolvedSessionId: sessionId,
});

const review = (overrides: { sessionId?: string; resume?: ResumeRequest } = {}) => ({
  id: REVIEW,
  resolvedSessionId: overrides.sessionId ?? REVIEW_SESSION,
  ...(overrides.resume === undefined ? {} : { resume: overrides.resume }),
});

suite('a review resolves to its own session (AC2 · test plan #1)', () => {
  it('returns void when the two resolved session ids differ', () => {
    expect(() => {
      assertIndependentReview(review(), [producer()]);
    }).not.toThrow();
  });

  it('refuses REVIEW_SESSION_NOT_INDEPENDENT when they are equal', () => {
    let thrown: unknown;
    try {
      assertIndependentReview(review({ sessionId: PRODUCER_SESSION }), [producer()]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SchedulingRefused);
    const refusal = thrown as SchedulingRefused;
    expect(refusal.code).toBe('REVIEW_SESSION_NOT_INDEPENDENT');
    expect(refusal.node).toBe(REVIEW);
    expect(refusal.producer).toBe(PRODUCER);
  });

  it('refuses on any producer in the list, not only the first', () => {
    const refusal = (): void => {
      assertIndependentReview(review({ sessionId: PRODUCER_SESSION }), [
        { id: OTHER, resolvedSessionId: 'ec6c2f3e-1a0b-4e6e-9a9b-2f1c5c9d0a77' },
        producer(),
      ]);
    };
    expect(refusal).toThrow(SchedulingRefused);
  });

  it('admits against a producer that held no session at all', () => {
    // A `tool` node named in `notSessionOf` has no session to collide with, and
    // refusing on a `null` there would make an ordinary plan unschedulable.
    expect(() => {
      assertIndependentReview(review(), [producer(null)]);
    }).not.toThrow();
  });

  it('refuses to answer at all when the review has no resolved session id', () => {
    // Fail closed: the check runs at the last point before the reviewer sees
    // input, and "we could not tell" must not read as "it was independent".
    expect(() => {
      assertIndependentReview({ id: REVIEW, resolvedSessionId: '' }, [producer()]);
    }).toThrow(SchedulingRefused);
  });
});

suite('the resume shape decides admission (AC3 · test plan #2)', () => {
  const table: readonly {
    readonly resume: ResumeRequest;
    readonly outcome: 'REVIEW_INHERITS_PRODUCER_CONTEXT' | 'admitted';
  }[] = [
    { resume: { kind: 'fork' }, outcome: 'REVIEW_INHERITS_PRODUCER_CONTEXT' },
    { resume: { of: PRODUCER }, outcome: 'REVIEW_INHERITS_PRODUCER_CONTEXT' },
    { resume: { kind: 'fork', of: PRODUCER }, outcome: 'REVIEW_INHERITS_PRODUCER_CONTEXT' },
    { resume: { kind: 'native-if-available' }, outcome: 'admitted' },
    { resume: 'always-replay', outcome: 'admitted' },
    { resume: 'native-if-available', outcome: 'admitted' },
    { resume: { of: OTHER }, outcome: 'admitted' },
  ];

  for (const { resume, outcome } of table) {
    it(`${JSON.stringify(resume)} → ${outcome}`, () => {
      const run = (): void => {
        assertIndependentReview(review({ resume }), [producer()]);
      };
      if (outcome === 'admitted') {
        expect(run).not.toThrow();
        return;
      }
      let thrown: unknown;
      try {
        run();
      } catch (error) {
        thrown = error;
      }
      expect((thrown as SchedulingRefused).code).toBe('REVIEW_INHERITS_PRODUCER_CONTEXT');
      expect((thrown as SchedulingRefused).node).toBe(REVIEW);
    });
  }

  it('refuses a fork even when the session ids already differ', () => {
    // The two checks are independent: a fresh session id says nothing about
    // whether the reasoning behind it was inherited.
    expect(() => {
      assertIndependentReview(review({ resume: { kind: 'fork' } }), [producer()]);
    }).toThrow(SchedulingRefused);
  });
});

suite('the refusal is a value the ledger can carry', () => {
  it('names exactly the two codes docs/10-verification-gates.md §3.2 defines', () => {
    expect([...REVIEW_REFUSAL_CODES]).toEqual([
      'REVIEW_SESSION_NOT_INDEPENDENT',
      'REVIEW_INHERITS_PRODUCER_CONTEXT',
    ]);
  });

  it('is gate-classed, because retrying an impossible schedule only loops', () => {
    try {
      assertIndependentReview(review({ resume: { kind: 'fork' } }), [producer()]);
      expect.unreachable('the fork should have been refused');
    } catch (error) {
      expect(isReviewRefusal(error)).toBe(true);
      // `gate` suspends the run for a human (./retry.ts) instead of retrying,
      // which is EPIC-12-S12's second scenario exactly.
      expect((error as SchedulingRefused).failureClass).toBe('gate');
    }
  });

  it('says which producer it collided with, in the message', () => {
    try {
      assertIndependentReview(review({ sessionId: PRODUCER_SESSION }), [producer()]);
      expect.unreachable('the shared session should have been refused');
    } catch (error) {
      expect((error as Error).message).toContain(PRODUCER);
      expect((error as Error).message).toContain(REVIEW);
    }
  });

  it('is not a refusal for anything else that was thrown', () => {
    expect(isReviewRefusal(new Error('unrelated'))).toBe(false);
  });
});
