/**
 * KAR-19.12 AC6 — the tab says which gate a run is waiting on, in the list and
 * on the run.
 *
 * `needs a decision` with nothing to decide on is the same silence in a
 * different font: the run list already turned `human.requested` into a status
 * word (KAR-19.1), and an operator scanning it still could not tell *what* was
 * being asked or of whom. Both halves are asserted against the frames a live
 * daemon emits, pushed through the same subscription the views open.
 *
 * Verifies: EPIC-19-S82 · KAR-19.12 AC6 · test plan #8
 */
import type { Event } from '@DeFlow/core';
import { EVENT_SCHEMAS, parseEvent, SPEC_APPROVAL_OPTIONS, SPEC_GATE_NODE } from '@DeFlow/core';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, expect, it, describe as suite } from 'vitest';
import { render } from 'vitest-browser-vue';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import type { ApiClient } from '../api/client.ts';
import RunGateBanner from '../components/RunGateBanner.vue';
import type { RunsFeed, RunsFeedFactory } from '../ledger/runs-feed.ts';
import { useRunListStore } from '../stores/useRunListStore.ts';
import { useRunStore } from '../stores/useRunStore.ts';

const RUN = 'run_20260814T013434Z_c984dd';

let shell: MountedShell;

afterEach(() => {
  shell?.unmount();
});

function listClient(runs: readonly unknown[] = []): ApiClient {
  return {
    runs: {
      $get: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ runs, cursor: null, more: false }),
        }),
    },
    approvals: {
      $get: () =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) }),
    },
  } as never;
}

function pushableFeed(): { factory: RunsFeedFactory; push: (event: Event) => void } {
  let deliver: ((event: Event) => void) | null = null;
  const factory: RunsFeedFactory = (options): RunsFeed => {
    deliver = options.onLifecycle;
    return { ready: Promise.resolve(), close: () => {} };
  };
  return {
    factory,
    push: (event) => {
      if (deliver === null) throw new Error('the root route opened no runs=* subscription');
      deliver(event);
    },
  };
}

const frame = (kind: string, seq: number, payload: unknown): Event =>
  ({ seq, runId: RUN, ts: 1_786_670_000_000, kind, v: 1, epoch: 1, payload }) as unknown as Event;

const created = (): Event =>
  frame('run.created', 4, {
    spec: { goal: 'Add a hello function' },
    cwd: '/repo',
    repo: { head: 'e83c516', branch: 'main' },
  });

const gateOpened = (): Event =>
  frame('human.requested', 7, {
    node: SPEC_GATE_NODE,
    prompt: 'Goal\nAdd a hello function',
    options: SPEC_APPROVAL_OPTIONS.map((option) => ({ ...option })),
  });

suite('EPIC-19-S82 — the run list names the gate (AC6)', () => {
  it('shows the gate node beside the status label when a gate opens', async () => {
    const feed = pushableFeed();
    shell = await mountShell({ at: '/', client: listClient([]), runsFeed: feed.factory });
    setActivePinia(shell.pinia);
    await expect.poll(() => useRunListStore(shell.pinia).hydrated).toBe(true);

    feed.push(created());
    await expect.poll(() => shell.container.querySelectorAll('[data-run-row]').length).toBe(1);

    feed.push(gateOpened());

    await expect
      .poll(
        () => shell.container.querySelector<HTMLElement>(`[data-run-gate="${RUN}"]`)?.textContent,
      )
      .toContain(SPEC_GATE_NODE);
    // The status word is unchanged and still `runStatusLabel`'s.
    expect(
      shell.container.querySelector<HTMLElement>(`[data-run-status="${RUN}"]`)?.textContent?.trim(),
    ).toBe('needs a decision');
  });

  it('carries the gate a page loaded after the gate opened already knows about', async () => {
    const feed = pushableFeed();
    shell = await mountShell({
      at: '/',
      client: listClient([
        {
          runId: RUN,
          status: 'needs-human',
          label: 'needs a decision',
          title: 'Add a hello function',
          createdAt: '2026-08-14T01:34:34.000Z',
          headSeq: 7,
          planVersion: 0,
          gate: {
            node: SPEC_GATE_NODE,
            options: SPEC_APPROVAL_OPTIONS.map((option) => ({
              id: option.id,
              label: option.label,
            })),
          },
        },
      ]),
      runsFeed: feed.factory,
    });
    setActivePinia(shell.pinia);

    await expect
      .poll(
        () => shell.container.querySelector<HTMLElement>(`[data-run-gate="${RUN}"]`)?.textContent,
      )
      .toContain(SPEC_GATE_NODE);
  });
});

suite('EPIC-19-S82 — the run’s own view renders the pending gate (AC6)', () => {
  it('reads the open escalation off the projection the tab already folds', () => {
    setActivePinia(createPinia());
    const store = useRunStore();
    store.open(RUN);
    store.applyEvent(parsed(7, gateOpened()));

    expect(store.openGate?.node).toBe(SPEC_GATE_NODE);
    expect(store.openGate?.options.map((option) => option.id)).toEqual(
      SPEC_APPROVAL_OPTIONS.map((option) => option.id),
    );

    store.applyEvent(
      parsed(
        8,
        frame('human.responded', 8, {
          node: SPEC_GATE_NODE,
          optionId: 'approve',
          at: '2026-08-14T01:40:00.000Z',
          by: 'operator',
        }),
      ),
    );
    expect(store.openGate).toBeNull();
  });

  it('renders the gate, its options and how to answer it', async () => {
    const screen = render(RunGateBanner, {
      props: {
        runId: RUN,
        gate: {
          node: SPEC_GATE_NODE,
          options: SPEC_APPROVAL_OPTIONS.map((option) => ({
            id: option.id,
            label: option.label,
          })),
        },
      },
    });

    const banner = screen.container.querySelector('[data-run-gate-banner]');
    expect(banner?.textContent).toContain(SPEC_GATE_NODE);
    for (const option of SPEC_APPROVAL_OPTIONS) {
      expect(banner?.textContent).toContain(option.label);
    }
    expect(banner?.textContent).toContain(`deflow answer ${RUN} --gate ${SPEC_GATE_NODE}`);
  });

  it('renders nothing at all when no gate is open', () => {
    const screen = render(RunGateBanner, { props: { runId: RUN, gate: null } });
    expect(screen.container.querySelector('[data-run-gate-banner]')).toBeNull();
  });
});

/** The frames above, through the parser the wire actually uses. */
function parsed(seq: number, event: Event): Event {
  const result = parseEvent({
    seq,
    runId: RUN,
    ts: 1_786_670_000_000,
    kind: event.kind,
    v: EVENT_SCHEMAS[event.kind].v,
    epoch: 1,
    payload: event.payload,
  });
  if (result.status !== 'ok') {
    throw new Error(`the spec built an envelope this build cannot read: ${JSON.stringify(result)}`);
  }
  return result.event;
}
