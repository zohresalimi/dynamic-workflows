/**
 * KAR-25.4 test plan #1 — the resolved status table, in isolation.
 *
 * Verifies: EPIC-25-S22, EPIC-25-S23, EPIC-25-S24 · AC1, AC2
 *
 * `Red when: the screen renders a CLI state and a binding state as though
 * they were one fact.` This is the pure half of that claim — no mount, no
 * daemon — and `../components/settings/connectors-panel.test.ts` is its
 * DOM counterpart, asserting the same table from what a browser renders
 * rather than from what this function returns.
 *
 * The five rows are the epic's own table verbatim (EPIC-25-S22's Scenario
 * Outline). The rows past them are the daemon's other four
 * `ConnectorStateName`s (`registry.ts`), each crossed with bound/unbound —
 * asserting the story's own instruction that an unlisted state must resolve
 * through the same rule the table's own rows follow, not fall through to a
 * default nobody chose.
 */
import { expect, it, describe as suite } from 'vitest';
import { type ConnectorStatusInput, resolveConnectorStatus } from './connector-status.ts';

const authCommand = { kind: 'command' } as const;
const authUnavailable = { kind: 'unavailable' } as const;

const rowOf = (state: string, connected: boolean, kind: 'command' | 'unavailable' = 'command') =>
  ({
    connected,
    state: { state },
    authorisation: kind === 'command' ? authCommand : authUnavailable,
  }) satisfies ConnectorStatusInput;

suite('EPIC-25-S22 — the resolved status table, all five rows (AC1)', () => {
  it.each([
    { state: 'connected', bound: true, status: 'connected', action: 'disconnect' },
    { state: 'connected', bound: false, status: 'available', action: 'connect' },
    { state: 'not-installed', bound: true, status: 'bound · CLI missing', action: 'disconnect' },
    { state: 'not-installed', bound: false, status: 'not installed', action: 'none' },
  ])(
    '$state / bound=$bound resolves to "$status", action "$action"',
    ({ state, bound, status, action }) => {
      const resolved = resolveConnectorStatus(rowOf(state, bound));
      expect(resolved.status).toBe(status);
      expect(resolved.action).toBe(action);
    },
  );

  it('a service with no authorisation route reads "cannot be connected" whatever the CLI state or binding', () => {
    for (const state of ['connected', 'not-installed']) {
      for (const bound of [true, false]) {
        const resolved = resolveConnectorStatus(rowOf(state, bound, 'unavailable'));
        expect(resolved).toEqual({ status: 'cannot be connected', action: 'none' });
      }
    }
  });
});

suite('EPIC-25-S23 — bound-but-CLI-missing reads as one coherent state (AC2)', () => {
  it('never renders "not-installed" and "connected" as two separate statuses', () => {
    const resolved = resolveConnectorStatus(rowOf('not-installed', true));
    expect(resolved.status).not.toContain('not-installed');
    expect(resolved.status).not.toBe('connected');
    expect(resolved.status).toBe('bound · CLI missing');
  });
});

suite('EPIC-25-S24 — not-installed and unbound offers no Disconnect (AC2)', () => {
  it('resolves to no action at all', () => {
    expect(resolveConnectorStatus(rowOf('not-installed', false)).action).toBe('none');
  });
});

suite(
  'the daemon’s other four ConnectorStateNames — a state the table does not name still resolves',
  () => {
    it.each([
      {
        state: 'not-authorised',
        bound: true,
        status: 'bound · not authorised',
        action: 'disconnect',
      },
      { state: 'not-authorised', bound: false, status: 'not authorised', action: 'none' },
      { state: 'expired', bound: true, status: 'bound · expired', action: 'disconnect' },
      { state: 'expired', bound: false, status: 'expired', action: 'none' },
      {
        state: 'missing-scope',
        bound: true,
        status: 'bound · missing scope',
        action: 'disconnect',
      },
      { state: 'missing-scope', bound: false, status: 'missing scope', action: 'none' },
      { state: 'unreachable', bound: true, status: 'bound · unreachable', action: 'disconnect' },
      { state: 'unreachable', bound: false, status: 'unreachable', action: 'none' },
    ])(
      '$state / bound=$bound resolves to "$status", action "$action", never Connect',
      ({ state, bound, status, action }) => {
        const resolved = resolveConnectorStatus(rowOf(state, bound));
        expect(resolved.status).toBe(status);
        expect(resolved.action).toBe(action);
        // Every one of these is a broken-but-installed state: none of them is
        // "connected", so none of them may ever offer Connect — offering it would
        // let an operator try to bind a service the daemon just said is broken.
        expect(resolved.action).not.toBe('connect');
      },
    );
  },
);
