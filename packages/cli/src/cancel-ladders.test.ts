/**
 * KAR-27.9 AC3 — *"the refusal and the capability are one fact, read from the
 * route, so the CLI and the API cannot disagree about which ladders a run
 * supports."*
 *
 * The way `deflow cancel` keeps that true is by having **no opinion**: it never
 * asks whether a run can take the cooperative ladder, it asks for one and
 * prints whatever the daemon says. This file pins the two halves of that.
 *
 * The first is the negative claim, and it is the one that matters. A CLI that
 * grew its own copy of the rule — "shim means forceful" — would be the second
 * reader AC3 forbids, and it would be wrong the first time a machine's routes
 * changed under a run that was already going. So the command is asserted to
 * send exactly what it was asked to send, and to reproduce the daemon's sentence
 * verbatim rather than compose one.
 *
 * Unit, with the socket injected, for the reason `./cancel.test.ts` gives: the
 * wire is asserted over a real daemon in
 * `../../daemon/test/integration/cancel-route-ladders.test.ts` and end to end in
 * `../../../e2e/cancel.test.ts`.
 *
 * Verifies: EPIC-27-S42, EPIC-27-S43 · KAR-27.9 AC2, AC3
 */
import { cooperativeCancelUnavailable, forcefulCancelCommand } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { runCancel } from './cancel.ts';
import { RUN_EXIT_CODES } from './run/exit-codes.ts';

const RUN = 'run_20260826T090000Z_1a2b3c';

/** The daemon this run is on: the exec shim, which has no channel for a
 * cooperative stop. The message is the daemon's own producer, not a copy. */
const REFUSAL = cooperativeCancelUnavailable(RUN, 'shim');

const daemon = () =>
  Promise.resolve({ baseUrl: 'http://127.0.0.1:7777', token: 'test-token' } as never);

/** Records what the command actually put on the wire. */
function capturing(response: () => Response): {
  readonly sent: { url: string; body: unknown }[];
  readonly fetch: typeof globalThis.fetch;
} {
  const sent: { url: string; body: unknown }[] = [];
  return {
    sent,
    fetch: ((url: string, init: RequestInit) => {
      // The command serialises its body with `JSON.stringify`, so this is a
      // string; reading it as one is the assertion, not a convenience.
      const body: string = typeof init.body === 'string' ? init.body : '';
      sent.push({ url, body: JSON.parse(body) });
      return Promise.resolve(response());
    }) as unknown as typeof globalThis.fetch,
  };
}

const refused = () =>
  new Response(
    JSON.stringify({
      error: { code: 'cancel_mode_unavailable', message: REFUSAL, detail: {}, retryable: false },
    }),
    { status: 422, headers: { 'content-type': 'application/json' } },
  );

suite('EPIC-27-S43 — the CLI has no second opinion about the ladders', () => {
  it('asks for cooperative on a run it cannot know the route of, and lets the daemon decide', async () => {
    const wire = capturing(refused);

    await runCancel({ argv: [RUN], env: {}, findDaemon: daemon, fetch: wire.fetch });

    // One request, and the mode the operator asked for — no probe of the run's
    // route first, and no local refusal that would be a second reader of it.
    expect(wire.sent).toHaveLength(1);
    expect(wire.sent[0]?.body).toEqual({ mode: 'cooperative' });
  });

  it("prints the daemon's refusal verbatim, so both surfaces say one thing", async () => {
    const wire = capturing(refused);

    const result = await runCancel({
      argv: [RUN],
      env: {},
      findDaemon: daemon,
      fetch: wire.fetch,
    });

    expect(result.exitCode).toBe(RUN_EXIT_CODES.failed);
    expect(result.stderr).toContain('cancel_mode_unavailable');
    expect(result.stderr).toContain(REFUSAL);
    // AC2 — and therefore names the ladder that is available, because the
    // daemon's sentence does.
    expect(result.stderr).toContain(forcefulCancelCommand(RUN));
    expect(result.stdout).toBe('');
  });

  it('sends forceful when the operator takes the ladder the refusal named', async () => {
    const wire = capturing(
      () =>
        new Response(
          JSON.stringify({
            runId: RUN,
            seq: 12,
            status: 'aborted',
            appended: true,
            kill: { outcome: 'stopped', survivors: [] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const result = await runCancel({
      argv: [RUN, '--force'],
      env: {},
      findDaemon: daemon,
      fetch: wire.fetch,
    });

    expect(wire.sent[0]?.body).toEqual({ mode: 'forceful' });
    expect(result.exitCode).toBe(0);
  });
});
