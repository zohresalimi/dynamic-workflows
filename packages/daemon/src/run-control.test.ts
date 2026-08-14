/**
 * KAR-15.5 test plan #1, #2 — the state machine behind `pause`, `resume` and
 * `cancel`, as a pure decision.
 *
 * Unit, and pure, because every claim here is about a *transition*: what a
 * second pause does, which states genuinely cannot pause, and what an
 * `ifLastSeq` that has been overtaken means. None of that needs a ledger — the
 * ledger reads that produce a `RunSituation` are the edge's, and they are
 * exercised over a real file in
 * `../test/integration/run-control-api.test.ts`.
 *
 * The one property worth stating up front, because it is what makes the whole
 * surface safe to double-click: a repeat is **`unchanged`**, carrying the seq
 * of the event that already established the state, and never a second append
 * and never an error (docs/11-api-and-realtime.md §11.1).
 *
 * Verifies: EPIC-15-S33, EPIC-15-S34, EPIC-15-S37 · AC1, AC2, AC3, AC6
 */
import type { RunStatus } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { planRunControl, type RunSituation } from './run-control.ts';

/** A run in `status`, put there at `establishedSeq`, with nothing stale. */
const at = (status: RunStatus, establishedSeq = 900, extra: Partial<RunSituation> = {}) =>
  ({ status, establishedSeq, head: 900, ...extra }) satisfies RunSituation;

suite('EPIC-15-S33 — the three control verbs (AC1)', () => {
  it('pauses a running run by appending run.paused', () => {
    const plan = planRunControl({ verb: 'pause', by: 'user' }, at('running'));
    expect(plan).toEqual({ outcome: 'append', kind: 'run.paused', payload: { by: 'user' } });
  });

  it('carries the operator’s reason on the pause when they gave one', () => {
    const plan = planRunControl(
      { verb: 'pause', by: 'user', reason: 'stepping away' },
      at('running'),
    );
    expect(plan).toEqual({
      outcome: 'append',
      kind: 'run.paused',
      payload: { by: 'user', reason: 'stepping away' },
    });
  });

  it('resumes a paused run by appending run.resumed', () => {
    const plan = planRunControl({ verb: 'resume', by: 'user' }, at('paused'));
    expect(plan).toEqual({ outcome: 'append', kind: 'run.resumed', payload: { by: 'user' } });
  });

  it('resumes a run that is only waiting on a human, which is what clears the ask', () => {
    // KAR-14.2 AC4: `run.resumed` clears `needsHuman` as well as the pause, so
    // a ceiling the operator raised does not leave the run halted for ever.
    expect(planRunControl({ verb: 'resume', by: 'user' }, at('needs-human'))).toMatchObject({
      outcome: 'append',
      kind: 'run.resumed',
    });
  });

  it('records the cancel mode in the event, because the ladder is a scheduling decision', () => {
    for (const mode of ['cooperative', 'forceful'] as const) {
      expect(planRunControl({ verb: 'cancel', by: 'user', mode }, at('running'))).toEqual({
        outcome: 'append',
        kind: 'run.cancel.requested',
        payload: { mode },
      });
    }
  });
});

suite('EPIC-15-S33 — repeating a write is a no-op, not an error (AC2)', () => {
  it('answers a second pause with the seq of the run.paused already in the log', () => {
    expect(planRunControl({ verb: 'pause', by: 'user' }, at('paused', 10_891))).toEqual({
      outcome: 'unchanged',
      seq: 10_891,
    });
  });

  it('answers a resume of a running run the same way', () => {
    expect(planRunControl({ verb: 'resume', by: 'user' }, at('running', 10_433))).toEqual({
      outcome: 'unchanged',
      seq: 10_433,
    });
  });

  it('answers a repeated cancel with the seq of the request already in flight', () => {
    const situation = at('cancelling', 0, {
      cancel: { mode: 'cooperative', requestedSeq: 10_920 },
    });
    expect(planRunControl({ verb: 'cancel', by: 'user', mode: 'cooperative' }, situation)).toEqual({
      outcome: 'unchanged',
      seq: 10_920,
    });
  });

  it('escalates a cooperative cancel to a forceful one rather than swallowing it', () => {
    // reduce()'s `run.cancel.requested` replaces the mode on purpose: an
    // escalation is the operator saying "stop asking nicely", and a sticky
    // first answer would ignore them.
    const situation = at('cancelling', 0, {
      cancel: { mode: 'cooperative', requestedSeq: 10_920 },
    });
    expect(planRunControl({ verb: 'cancel', by: 'user', mode: 'forceful' }, situation)).toEqual({
      outcome: 'append',
      kind: 'run.cancel.requested',
      payload: { mode: 'forceful' },
    });
  });
});

suite('EPIC-15-S33 — a run that genuinely cannot pause (AC2)', () => {
  it('refuses to pause a completed run with 409 run_not_pausable', () => {
    const plan = planRunControl({ verb: 'pause', by: 'user' }, at('completed'));
    expect(plan).toMatchObject({ outcome: 'refused', http: 409, code: 'run_not_pausable' });
  });

  it('refuses to pause or resume an aborted run', () => {
    for (const verb of ['pause', 'resume'] as const) {
      expect(planRunControl({ verb, by: 'user' }, at('aborted'))).toMatchObject({
        outcome: 'refused',
        code: 'run_not_pausable',
      });
    }
  });

  it('refuses to pause a run that is already cancelling', () => {
    expect(planRunControl({ verb: 'pause', by: 'user' }, at('cancelling'))).toMatchObject({
      outcome: 'refused',
      code: 'run_not_pausable',
    });
  });

  /**
   * > **Amended 2026-08-12 by KAR-19.6 AC6.** A cancel of a run that has
   * > already ended is a *repeat*, not a conflict: the operator asked for a
   * > state the run is already in, and KAR-15.5 AC2's own rule for that is
   * > `200` with the seq already in the log. `pause` and `resume` keep the
   * > `409` — neither is a state an ended run is in.
   */
  it('answers a cancel of a run that has already ended with the seq that ended it', () => {
    expect(
      planRunControl({ verb: 'cancel', by: 'user', mode: 'forceful' }, at('completed', 8_113)),
    ).toEqual({ outcome: 'unchanged', seq: 8_113 });
    expect(
      planRunControl({ verb: 'cancel', by: 'user', mode: 'cooperative' }, at('aborted', 8_114)),
    ).toEqual({ outcome: 'unchanged', seq: 8_114 });
  });

  it('says which state refused, so the message is actionable', () => {
    const plan = planRunControl({ verb: 'pause', by: 'user' }, at('completed'));
    expect(plan.outcome === 'refused' && plan.message).toContain('completed');
  });

  it('answers a run the ledger does not hold with 404 run_not_found', () => {
    expect(
      planRunControl({ verb: 'pause', by: 'user' }, at('running', 0, { status: null })),
    ).toMatchObject({ outcome: 'refused', http: 404, code: 'run_not_found' });
  });
});

suite('EPIC-15-S37 — acting before the spec is approved (AC6)', () => {
  /**
   * > **Amended 2026-08-12 by KAR-19.6 AC3.** `cancel` left this loop. The
   * > blanket rule was right for the two verbs that admit work and wrong for
   * > the one that ends it: with `abandonRun` refusing when no gate is open, a
   * > run accepted and never framed could be stopped by neither route.
   */
  it('refuses pause and resume with 422 spec_not_approved while the F1.3 gate is open', () => {
    for (const verb of ['pause', 'resume'] as const) {
      expect(planRunControl({ verb, by: 'user' }, at('awaiting-spec-approval'))).toMatchObject({
        outcome: 'refused',
        http: 422,
        code: 'spec_not_approved',
      });
    }
  });

  it('refuses a run that intake created and framing has not reached yet', () => {
    expect(planRunControl({ verb: 'pause', by: 'user' }, at('created'))).toMatchObject({
      outcome: 'refused',
      code: 'spec_not_approved',
    });
  });

  it('admits the verbs once the spec is approved', () => {
    expect(planRunControl({ verb: 'pause', by: 'user' }, at('spec-approved'))).toMatchObject({
      outcome: 'append',
      kind: 'run.paused',
    });
  });
});

/**
 * KAR-19.6 test plan #1 — the whole `RunStatus` × verb table, because the
 * change being made here is an **ordering** change and a table is the only way
 * to say that nothing else moved with it.
 *
 * Verifies: EPIC-19-S39 (second scenario), EPIC-19-S41 · KAR-19.6 AC3, AC6
 */
suite('EPIC-19-S39 — cancel below the verb split (KAR-19.6 AC3)', () => {
  const UNAPPROVED: readonly RunStatus[] = ['created', 'awaiting-spec-approval'];

  it('plans a termination for a run that never started, rather than refusing it', () => {
    for (const status of UNAPPROVED) {
      expect(planRunControl({ verb: 'cancel', by: 'user' }, at(status))).toEqual({
        outcome: 'terminate',
        mode: 'cooperative',
      });
    }
  });

  it('carries the mode the operator asked for onto the termination', () => {
    expect(planRunControl({ verb: 'cancel', by: 'user', mode: 'forceful' }, at('created'))).toEqual(
      { outcome: 'terminate', mode: 'forceful' },
    );
  });

  it('leaves pause and resume refusing exactly where they refused before', () => {
    for (const status of UNAPPROVED) {
      for (const verb of ['pause', 'resume'] as const) {
        expect(planRunControl({ verb, by: 'user' }, at(status))).toMatchObject({
          outcome: 'refused',
          http: 422,
          code: 'spec_not_approved',
          runStatus: status,
        });
      }
    }
  });

  it('keeps 404 run_not_found ahead of the verb split, for every verb', () => {
    for (const verb of ['pause', 'resume', 'cancel'] as const) {
      expect(
        planRunControl({ verb, by: 'user' }, at('created', 0, { status: null })),
      ).toMatchObject({ outcome: 'refused', http: 404, code: 'run_not_found' });
    }
  });

  it('still refuses a cancel written against a cursor the run has moved past', () => {
    // A widened `cancel` must not become a widened *anything*: a stale panel is
    // told it is stale, on the verb that ends a run as much as on the two that
    // do not.
    expect(
      planRunControl({ verb: 'cancel', by: 'user' }, at('created', 900, { movedAt: 10_920 })),
    ).toMatchObject({ outcome: 'refused', http: 409, code: 'stale_cursor' });
  });

  it('plans an ordinary cancel append for every status that is admitting work', () => {
    for (const status of ['spec-approved', 'running', 'paused', 'needs-human'] as const) {
      expect(planRunControl({ verb: 'cancel', by: 'user' }, at(status))).toEqual({
        outcome: 'append',
        kind: 'run.cancel.requested',
        payload: { mode: 'cooperative' },
      });
    }
  });
});

suite('EPIC-15-S34 — ifLastSeq over a decision surface that moves (AC3)', () => {
  it('refuses with 409 stale_cursor when the surface moved after the cursor', () => {
    const plan = planRunControl(
      { verb: 'pause', by: 'user' },
      at('running', 900, { movedAt: 10_920, head: 10_920 }),
    );
    expect(plan).toMatchObject({ outcome: 'refused', http: 409, code: 'stale_cursor' });
    expect(plan.outcome === 'refused' && plan.movedAt).toBe(10_920);
  });

  it('succeeds when the head advanced harmlessly, which is what keeps it usable', () => {
    // `movedAt: null` is the edge's answer for a head that moved only by
    // progress frames. A 409 on every one of those would train the operator to
    // retry blindly, which is the same failure as an always-on dialog.
    expect(
      planRunControl({ verb: 'pause', by: 'user' }, at('running', 900, { movedAt: null })),
    ).toMatchObject({ outcome: 'append', kind: 'run.paused' });
  });

  it('asks about staleness before the state machine, so a stale panel is told so first', () => {
    // The run also happens to be paused already. The operator's view is what is
    // wrong, and telling them "nothing changed" would hide it.
    expect(
      planRunControl({ verb: 'pause', by: 'user' }, at('paused', 900, { movedAt: 10_920 })),
    ).toMatchObject({ outcome: 'refused', code: 'stale_cursor' });
  });

  it('refuses a stale cursor after the spec gate, so the more basic answer wins', () => {
    expect(
      planRunControl(
        { verb: 'pause', by: 'user' },
        at('awaiting-spec-approval', 900, { movedAt: 10_920 }),
      ),
    ).toMatchObject({ code: 'spec_not_approved' });
  });
});
