/**
 * KAR-17.1 — the live plan graph, mounted in the real shell over a real
 * recording.
 *
 * Verifies: EPIC-17-S1 (scenarios 1, 3 and 4), EPIC-17-S2 (scenarios 1 and 2) ·
 * AC1, AC2, AC3, AC4, AC7
 *
 * Test plan rows 2, 3, 4 and 7. The graph renders from `useRunStore` — the same
 * store `../ledger/feed.ts` pours the stream into — so these specs put the
 * `happy-path-12` recording through `applyEvent` and then assert on the DOM.
 * What that leaves out is the socket, deliberately: the wire from
 * `openLedgerStream` through the store to this view is the thing
 * `e2e/plan-graph.test.ts` exists for, against a real `deflow replay` daemon,
 * because a browser spec that stubbed the transport could not tell a wired
 * application from an unwired one — which is exactly the state EPIC-16 shipped
 * in.
 *
 * The recording is not a convenience. All seven display states occur in it at
 * once, so EPIC-17-S2's *"every state, three signals"* matrix runs over a real
 * fold of real events rather than over seven hand-built view models that agree
 * with the component by construction.
 */
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import { HAPPY_PATH_RUN, happyPath12 } from '../../test/fixture-events.ts';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import { NODE_SIZE } from '../components/graph/node-size.ts';
import { DISPLAY_STATES, type DisplayState, STATE_LABELS } from '../lib/state-palette.ts';
import { useRunStore } from '../stores/useRunStore.ts';

let shell: MountedShell;

/** The whole recording, folded through the store the view renders from. */
async function openRun(): Promise<void> {
  shell = await mountShell({ at: { name: 'run-plan', params: { runId: HAPPY_PATH_RUN } } });
  setActivePinia(shell.pinia);
  const run = useRunStore(shell.pinia);
  for (const event of happyPath12()) run.applyEvent(event);
  await laidOut();
}

const bodies = (): HTMLElement[] => [
  ...shell.container.querySelectorAll<HTMLElement>('[data-plan-node]'),
];

const bodyOf = (id: string): HTMLElement =>
  shell.container.querySelector<HTMLElement>(`[data-plan-node="${id}"]`) as HTMLElement;

async function laidOut(count = 12): Promise<void> {
  await expect.poll(() => bodies().length, { timeout: 15_000 }).toBe(count);
}

/** The palette's own value for a state, resolved against the live cascade. */
const paletteColour = (state: DisplayState): string =>
  getComputedStyle(document.documentElement).getPropertyValue(`--state-${state}`).trim();

beforeEach(() => {
  // A recording folded into a store that a previous file left open would be a
  // graph made of two runs.
  setActivePinia(undefined as never);
});

afterEach(() => {
  shell?.unmount();
});

suite('EPIC-17-S1 — the Operator opens a run and sees all of it', () => {
  it('renders every node and every edge the recording describes', async () => {
    await openRun();

    // Twelve nodes and the edges between them — the count the fixture's own
    // projection snapshot records, so a graph that dropped one is caught here
    // rather than in a screenshot nobody compares.
    expect(bodies()).toHaveLength(12);
    await expect
      .poll(() => shell.container.querySelectorAll('.vue-flow__edge').length)
      .toBeGreaterThan(10);
  });

  it('gives one node the full accessible name a reader needs', async () => {
    await openRun();

    // `${type} ${title}, ${state}, ${provider}` — docs/12 §9.3, and the same
    // sentence whichever renderer is drawing.
    const node = shell.container.querySelector('.vue-flow__node[data-id="impl-signup"]');
    expect(node?.getAttribute('aria-label')).toBe(
      'agent Migrate the signup view, running, claude-code',
    );
  });

  it('says what a node is: type, title, state, provider, model and permission', async () => {
    await openRun();

    const body = bodyOf('recon-auth-surface');
    expect(body.textContent).toContain('Survey the auth surface');
    expect(body.textContent).toContain('agent');
    expect(body.textContent).toContain('Passed');
    expect(body.textContent).toContain('claude-code');
    expect(body.textContent).toContain('read');
    // The fixture's `node.scheduled` names no model. Saying so is the point:
    // an empty cell reads as "no model", which is a different claim.
    expect(body.textContent).toContain('no model reported');
    // And a glyph for what kind of node it is, beside the state's own.
    expect(body.querySelector('[data-slot="type-glyph"] svg')).not.toBeNull();
  });

  it('draws a body at exactly the box ELK was told to space for', async () => {
    await openRun();

    // ELK spaces *boxes*, not points, so `NODE_SIZE` and the `.plan-node` rule
    // are two statements of one number. When they drift, nothing fails: the
    // drawing simply overlaps (body larger) or gaps (body smaller), which reads
    // as a layout opinion rather than as the bug it is. A rendered rectangle is
    // the only place the two can be compared.
    // `offsetWidth`/`offsetHeight` and not `getBoundingClientRect`: the
    // renderer scales the whole pane to fit the view, so a client rect reports
    // the box multiplied by whatever zoom the fit landed on. Layout pixels are
    // what ELK was given.
    const body = bodyOf('recon-auth-surface');
    expect({ width: body.offsetWidth, height: body.offsetHeight }).toEqual({
      width: NODE_SIZE.width,
      height: NODE_SIZE.height,
    });
  });

  it('badges the running nodes as streaming, and none of the others', async () => {
    await openRun();

    const streaming = bodies()
      .filter((body) => body.querySelector('[data-slot="streaming"]') !== null)
      .map((body) => body.dataset['planNode']);

    // Two nodes are mid-flight in this recording; the other ten are not.
    expect(streaming.toSorted()).toEqual(['impl-signup', 'review-security']);
  });

  it('chips the gate verdict on the node whose work was judged', async () => {
    await openRun();

    // The last gate to speak about `impl-signup` said `needs-human`, and that
    // is the one an operator needs on the node — not the `pass` before it.
    const chip = bodyOf('impl-signup').querySelector('[data-slot="verdict"]');
    expect(chip?.textContent).toContain('needs-human');
    expect(chip?.textContent).toContain('contract');
    expect(bodyOf('recon-auth-surface').querySelector('[data-slot="verdict"]')).toBeNull();
  });

  it('shows elapsed time and cost so far', async () => {
    await openRun();

    const body = bodyOf('recon-auth-surface');
    // The span ran from ts 1786438808000 to 1786438811000 — three seconds, off
    // the ledger's own two timestamps and not off the wall clock.
    expect(body.querySelector('[data-slot="elapsed"]')?.textContent).toContain('3.0 s');
    // 0.062 vendor-reported dollars, and the vendor's figure rather than the
    // estimate beside it.
    expect(body.querySelector('[data-slot="cost"]')?.textContent).toContain('$0.06');
    // A node that never ran says so rather than reading as instant and free.
    expect(bodyOf('smoke-tests').querySelector('[data-slot="elapsed"]')?.textContent).toContain(
      'not started',
    );
    expect(bodyOf('smoke-tests').querySelector('[data-slot="cost"]')?.textContent).toContain(
      'not priced',
    );
  });
});

suite('EPIC-17-S2 — every state, three signals', () => {
  it('renders all seven states, each one somewhere in this recording', async () => {
    await openRun();

    const states = new Set(bodies().map((body) => body.dataset['state']));
    expect([...states].toSorted()).toEqual([...DISPLAY_STATES].toSorted());
  });

  it.each(DISPLAY_STATES)('paints "%s" with its own colour, glyph and label', async (state) => {
    await openRun();

    const body = bodies().find((each) => each.dataset['state'] === state) as HTMLElement;
    expect(body, `no node in happy-path-12 is ${state}`).toBeDefined();

    // Colour, through the custom property and never as a literal.
    expect(getComputedStyle(body).borderColor).toBe(paletteColour(state));
    // Glyph, laid out rather than merely present — a zero-size <svg> is what
    // jsdom reports for one that never rendered.
    const glyph = body.querySelector('[data-slot="glyph"] svg') as SVGElement;
    expect(glyph).not.toBeNull();
    expect(glyph.getBoundingClientRect().width).toBeGreaterThan(0);
    // Text, the same words the accessible name uses.
    expect(body.querySelector('[data-slot="label"]')?.textContent?.trim()).toBe(
      STATE_LABELS[state],
    );
  });

  it('renders abandoned differently from failed, in all three signals', async () => {
    await openRun();

    const abandoned = bodyOf('impl-legacy-shim');
    const failed = bodyOf('impl-login');

    // A branch the planner gave up on is not a branch that broke, and an
    // operator scanning for red must not find it here.
    expect(getComputedStyle(abandoned).borderColor).not.toBe(getComputedStyle(failed).borderColor);
    expect(abandoned.querySelector('[data-slot="label"]')?.textContent?.trim()).toBe('Abandoned');
    expect(failed.querySelector('[data-slot="label"]')?.textContent?.trim()).toBe('Failed');
    expect(abandoned.querySelector('[data-slot="glyph"] svg')?.innerHTML).not.toBe(
      failed.querySelector('[data-slot="glyph"] svg')?.innerHTML,
    );
  });
});

suite('EPIC-17-S1 — it moves without being refreshed', () => {
  it('moves a node to running within one frame of node.started', async () => {
    await openRun();
    const run = useRunStore(shell.pinia);

    expect(bodyOf('smoke-tests').dataset['state']).toBe('pending');

    // EPIC-16-S1 scenario 2, which EPIC-16 could not close because nothing was
    // wired: an appended event moves the graph, and it moves *now* — Vue
    // flushes on the microtask queue, so the DOM is correct before the frame
    // this event arrived in is painted.
    const seen: string[] = [];
    const watching = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      seen.push(String(args[0]));
      return watching(...args);
    }) as typeof fetch;

    try {
      run.applyEvent({
        seq: (happyPath12().at(-1)?.seq ?? 0) + 1,
        runId: HAPPY_PATH_RUN,
        ts: 1_786_438_900_000,
        kind: 'node.started',
        v: 2,
        epoch: 3,
        payload: {
          node: 'smoke-tests',
          attempt: 0,
          ikey: `${HAPPY_PATH_RUN}/smoke-tests/0/0`,
          binary: {
            path: '/tmp/deflow-happy-path-12/bin/deflow',
            version: '2.1.220',
            sha256: '5092cc9a1056449838b6cc78f04a7cb838ca7016d04a905ec85e501a4058f4fa',
          },
        },
      } as never);

      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(bodyOf('smoke-tests').dataset['state']).toBe('running');
      // The streaming badge follows the state, in the same frame.
      expect(bodyOf('smoke-tests').querySelector('[data-slot="streaming"]')).not.toBeNull();
      // *"and no refetch of any endpoint occurred — the transition came from
      // the stream"*. A view that re-read `/api/runs/:id` on every event would
      // look identical and would fall over on a chatty run.
      expect(seen).toEqual([]);
    } finally {
      globalThis.fetch = watching;
    }
  });
});

suite('EPIC-17-S1 — progress is not a state change', () => {
  it('updates the phase text and leaves the state where it was', async () => {
    await openRun();
    const run = useRunStore(shell.pinia);

    const before = bodyOf('impl-signup').dataset['state'];
    expect(before).toBe('running');

    const head = happyPath12().at(-1)?.seq ?? 0;
    for (const [index, phase] of ['reading', 'editing', 'verifying'].entries()) {
      run.applyEvent({
        seq: head + index + 1,
        runId: HAPPY_PATH_RUN,
        ts: 1_786_438_900_000 + index,
        kind: 'node.progress',
        v: 1,
        epoch: 3,
        payload: { node: 'impl-signup', attempt: 1, phase, message: `now ${phase}` },
      } as never);

      await expect
        .poll(() => bodyOf('impl-signup').querySelector('[data-slot="phase"]')?.textContent)
        .toContain(phase);
      // Forty of these arrive on a real run. Not one of them is a transition.
      expect(bodyOf('impl-signup').dataset['state']).toBe('running');
    }
  });
});

suite('EPIC-17-S1 — a node is one click from everything else (AC7)', () => {
  it('moves the selection with j and k', async () => {
    await openRun();

    await userEvent.keyboard('j');
    await expect.poll(() => shell.ui.selectedNodeId).toBe('recon-auth-surface');

    await userEvent.keyboard('j');
    await expect.poll(() => shell.ui.selectedNodeId).toBe('plan-migration');

    await userEvent.keyboard('k');
    await expect.poll(() => shell.ui.selectedNodeId).toBe('recon-auth-surface');
  });

  it('opens the inspector on Enter, for the node that is selected', async () => {
    await openRun();

    await userEvent.keyboard('j');
    await userEvent.keyboard('{Enter}');

    await expect.poll(() => document.querySelector('[data-overlay="inspector"]')).not.toBeNull();
    expect(document.querySelector('[data-overlay="inspector"]')?.textContent).toContain(
      'Survey the auth surface',
    );
  });

  it('reflects the selection in the URL, so a graph position is linkable', async () => {
    await openRun();

    await userEvent.keyboard('j');
    await userEvent.keyboard('j');

    await expect.poll(() => shell.router.currentRoute.value.query['node']).toBe('plan-migration');
    // Replaced rather than pushed: a graph you cannot press Back out of is a
    // graph whose history is thirty selections deep after a minute of j.
    expect(shell.router.currentRoute.value.path).toContain(HAPPY_PATH_RUN);
  });

  it('takes the selection back out of a URL somebody was sent', async () => {
    shell = await mountShell({
      at: {
        name: 'run-plan',
        params: { runId: HAPPY_PATH_RUN },
        query: { node: 'impl-login' },
      },
    });
    setActivePinia(shell.pinia);
    const run = useRunStore(shell.pinia);
    for (const event of happyPath12()) run.applyEvent(event);
    await laidOut();

    // The whole point of putting it in the URL: the link opens on the node.
    await expect.poll(() => shell.ui.selectedNodeId).toBe('impl-login');
    await expect.poll(() => bodyOf('impl-login').dataset['selected']).toBe('true');
  });
});
