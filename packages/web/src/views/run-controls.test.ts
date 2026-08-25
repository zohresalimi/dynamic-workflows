/**
 * KAR-27.7 AC1, AC2 — the controls on the real run surface, and the state they
 * show coming from the ledger rather than from a 200.
 *
 * Verifies: EPIC-27-S34, EPIC-27-S35, EPIC-27-S36 · AC1, AC2
 *
 * The component's own contract — which control in which state, what each sends,
 * the confirmation — is `../components/RunControls.test.ts`, against props. What
 * only *this* file can say is the half that needs a page: that the controls are
 * reachable on the project's workflows view at all, and that pressing pause
 * changes nothing on screen until `run.paused` arrives on the run's feed. A
 * surface that flipped to "paused" on the response would pass every assertion
 * in the component spec and still be lying to an operator whose drive never
 * held the run.
 *
 * The shell, the client and the frame path are the shipped ones, exactly as in
 * `./run-gate-answer.test.ts`: a real `createClient` over an injected `fetch`,
 * and events poured into the very sink `../ledger/feed.ts` pours into.
 */
import type { Event } from '@DeFlow/core';
import { EVENT_SCHEMAS, parseEvent } from '@DeFlow/core';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import { type MountedShell, mountShell, TEST_TOKEN } from '../../test/shell.ts';
import { createClient } from '../api/client.ts';
import type { RunFeed, RunFeedFactory, RunFeedOptions } from '../ledger/feed.ts';

const PROJECT = 'prj_20260825T101112Z_a1b2c3';
const LIVE_RUN = 'run_20260825T090000Z_b17e55';
const DONE_RUN = 'run_20260825T080000Z_44aa10';
const ORIGIN = 'http://daemon.test';
const T0 = 1_787_000_000_000;

interface SentRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
}

interface Wire {
  readonly sent: SentRequest[];
  /** The next answer for a POST, or `null` for the ordinary `200`. */
  refuseWith: { readonly status: number; readonly body: unknown } | null;
}

const wire: Wire = { sent: [], refuseWith: null };

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** One row of the project's history, as `runEntry` sends it. */
function historyRow(runId: string, status: string): Record<string, unknown> {
  return {
    runId,
    status,
    label: status,
    title: 'Migrate the checkout module',
    createdAt: new Date(runId === LIVE_RUN ? T0 : T0 - 3_600_000).toISOString(),
    headSeq: 7,
    planVersion: 0,
    cost: null,
    gate: null,
  };
}

async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : String((input as Request).url ?? input));
  const method = (init?.method ?? 'GET').toUpperCase();
  const raw = init?.body;
  wire.sent.push({
    method,
    pathname: url.pathname,
    body: typeof raw === 'string' && raw !== '' ? (JSON.parse(raw) as unknown) : null,
  });

  if (method === 'POST') {
    const refusal = wire.refuseWith;
    return refusal === null
      ? reply({ runId: LIVE_RUN, seq: 8, appended: true })
      : reply(refusal.body, refusal.status);
  }

  if (url.pathname === '/api/projects') {
    return reply({
      projects: [
        {
          id: PROJECT,
          name: 'checkout',
          path: '/repos/checkout',
          createdAt: new Date(T0).toISOString(),
          health: { state: 'ok', message: null },
          lastRun: null,
        },
      ],
    });
  }
  if (url.pathname === `/api/projects/${PROJECT}/runs`) {
    return reply({ runs: [historyRow(LIVE_RUN, 'running'), historyRow(DONE_RUN, 'completed')] });
  }
  if (url.pathname === '/api/runs') return reply({ runs: [], cursor: null, more: false });
  if (url.pathname === '/api/approvals') return reply({ items: [], counts: {}, headSeq: 0 });
  if (url.pathname === '/api/providers/routes') return reply({ providers: [], known: false });
  return reply({ events: [], cursor: 0, more: false, headSeq: 0 });
}

function frame(kind: string, seq: number, payload: unknown, runId: string = LIVE_RUN): Event {
  const result = parseEvent({
    seq,
    runId,
    ts: T0,
    kind,
    v: (EVENT_SCHEMAS as Record<string, { v: number }>)[kind]?.v ?? 1,
    epoch: 1,
    payload,
  });
  if (result.status !== 'ok') {
    throw new Error(`the spec built an envelope this build cannot read: ${JSON.stringify(result)}`);
  }
  return result.event;
}

interface OpenedFeed {
  readonly runId: string;
  readonly sink: { applyEvent(event: Event): boolean };
}

let shell: MountedShell;
let opened: OpenedFeed[] = [];

const feedFactory: RunFeedFactory = (options: RunFeedOptions): RunFeed => {
  opened.push({ runId: options.runId, sink: options.sink });
  return { runId: options.runId, ready: Promise.resolve(), close: () => {} };
};

const control = (action: string): HTMLButtonElement | null =>
  shell.container.querySelector<HTMLButtonElement>(`[data-run-control="${action}"]`);

const posts = (): SentRequest[] => wire.sent.filter((request) => request.method === 'POST');

function push(event: Event): void {
  const feed = opened.at(-1);
  if (feed === undefined) throw new Error('the workspace opened no run feed');
  feed.sink.applyEvent(event);
}

async function openWorkspace(at: string = `/projects/${PROJECT}`): Promise<void> {
  shell = await mountShell({
    at,
    client: createClient({ baseUrl: `${ORIGIN}/api`, token: () => TEST_TOKEN, fetch: serve }),
    feed: feedFactory,
  });
  setActivePinia(shell.pinia);
  await expect.poll(() => opened.length, { timeout: 15_000 }).toBeGreaterThan(0);
}

beforeEach(() => {
  wire.sent.length = 0;
  wire.refuseWith = null;
  opened = [];
  setActivePinia(undefined as never);
});

afterEach(() => {
  shell?.unmount();
});

suite('EPIC-27-S34 — the run surface offers the controls (AC1)', () => {
  it('shows pause and stop on the project’s live run', async () => {
    await openWorkspace();

    await expect.poll(() => control('pause'), { timeout: 15_000 }).not.toBeNull();
    expect(control('stop')).not.toBeNull();
    expect(control('resume')).toBeNull();
  });

  it('offers neither on a run from history that has concluded', async () => {
    await openWorkspace(`/projects/${PROJECT}/runs/${DONE_RUN}`);

    await expect
      .poll(() => shell.container.querySelector('[data-run-header]'), { timeout: 15_000 })
      .not.toBeNull();
    expect(control('pause')).toBeNull();
    expect(control('stop')).toBeNull();
    expect(control('resume')).toBeNull();
  });
});

suite('EPIC-27-S35 — the state on screen follows the ledger, not the response (AC2)', () => {
  it('pauses over the endpoint, and waits for run.paused to say so', async () => {
    await openWorkspace();
    await expect.poll(() => control('pause'), { timeout: 15_000 }).not.toBeNull();

    await userEvent.click(control('pause') as HTMLElement);
    await expect.poll(() => posts().length, { timeout: 15_000 }).toBe(1);

    expect(posts()[0]?.pathname).toBe(`/api/runs/${LIVE_RUN}/pause`);
    // The daemon said yes. The drive has not held the run yet, and the surface
    // does not claim it has.
    await expect.poll(() => control('pause')?.disabled, { timeout: 15_000 }).toBe(false);
    expect(control('resume')).toBeNull();

    // The ledger says so, and only now does the control change.
    push(frame('run.paused', 8, { by: 'user' }));
    await expect.poll(() => control('resume'), { timeout: 15_000 }).not.toBeNull();
    expect(control('pause')).toBeNull();
  });

  it('resumes the run the ledger says is paused, over the resume endpoint', async () => {
    await openWorkspace();
    await expect.poll(() => control('pause'), { timeout: 15_000 }).not.toBeNull();
    push(frame('run.paused', 8, { by: 'user' }));
    await expect.poll(() => control('resume'), { timeout: 15_000 }).not.toBeNull();

    await userEvent.click(control('resume') as HTMLElement);
    await expect.poll(() => posts().length, { timeout: 15_000 }).toBe(1);

    expect(posts()[0]?.pathname).toBe(`/api/runs/${LIVE_RUN}/resume`);
  });
});

suite('EPIC-27-S36 — a refusal reaches the operator (AC2)', () => {
  it('shows the daemon’s own sentence on the run surface', async () => {
    wire.refuseWith = {
      status: 409,
      body: {
        error: {
          code: 'run_not_pausable',
          message: 'this run is cancelling, so it cannot be paused: nothing was appended',
        },
      },
    };
    await openWorkspace();
    await expect.poll(() => control('pause'), { timeout: 15_000 }).not.toBeNull();

    await userEvent.click(control('pause') as HTMLElement);

    await expect
      .poll(() => shell.container.querySelector('[data-run-control-error]')?.textContent ?? '', {
        timeout: 15_000,
      })
      .toContain('this run is cancelling, so it cannot be paused');
  });
});
