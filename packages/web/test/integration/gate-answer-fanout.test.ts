/**
 * KAR-22.5 AC5, AC6 — one answer, every tab; and the same answer twice, one
 * decision.
 *
 * Verifies: EPIC-22-S63, EPIC-22-S64 · test plan #7, #8
 *
 * Integration rather than browser, because both claims are about **the wire**.
 * A second tab is a second subscription, and what has to be true is that the
 * daemon fans one answer out to both of them — a browser spec sharing one
 * pushable feed between two mounted shells would be asserting the fan-out it
 * had itself performed. So this opens two of the very feeds the workspace
 * mounts (`src/ledger/feed.ts`, through `useRunFeed`) against one real daemon
 * over one real file-backed ledger, and answers the gate over the endpoint
 * `deflow answer` and the gate panel both call.
 */
import type { RunId } from '@DeFlow/core';
import { gateAnswerRequest, NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { boot } from '@DeFlow/daemon';
import { appendEventsSchedulingWakes, type EventDraft } from '@DeFlow/ledger';
import { it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { openRunFeed } from '../../src/ledger/feed.ts';
import { gatesProjection } from '../../src/ledger/projections/index.ts';

const RUN: RunId = RunIdSchema.parse('run_20260815T090000Z_c17e56');
const GATE_NODE = NodeIdSchema.parse('review-changes');
const T0 = 1_786_800_000_000;

const OPTIONS = [
  { id: 'approve', label: 'Ship it', effect: 'approve' },
  { id: 'reject', label: 'Send it back', effect: 'reject' },
] as const;

interface Served {
  readonly origin: string;
  close(): Promise<void>;
}

/**
 * A daemon whose ledger holds one run suspended on one open `human` gate.
 *
 * The request and its `node_wake` row are written together through
 * `appendEventsSchedulingWakes`, which is exactly how admission writes them
 * (KAR-13.1 AC1) — so the answer below consumes a row that is really there, and
 * the transaction this test exercises is the one that ships.
 */
async function serveGatedRun(tmp: string): Promise<Served> {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
  const address = booted.http.server.address() as AddressInfo;

  const draft = (kind: string, payload: unknown, over: Partial<EventDraft> = {}): EventDraft =>
    ({ runId: RUN, ts: T0, kind, v: 1, epoch: 1, payload, ...over }) as EventDraft;

  appendEventsSchedulingWakes(
    booted.db,
    [
      draft('task.submitted', {
        source: { kind: 'text', raw: 'migrate the checkout module', bytes: 27 },
        provenance: { kind: 'text', by: 'ui', at: new Date(T0).toISOString() },
      }),
      draft('run.started', {}),
      draft(
        'human.requested',
        {
          node: GATE_NODE,
          prompt: 'The change is ready. Ship it?',
          options: OPTIONS.map((option) => ({ ...option })),
        },
        { v: 5, nodeId: GATE_NODE },
      ),
    ],
    [{ runId: RUN, nodeId: GATE_NODE, wakeAt: Number.MAX_SAFE_INTEGER, reason: 'human_gate' }],
  );

  return { origin: `http://127.0.0.1:${address.port}`, close: () => booted.shutdown() };
}

/** One tab: the feed the workspace opens, with everything it received. */
function openTab(origin: string): {
  readonly events: { seq: number; kind: string }[];
  readonly gates: ReturnType<(typeof gatesProjection)['create']>;
  readonly feed: ReturnType<typeof openRunFeed>;
} {
  const events: { seq: number; kind: string }[] = [];
  const gates = gatesProjection.create();
  const feed = openRunFeed({
    runId: RUN,
    baseUrl: `${origin}/api`,
    token: () => TEST_DAEMON_TOKEN,
    sink: {
      applyEvent(event) {
        events.push({ seq: event.seq, kind: event.kind });
        gatesProjection.apply(gates, event);
        return true;
      },
    },
  });
  return { events, gates, feed };
}

const answer = (origin: string, optionId: string): Promise<Response> => {
  const request = gateAnswerRequest({ runId: RUN, gate: GATE_NODE, optionId });
  if (request === null) throw new Error(`${optionId} is not routable, which this gate offers`);
  return fetch(`${origin}${request.path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_DAEMON_TOKEN}`,
      'X-DeFlow-Submitted-By': 'ui',
    },
    body: JSON.stringify(request.body),
  });
};

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

suite('EPIC-22-S63 — two tabs watching one run both see the answer', () => {
  it('fans one answer out to every open subscription', async ({ tmp }) => {
    served = await serveGatedRun(tmp);
    const origin = served.origin;

    const first = openTab(origin);
    const second = openTab(origin);
    await Promise.all([first.feed.ready, second.feed.ready]);

    // Both tabs are showing the gate before anybody answers it.
    for (const tab of [first, second]) {
      expect(tab.gates.escalations.map((one) => [one.node, one.answeredWith])).toEqual([
        [GATE_NODE, null],
      ]);
    }

    const response = await answer(origin, 'approve');
    expect(response.status, await response.clone().text()).toBe(200);

    try {
      for (const tab of [first, second]) {
        await expect
          .poll(() => tab.events.some((event) => event.kind === 'human.responded'), {
            timeout: 15_000,
          })
          .toBe(true);
        // And the fold each tab renders from reports the gate closed.
        expect(tab.gates.escalations.map((one) => one.answeredWith)).toEqual(['approve']);
      }
    } finally {
      first.feed.close();
      second.feed.close();
    }
  });
});

suite('EPIC-22-S64 — a gate answered twice records one decision', () => {
  it('refuses the second with 409, carrying the first decision', async ({ tmp }) => {
    served = await serveGatedRun(tmp);
    const origin = served.origin;

    expect((await answer(origin, 'approve')).status).toBe(200);

    const second = await answer(origin, 'reject');
    expect(second.status).toBe(409);
    const body = (await second.json()) as {
      error: { code: string; message: string; detail: { response?: { optionId?: string } } };
    };
    expect(body.error.code).toBe('already_answered');
    expect(body.error.detail.response?.optionId).toBe('approve');

    // And the ledger holds one decision, not two.
    const events = (await (
      await fetch(`${origin}/api/runs/${RUN}/events?since=0&limit=100`, {
        headers: { Authorization: `Bearer ${TEST_DAEMON_TOKEN}` },
      })
    ).json()) as { events: readonly { kind: string }[] };
    expect(events.events.filter((event) => event.kind === 'human.responded')).toHaveLength(1);
  });
});
