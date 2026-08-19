/**
 * KAR-22.5 — answering a run's human gate from the browser, in a real Chromium.
 *
 * Verifies: EPIC-22-S58, EPIC-22-S59, EPIC-22-S61, EPIC-22-S62, EPIC-22-S65,
 * EPIC-22-S66, EPIC-22-S67 · AC1–AC8 · test plan #2, #3, #4, #5, #6, #9, #10,
 * #11
 *
 * The API client here is the **real** one (`../api/client.ts`) over an injected
 * `fetch`, rather than a hand-written object with the two methods the view
 * happens to call. That is the whole point of the file: what AC2 claims is that
 * the browser puts the same **URL** and the same **body** on the wire that
 * `deflow answer` does, and a fake client that never builds a URL cannot say
 * anything about it. So every assertion below is against the request that
 * actually left, compared with `gateAnswerRequest`'s own answer.
 *
 * The gate itself arrives the way it arrives in production — as a
 * `human.requested` frame poured into the very sink `../ledger/feed.ts` pours
 * into — so the path from frame to button is the shipped one.
 */
import type { Event } from '@DeFlow/core';
import {
  EVENT_SCHEMAS,
  gateAnswerRequest,
  parseEvent,
  SPEC_APPROVAL_OPTIONS,
  SPEC_GATE_NODE,
} from '@DeFlow/core';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import { type MountedShell, mountShell, TEST_TOKEN } from '../../test/shell.ts';
import { createClient } from '../api/client.ts';
import type { RunFeed, RunFeedFactory, RunFeedOptions } from '../ledger/feed.ts';
import type { RunsFeed, RunsFeedFactory } from '../ledger/runs-feed.ts';

const PROJECT = 'prj_20260815T101112Z_a1b2c3';
const GATED_RUN = 'run_20260815T090000Z_b17e55';
const QUIET_RUN = 'run_20260815T080000Z_44aa10';
const ORIGIN = 'http://daemon.test';
const T0 = 1_786_800_000_000;

/** The gate node a permission escalation opens — not the F1.3 one (AC8). */
const PERMISSION_NODE = 'escalate-write';

/** The rendered spec the F1.3 gate carries, in `renderSpecForReview`'s shape. */
const SPEC_PROMPT = [
  'Goal',
  'Migrate the checkout module',
  '',
  'In scope',
  '- the checkout module',
  '',
  'Non-goals',
  '- rewriting billing',
  '',
  'Constraints',
  '- no schema change',
  '',
  'Acceptance criteria',
  '- ac-1: it migrates (verified by build)',
  '',
  'Known failure modes',
  '- fm-1: the cart empties — detected by: the cart gate',
].join('\n');

/* -------------------------------------------------------------------------- *
 * the wire
 * -------------------------------------------------------------------------- */

interface SentRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
}

interface Wire {
  readonly sent: SentRequest[];
  /** The next answer for a POST, or `null` for the ordinary `200 {}`. */
  refuseWith: { readonly status: number; readonly body: unknown } | null;
  /** `GET /api/approvals`'s `items` — KAR-25.7's approvals control suites. */
  approvals: readonly unknown[];
}

const wire: Wire = { sent: [], refuseWith: null, approvals: [] };

/** One row of the project's history, as `runEntry` sends it. */
function historyRow(runId: string, gate: unknown): Record<string, unknown> {
  return {
    runId,
    status: gate === null ? 'completed' : 'needs-human',
    label: gate === null ? 'completed' : 'needs a decision',
    title: 'Migrate the checkout module',
    createdAt: new Date(T0).toISOString(),
    headSeq: 7,
    planVersion: 0,
    cost: null,
    gate,
  };
}

/** The gate `pendingGate` puts on a waiting run's list row. */
const SPEC_GATE_ROW = {
  node: SPEC_GATE_NODE,
  prompt: SPEC_PROMPT,
  options: SPEC_APPROVAL_OPTIONS.map((option) => ({ id: option.id, label: option.label })),
  requestedSeq: 7,
  specApproval: true,
  reason: null,
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The daemon, as far as this file is concerned: four reads and every answer. */
async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : String((input as Request).url ?? input));
  const method = (init?.method ?? 'GET').toUpperCase();
  const raw = init?.body;
  const body = typeof raw === 'string' && raw !== '' ? (JSON.parse(raw) as unknown) : null;
  wire.sent.push({ method, pathname: url.pathname, body });

  if (method === 'POST') {
    const refusal = wire.refuseWith;
    return refusal === null ? reply({ ok: true }) : reply(refusal.body, refusal.status);
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
    return reply({ runs: [historyRow(GATED_RUN, SPEC_GATE_ROW), historyRow(QUIET_RUN, null)] });
  }
  if (url.pathname === '/api/runs') return reply({ runs: [], cursor: null, more: false });
  if (url.pathname === '/api/approvals') {
    return reply({ items: wire.approvals, counts: {}, headSeq: 0 });
  }
  if (url.pathname === '/api/providers/routes') return reply({ providers: [], known: false });
  // The hydrate the run feed would make; this file pushes frames itself.
  return reply({ events: [], cursor: 0, more: false, headSeq: 0 });
}

/* -------------------------------------------------------------------------- *
 * frames
 * -------------------------------------------------------------------------- */

function frame(kind: string, seq: number, payload: unknown, runId: string = GATED_RUN): Event {
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

const specGateOpened = (): Event =>
  frame('human.requested', 7, {
    node: SPEC_GATE_NODE,
    prompt: SPEC_PROMPT,
    options: SPEC_APPROVAL_OPTIONS.map((option) => ({ ...option })),
  });

const permissionGateOpened = (): Event =>
  frame('human.requested', 7, {
    node: PERMISSION_NODE,
    prompt: 'The agent asked to write outside its worktree.',
    options: [
      { id: 'allow', label: 'Allow this write once', effect: 'approve' },
      { id: 'deny', label: 'Refuse it', effect: 'reject' },
    ],
    reason: { code: 'path-outside-scope', detail: 'the target resolves outside the worktree' },
  });

const answered = (node: string, optionId: string): Event =>
  frame('human.responded', 8, {
    node,
    optionId,
    at: new Date(T0 + 60_000).toISOString(),
    by: 'operator',
  });

/* -------------------------------------------------------------------------- *
 * the shell
 * -------------------------------------------------------------------------- */

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

const one = <T extends Element = HTMLElement>(selector: string): T | null =>
  shell.container.querySelector<T>(selector);

const all = (selector: string): HTMLElement[] => [
  ...shell.container.querySelectorAll<HTMLElement>(selector),
];

const panel = (): HTMLElement | null => one('[data-run-gate-banner]');

const optionButton = (id: string): HTMLButtonElement | null =>
  one<HTMLButtonElement>(`[data-gate-option="${id}"]`);

const posts = (): SentRequest[] => wire.sent.filter((request) => request.method === 'POST');

function push(event: Event): void {
  const feed = opened.at(-1);
  if (feed === undefined) throw new Error('the workspace opened no run feed');
  feed.sink.applyEvent(event);
}

/** The workspace of the project whose newest run is waiting on the F1.3 gate. */
async function openGatedWorkspace(open: () => Event = specGateOpened): Promise<void> {
  shell = await mountShell({
    at: `/projects/${PROJECT}`,
    client: createClient({ baseUrl: `${ORIGIN}/api`, token: () => TEST_TOKEN, fetch: serve }),
    feed: feedFactory,
  });
  setActivePinia(shell.pinia);
  await expect.poll(() => opened.length, { timeout: 15_000 }).toBeGreaterThan(0);
  push(open());
  await expect.poll(() => panel(), { timeout: 15_000 }).not.toBeNull();
}

beforeEach(() => {
  wire.sent.length = 0;
  wire.refuseWith = null;
  wire.approvals = [];
  opened = [];
  setActivePinia(undefined as never);
});

afterEach(() => {
  shell?.unmount();
});

suite('EPIC-22-S58 — the run’s open gate is answered from the browser', () => {
  it('names the gate and offers every option the daemon offered', async () => {
    await openGatedWorkspace();

    expect(one('[data-run-gate-node]')?.textContent).toContain(SPEC_GATE_NODE);
    expect(all('[data-gate-option]').map((button) => button.dataset.gateOption)).toEqual(
      SPEC_APPROVAL_OPTIONS.map((option) => option.id),
    );
    // The labels are the gate's own, never the page's (R4).
    for (const option of SPEC_APPROVAL_OPTIONS) {
      expect(optionButton(option.id)?.textContent).toContain(option.label);
    }
  });

  it('approves over the endpoint deflow answer uses, with that endpoint’s body', async () => {
    await openGatedWorkspace();
    const expected = gateAnswerRequest({
      runId: GATED_RUN,
      gate: SPEC_GATE_NODE,
      optionId: 'approve',
    });

    await userEvent.click(optionButton('approve') as HTMLElement);
    await expect.poll(() => posts().length, { timeout: 15_000 }).toBe(1);

    const sent = posts()[0] as SentRequest;
    expect(sent.pathname).toBe(expected?.path);
    expect(sent.body).toEqual(expected?.body);
  });

  it('sends the operator’s reason on a rejection, in the field that route reads', async () => {
    await openGatedWorkspace();
    const expected = gateAnswerRequest({
      runId: GATED_RUN,
      gate: SPEC_GATE_NODE,
      optionId: 'reject',
      text: 'the scope is wrong',
    });

    await userEvent.click(one('[data-gate-text]') as HTMLElement);
    await userEvent.fill(one('[data-gate-text]') as HTMLElement, 'the scope is wrong');
    await userEvent.click(optionButton('reject') as HTMLElement);
    await expect.poll(() => posts().length, { timeout: 15_000 }).toBe(1);

    const sent = posts()[0] as SentRequest;
    expect(sent.pathname).toBe(expected?.path);
    expect(sent.body).toEqual(expected?.body);
  });
});

suite('EPIC-22-S59 — the spec is readable before it is approved', () => {
  it('renders the gate’s own prompt, section by section, before anything is pressed', async () => {
    await openGatedWorkspace();

    const prompt = one('[data-run-gate-prompt]')?.textContent ?? '';
    for (const section of [
      'Goal',
      'In scope',
      'Non-goals',
      'Constraints',
      'Acceptance criteria',
      'Known failure modes',
    ]) {
      expect(prompt).toContain(section);
    }
    expect(prompt).toContain('Migrate the checkout module');
    expect(posts()).toHaveLength(0);
  });
});

suite('EPIC-22-S61 — edit is offered honestly or not at all', () => {
  it('lists edit, refuses to submit it, and says why in the shipped sentence', async () => {
    await openGatedWorkspace();

    const edit = optionButton('edit');
    expect(edit).not.toBeNull();
    expect(edit?.disabled).toBe(true);
    expect(one('[data-gate-option-reason="edit"]')?.textContent).toContain(
      'DeFlow.taskspecdraft.v1',
    );

    edit?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posts()).toHaveLength(0);
  });
});

suite('EPIC-22-S62 — answering resolves the gate live', () => {
  it('clears the panel when the answer’s own frame arrives, with no reload', async () => {
    await openGatedWorkspace();

    await userEvent.click(optionButton('approve') as HTMLElement);
    await expect.poll(() => posts().length, { timeout: 15_000 }).toBe(1);

    // Still on screen: the POST returned, and the panel is cleared by the
    // ledger's own event rather than by its own optimism.
    expect(panel()).not.toBeNull();

    push(answered(SPEC_GATE_NODE, 'approve'));
    await expect.poll(() => panel(), { timeout: 15_000 }).toBeNull();

    // And nothing re-fetched the run to find that out.
    expect(wire.sent.filter((request) => request.pathname === `/api/runs/${GATED_RUN}`)).toEqual(
      [],
    );
  });

  it('clears the panel for an answer this tab never sent (AC6)', async () => {
    await openGatedWorkspace();

    // The CLI answered it. The only thing that reaches this tab is the frame.
    push(answered(SPEC_GATE_NODE, 'abandon'));

    await expect.poll(() => panel(), { timeout: 15_000 }).toBeNull();
    expect(posts()).toHaveLength(0);
  });
});

suite('EPIC-22-S65 — the conflict is the daemon’s sentence, and the buttons go', () => {
  it('renders a 409 verbatim, stops offering options and retries nothing', async () => {
    await openGatedWorkspace();
    wire.refuseWith = {
      status: 409,
      body: {
        error: {
          code: 'already_answered',
          message: "the 'spec-approval' gate was answered with 'approve' at 01:40 by operator",
          detail: { response: { optionId: 'approve', by: 'operator' } },
          retryable: false,
        },
      },
    };

    await userEvent.click(optionButton('approve') as HTMLElement);

    await expect
      .poll(() => one('[data-gate-error]')?.textContent, { timeout: 15_000 })
      .toContain("was answered with 'approve'");
    expect(all('[data-gate-option]')).toEqual([]);
    expect(posts()).toHaveLength(1);
  });
});

suite('EPIC-22-S66 — a waiting run is findable without opening it', () => {
  it('marks the waiting run in the project’s history and leaves the other alone', async () => {
    await openGatedWorkspace();

    await expect
      .poll(() => one(`[data-history-gate="${GATED_RUN}"]`)?.textContent, { timeout: 15_000 })
      .toContain(SPEC_GATE_NODE);
    expect(one(`[data-history-gate="${QUIET_RUN}"]`)).toBeNull();
  });
});

suite('EPIC-22-S67 — a permission escalation uses the same surface', () => {
  it('renders in the same panel and answers on nodes/:nodeId/respond', async () => {
    await openGatedWorkspace(permissionGateOpened);
    const expected = gateAnswerRequest({
      runId: GATED_RUN,
      gate: PERMISSION_NODE,
      optionId: 'deny',
    });

    expect(one('[data-run-gate-node]')?.textContent).toContain(PERMISSION_NODE);
    expect(all('[data-gate-option]').map((button) => button.dataset.gateOption)).toEqual([
      'allow',
      'deny',
    ]);
    // Nothing about this gate is spec-shaped, so nothing is disabled.
    expect(optionButton('deny')?.disabled).toBe(false);

    await userEvent.click(optionButton('deny') as HTMLElement);
    await expect.poll(() => posts().length, { timeout: 15_000 }).toBe(1);

    const sent = posts()[0] as SentRequest;
    expect(sent.pathname).toBe(expected?.path);
    expect(sent.body).toEqual(expected?.body);
  });
});

/* -------------------------------------------------------------------------- *
 * KAR-25.7 — the approvals control (topbar), and the same frame clearing all
 * of it and the run's own gate panel together.
 * -------------------------------------------------------------------------- */

/** Portalled to `document.body`, like the inspector — queried from `document`
 * rather than from `shell.container` for the same reason. */
const docOne = <T extends Element = HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);
const docAll = (selector: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(selector),
];

/** One row of `GET /api/approvals`, in the shape `useApprovalsStore.hydrate`
 * reads — `ApprovalRowIn`, copied rather than imported so this file keeps
 * asserting against the wire shape rather than against the store's own type. */
function approvalItem(
  runId: string,
  node: string,
  prompt: string,
  options: readonly { readonly id: string; readonly label: string }[] = [
    { id: 'approve', label: 'Ship it' },
  ],
): Record<string, unknown> {
  return { runId, kind: 'human-node', node, prompt, options, seq: 7 };
}

/** A `?runs=*` feed a spec pushes frames into — `../../views/run-list.test.ts`'s
 * own `pushableFeed()`, copied here rather than imported: it is test-only and
 * this file already keeps its own small doubles rather than reaching across
 * suites for one. */
function pushableRunsFeed(): { factory: RunsFeedFactory; push: (event: Event) => void } {
  // A set, not one slot: the real shared hub (`../ledger/shared-hub.ts`) fans
  // one lifecycle frame out to every listener — `App.vue`'s `useApprovals`
  // always registers one, and a route that also reads the topic (the run
  // list, the project run history) registers another on the very same
  // connection. A fake that remembered only the last caller would look
  // correct with one listener and silently starve every one before it.
  const listeners = new Set<(event: Event) => void>();
  const factory: RunsFeedFactory = (options): RunsFeed => {
    listeners.add(options.onLifecycle);
    return { ready: Promise.resolve(), close: () => listeners.delete(options.onLifecycle) };
  };
  return {
    factory,
    push: (event) => {
      if (listeners.size === 0) throw new Error('the shell opened no ?runs=* subscription');
      for (const listener of listeners) listener(event);
    },
  };
}

const approvalsTrigger = (): HTMLButtonElement | null =>
  docOne<HTMLButtonElement>('[data-approvals-trigger]');

suite('EPIC-25-S42, AC1 — a gate announced globally is reached and answered globally', () => {
  it('reaches the gate through the approvals control and answers it, with no URL and no terminal', async () => {
    wire.approvals = [approvalItem(GATED_RUN, SPEC_GATE_NODE, 'Ship it?')];
    const runsFeed = pushableRunsFeed();

    shell = await mountShell({
      at: '/projects',
      client: createClient({ baseUrl: `${ORIGIN}/api`, token: () => TEST_TOKEN, fetch: serve }),
      runsFeed: runsFeed.factory,
    });
    setActivePinia(shell.pinia);

    await expect.poll(() => approvalsTrigger(), { timeout: 15_000 }).not.toBeNull();
    expect(approvalsTrigger()?.getAttribute('data-approvals')).toBe('1');

    await userEvent.click(approvalsTrigger() as HTMLElement);
    await expect.poll(() => docOne('[data-approval-entry]'), { timeout: 15_000 }).not.toBeNull();

    const expected = gateAnswerRequest({
      runId: GATED_RUN,
      gate: SPEC_GATE_NODE,
      optionId: 'approve',
    });
    await userEvent.click(docOne('[data-gate-option="approve"]') as HTMLElement);
    await expect.poll(() => posts().length, { timeout: 15_000 }).toBe(1);

    const sent = posts()[0] as SentRequest;
    expect(sent.pathname).toBe(expected?.path);
    expect(sent.body).toEqual(expected?.body);
  });
});

suite(
  'EPIC-25-S43, EPIC-25-S44 — the control names every waiting run and node, or is absent',
  () => {
    it('lists one entry per waiting gate, each naming its run and its node', async () => {
      const otherRun = 'run_20260815T091500Z_dd44aa';
      wire.approvals = [
        approvalItem(GATED_RUN, SPEC_GATE_NODE, 'Ship it?'),
        approvalItem(otherRun, 'escalate-write', 'Write outside the worktree?', [
          { id: 'allow', label: 'Allow once' },
        ]),
      ];

      shell = await mountShell({
        at: '/projects',
        client: createClient({ baseUrl: `${ORIGIN}/api`, token: () => TEST_TOKEN, fetch: serve }),
        runsFeed: pushableRunsFeed().factory,
      });
      setActivePinia(shell.pinia);

      await expect.poll(() => approvalsTrigger(), { timeout: 15_000 }).not.toBeNull();
      await userEvent.click(approvalsTrigger() as HTMLElement);

      await expect.poll(() => docAll('[data-approval-entry]').length, { timeout: 15_000 }).toBe(2);
      expect(
        docOne(`[data-approval-entry="${GATED_RUN}"] [data-approval-run]`)?.textContent,
      ).toContain(GATED_RUN);
      expect(
        docOne(`[data-approval-entry="${GATED_RUN}"] [data-approval-node]`)?.textContent,
      ).toContain(SPEC_GATE_NODE);
      expect(
        docOne(`[data-approval-entry="${otherRun}"] [data-approval-node]`)?.textContent,
      ).toContain('escalate-write');
    });

    it('renders no control at all when nothing is waiting — never an empty panel', async () => {
      wire.approvals = [];

      shell = await mountShell({
        at: '/projects',
        client: createClient({ baseUrl: `${ORIGIN}/api`, token: () => TEST_TOKEN, fetch: serve }),
        runsFeed: pushableRunsFeed().factory,
      });
      setActivePinia(shell.pinia);

      // Give the hydrate a turn to land, if it were going to render something.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(approvalsTrigger()).toBeNull();
      expect(docOne('[data-approvals-list]')).toBeNull();
    });
  },
);

suite(
  'EPIC-25-S48, EPIC-25-S49 — one human.responded frame clears the run’s panel and the control together',
  () => {
    it('leaves the answer’s own POST on screen until the frame arrives, then clears both surfaces, from the ledger', async () => {
      wire.approvals = [approvalItem(GATED_RUN, SPEC_GATE_NODE, 'Ship it?')];
      const runsFeed = pushableRunsFeed();

      shell = await mountShell({
        at: `/projects/${PROJECT}`,
        client: createClient({ baseUrl: `${ORIGIN}/api`, token: () => TEST_TOKEN, fetch: serve }),
        feed: feedFactory,
        runsFeed: runsFeed.factory,
      });
      setActivePinia(shell.pinia);
      await expect.poll(() => opened.length, { timeout: 15_000 }).toBeGreaterThan(0);
      push(specGateOpened());
      await expect.poll(() => panel(), { timeout: 15_000 }).not.toBeNull();
      await expect.poll(() => approvalsTrigger(), { timeout: 15_000 }).not.toBeNull();

      await userEvent.click(optionButton('approve') as HTMLElement);
      await expect.poll(() => posts().length, { timeout: 15_000 }).toBe(1);

      // AC5 — no "did my own request succeed" special case: both surfaces are
      // still showing the gate, because the POST resolving is not the ledger
      // saying the gate is answered.
      expect(panel()).not.toBeNull();
      expect(approvalsTrigger()).not.toBeNull();

      // The one frame that closes it — indistinguishable here from one
      // `deflow answer` in a terminal would produce (AC6): this tab did not
      // send it, it arrived on both of its subscriptions.
      const responded = answered(SPEC_GATE_NODE, 'approve');
      push(responded);
      runsFeed.push(responded);

      await expect.poll(() => panel(), { timeout: 15_000 }).toBeNull();
      await expect.poll(() => approvalsTrigger(), { timeout: 15_000 }).toBeNull();
    });
  },
);

suite('KAR-25.7 AC3 — the project run history’s gate opens live, from the ledger', () => {
  it('marks a quiet row the moment human.requested arrives, with no refetch', async () => {
    wire.approvals = [];
    const runsFeed = pushableRunsFeed();

    shell = await mountShell({
      at: `/projects/${PROJECT}`,
      client: createClient({ baseUrl: `${ORIGIN}/api`, token: () => TEST_TOKEN, fetch: serve }),
      feed: feedFactory,
      runsFeed: runsFeed.factory,
    });
    setActivePinia(shell.pinia);

    // QUIET_RUN is in the fetched history with `gate: null` — the state an
    // operator is in when a run they are watching has not stopped yet.
    await expect
      .poll(() => one(`[data-history-gate="${GATED_RUN}"]`), { timeout: 15_000 })
      .not.toBeNull();
    expect(one(`[data-history-gate="${QUIET_RUN}"]`)).toBeNull();

    const before = wire.sent.filter((request) => request.pathname.includes('/runs')).length;

    // The announcing half of a gate's life. Before KAR-25.7's correction this
    // view folded only `human.responded`, so this frame changed nothing and the
    // row stayed quiet until the page was reloaded.
    runsFeed.push(
      frame(
        'human.requested',
        9,
        {
          node: PERMISSION_NODE,
          prompt: 'The agent asked to write outside its worktree.',
          options: [
            { id: 'allow', label: 'Allow this write once', effect: 'approve' },
            { id: 'deny', label: 'Refuse it', effect: 'reject' },
          ],
          reason: { code: 'path-outside-scope', detail: 'the target resolves outside the worktree' },
        },
        QUIET_RUN,
      ),
    );

    await expect
      .poll(() => one(`[data-history-gate="${QUIET_RUN}"]`), { timeout: 15_000 })
      .not.toBeNull();
    expect(one(`[data-history-gate="${QUIET_RUN}"]`)?.textContent).toContain(PERMISSION_NODE);
    // The gated row is somebody else's gate and is left exactly as it was.
    expect(one(`[data-history-gate="${GATED_RUN}"]`)?.textContent).toContain(SPEC_GATE_NODE);
    expect(wire.sent.filter((request) => request.pathname.includes('/runs')).length).toBe(before);
  });
});

suite('KAR-25.7 AC3 — the project run history’s gate clears live, from the ledger', () => {
  it('carries the gate’s options and clears the row on human.responded, with no refetch', async () => {
    wire.approvals = [];
    const runsFeed = pushableRunsFeed();

    shell = await mountShell({
      at: `/projects/${PROJECT}`,
      client: createClient({ baseUrl: `${ORIGIN}/api`, token: () => TEST_TOKEN, fetch: serve }),
      feed: feedFactory,
      runsFeed: runsFeed.factory,
    });
    setActivePinia(shell.pinia);

    await expect
      .poll(() => one(`[data-history-gate="${GATED_RUN}"]`), { timeout: 15_000 })
      .not.toBeNull();
    expect(one(`[data-history-gate="${GATED_RUN}"]`)?.textContent).toContain(SPEC_GATE_NODE);

    const before = wire.sent.filter((request) => request.pathname.includes('/runs')).length;

    // The frame this view never asked for — no subscription of its own beyond
    // the shared `?runs=*` topic every `human.responded` now rides.
    runsFeed.push(answered(SPEC_GATE_NODE, 'approve'));

    await expect
      .poll(() => one(`[data-history-gate="${GATED_RUN}"]`), { timeout: 15_000 })
      .toBeNull();
    expect(wire.sent.filter((request) => request.pathname.includes('/runs')).length).toBe(before);
  });
});
