/**
 * KAR-01.3 — the one-command dev loop, end to end, against the real `pnpm dev`
 * script and a real `node --watch` supervisor.
 *
 * Verifies: EPIC-01-S1 (scenarios 1 and 3), EPIC-01-S9 (scenario 1),
 * EPIC-01-S12 (scenario 1) · AC1, AC2, AC3, AC4, AC10
 *
 * Not covered here, deliberately: EPIC-01-S10 (effects left pending) and the
 * first and third scenarios of EPIC-01-S11 (the reducer refusing an unknown
 * event kind, `DeFlow ledger snapshot`). There is no ledger and no orchestrator
 * at this point in the backlog; those land with KAR-03.8 and KAR-06.9. This
 * story delivers the process shape and the restart, which is what those
 * scenarios will hang from.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe as suite, expect, it } from 'vitest';
import {
  health,
  listeningSockets,
  repoRoot,
  sleep,
  startDevLoop,
  waitForRestart,
  type DevLoop,
} from './support/dev-loop.ts';
import { openHmrSocket, openSse } from './support/streams.ts';

const ENGINE_FILE = 'packages/core/src/index.ts';
const SFC_FILE = 'packages/web/src/components/HelloDeFlow.vue';

/** Edit a real source file and put it back exactly as it was. */
async function withEdit(relativePath: string, edit: (text: string) => string, body: () => Promise<void>) {
  const absolute = join(repoRoot, relativePath);
  const original = readFileSync(absolute, 'utf8');
  try {
    writeFileSync(absolute, edit(original));
    await body();
  } finally {
    writeFileSync(absolute, original);
  }
}

suite('the dev loop', () => {
  let loop: DevLoop;

  beforeAll(async () => {
    loop = await startDevLoop();
  }, 60_000);

  afterAll(async () => {
    await loop?.stop();
  });

  it('serves from exactly one listening socket (AC1, EPIC-01-S1)', async () => {
    const current = await health(loop.origin);
    const sockets = listeningSockets(current.pid);
    expect(
      sockets,
      `expected one socket, got ${JSON.stringify(sockets)} — a second one means Vite opened its own HMR server and D10's premise fails`,
    ).toHaveLength(1);
    expect(sockets[0]?.port).toBe(loop.port);
    expect(sockets[0]?.address).toBe('127.0.0.1');
  });

  it('serves the API from Hono and the Vue app from / on that one port (AC2)', async () => {
    const api = await fetch(`${loop.origin}/api/health`);
    expect(api.status).toBe(200);
    expect(api.headers.get('content-type')).toContain('application/json');

    const ui = await fetch(`${loop.origin}/`);
    expect(ui.status).toBe(200);
    expect(ui.headers.get('content-type')).toContain('text/html');
    const html = await ui.text();
    expect(html).toContain('id="app"');
  });

  it('needs no CORS header, because there is one origin (AC2)', async () => {
    const response = await fetch(`${loop.origin}/api/health`, {
      headers: { origin: loop.origin },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reaches the first 200 well inside the NF3 cold-start budget (AC10)', () => {
    // Recorded in docs/CONTRIBUTING.md; the budget is 3 s from `pnpm dev`.
    // eslint-disable-next-line no-console
    console.log(`cold start to first 200 on /api/health: ${loop.coldStartMs.toFixed(0)} ms`);
    expect(loop.coldStartMs).toBeLessThan(3_000);
  });

  it('restarts within 2 s when engine code is saved (AC3, EPIC-01-S9)', async () => {
    const before = await health(loop.origin);
    await withEdit(
      ENGINE_FILE,
      (text) => `${text}\n// KAR-01.3 dev-loop probe\n`,
      async () => {
        const { health: after, elapsedMs } = await waitForRestart(loop.origin, before.bootId, 10_000);
        expect(after.pid).not.toBe(before.pid);
        expect(after.bootId).not.toBe(before.bootId);
        expect(
          elapsedMs,
          'a save must be back to serving within 2 s or node --watch is not usable as the loop',
        ).toBeLessThan(2_000);

        // "serves requests again without manual intervention"
        expect((await fetch(`${loop.origin}/`)).status).toBe(200);
      },
    );
    // Restoring the file restarts it once more; wait for that to settle so the
    // next spec is not racing a restart.
    await waitForRestart(loop.origin, (await health(loop.origin)).bootId, 10_000).catch(() => undefined);
  }, 30_000);

  it('hot-reloads a .vue save over the same port without restarting (AC4, EPIC-01-S12)', async () => {
    const before = await health(loop.origin);

    // A browser would fetch these; fetching them here is what puts the modules
    // in Vite's graph, which is what makes an edit an HMR update rather than a
    // full reload.
    expect((await fetch(`${loop.origin}/src/main.ts`)).status).toBe(200);
    expect((await fetch(`${loop.origin}/src/App.vue`)).status).toBe(200);
    expect((await fetch(`${loop.origin}/src/components/HelloDeFlow.vue`)).status).toBe(200);

    const hmr = await openHmrSocket(loop.origin);
    const sse = await openSse(`${loop.origin}/api/stream`);
    try {
      await sse.next((event) => event.event === 'hello', 5_000);
      const beatsBefore = sse.events().filter((event) => event.event === 'heartbeat').length;

      await withEdit(
        SFC_FILE,
        (text) => text.replace('One command.', 'One command, still.'),
        async () => {
          const update = await hmr.next((message) => message.type === 'update', 10_000);
          expect(JSON.stringify(update)).toContain('HelloDeFlow.vue');

          // The daemon did not restart: same process, same boot.
          const after = await health(loop.origin);
          expect(after.pid).toBe(before.pid);
          expect(after.bootId).toBe(before.bootId);

          // And the stream never dropped — the analogue of EventSource.readyState
          // never leaving OPEN.
          await sleep(600);
          expect(sse.ended(), 'the SSE stream must survive an SFC edit').toBe(false);
          expect(sse.error()).toBeUndefined();
          const beatsAfter = sse.events().filter((event) => event.event === 'heartbeat').length;
          expect(beatsAfter).toBeGreaterThan(beatsBefore);
        },
      );
    } finally {
      sse.close();
      hmr.close();
    }
  }, 40_000);

  it('logs ndjson namespaced by subsystem (AC9)', async () => {
    await sleep(100);
    const lines = loop
      .output()
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.mod === 'http')).toBe(true);
  });
});
