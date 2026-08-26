/**
 * KAR-27.7 AC1, AC3, AC4 — which control the run surface offers in which state,
 * and which of them the daemon would refuse.
 *
 * Verifies: EPIC-27-S34, EPIC-27-S37 · AC1, AC3, AC4
 *
 * Every expectation about *enabled* below is computed from `planRunControl` —
 * the daemon's own decision function, which KAR-27.7 moved into `@DeFlow/core`
 * precisely so this file could call it. AC3's word is **exactly**: a control is
 * disabled exactly when the daemon would refuse it. A hand-written table of
 * "statuses that cannot pause" would be a second opinion that agrees on the day
 * it is written, which is how a control ends up enabled into a predictable 409.
 *
 * The file lives in the browser slice by placement (`src/lib/`) though it needs
 * no DOM; `test/web-suite-split.test.ts` is the guard that keeps that a decision
 * rather than an accident.
 */
import { planRunControl, RUN_STATUSES, type RunStatus } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  cooperativeStopHint,
  RUN_CONTROL_STOP_MODE,
  RUN_CONTROL_VERB,
  type RunControlAction,
  runControlOffers,
  STOP_CONFIRMATION,
} from './run-controls.ts';

const RUN = 'run_20260825T090000Z_b17e55';

const actionsFor = (status: RunStatus | null): readonly RunControlAction[] =>
  runControlOffers(status).map((offer) => offer.action);

const offerFor = (status: RunStatus | null, action: RunControlAction) =>
  runControlOffers(status).find((offer) => offer.action === action) ?? null;

/** What the daemon would answer for this action against this status. */
const daemonPlan = (status: RunStatus, action: RunControlAction) =>
  planRunControl(
    {
      verb: RUN_CONTROL_VERB[action],
      by: 'user',
      ...(action === 'stop' ? { mode: RUN_CONTROL_STOP_MODE } : {}),
    },
    { status, establishedSeq: 0 },
  );

suite('EPIC-27-S34 — the controls are offered in the states they apply to (AC1)', () => {
  it('offers pause and stop on a running run', () => {
    expect(actionsFor('running')).toEqual(['pause', 'stop']);
  });

  it('offers resume and stop on a paused run, and never pause', () => {
    expect(actionsFor('paused')).toEqual(['resume', 'stop']);
  });

  it('offers neither pause nor stop on a run that has concluded', () => {
    expect(actionsFor('completed')).toEqual([]);
    expect(actionsFor('aborted')).toEqual([]);
  });

  it('offers nothing at all when no run is open', () => {
    expect(actionsFor(null)).toEqual([]);
  });

  it('never offers pause and resume at the same time, in any state', () => {
    for (const status of RUN_STATUSES) {
      const actions = actionsFor(status);
      expect(
        actions.includes('pause') && actions.includes('resume'),
        `${status} offers both pause and resume`,
      ).toBe(false);
    }
  });
});

suite('AC3 — a control is disabled exactly when the daemon would refuse it', () => {
  it.each(RUN_STATUSES)('agrees with planRunControl on every offer for "%s"', (status) => {
    for (const offer of runControlOffers(status)) {
      const plan = daemonPlan(status, offer.action);
      expect(offer.enabled, `${status}/${offer.action}`).toBe(plan.outcome !== 'refused');
    }
  });

  it('shows the daemon’s own sentence as the reason, never a paraphrase', () => {
    const offer = offerFor('created', 'pause');
    const plan = daemonPlan('created', 'pause');

    expect(plan.outcome).toBe('refused');
    expect(offer?.enabled).toBe(false);
    expect(offer?.reason).toBe(plan.outcome === 'refused' ? plan.message : null);
  });

  it('disables pause on a run already cancelling, in the daemon’s words', () => {
    const offer = offerFor('cancelling', 'pause');
    const plan = daemonPlan('cancelling', 'pause');

    expect(offer?.enabled).toBe(false);
    expect(offer?.reason).toBe(plan.outcome === 'refused' ? plan.message : null);
  });

  it('carries no reason on a control it leaves enabled', () => {
    expect(offerFor('running', 'pause')?.reason).toBeNull();
    expect(offerFor('running', 'stop')?.reason).toBeNull();
  });

  it('names every control for assistive technology, not only on the button face', () => {
    for (const status of RUN_STATUSES) {
      for (const offer of runControlOffers(status)) {
        expect(offer.label.trim(), `${status}/${offer.action} label`).not.toBe('');
        expect(offer.name.trim().length, `${status}/${offer.action} name`).toBeGreaterThan(
          offer.label.trim().length,
        );
      }
    }
  });
});

suite('AC1 — the stop control is the forceful ladder, chosen and not defaulted', () => {
  it('maps stop onto the cancel verb with forceful stated', () => {
    expect(RUN_CONTROL_VERB.stop).toBe('cancel');
    expect(RUN_CONTROL_STOP_MODE).toBe('forceful');
  });

  it('does not lean on the endpoint’s default, which is the other ladder', () => {
    // `planRunControl` with no mode takes `cooperative`. If the surface ever
    // stopped stating the mode, this is the difference it would make.
    const defaulted = planRunControl(
      { verb: 'cancel', by: 'user' },
      { status: 'running', establishedSeq: 0 },
    );
    expect(defaulted).toMatchObject({ payload: { mode: 'cooperative' } });
    expect(daemonPlan('running', 'stop')).toMatchObject({ payload: { mode: 'forceful' } });
  });
});

suite('EPIC-27-S37 — stop asks first, and says what it costs (AC4)', () => {
  it('warns that the transcript may be truncated', () => {
    expect(STOP_CONFIRMATION.warning.toLowerCase()).toContain('truncated');
  });

  it('says the stop cannot be taken back, which is why it asks at all', () => {
    const words = `${STOP_CONFIRMATION.title} ${STOP_CONFIRMATION.warning} ${STOP_CONFIRMATION.irreversible}`;
    expect(words.toLowerCase()).toMatch(/cannot be (resumed|undone)/);
  });

  it('offers a way out of the dialog that is not the stop', () => {
    expect(STOP_CONFIRMATION.confirmLabel).not.toBe(STOP_CONFIRMATION.cancelLabel);
    expect(STOP_CONFIRMATION.cancelLabel.trim()).not.toBe('');
  });

  it('points at the cooperative ladder for an operator who wants the transcript', () => {
    const hint = cooperativeStopHint(RUN);
    expect(hint).toContain(`deflow cancel ${RUN}`);
    // The cooperative ladder is the endpoint's *default*, so the hint must not
    // name a flag: `--force` is the ladder this button already is.
    expect(hint).not.toContain('--force');
  });
});
