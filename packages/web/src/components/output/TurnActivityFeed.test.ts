/**
 * KAR-28.1 — the activity feed a pre-execution turn is read from.
 *
 * Verifies: EPIC-28-S01, EPIC-28-S02, EPIC-28-S03, EPIC-28-S04, EPIC-28-S06 ·
 * AC1–AC6
 *
 * What this file asserts that `../../lib/turn-activity.test.ts` cannot: that
 * the rows the reader produces reach the screen at all. The defect KAR-28.1
 * exists for was never a parsing one — `turnActivity` has extracted the agent's
 * prose since KAR-27.3 and **every renderer discarded it**. A spec over the
 * pure function alone would have stayed green through the whole five minutes
 * the operator spent watching three tool names.
 *
 * Real Chromium, and the shipped `readIoTail`/`readIoSince` over an NDJSON body
 * rather than a stub handing back parsed rows: the line assembly across chunk
 * boundaries is the part that has historically dropped exactly the long frames,
 * which are exactly the interesting ones.
 */
import { expect, it, describe as suite } from 'vitest';
import { render } from 'vitest-browser-vue';
import { createMemoryHistory } from 'vue-router';
import type { ApiClient } from '../../api/client.ts';
import { API_CLIENT } from '../../api/provide.ts';
import { createAppRouter } from '../../router/index.ts';
import '../../styles/theme.css';
import TurnActivityFeed from './TurnActivityFeed.vue';

const PROJECT = 'prj_20260825T101112Z_a1b2c3';
const RUN = 'run_20260825T000000Z_000000';
const TS = 1_787_000_000_000;

/** One `io_chunk` NDJSON line, as the endpoint writes them. */
const line = (seq: number, data: string): string =>
  `${JSON.stringify({ seq, stream: 'stdout', ts: TS + seq, data })}\n`;

const assistant = (blocks: readonly unknown[]): string =>
  `${JSON.stringify({ type: 'assistant', message: { content: blocks } })}\n`;

const user = (blocks: readonly unknown[]): string =>
  `${JSON.stringify({ type: 'user', message: { content: blocks } })}\n`;

/**
 * A turn that did the three things AC2–AC4 name, plus one frame in a dialect
 * this build has no reading for (AC5).
 */
const TURN =
  line(1, assistant([{ type: 'text', text: 'Reading the checkout module' }])) +
  line(
    2,
    assistant([
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/checkout.ts' } },
    ]),
  ) +
  line(3, user([{ type: 'tool_result', tool_use_id: 'tu_1', content: '240 lines read' }])) +
  line(4, assistant([{ type: 'thinking', thinking: 'a dialect nothing here parses' }])) +
  line(5, assistant([{ type: 'text', text: 'The tests should tell me more' }])) +
  line(
    6,
    assistant([
      {
        type: 'tool_use',
        id: 'tu_2',
        name: 'Bash',
        input: { command: 'pnpm vitest run checkout' },
      },
    ]),
  ) +
  line(
    7,
    user([
      {
        type: 'tool_result',
        tool_use_id: 'tu_2',
        is_error: true,
        content: [{ type: 'text', text: '2 tests failed' }],
      },
    ]),
  );

/** A client whose io tail answers one body, saying whether more is behind it. */
function ioClient(body: string, more = false): ApiClient {
  return {
    runs: {
      ':id': {
        nodes: {
          ':nodeId': {
            io: {
              $get: () =>
                Promise.resolve({
                  ok: true,
                  status: 200,
                  headers: new Headers({ 'X-DeFlow-Io-More': more ? 'true' : 'false' }),
                  text: () => Promise.resolve(body),
                }),
            },
          },
        },
      },
    },
  } as unknown as ApiClient;
}

/** The mounted component, once its `render` promise has settled. */
type Screen = Awaited<ReturnType<typeof render>>;

async function mount(body: string, more = false): Promise<Screen> {
  const router = createAppRouter(createMemoryHistory());
  await router.push(`/projects/${PROJECT}/runs/${RUN}`);
  await router.isReady();

  return render(TurnActivityFeed, {
    props: { runId: RUN, projectId: PROJECT, node: 'framing' },
    global: { plugins: [router], provide: { [API_CLIENT as symbol]: ioClient(body, more) } },
  });
}

const rowsOf = (screen: Screen): HTMLElement[] => [
  ...screen.container.querySelectorAll<HTMLElement>('[data-turn-feed-row]'),
];

suite('EPIC-28-S01/S03 — the turn reads as a course of actions, oldest first', () => {
  it('renders one row per event, in the order the agent emitted them', async () => {
    const screen = await mount(TURN);

    await expect.poll(() => rowsOf(screen).length, { timeout: 15_000 }).toBe(4);
    expect(rowsOf(screen).map((row) => row.dataset.turnFeedRow)).toEqual([
      'text',
      'tool',
      'text',
      'tool',
    ]);
  });

  it('names each tool and the argument it acted on, as the frame spelled it', async () => {
    const screen = await mount(TURN);

    await expect.poll(() => rowsOf(screen).length, { timeout: 15_000 }).toBeGreaterThan(0);
    const names = [...screen.container.querySelectorAll('[data-turn-feed-tool]')].map(
      (node) => node.textContent,
    );
    const targets = [...screen.container.querySelectorAll('[data-turn-feed-target]')].map(
      (node) => node.textContent,
    );

    expect(names).toEqual(['Read', 'Bash']);
    expect(targets).toEqual(['src/checkout.ts', 'pnpm vitest run checkout']);
  });

  it("puts the agent's own prose on screen rather than discarding it", async () => {
    const screen = await mount(TURN);

    await expect
      .poll(() => screen.container.querySelector('[data-turn-feed-text]')?.textContent ?? '', {
        timeout: 15_000,
      })
      .toContain('Reading the checkout module');
  });
});

suite("EPIC-28-S02 — a tool call's result is folded into its row", () => {
  it("marks success and failure and carries the vendor's own summary", async () => {
    const screen = await mount(TURN);

    await expect
      .poll(() => screen.container.querySelectorAll('[data-turn-feed-result]').length, {
        timeout: 15_000,
      })
      .toBe(2);

    const results = [...screen.container.querySelectorAll<HTMLElement>('[data-turn-feed-result]')];
    expect(results.map((node) => node.dataset.turnFeedResult)).toEqual(['ok', 'failed']);
    expect(results[0]?.textContent).toContain('240 lines read');
    expect(results[1]?.textContent).toContain('2 tests failed');
  });

  it('shows the call alone when the result cannot be read, and reports no error', async () => {
    const unreadable =
      line(
        1,
        assistant([{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } }]),
      ) +
      line(2, user([{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'image' }] }]));

    const screen = await mount(unreadable);

    await expect.poll(() => rowsOf(screen).length, { timeout: 15_000 }).toBe(1);
    expect(screen.container.querySelector('[data-turn-feed-result]')).toBeNull();
    expect(screen.container.textContent).not.toContain('error');
  });
});

suite('EPIC-28-S04 — the feed holds the whole turn, or says it does not', () => {
  it('says nothing about a window when the whole turn is on screen', async () => {
    const screen = await mount(TURN);

    await expect.poll(() => rowsOf(screen).length, { timeout: 15_000 }).toBe(4);
    expect(screen.container.querySelector('[data-turn-feed-windowed]')).toBeNull();
  });

  it('states the bound and links to the full transcript when output is behind it', async () => {
    const screen = await mount(TURN, true);

    await expect
      .poll(() => screen.container.querySelector('[data-turn-feed-windowed]'), { timeout: 15_000 })
      .not.toBeNull();

    const link = screen.container.querySelector<HTMLAnchorElement>('[data-turn-feed-transcript]');
    expect(link?.getAttribute('href')).toBe(
      `/projects/${PROJECT}/runs/${RUN}/nodes/framing/output`,
    );
  });
});
