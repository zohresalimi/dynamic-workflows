/**
 * KAR-02.7 — the boot preflight (EPIC-02-S21 scenario 2).
 *
 * The upcaster chain check is O(kinds × versions) over a static table, so
 * running it at every daemon start costs nothing — and the alternative is
 * discovering a missing hop during replay of a nine-hour run, at the one
 * moment the data is least recoverable.
 *
 * The check returns a value rather than throwing so that the failure at boot
 * is a typed error naming the gap, not a stack trace, and so that this test
 * does not have to kill its own process to observe it.
 *
 * Verifies: EPIC-02-S21 · AC4
 */
import { UpcasterRegistry } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { readText } from '../../../test/support/workspace.ts';
import { checkSchemaRegistry } from '../src/preflight.ts';

suite('DeFlowd checks the upcaster chains before it opens anything', () => {
  it('passes over the real registry', () => {
    expect(checkSchemaRegistry()).toEqual({ ok: true });
  });

  it('reports the gap, typed, when a hop is missing', () => {
    // v1→v2 registered, v2→v3 missing. `to` is only read by the fixture
    // guards in @DeFlow/core, never by the completeness check this exercises,
    // and the daemon has no direct zod dependency to build a real one with.
    const holed = new UpcasterRegistry({ 'gate.evaluated': 3 });
    holed.register({
      kind: 'gate.evaluated',
      from: 1,
      to: { safeParse: () => ({ success: true }) } as never,
      fixture: {},
      up: (payload) => payload,
    });

    const result = checkSchemaRegistry(holed);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('gate.evaluated');
    expect(result.version).toBe(2);
    expect(result.message).toContain('gate.evaluated');
    expect(result.message).toContain('2');
  });

  it('reports a message, not a stack trace', () => {
    const holed = new UpcasterRegistry({ 'gate.evaluated': 2 });

    const result = checkSchemaRegistry(holed);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).not.toContain('\n    at ');
  });

  it('runs in main.ts before the HTTP server binds', () => {
    const main = readText('packages/daemon/src/main.ts');

    const preflightAt = main.indexOf('checkSchemaRegistry(');
    const listenAt = main.indexOf('startHttp(');

    expect(preflightAt, 'main.ts does not run the schema preflight').toBeGreaterThan(-1);
    expect(listenAt).toBeGreaterThan(-1);
    expect(preflightAt).toBeLessThan(listenAt);
  });
});
