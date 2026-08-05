/**
 * KAR-06.6 AC1 / EPIC-06-S21 scenario 3 — the orchestrator has exactly one
 * timer, and it is a sleep hint rather than a wait.
 *
 * The scheduling half of DeFlow is @DeFlow/core (`decide()`, pure, already
 * forbidden a timer by ../../core/test/purity.test.ts) plus this package's
 * imperative shell. This spec is the shell's half of the rule: a source scan
 * that names the single permitted call site, and the lint config that refuses
 * a second one in the editor as it is typed rather than at review time.
 *
 * That the permitted site is `src/clock.ts` and not `src/ticker.ts` is the
 * point rather than an accident. Time enters the daemon through the `Clock`
 * port; the ticker asks the port to sleep and never names a global. So the
 * ticker's sleep hint, the shutdown hard-exit and every future grace window
 * are one `setTimeout`, in one file, whose whole job is to be that one.
 *
 * Verifies: EPIC-06-S21 (scenario 3) · AC1
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkNoTimerWaits,
  checkTimerAllowlistIsLinted,
  describe as render,
  TIMER_ALLOWLIST,
  TIMER_GLOBALS,
} from '../../../test/support/guards.ts';
import { productionSources, readText } from '../../../test/support/workspace.ts';

suite('the only wait in the orchestrator is a node_wake row (AC1)', () => {
  it('names the globals a wait must never be written with', () => {
    expect([...TIMER_GLOBALS]).toEqual(['setTimeout', 'setInterval']);
  });

  it('allowlists exactly one call site', () => {
    expect(TIMER_ALLOWLIST).toEqual(['packages/daemon/src/clock.ts']);
  });

  it('has no other source that names one', () => {
    const sources = productionSources('packages/daemon');
    expect(sources.length).toBeGreaterThan(0);
    expect(render(checkNoTimerWaits(sources, TIMER_ALLOWLIST))).toBe('');
  });

  it('and that is a real result, not an empty scan', () => {
    // Take the rule away from every file and the guard must object — which is
    // only possible if it read them in the first place.
    const mutated = productionSources('packages/daemon').map((file) => ({
      ...file,
      text: `${file.text}\nexport const wait = (ms: number) => setTimeout(() => {}, ms);\n`,
    }));

    // Every file but the allowlisted one, which is allowed to say it twice.
    expect(checkNoTimerWaits(mutated, TIMER_ALLOWLIST).length).toBe(mutated.length - 1);
  });

  it('is enforced by the linter too, global by global', () => {
    expect(render(checkTimerAllowlistIsLinted(readText('.oxlintrc.json')))).toBe('');
  });
});
