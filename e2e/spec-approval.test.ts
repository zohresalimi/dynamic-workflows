/**
 * KAR-10.3 AC4 / EPIC-10-S18 — approving from the CLI and approving from the
 * API produce the same ledger, apart from `by`.
 *
 * e2e because the claim is about two *surfaces*, and a spec that called both
 * functions in one process would prove nothing about either: what is under test
 * is a real DeFlowd over a real data directory, reached once over HTTP and once
 * through `DeFlow`'s own HTTP client from what is, as far as the daemon is
 * concerned, a second terminal.
 *
 * M1's UI arrives in W10–W11, well after W7a, so the CLI path is not a
 * convenience here — it is the only way this epic is testable end to end when it
 * is built.
 *
 * Verifies: EPIC-10-S18 · AC4 · test plan #9
 */

import { openLedger, readRange } from '@DeFlow/ledger';
import { approveSpec } from 'DeFlow';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type DaemonProcess,
  freePort,
  makeDataDir,
  removeDataDir,
  spawnDaemon,
  waitForHealth,
} from './support/daemon.ts';
import {
  SPEC_RUN,
  seedRunAtSpecGate,
  seedRunAtSpecGateOnUncoveredPlan,
} from './support/spec-gate-fixture.ts';

const dirs: string[] = [];
const running: DaemonProcess[] = [];

beforeEach(() => {
  dirs.length = 0;
});

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) await removeDataDir(dir);
});

/** A data directory holding one run parked at the approval gate, with a real
 * DeFlowd listening over it. */
async function daemonAtGate(
  seed: (dataDir: string) => Promise<string> = seedRunAtSpecGate,
): Promise<DaemonProcess> {
  const dataDir = await makeDataDir();
  dirs.push(dataDir);
  await seed(dataDir);

  const daemon = spawnDaemon({ dataDir, port: await freePort() });
  running.push(daemon);
  await waitForHealth(daemon);
  return Object.assign(daemon, { dataDir });
}

/**
 * Every event of the run, with `by` and the timestamps normalised away — S18's
 * *"identical modulo the by field and timestamps"*, spelled out.
 *
 * The instants are the daemon's own `Clock`, so the two runs' `human.responded`
 * differ by however many milliseconds the second daemon took to start. Ordering
 * is `seq` and never `at` (docs/04-domain-model.md §9), so a timestamp is
 * display data here and comparing it would be comparing the machine.
 */
const ISO_INSTANT = /"\d{4}-\d{2}-\d{2}T[\d:.]+Z"/g;

function comparableLedger(dataDir: string): unknown[] {
  const db = openLedger(dataDir);
  try {
    return readRange(db, SPEC_RUN, 0, 500).events.map(
      (event: { kind: string; payload: unknown }) => ({
        kind: event.kind,
        payload: JSON.parse(
          JSON.stringify(event.payload)
            .replaceAll('"cli"', '"ui"')
            .replace(ISO_INSTANT, '"<instant>"'),
        ) as unknown,
      }),
    );
  } finally {
    db.close();
  }
}

suite('EPIC-10-S18 — two surfaces, one code path', () => {
  it('records by: ui over HTTP and by: cli from the CLI, and nothing else differs', async () => {
    const viaApi = (await daemonAtGate()) as DaemonProcess & { dataDir: string };
    const viaCli = (await daemonAtGate()) as DaemonProcess & { dataDir: string };

    const apiResponse = await fetch(`${viaApi.origin}/api/runs/${SPEC_RUN}/spec/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(apiResponse.status).toBe(200);
    expect((await apiResponse.json()) as { by: string }).toMatchObject({ by: 'ui' });

    // The second terminal: `DeFlow approve`, which is an HTTP client of the
    // daemon and not a second implementation of the gate.
    const cliResult = await approveSpec(SPEC_RUN, { baseUrl: viaCli.origin });
    expect(cliResult.by).toBe('cli');
    expect(cliResult.specHash).toBe(
      (
        (await (await fetch(`${viaApi.origin}/api/runs/${SPEC_RUN}`)).json()) as {
          specHash?: string;
        }
      ).specHash ?? cliResult.specHash,
    );

    await viaApi.stop();
    await viaCli.stop();
    running.length = 0;

    expect(comparableLedger(viaCli.dataDir)).toEqual(comparableLedger(viaApi.dataDir));

    // And both runs are now schedulable, which is the point of the gate.
    const approvals = comparableLedger(viaApi.dataDir).filter(
      (event) => (event as { kind: string }).kind === 'run.spec.approved',
    );
    expect(approvals).toHaveLength(1);
  });

  it('answers a second approval with 409 rather than approving twice', async () => {
    const daemon = (await daemonAtGate()) as DaemonProcess & { dataDir: string };

    const first = await fetch(`${daemon.origin}/api/runs/${SPEC_RUN}/spec/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${daemon.origin}/api/runs/${SPEC_RUN}/spec/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(second.status).toBe(409);
    expect((await second.json()) as { error: string }).toMatchObject({ error: 'gate_not_open' });

    await daemon.stop();
    running.length = 0;
    const approvals = comparableLedger(daemon.dataDir).filter(
      (event) => (event as { kind: string }).kind === 'run.spec.approved',
    );
    expect(approvals).toHaveLength(1);
  });
});

/**
 * KAR-12.4 AC1 / EPIC-12-S24 — *"the run does not start. No agent process is
 * spawned. `POST /api/runs/:id/spec/approve` returns the diagnostic rather than
 * a 201."*
 *
 * e2e because the claim is about the operator-facing surface of a real daemon:
 * the diagnostic has to survive being computed in the gate, thrown, mapped to a
 * status code and serialised over HTTP. A spec that called `approveSpec` in
 * process would prove the walk works and nothing about what an operator — or
 * the UI — is actually told.
 */
suite('EPIC-12-S24 — approval is refused while a criterion reaches no gate', () => {
  it('answers with the diagnostic, approves nothing, and starts nothing', async () => {
    const daemon = (await daemonAtGate(seedRunAtSpecGateOnUncoveredPlan)) as DaemonProcess & {
      dataDir: string;
    };

    const response = await fetch(`${daemon.origin}/api/runs/${SPEC_RUN}/spec/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      message: string;
      issues: { code: string; criterion: string }[];
    };
    expect(body.error).toBe('invalid_spec');
    expect(body.issues).toMatchObject([{ code: 'CRITERION_UNCOVERED', criterion: 'ac-2' }]);
    expect(body.message).toContain('ac-2');

    await daemon.stop();
    running.length = 0;

    const ledger = comparableLedger(daemon.dataDir);
    // Nothing was appended: the seeded approval is still the only one, no
    // answer was recorded against the gate, and no node was ever scheduled —
    // so no agent process could have been spawned.
    expect(
      ledger.filter((event) => (event as { kind: string }).kind === 'run.spec.approved'),
    ).toHaveLength(1);
    expect(ledger.map((event) => (event as { kind: string }).kind)).not.toContain(
      'human.responded',
    );
    expect(ledger.map((event) => (event as { kind: string }).kind)).not.toContain('node.scheduled');
    expect(ledger.map((event) => (event as { kind: string }).kind)).not.toContain('node.started');
  });
});
