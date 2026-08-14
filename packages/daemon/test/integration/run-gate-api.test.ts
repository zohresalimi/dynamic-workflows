/**
 * KAR-19.12 AC6 — the pending gate **on the wire**, from the daemon's own two
 * read routes (EPIC-19-S82, third scenario).
 *
 * `pendingGate` itself is proven in `@DeFlow/core`'s unit spec, and the tab's
 * rendering of a gate is proven in `packages/web`. Neither of them can fail the
 * way this file can: the web specs hand their store a fabricated JSON body, so a
 * `GET /api/runs/:id` that computed a correct gate and then dropped it out of
 * the response — or spelled its key differently, or serialised a `NodeId` the
 * client cannot parse — is green everywhere else in the repository. The CLI is
 * no help either, and deliberately so: `deflow run` and `deflow status` compute
 * `pendingGate` locally off the reduced `RunState`, so neither of them ever
 * reads this field.
 *
 * So: a real booted daemon, a real socket, a real file-backed ledger, and the
 * gate opened by the **real scheduler** — `seedHumanRun` plus `driveToTheGate`,
 * which is `decide()` returning a `SuspendNode` and the run executor committing
 * `human.requested`, `node.suspended` and the `node_wake` row together. A
 * hand-written `human.requested` would prove the serialiser and not the fold.
 *
 * The fixture is a **plan-level `human` node** rather than the F1.3 spec gate,
 * for the reason EPIC-19-S82's own note gives: the spec gate moves the run's
 * status to `awaiting-spec-approval` and is therefore half-visible from the
 * status word alone, while a plan gate opens while the run is still `running` —
 * which is the case the status word cannot express and the one the field exists
 * for. The run's status is asserted here as `running` for exactly that reason.
 *
 * Seeded *after* the boot and through the daemon's own write connection at its
 * own epoch, because the reducer skips events stamped with an epoch older than
 * the one it has already seen: a fixture written before `bumpEpoch` would fold
 * to a run with no gate on it, and the spec would pass or fail for a reason
 * that has nothing to do with the route.
 *
 * Verifies: EPIC-19-S82 · KAR-19.12 AC6
 */
import type { PendingGate, RunId, RunStatus } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import { appendEvents } from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN, TestClock } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';
import {
  driveToTheGate,
  GATE,
  HUMAN_RUN,
  OPTIONS,
  PROMPT,
  seedHumanRun,
  T0,
} from './support/human-gate-run.ts';

const fetch = authorizedFetch();

/** A second run in the same directory, waiting on nobody. Without it, a route
 * that put a gate on every row would be indistinguishable from a correct one. */
const QUIET: RunId = RunIdSchema.parse('run_20260810T093000Z_c0ffee');

/** `GET /api/runs/:id`, as much of it as this spec reads. */
interface RunBody {
  readonly runId: string;
  readonly status: RunStatus;
  readonly gate?: PendingGate;
}

interface RunListBody {
  readonly runs: readonly { readonly runId: string; readonly gate: PendingGate | null }[];
}

/** The gate's options as a surface receives them: an id and a sentence, and no
 * `effect` — that is DeFlow's vocabulary about the node, not the operator's. */
const OFFERED = OPTIONS.map((option) => ({ id: option.id, label: option.label }));

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
});

/** A daemon holding one run suspended on a plan `human` node, and one that is
 * not waiting on anybody. */
async function daemonAtTheGate(tmp: string): Promise<string> {
  const dataDir = join(tmp, 'data');
  booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });

  seedHumanRun(booted.db, undefined, booted.epoch);
  await driveToTheGate(booted.db, new TestClock(T0), booted.epoch);

  appendEvents(booted.db, [
    {
      runId: QUIET,
      ts: T0 + 1000,
      kind: 'task.submitted',
      v: 1,
      epoch: booted.epoch,
      payload: {
        sha256: 'b'.repeat(64),
        raw: 'Rename the checkout module',
        provenance: { kind: 'text', by: 'cli', submittedAt: T0 + 1000 },
      },
    },
  ]);

  const address = booted.http.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

suite('EPIC-19-S82 — GET /api/runs/:id carries the pending gate (AC6)', () => {
  it('names the gate, its prompt and every option it offers, on a run that is still running', async ({
    tmp,
  }) => {
    const origin = await daemonAtTheGate(tmp);

    const response = await fetch(`${origin}/api/runs/${HUMAN_RUN}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as RunBody;

    // The case the status word cannot express, and the reason the field is on
    // the response at all: a `running` run that is waiting for a person.
    expect(body.status).toBe('running');
    expect(body.gate).toMatchObject({
      node: GATE,
      prompt: PROMPT,
      // Not the F1.3 gate, so a client routes an answer to `nodes/:id/respond`.
      specApproval: false,
      // Not a permission escalation either — a gate the plan declared.
      reason: null,
    });
    expect(body.gate?.options).toEqual(OFFERED);
    // F10.3's deep link: the `seq` of the `human.requested` that opened it.
    expect(body.gate?.requestedSeq).toBeGreaterThan(0);
  });

  it('omits the gate entirely for a run that is waiting on nobody', async ({ tmp }) => {
    const origin = await daemonAtTheGate(tmp);

    const body = (await (await fetch(`${origin}/api/runs/${QUIET}`)).json()) as RunBody;

    // Absent rather than `null`, like its three siblings `refusal`, `failure`
    // and `provider`: the body says nothing about a question nobody asked.
    expect(body.runId).toBe(QUIET);
    expect('gate' in body).toBe(false);
  });
});

suite("EPIC-19-S82 — GET /api/runs' rows carry it too (AC6)", () => {
  it('puts the gate on the waiting run’s row and null on the other', async ({ tmp }) => {
    const origin = await daemonAtTheGate(tmp);

    const response = await fetch(`${origin}/api/runs?limit=10`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as RunListBody;

    const waiting = body.runs.find((run) => run.runId === HUMAN_RUN);
    const quiet = body.runs.find((run) => run.runId === QUIET);

    // The list is where an operator scans for the run that wants them, so the
    // row has to carry the gate rather than only announce that one exists.
    expect(waiting?.gate).toMatchObject({ node: GATE, specApproval: false });
    expect(waiting?.gate?.options).toEqual(OFFERED);
    expect(quiet?.gate).toBeNull();
  });

  it('agrees with the run’s own view, field for field', async ({ tmp }) => {
    const origin = await daemonAtTheGate(tmp);

    const list = (await (await fetch(`${origin}/api/runs?limit=10`)).json()) as RunListBody;
    const one = (await (await fetch(`${origin}/api/runs/${HUMAN_RUN}`)).json()) as RunBody;

    // Both from `pendingGate` and from nothing else — which is only observable
    // as "the two routes cannot disagree at one head sequence".
    expect(list.runs.find((run) => run.runId === HUMAN_RUN)?.gate).toEqual(one.gate);
  });
});

suite('EPIC-19-S82 — an answered gate leaves both responses (AC6)', () => {
  it('drops the gate from the row and from the run once the daemon records the answer', async ({
    tmp,
  }) => {
    const origin = await daemonAtTheGate(tmp);

    // Answered through the daemon's own route, the way the tab answers it.
    const answered = await fetch(`${origin}/api/runs/${HUMAN_RUN}/nodes/${GATE}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'yes' }),
    });
    expect(answered.status).toBe(200);

    const one = (await (await fetch(`${origin}/api/runs/${HUMAN_RUN}`)).json()) as RunBody;
    const list = (await (await fetch(`${origin}/api/runs?limit=10`)).json()) as RunListBody;

    // A gate is what the run is waiting on *now*, not what it once asked: a
    // field that survived its answer would leave the list telling operators to
    // go and decide something that has been decided.
    expect('gate' in one).toBe(false);
    expect(list.runs.find((run) => run.runId === HUMAN_RUN)?.gate).toBeNull();
  });
});
