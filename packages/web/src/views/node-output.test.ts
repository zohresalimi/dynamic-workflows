/**
 * KAR-17.5 — the output panel in the assembled shell: what it asks for, what it
 * renders, and what it refuses to say.
 *
 * Verifies: EPIC-17-S20 (scenarios 1, 3 and 4), EPIC-17-S21 (scenarios 1 and
 * 3), EPIC-17-S23 (scenarios 1 and 3) · AC1, AC3, AC6, AC7, AC8, AC10
 *
 * The client is injected rather than `globalThis.fetch` monkey-patched, because
 * most of what is asserted here is **which request the panel made** — AC6 is a
 * claim about a URL, and a spec that only checked what rendered would pass for
 * a panel that downloaded a 200 MB log and drew the last screenful of it.
 */
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { type MountedShell, mountShell } from '../../test/shell.ts';

/** KAR-25.1 — the run views are project-scoped now; the value is never
 * asserted on, only threaded through so the named route resolves. */
const PROJECT_ID = 'prj_test';

import { createClient } from '../api/client.ts';
import { ENDED_WITHOUT_RESULT, NO_OUTPUT_AT_ALL } from '../lib/node-output.ts';
import { forgetTerminalSnapshots, liveTerminalCount } from '../lib/terminal-session.ts';
import { useRunStore } from '../stores/useRunStore.ts';

const RUN = 'run_20260810T101500Z_ac1540';
const NODE = 'n_impl_3';
const T0 = 1_754_812_800_000;

interface Asked {
  readonly path: string;
  readonly limit: string | null;
  readonly fromSeq: string | null;
}

const ndjson = (
  lines: readonly { seq: number; stream: string; ts: number; data: string }[],
): string => lines.map((line) => `${JSON.stringify(line)}\n`).join('');

/** A CLI-shim node: ANSI on stdout, which is what xterm is for. */
const shimTail = (count: number) =>
  Array.from({ length: count }, (_unused, index) => ({
    seq: 88_000 + index,
    stream: 'stdout',
    ts: T0 + index,
    data: `[32m✓[0m step ${index} passed\r\n`,
  }));

/** An ACP node: typed JSON-RPC frames, which xterm must never see. */
const acpTail = (over: { readonly withResult: boolean }) => {
  const update = (seq: number, sessionUpdate: unknown) => ({
    seq,
    stream: 'agent_json',
    ts: T0 + seq,
    data: `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's-1', update: sessionUpdate },
    })}\n`,
  });

  const frames = [
    update(91_000, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Reading the failing test.' },
      messageId: 'msg-1',
    }),
    update(91_001, {
      sessionUpdate: 'tool_call',
      toolCallId: 'toolu_1',
      title: 'Read',
      kind: 'read',
      status: 'pending',
      content: [],
    }),
  ];

  if (over.withResult) {
    frames.push({
      seq: 91_002,
      stream: 'agent_json',
      ts: T0 + 91_002,
      data: `${JSON.stringify({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })}\n`,
    });
  }
  return frames;
};

function recordingClient(asked: Asked[], body: string): ReturnType<typeof createClient> {
  return createClient({
    // The daemon serves the API under `/api` on its own origin, which is what
    // `defaultBaseUrl()` builds; naming it here keeps the path assertion below
    // about the real route rather than about this fixture's shape.
    baseUrl: 'http://127.0.0.1:7777/api',
    fetch: ((input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      asked.push({
        path: url.pathname,
        limit: url.searchParams.get('limit'),
        fromSeq: url.searchParams.get('fromSeq'),
      });

      if (url.pathname.endsWith('/io')) {
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/x-ndjson' },
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }) as typeof fetch,
  });
}

let shell: MountedShell;

async function openPanel(body: string, asked: Asked[]): Promise<MountedShell> {
  shell = await mountShell({
    at: { name: 'run-node-output', params: { projectId: PROJECT_ID, runId: RUN, nodeId: NODE } },
    client: recordingClient(asked, body),
  });
  setActivePinia(shell.pinia);
  return shell;
}

beforeEach(() => {
  setActivePinia(undefined as never);
  forgetTerminalSnapshots();
});

afterEach(() => {
  shell?.unmount();
  forgetTerminalSnapshots();
});

suite('EPIC-17-S20 scenario 1 / AC6 — the reattach asks for the tail', () => {
  it('sets limit and omits fromSeq on the very first request', async () => {
    const asked: Asked[] = [];
    await openPanel(ndjson(shimTail(40)), asked);

    await expect
      .poll(() => asked.filter((one) => one.path.endsWith('/io')).length)
      .toBeGreaterThan(0);

    const io = asked.filter((one) => one.path.endsWith('/io'));
    expect(io[0]?.path).toBe(`/api/runs/${RUN}/nodes/${NODE}/io`);
    expect(io[0]?.limit).not.toBeNull();
    // The whole claim: no cursor on the first ask, which is what the daemon
    // reads as "the tail" rather than "page forward from the beginning".
    expect(io[0]?.fromSeq).toBeNull();
  });

  it('configures the terminal with scrollback 5,000 for a shim node (AC3)', async () => {
    const asked: Asked[] = [];
    const mounted = await openPanel(ndjson(shimTail(40)), asked);

    await expect.poll(() => mounted.container.querySelector('[data-terminal]')).not.toBeNull();

    const host = mounted.container.querySelector('[data-terminal]') as HTMLElement;
    expect(host.getAttribute('data-scrollback')).toBe('5000');
    expect(liveTerminalCount()).toBe(1);
  });
});

suite('EPIC-17-S21 — an ACP node gets the typed list and no terminal', () => {
  it('renders typed messages and constructs no Terminal', async () => {
    const asked: Asked[] = [];
    const mounted = await openPanel(ndjson(acpTail({ withResult: true })), asked);

    await expect
      .poll(() => mounted.container.querySelectorAll('[data-acp-message]').length)
      .toBeGreaterThan(0);

    expect(
      [...mounted.container.querySelectorAll('[data-acp-message]')].map((row) =>
        row.getAttribute('data-kind'),
      ),
    ).toEqual(['agent_message_chunk', 'tool_call']);
    expect(liveTerminalCount()).toBe(0);
    expect(mounted.container.querySelector('[data-terminal]')).toBeNull();
  });
});

suite('AC10 — the two things the panel says honestly', () => {
  it('says a node produced no output at all, rather than showing an empty terminal', async () => {
    const asked: Asked[] = [];
    const mounted = await openPanel('', asked);

    await expect.poll(() => mounted.container.textContent ?? '').toContain(NO_OUTPUT_AT_ALL);
    expect(liveTerminalCount()).toBe(0);
    expect(mounted.container.querySelector('[data-terminal]')).toBeNull();
  });

  it('says when the adapter’s output ended without a result envelope', async () => {
    const asked: Asked[] = [];
    const mounted = await openPanel(ndjson(acpTail({ withResult: false })), asked);

    await expect.poll(() => mounted.container.textContent ?? '').toContain(ENDED_WITHOUT_RESULT);
  });

  it('does not claim a truncation when the turn actually finished', async () => {
    const asked: Asked[] = [];
    const mounted = await openPanel(ndjson(acpTail({ withResult: true })), asked);

    await expect
      .poll(() => mounted.container.querySelectorAll('[data-acp-message]').length)
      .toBeGreaterThan(0);
    expect(mounted.container.textContent ?? '').not.toContain(ENDED_WITHOUT_RESULT);
  });
});

suite('AC8 — io_chunk never reaches the run store', () => {
  it('leaves the store’s event ring and node set untouched by 400 chunks', async () => {
    const asked: Asked[] = [];
    const mounted = await openPanel(ndjson(shimTail(400)), asked);
    const run = useRunStore(mounted.pinia);

    await expect.poll(() => mounted.container.querySelector('[data-terminal]')).not.toBeNull();

    const counts = run.counts();
    // The data plane is physically separate from the control plane in the
    // ledger (`packages/ledger/src/io-chunk.ts`), and it stays separate here:
    // 400 chunks of agent output arrived and the projection store did not move.
    expect(counts.events).toBe(0);
    expect(counts.nodes).toBe(0);
    expect(counts.facts).toBe(0);
  });

  it('registers the live terminal with the store, so the leak assertion can see it', async () => {
    const asked: Asked[] = [];
    const mounted = await openPanel(ndjson(shimTail(40)), asked);
    const run = useRunStore(mounted.pinia);

    await expect.poll(() => run.counts().terminals).toBe(1);

    mounted.unmount();
    expect(run.counts().terminals).toBe(0);
    expect(liveTerminalCount()).toBe(0);
  });
});

suite('EPIC-17-S23 scenario 1 — "Open full log"', () => {
  it('offers the archive, and says why when the ledger carries no handle for it', async () => {
    const asked: Asked[] = [];
    const mounted = await openPanel(ndjson(shimTail(40)), asked);

    await expect.poll(() => mounted.container.querySelector('[data-open-full-log]')).not.toBeNull();

    const button = mounted.container.querySelector('[data-open-full-log]') as HTMLButtonElement;
    // This run's node has completed nothing, so it has published no artifact
    // handle. A button that opened an empty viewer would be worse than one that
    // says what is missing.
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title') ?? '').toMatch(/archive/i);
  });
});
