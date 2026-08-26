/**
 * KAR-27.10 AC1, AC2 — the daemon's own exit deadline must outlast the ladder
 * it runs on the way out.
 *
 * `main.ts` arms a hard `process.exit` when a signal arrives, so that a wedged
 * shutdown cannot hold the port past `node --watch`'s restart. That deadline
 * was two seconds, and `sweepGroup`'s SIGTERM grace alone is five: a child that
 * did not die on rung 2 — one ignoring SIGTERM, or one uninterruptible in a
 * syscall — was still alive when the daemon exited, and was adopted by init and
 * carried on. That is the 2026-08-25 observation, and it is arithmetic rather
 * than a race: **no** shutdown could ever reach rung 3.
 *
 * So the deadline is derived from the ladder rather than chosen, and this is
 * the derivation, asserted. It is a spec and not a comment because the ladder's
 * own constants are tunable (`TERM_GRACE_MS` is documented as a default, not a
 * law) and the day one of them is raised is the day a literal here would go
 * quietly wrong again.
 *
 * The ordering claim is the other half of AC2: what could not be terminated is
 * recorded *before the process ends*, which is only true while the ledger is
 * still open — so `stopChildren` has to be awaited before `db.close()` in the
 * one place that closes it.
 *
 * Verifies: EPIC-27-S45, EPIC-27-S46 · AC1, AC2
 */
import { expect, it, describe as suite } from 'vitest';
import { readText } from '../../../test/support/workspace.ts';
import { KILL_VERIFY_MS, TERM_GRACE_MS } from '../src/cancel.ts';
import { SHUTDOWN_DEADLINE_MS } from '../src/shutdown.ts';

suite('the exit deadline outlasts the shutdown ladder (AC1)', () => {
  it('leaves room for SIGTERM, the whole grace, SIGKILL and the verification', () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThan(TERM_GRACE_MS + KILL_VERIFY_MS);
  });

  it('is what main.ts arms its hard exit with, by name and not by value', () => {
    const main = readText('packages/daemon/src/main.ts');
    expect(main).toMatch(/SHUTDOWN_DEADLINE_MS/);
    expect(main).toMatch(/from '\.\/shutdown\.ts'/);
    // The literal that was there is not: a number here cannot track the ladder.
    expect(main).toMatch(/setTimer\(\s*SHUTDOWN_DEADLINE_MS\s*,/);
  });

  it('is the only deadline main.ts puts on its own exit', () => {
    const main = readText('packages/daemon/src/main.ts');
    const armed = [...main.matchAll(/setTimer\(([^,]+),/g)].map((match) => (match[1] ?? '').trim());
    expect(armed).toEqual(['SHUTDOWN_DEADLINE_MS']);
  });
});

suite('survivors are recorded while the ledger is still open (AC2)', () => {
  it('boot.ts awaits stopChildren before it closes the database', () => {
    const bootSource = readText('packages/daemon/src/boot.ts');
    const stopping = bootSource.indexOf('await stopChildren(');
    const closing = bootSource.indexOf('db.close()', stopping);
    expect(stopping).toBeGreaterThan(-1);
    expect(closing).toBeGreaterThan(stopping);
  });
});
