/**
 * KAR-27.9 AC2, AC3 — a route with no channel refuses a cooperative cancel at
 * the point of request, and every surface reads the same fact to know that.
 *
 * **What the spike found.** The two routes are not alike. On `acp` the child
 * speaks JSON-RPC over its stdio for the whole turn, so `session/cancel` has
 * somewhere to go. On `shim` the child is `claude -p …` — argv in, one-way
 * `stream-json` out — and there is nothing DeFlow can write to it that means
 * *stop politely*. Before this story both were accepted identically, and a
 * cooperative cancel of a shim run was appended, projected as `cancelling`, and
 * parked for ever with nothing able to end it but `--force`.
 *
 * So the refusal happens **before** `controlRun`, and the assertion that makes
 * that meaningful is the negative one: no `run.cancel.requested` reaches the
 * ledger, because a run that carries one is a run every projection considers to
 * be stopping.
 *
 * Integration rather than unit because the claim is about the wire: the status
 * code, the closed envelope, and the ledger the route did or did not touch.
 * The pure half — which ladders a route has — is
 * `../../../core/src/cancel-ladders.test.ts`.
 *
 * Verifies: EPIC-27-S42, EPIC-27-S43 · KAR-27.9 AC2, AC3
 */
import type { Db, ProviderRoute } from '@DeFlow/core';
import { cancelLaddersFor, forcefulCancelCommand } from '@DeFlow/core';
import { appendEvents, openLedger } from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN, TestClock } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearIntakePorts, setIntakePorts } from '../../src/http/intake-ports.ts';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';
import { CANCEL_RUN, completeAuth, draft, seedRunningRun, T0 } from './support/cancel-run.ts';

const fetch = authorizedFetch();
const RUN = CANCEL_RUN;

/**
 * The admission record a run carries once it has been admitted onto a route —
 * the same `provider.probed` shape `intake.ts` writes, because the whole point
 * is that the refusal is read off what production already stores.
 */
function admittedOn(route: ProviderRoute): ReturnType<typeof draft> {
  return draft('provider.probed', {
    provider: 'claude',
    admission: 'available',
    vendorBin: 'claude',
    vendorPath: '/usr/local/bin/claude',
    adapterBin: 'claude-code-acp',
    adapterPath: route === 'acp' ? '/usr/local/bin/claude-code-acp' : null,
    package: null,
    chosen: {
      route,
      binaryPath: route === 'acp' ? '/usr/local/bin/claude-code-acp' : '/usr/local/bin/claude',
      routes: {
        acp: route === 'acp' ? 'available' : 'missing',
        shim: 'available',
      },
      unserved: [],
    },
  });
}

interface Served {
  readonly origin: string;
  readonly db: Db;
  close(): Promise<void>;
}

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

async function serve(dataDir: string, route: ProviderRoute | null): Promise<Served> {
  const db = openLedger(dataDir);
  seedRunningRun(db);
  if (route !== null) appendEvents(db, [admittedOn(route)]);

  const view = openLedgerView(dataDir);
  setLedgerView(view);
  setIntakePorts({
    db,
    epoch: 1,
    clock: new TestClock(T0),
    dataDir,
    randomHex: () => 'aa0001',
  });

  const started = await startHttp({
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    token: TEST_DAEMON_TOKEN,
  });
  const address = started.server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    db,
    async close() {
      await started.close();
      clearLedgerView();
      clearIntakePorts();
      view.close();
      db.close();
    },
  };
}

const kindsOf = (db: Db): string[] =>
  db
    .prepare<{ kind: string }>('SELECT kind FROM event WHERE run_id = ? ORDER BY seq')
    .all(RUN)
    .map((row) => row.kind);

const cancel = async (origin: string, body: unknown): Promise<Response> =>
  fetch(`${origin}/api/runs/${RUN}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface Refusal {
  readonly error: { readonly code: string; readonly message: string };
}

suite('EPIC-27-S42 — a route that cannot carry one refuses rather than waits (AC2)', () => {
  it('refuses the explicit cooperative mode, naming forceful, and appends nothing', async ({
    tmp,
  }) => {
    served = await serve(tmp, 'shim');
    const before = kindsOf(served.db);

    const response = await cancel(served.origin, { mode: 'cooperative' });

    expect(response.status).toBe(422);
    const body = (await response.json()) as Refusal;
    expect(body.error.code).toBe('cancel_mode_unavailable');
    expect(body.error.message).toContain(forcefulCancelCommand(RUN));
    expect(body.error.message).toContain('exec shim');

    // The half that matters: nothing in the ledger now says this run is
    // stopping, so nothing projects it as `cancelling` for ever.
    expect(kindsOf(served.db)).toEqual(before);
    expect(kindsOf(served.db)).not.toContain('run.cancel.requested');
  });

  it('refuses the *default* mode too, which is the one the incident took', async ({ tmp }) => {
    served = await serve(tmp, 'shim');

    // No body at all: `POST /api/runs/:id/cancel` defaults to cooperative, and
    // that default is exactly what two runs took on 2026-08-25.
    const response = await fetch(`${served.origin}/api/runs/${RUN}/cancel`, { method: 'POST' });

    expect(response.status).toBe(422);
    expect(kindsOf(served.db)).not.toContain('run.cancel.requested');
  });

  it('still accepts forceful on that route, because that ladder is the one it has', async ({
    tmp,
  }) => {
    served = await serve(tmp, 'shim');

    const response = await cancel(served.origin, { mode: 'forceful' });

    expect(response.status).toBe(200);
    expect(kindsOf(served.db)).toContain('run.cancel.requested');
  });
});

suite('EPIC-27-S42 — a route that can carry one is untouched', () => {
  it('accepts a cooperative cancel on the ACP route', async ({ tmp }) => {
    served = await serve(tmp, 'acp');

    const response = await cancel(served.origin, { mode: 'cooperative' });

    expect(response.status).toBe(200);
    expect(kindsOf(served.db)).toContain('run.cancel.requested');
  });

  it('accepts one on a shim run with nothing in flight (EPIC-19-S39, EPIC-19-S40)', async ({
    tmp,
  }) => {
    // The refusal is about a wait that cannot end. A run with no turn in flight
    // is not waiting on anything: both ladders reduce to the same `run.aborted`
    // on the next tick. Refusing here would make the run `deflow cancel` was
    // built to dispose of need `--force` — and that is a shipped guarantee, with
    // an e2e spec behind it.
    served = await serve(tmp, 'shim');
    appendEvents(served.db, [...completeAuth()]);

    const response = await cancel(served.origin, { mode: 'cooperative' });

    expect(response.status).toBe(200);
    expect(kindsOf(served.db)).toContain('run.cancel.requested');
  });

  it('accepts one on a run that was never admitted onto a route at all', async ({ tmp }) => {
    // EPIC-19-S39's run: nothing was spawned, so there is no unendable wait to
    // be accepted into, and requiring `--force` to get rid of it would be a
    // regression of the story that made it disposable.
    served = await serve(tmp, null);

    const response = await cancel(served.origin, { mode: 'cooperative' });

    expect(response.status).toBe(200);
    expect(kindsOf(served.db)).toContain('run.cancel.requested');
  });
});

suite('EPIC-27-S43 — the CLI and the API agree, because both read one fact', () => {
  it('serves the run its ladders, and they are the ones the refusal was derived from', async ({
    tmp,
  }) => {
    served = await serve(tmp, 'shim');

    const body = (await (await fetch(`${served.origin}/api/runs/${RUN}`)).json()) as {
      readonly cancelLadders: { readonly route: string; readonly modes: readonly string[] };
    };

    expect(body.cancelLadders).toEqual(cancelLaddersFor({ route: 'shim', inFlight: true }));
    expect(body.cancelLadders.modes).toEqual(['forceful']);

    // And the route refuses exactly the mode the capability leaves out — one
    // fact, read twice, never two tables that agree today.
    const refused = await cancel(served.origin, { mode: 'cooperative' });
    expect(refused.status).toBe(422);
    expect(body.cancelLadders.modes).not.toContain('cooperative');
  });

  it('serves both ladders for a run on the ACP route', async ({ tmp }) => {
    served = await serve(tmp, 'acp');

    const body = (await (await fetch(`${served.origin}/api/runs/${RUN}`)).json()) as {
      readonly cancelLadders: { readonly modes: readonly string[] };
    };

    expect(body.cancelLadders.modes).toEqual(['cooperative', 'forceful']);
  });
});
