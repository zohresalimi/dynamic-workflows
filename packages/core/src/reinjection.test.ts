/**
 * KAR-09.4 — the interval counter, and the warning that stands in for it where
 * a turn boundary cannot be observed.
 *
 * Every assertion here is arithmetic over turn numbers, which is why the whole
 * mechanism is a pure reducer: the adapter decides *whether* a re-injection can
 * be delivered, this decides *when* one is due, and the two are testable apart.
 *
 * Verifies: EPIC-09-S23, EPIC-09-S24 · AC5, AC6, AC7 · test plan #8
 */
import { expect, it, describe as suite } from 'vitest';
import {
  afterReinjection,
  afterTurn,
  PIN_REINJECT_TURNS_DEFAULT,
  reinjectionPlanningWarning,
  startReinjection,
} from './reinjection.ts';

/** The turn numbers at which a re-injection came due, over `turns` turns. */
function injectionTurns(everyTurns: number, turns: number): number[] {
  let counter = startReinjection(everyTurns);
  const due: number[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    const tick = afterTurn(counter);
    counter = tick.counter;
    if (tick.reinject) due.push(turn);
  }
  return due;
}

suite('the default interval', () => {
  it('is 8, the Safe Turn Depth §4.2 starts from', () => {
    expect(PIN_REINJECT_TURNS_DEFAULT).toBe(8);
    expect(startReinjection().everyTurns).toBe(8);
  });
});

suite('injections land at the configured interval (EPIC-09-S23)', () => {
  it('comes due after turn 8 and after turn 16 of a 20-turn node', () => {
    expect(injectionTurns(PIN_REINJECT_TURNS_DEFAULT, 20)).toEqual([8, 16]);
  });

  it('honours a per-provider interval of 5 over a 12-turn node', () => {
    expect(injectionTurns(5, 12)).toEqual([5, 10]);
  });

  it('never comes due on a node shorter than the interval', () => {
    expect(injectionTurns(8, 7)).toEqual([]);
  });
});

suite('the counter resets on any verbatim re-injection (AC7, test plan #8)', () => {
  it('a compaction at turn 7 means no second injection at turn 8', () => {
    let counter = startReinjection(8);
    const due: number[] = [];

    for (let turn = 1; turn <= 20; turn += 1) {
      const tick = afterTurn(counter);
      counter = tick.counter;
      if (tick.reinject) due.push(turn);
      // The compaction path re-injects the same bytes for its own reason. AC7:
      // the interval must not fire again one turn later.
      if (turn === 7) counter = afterReinjection(counter);
    }

    expect(due).toEqual([15]);
  });

  it('resetting is idempotent — two resets in a row are one', () => {
    const counter = afterReinjection(afterReinjection(afterTurn(startReinjection(8)).counter));

    expect(counter.turnsSinceReinjection).toBe(0);
  });
});

suite('the planning warning where a turn boundary cannot be steered (AC6)', () => {
  const node = 'implement-checkout';

  it('names the node, its expected turn count and the interval it outgrew', () => {
    const warning = reinjectionPlanningWarning({
      node,
      expectedTurns: 30,
      pinReinjectTurns: 8,
      steering: false,
    });

    expect(warning).toContain(node);
    expect(warning).toContain('30');
    expect(warning).toContain('8');
    expect(warning).toContain('split');
  });

  it('is silent while the node stays inside the interval', () => {
    expect(
      reinjectionPlanningWarning({ node, expectedTurns: 8, pinReinjectTurns: 8, steering: false }),
    ).toBeNull();
  });

  it('is silent on a steering-capable adapter, which re-injects instead', () => {
    expect(
      reinjectionPlanningWarning({ node, expectedTurns: 30, pinReinjectTurns: 8, steering: true }),
    ).toBeNull();
  });

  it('treats an unadvertised capability exactly like a refused one', () => {
    // EPIC-09-S24's outline: true → interval, false → none, unknown → none.
    expect(
      reinjectionPlanningWarning({
        node,
        expectedTurns: 30,
        pinReinjectTurns: 8,
        steering: undefined,
      }),
    ).toContain(node);
  });

  it('says nothing when the plan declared no turn estimate at all', () => {
    expect(reinjectionPlanningWarning({ node, pinReinjectTurns: 8, steering: false })).toBeNull();
  });
});
