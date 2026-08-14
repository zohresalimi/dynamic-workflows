/**
 * KAR-19.4 AC4 / EPIC-19-S26 — the node output panel over a node that is still
 * running.
 *
 * KAR-17.5 built the panel and gave it one read: the tail, once, on open. That
 * is exactly right for a finished node and is silence for a live one — the same
 * silence the operator reported on 2026-08-12, one surface over. This spec is
 * about the second half: the view **grows** while the node produces, and a
 * dropped connection backfills from the cursor it already holds.
 *
 * The two failures it is written against are named in the scenario:
 *
 *  - **No follow at all.** The panel paints the tail it got at mount and never
 *    changes again, so a node that has been running for eleven minutes shows
 *    whatever it had said at second one.
 *  - **A reconnect that re-fetches from zero.** That is the easy
 *    implementation, and on a long node it duplicates every line already on
 *    screen — worse than losing the connection, because the operator cannot
 *    tell which of the two copies is the live one.
 *
 * The client is injected rather than `globalThis.fetch` monkey-patched, for the
 * same reason as `./node-output.test.ts`: most of what is asserted here is
 * **which request the panel made**, and a spec that only checked what rendered
 * would pass for a panel that downloaded the whole log every second.
 *
 * Verifies: EPIC-19-S26 · KAR-19.4 AC4 · test plan #3
 */
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import { createClient } from '../api/client.ts';
import { forgetTerminalSnapshots } from '../lib/terminal-session.ts';

const RUN = 'run_20260810T101500Z_ac1540';
const NODE = 'n_impl_3';
const T0 = 1_754_812_800_000;

interface Asked {
  readonly fromSeq: string | null;
  readonly limit: string | null;
}

const frame = (seq: number, text: string) => ({
  seq,
  stream: 'agent_json',
  ts: T0 + seq,
  data: `${JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 's-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        messageId: `msg-${String(seq)}`,
      },
    },
  })}\n`,
});

const ndjson = (lines: readonly ReturnType<typeof frame>[]): string =>
  lines.map((line) => `${JSON.stringify(line)}\n`).join('');

/**
 * A daemon whose `/io` answers change between requests, and that can be told to
 * fail — which is what a dropped connection looks like from a client.
 */
class LiveIo {
  readonly asked: Asked[] = [];
  private produced: ReturnType<typeof frame>[] = [];
  private broken = false;

  produce(...frames: readonly ReturnType<typeof frame>[]): void {
    this.produced.push(...frames);
  }

  /** Every seq this node has ever produced, in produced order. */
  producedSeqs(): number[] {
    return this.produced.map((one) => one.seq);
  }

  drop(): void {
    this.broken = true;
  }

  restore(): void {
    this.broken = false;
  }

  client(): ReturnType<typeof createClient> {
    return createClient({
      baseUrl: 'http://127.0.0.1:7777/api',
      fetch: ((input: string | URL | Request) => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        if (!url.pathname.endsWith('/io')) {
          return Promise.resolve(new Response('{}', { status: 404 }));
        }

        const fromSeq = url.searchParams.get('fromSeq');
        this.asked.push({ fromSeq, limit: url.searchParams.get('limit') });
        if (this.broken) return Promise.reject(new Error('connection dropped'));

        // The endpoint's own two modes: `fromSeq` omitted is the tail,
        // `fromSeq` set pages forward with `seq > fromSeq` — never `>=`.
        const cursor = fromSeq === null ? null : Number(fromSeq);
        const page =
          cursor === null ? this.produced : this.produced.filter((one) => one.seq > cursor);
        return Promise.resolve(
          new Response(ndjson(page), {
            status: 200,
            headers: { 'Content-Type': 'application/x-ndjson', 'X-DeFlow-Io-More': 'false' },
          }),
        );
      }) as typeof fetch,
    });
  }
}

let shell: MountedShell;

async function openPanel(io: LiveIo): Promise<MountedShell> {
  shell = await mountShell({
    at: { name: 'run-node-output', params: { runId: RUN, nodeId: NODE } },
    client: io.client(),
  });
  setActivePinia(shell.pinia);
  return shell;
}

/** The message texts currently on screen, in the order they are painted. */
const shown = (mounted: MountedShell): string[] =>
  [...mounted.container.querySelectorAll('[data-acp-message]')].map(
    (row) => row.textContent?.trim() ?? '',
  );

beforeEach(() => {
  setActivePinia(undefined as never);
  forgetTerminalSnapshots();
});

afterEach(() => {
  shell?.unmount();
  forgetTerminalSnapshots();
});

suite('EPIC-19-S26 — the panel grows while the node runs (AC4)', () => {
  it('renders chunks that arrive after it opened, without re-asking for the ones it has', async () => {
    const io = new LiveIo();
    io.produce(frame(101, 'reading the failing test'));
    const mounted = await openPanel(io);

    await expect.poll(() => shown(mounted).length).toBe(1);
    expect(shown(mounted)[0]).toContain('reading the failing test');

    io.produce(frame(102, 'editing the component'), frame(103, 'running the suite'));

    await expect.poll(() => shown(mounted).length).toBe(3);
    expect(shown(mounted).join(' | ')).toContain('running the suite');

    // The follow is a cursor, never a re-read: every request after the first
    // carries a `fromSeq`, and the first carries none because that is what the
    // daemon reads as "the tail".
    expect(io.asked[0]?.fromSeq).toBeNull();
    expect(io.asked.slice(1).every((one) => one.fromSeq !== null)).toBe(true);
  });

  it('backfills from its own cursor after a reconnect, with no gap and no duplicate', async () => {
    const io = new LiveIo();
    io.produce(frame(201, 'first'), frame(202, 'second'));
    const mounted = await openPanel(io);
    await expect.poll(() => shown(mounted).length).toBe(2);

    // The connection goes. Output keeps being produced while it is gone —
    // which is the case the backfill exists for.
    io.drop();
    io.produce(frame(203, 'third'), frame(204, 'fourth'));
    await expect
      .poll(() => io.asked.filter((one) => one.fromSeq !== null).length)
      .toBeGreaterThan(1);
    expect(shown(mounted)).toHaveLength(2);

    io.restore();

    await expect.poll(() => shown(mounted).length).toBe(4);
    // Exactly equal to the produced set: nothing missing, nothing twice.
    expect(shown(mounted).map((text) => text)).toEqual([
      expect.stringContaining('first'),
      expect.stringContaining('second'),
      expect.stringContaining('third'),
      expect.stringContaining('fourth'),
    ]);
    expect(io.producedSeqs()).toEqual([201, 202, 203, 204]);

    // The re-request resumed from the highest seq the panel had applied — 202,
    // the last one it saw — rather than from zero. `seq > fromSeq` is the
    // contract, so the cursor is the seq *seen* and never that plus one.
    const afterDrop = io.asked.filter((one) => one.fromSeq !== null);
    expect(afterDrop.some((one) => one.fromSeq === '202')).toBe(true);
    expect(afterDrop.every((one) => one.fromSeq !== '0')).toBe(true);
  });
});
