/**
 * KAR-19.6 AC5 — *"there is one abandon implementation, not two: a source guard
 * asserts that exactly one shipped module appends `run.aborted` on an operator
 * stop."*
 *
 * The temptation this exists to refuse is specific and was already taken once.
 * `POST /runs/:id/spec/abandon` ends a run at the F1.3 gate; `cancel` now ends
 * one that never reached the gate; a crashed cancel is finished by the driver.
 * Three callers, three obvious places to write `kind: 'run.aborted'` — and the
 * moment there are two, they differ: one records `human.responded` in front of
 * the abort, one records `run.cancel.requested`, and the third records nothing,
 * at which point *"a bare `run.aborted { outcome: 'failed' }` is
 * indistinguishable from a run that died of a defect"* is true again. That is
 * precisely how the three runs of 2026-08-12 were produced.
 *
 * So the rule is structural rather than remembered: the operator-stop path may
 * spell the event in exactly one module, and the module that decides — the run
 * control state machine — may not spell it at all.
 *
 * The two other appenders in the daemon are named here rather than silently
 * allowed, because each is a different fact about a run and neither is an
 * operator stopping one: intake refusing a run no provider can serve
 * (KAR-19.2), and the executor concluding a run whose nodes did not all
 * complete (KAR-06.5).
 *
 * Verifies: EPIC-19-S39 (third scenario) · KAR-19.6 AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { packageProductionSources, readText } from './support/workspace.ts';

/** The one module allowed to end a run because a person said so. */
const ABANDON_SEAM = 'packages/daemon/src/spec/gate.ts';

/** The state machine that *decides* an operator stop, and writes none of it. */
const DECIDER = 'packages/daemon/src/run-control.ts';

/** Appenders that are not operator stops. @see the module note. */
const OTHER_APPENDERS = [
  'packages/daemon/src/intake/intake.ts',
  'packages/daemon/src/exec/run-executor.ts',
];

/** An event draft for `run.aborted`, as it is written in this repository. */
const APPENDS_ABORT = /kind:\s*(done \?[^:]*:\s*)?'run\.aborted'/;

const sources = packageProductionSources();

suite('AC5 — one abandon implementation', () => {
  it('scans a tree that actually has sources in it, so an empty result means something', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.map((file) => file.path)).toContain(ABANDON_SEAM);
    expect(APPENDS_ABORT.test(readText(ABANDON_SEAM))).toBe(true);
  });

  it('spells the abort in the seam and in the two appenders that are not operator stops', () => {
    const appenders = sources
      .filter((file) => APPENDS_ABORT.test(file.text))
      .map((file) => file.path);
    expect(appenders.toSorted()).toEqual([ABANDON_SEAM, ...OTHER_APPENDERS].toSorted());
  });

  it('has the control path reaching exactly one of them', () => {
    const decider = readText(DECIDER);
    // It decides and does not write: a `run.aborted` drafted here would be a
    // second abandon implementation on the operator's own route.
    expect(APPENDS_ABORT.test(decider)).toBe(false);

    const reached = [ABANDON_SEAM, ...OTHER_APPENDERS].filter((path) =>
      decider.includes(`${path.replace('packages/daemon/src/', './')}`),
    );
    expect(reached).toEqual([ABANDON_SEAM]);
  });

  it('and that guard is not vacuous: a second appender is refused', () => {
    const invented = [
      { path: 'packages/daemon/src/made-up.ts', text: "  kind: 'run.aborted',\n" },
      ...sources,
    ];
    const appenders = invented
      .filter((file) => APPENDS_ABORT.test(file.text))
      .map((file) => file.path);
    expect(appenders).toContain('packages/daemon/src/made-up.ts');
  });
});
