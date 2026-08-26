/**
 * KAR-27.9 AC1 — *"`protocolCancel` is supplied in production for every route
 * that has a channel to carry it."*
 *
 * This is a source scan rather than a behavioural spec, for the same reason
 * `./one-cancel-remedy.test.ts` and `./machine-identity-boot-options.test.ts`
 * are: the defect being pinned is an **unbound port**, and an unbound port has
 * no behaviour to assert against. `cancelNode`'s rung 1 had a documented
 * contract, three passing integration tests and no shipped caller for four
 * epics — every one of those tests supplied the port itself, and all of them
 * were green throughout the two incidents of 2026-08-25.
 *
 * The chain has four links, and a break in any one of them puts the port back
 * where it was:
 *
 *  1. the ACP performer opens a cancellable turn (`signal`) and forbids the
 *     adapter's own escalation, because a cooperative cancel is never promoted;
 *  2. it registers that turn where the loop can reach it;
 *  3. both composition roots hand the registry to `boot()`;
 *  4. `boot()` hands it to the driver.
 *
 * Verifies: EPIC-27-S41 · KAR-27.9 AC1
 */
import { expect, it, describe as suite } from 'vitest';
import { readText } from './support/workspace.ts';

const PERFORMER = 'packages/daemon/src/pipeline/live-nodes.ts';
const BOOT = 'packages/daemon/src/boot.ts';
/** Both composition roots: `deflow up` is production, `main.ts` is `pnpm dev`. */
const ROOTS = ['packages/cli/src/up.ts', 'packages/daemon/src/main.ts'] as const;

suite('AC1 — the ACP performer opens a turn that can be asked to stop', () => {
  const performer = readText(PERFORMER);

  it('passes a cancellation signal to the ACP runner', () => {
    expect(performer).toMatch(/signal:\s*\w/);
  });

  it('forbids the adapter escalating an unanswered cancel on its own timer', () => {
    // EPIC-19-S38, EPIC-27-S30. Without this the wiring above would turn every
    // cooperative cancel into a forceful one five seconds later.
    expect(performer).toContain('escalateUnansweredCancel: false');
  });

  it('registers the turn, and disposes of it', () => {
    expect(performer).toMatch(/liveTurns\?\.register\(/);
    expect(performer).toMatch(/dispose\?\.\(\)/);
  });
});

suite('AC1 — the registry reaches the loop from both composition roots', () => {
  it.each(ROOTS)('%s hands the live turns to boot()', (path) => {
    expect(readText(path)).toMatch(/liveTurns/);
  });

  it('boot() hands them to the driver', () => {
    const boot = readText(BOOT);
    // Not merely accepted as an option and dropped, which is precisely what
    // `executeNodes` was doing on 2026-08-12: the option has to appear inside
    // the `createRunDriver({ … })` call, and the option list is bounded by the
    // statement that follows it.
    const from = boot.indexOf('createRunDriver({');
    expect(from).toBeGreaterThan(-1);
    const call = boot.slice(from, boot.indexOf('const tickIntervalMs', from));
    expect(call.length).toBeGreaterThan(0);
    expect(call).toMatch(/liveTurns: options\.liveTurns/);
  });
});
