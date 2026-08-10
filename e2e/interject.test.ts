/**
 * KAR-13.3 test plan #9 — a real DeFlowd, interjected mid-node.
 *
 * e2e because the claim is about a **process**: every layer below this has been
 * asserted against a database the spec also held open, and none of them can
 * show that a daemon which owns the exclusive lease on a data directory accepts
 * a correction over its socket and writes it once. The failure this would catch
 * is a route that only works when the ledger connection happens to be the
 * spec's own.
 *
 * The run is seeded before the daemon starts and the connection is closed
 * first: `boot()` takes an exclusive lease, and two writers is the failure
 * EPIC-03-S21 exists to prevent, not one to reproduce here by accident.
 *
 * Verifies: EPIC-13-S17 · AC1, AC4
 */
import { openLedger, readRange } from '@DeFlow/ledger';
import { afterEach, expect, it, describe as suite } from 'vitest';
import {
  type DaemonProcess,
  freePort,
  makeDataDir,
  removeDataDir,
  spawnDaemon,
  waitForHealth,
} from './support/daemon.ts';
import {
  GATE,
  GUIDANCE,
  IMPL,
  INTERJECT_RUN,
  seedRunningNode,
} from './support/interject-fixture.ts';

const dirs: string[] = [];
const running: DaemonProcess[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) await removeDataDir(dir);
});

async function daemonWithRunningNode(): Promise<DaemonProcess & { dataDir: string }> {
  const dataDir = await makeDataDir();
  dirs.push(dataDir);
  await seedRunningNode(dataDir);

  const daemon = spawnDaemon({ dataDir, port: await freePort() });
  running.push(daemon);
  await waitForHealth(daemon);
  return Object.assign(daemon, { dataDir });
}

function ledgerKinds(dataDir: string): string[] {
  const db = openLedger(dataDir);
  try {
    return readRange(db, INTERJECT_RUN, 0, 500).events.map((event) => event.kind);
  } finally {
    db.close();
  }
}

suite('EPIC-13-S17 — the correction lands and the run is not discarded', () => {
  it('accepts one interjection over the socket and cancels nothing', async () => {
    const daemon = await daemonWithRunningNode();

    const response = await fetch(`${daemon.origin}/api/runs/${INTERJECT_RUN}/interject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: IMPL, text: GUIDANCE, mode: 'next-turn' }),
    });

    expect(response.status).toBe(202);
    // The adapter this node runs on advertises mid-turn steering, and the
    // answer comes from that probed row rather than from a provider name.
    const body = (await response.json()) as { seq: number; delivery: string };
    expect(body.delivery).toBe('queued');
    expect(body.seq).toBeGreaterThan(0);

    await daemon.stop();
    running.length = 0;

    const kinds = ledgerKinds(daemon.dataDir);
    expect(kinds.filter((kind) => kind === 'human.interjected')).toHaveLength(1);
    // AC4, in its own words: the run was not discarded, cancelled or reset.
    // `node.retry.scheduled` is deliberately *not* asserted on here — boot
    // recovery concludes the attempt a dead daemon was holding and hands it to
    // the retry ladder (KAR-06.9 step 5), which is EPIC-06's behaviour and not
    // this interjection's. That the interjection itself schedules no retry is
    // asserted where it can be attributed, in
    // `packages/daemon/test/integration/interject-pause.test.ts`.
    expect(kinds).not.toContain('run.cancel.requested');
    expect(kinds).not.toContain('node.cancelled');
    expect(kinds).not.toContain('run.aborted');
  });

  it('sends an interjection aimed at a human gate to the respond route instead', async () => {
    const daemon = await daemonWithRunningNode();

    const response = await fetch(`${daemon.origin}/api/runs/${INTERJECT_RUN}/interject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: GATE, text: GUIDANCE, mode: 'next-turn' }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('use_respond');
    expect(body.message).toContain('/respond');

    await daemon.stop();
    running.length = 0;

    // Nothing was appended: the two "tell the run something" mechanisms do not
    // silently overlap, and the wrong one writes no audit trail.
    expect(ledgerKinds(daemon.dataDir)).not.toContain('human.interjected');
  });
});
