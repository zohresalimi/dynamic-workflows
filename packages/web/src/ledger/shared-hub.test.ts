/**
 * KAR-25.7 — the tab's one connection, held open for a global lifecycle
 * listener and a per-run watch at the same time.
 *
 * Verifies: EPIC-25-S42, EPIC-25-S48 (the "one ledger, three renderings"
 * premise) — this is the plumbing under all three surfaces, not a surface
 * itself, so what is asserted here is the property the module's own header
 * comment names: two different consumers, one socket. `../../test/sse-origin.ts`
 * is a real `node:http` server counting streams from the server side, for the
 * same reason `./stream.test.ts` uses it rather than a mock.
 */
import type { Event } from '@DeFlow/core';
import { afterEach, beforeEach, expect, inject, it, describe as suite, vi } from 'vitest';
import { resetSharedHub, watchLifecycle, watchRun } from './shared-hub.ts';

const ORIGIN = inject('sseOrigin');
const BASE = `${ORIGIN}/api`;

const RUN_A = 'run_20260811T093000Z_aa0001';
const RUN_B = 'run_20260811T093000Z_bb0002';

function scratchStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

interface StreamsSeen {
  readonly open: number;
}

const streamsSeen = async (): Promise<StreamsSeen> =>
  (await fetch(`${ORIGIN}/__streams`)).json() as Promise<StreamsSeen>;

async function post(path: string, body: unknown): Promise<void> {
  await fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(body),
  });
}

const emit = (runs: readonly string[], extra: { kind?: string; seqs?: number[] } = {}) =>
  post('/__emit', { runs, ...extra });

beforeEach(async () => {
  resetSharedHub();
  await post('/__reset', {});
});

afterEach(async () => {
  resetSharedHub();
  await vi.waitFor(async () => expect((await streamsSeen()).open).toBe(0), { timeout: 10_000 });
});

suite('KAR-25.7 — one connection, shared by every consumer', () => {
  it('opens one connection for a lifecycle watch and a run watch together', async () => {
    const lifecycle: Event[] = [];
    const lc = watchLifecycle((event) => lifecycle.push(event), {
      baseUrl: BASE,
      storage: scratchStorage(),
    });
    await lc.ready;

    const applied: Event[] = [];
    const rw = watchRun(
      RUN_A,
      {
        applyEvent(event) {
          applied.push(event);
          return true;
        },
      },
      { baseUrl: BASE, storage: scratchStorage() },
    );
    await rw.ready;

    // Two consumers, and the origin still counts one open stream.
    expect((await streamsSeen()).open).toBe(1);

    // A frame for the watched run reaches the run's own sink...
    await emit([RUN_A]);
    await vi.waitFor(() => expect(applied).toHaveLength(1), { timeout: 10_000 });

    // ...and a lifecycle frame for a run *nobody* watched — RUN_B, never
    // named in `watchRun` — reaches the lifecycle listener on the very same
    // connection, exactly as `?runs=*` is supposed to.
    await emit([RUN_B], { kind: 'run.completed' });
    await vi.waitFor(
      () => expect(lifecycle.some((event) => event.kind === 'run.completed')).toBe(true),
      { timeout: 10_000 },
    );

    // Closing the run watch leaves the lifecycle listener's connection alone —
    // there is one hub, not one per consumer, and unwatching a run is a filter
    // change, never a socket closing under a sibling listener.
    rw.close();
    expect((await streamsSeen()).open).toBe(1);

    lc.close();
  });

  it('fans one lifecycle frame out to every registered listener', async () => {
    const first: Event[] = [];
    const second: Event[] = [];
    const a = watchLifecycle((event) => first.push(event), {
      baseUrl: BASE,
      storage: scratchStorage(),
    });
    await a.ready;
    const b = watchLifecycle((event) => second.push(event), {
      baseUrl: BASE,
      storage: scratchStorage(),
    });
    await b.ready;

    expect((await streamsSeen()).open).toBe(1);

    await emit([RUN_A], { kind: 'run.completed' });
    await vi.waitFor(() => expect(first).toHaveLength(1), { timeout: 10_000 });
    expect(second).toHaveLength(1);

    a.close();
    b.close();
  });
});
