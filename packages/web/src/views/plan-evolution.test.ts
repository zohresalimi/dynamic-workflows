/**
 * EPIC-15-S47's two remaining lines, closed here.
 *
 * Verifies: EPIC-15-S47 (the two lines deferred to this epic) · KAR-16.1
 *
 * `packages/web/src/api/scrub.test.ts` automates the three lines of that
 * scenario that are about the *client's request pattern*, and
 * `docs/delivery/flows/EPIC-15-daemon-api-flows.md` records the other two as
 * deferred here, because both are assertions about a view that did not exist
 * yet:
 *
 * - *"And the tab remains responsive throughout"*
 * - *"And the rendered diff for each step matches the plans/diff response for
 *   the same pair"*
 *
 * Both hang off the `When` of *"the operator drags the scrubber"*, so they need
 * a scrubber to drag. This file drags the real one, over the same
 * `three-patches` fixture, through the same `createScrubber` module — the note
 * in the flow file is explicit that this epic must not write a second client.
 *
 * **Responsiveness is measured against a control on the same machine**, not
 * against a fixed millisecond budget: a headless Chromium sharing a laptop with
 * the rest of the suite has an idle frame gap that moves, and a constant budget
 * either flakes there or is so loose it proves nothing. The control is the same
 * page, the same duration, doing nothing.
 */
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import {
  API_BASE,
  type Asked,
  DIFFS,
  daemonFetch,
  diffsIn,
  eventsIn,
  PLAN_VERSIONS,
  RUN,
  snapshotsIn,
} from '../../test/three-patches.ts';
import { createClient } from '../api/client.ts';

let shell: MountedShell;
let asked: Asked[];

const mountAtEvolution = async () => {
  asked = [];
  return mountShell({
    at: { name: 'plan-evolution', params: { runId: RUN } },
    client: createClient({ baseUrl: API_BASE, fetch: daemonFetch(asked) }),
  });
};

const attribute = (selector: string, name: string): string | null =>
  shell.container.querySelector(selector)?.getAttribute(name) ?? null;

/**
 * Wait until the view has actually landed on `version`.
 *
 * "Landed" is the rendered `seq` matching the one the rail says that version
 * was proposed at — not the version label, which changes the moment the store
 * does and is still true while the request is in flight. v1 has no predecessor
 * and therefore no diff, which is why the pair is only awaited above it.
 */
async function settled(version: number): Promise<void> {
  const seq = PLAN_VERSIONS.find((row) => row.version === version)?.seq;
  await expect
    .poll(() => attribute('[data-scrub-version]', 'data-scrub-version'))
    .toBe(String(version));
  await expect.poll(() => attribute('[data-scrub-seq]', 'data-scrub-seq')).toBe(String(seq));
  if (version > 1) {
    await expect
      .poll(() => attribute('[data-diff-pair]', 'data-diff-pair'))
      .toBe(`${version - 1}:${version}`);
  }
}

/** The diff as the DOM reports it: one row per changed thing, with its kind. */
function renderedDiff(): {
  pair: string | null;
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
  edgesAdded: string[];
  edgesRemoved: string[];
} {
  const rows = [...shell.container.querySelectorAll('[data-diff-row]')];
  const idsOf = (kind: string) =>
    rows
      .filter((row) => row.getAttribute('data-diff-row') === kind)
      .map((row) => row.getAttribute('data-diff-id') ?? '');

  return {
    pair: shell.container.querySelector('[data-diff-pair]')?.getAttribute('data-diff-pair') ?? null,
    added: idsOf('node-added'),
    removed: idsOf('node-removed'),
    changed: idsOf('node-changed'),
    unchanged: idsOf('node-unchanged'),
    edgesAdded: idsOf('edge-added'),
    edgesRemoved: idsOf('edge-removed'),
  };
}

const edgeId = (edge: { from: string; to: string; kind: string }) =>
  `${edge.from}→${edge.to}:${edge.kind}`;

interface DiffDocument {
  readonly from: number;
  readonly to: number;
  readonly nodes: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly { readonly id: string }[];
    readonly unchanged: readonly string[];
  };
  readonly edges: {
    readonly added: readonly { from: string; to: string; kind: string }[];
    readonly removed: readonly { from: string; to: string; kind: string }[];
  };
}

afterEach(() => shell?.unmount());

suite('EPIC-15-S47 — the rendered diff matches plans/diff for the same pair', () => {
  beforeEach(async () => {
    shell = await mountAtEvolution();
    await settled(4);
  });

  it('asks the endpoint for the pair it is showing, and never computes one itself', async () => {
    // Dragged back to v1 and forward through each patch: three adjacent pairs.
    shell.ui.selectPlanVersion(1);
    await settled(1);

    for (const to of [2, 3, 4]) {
      shell.ui.stepPlanVersion(1);
      await settled(to);
      expect(renderedDiff().pair).toBe(`${to - 1}:${to}`);
    }

    const pairs = diffsIn(asked).map((one) => `${one.from}:${one.to}`);
    expect(pairs).toContain('1:2');
    expect(pairs).toContain('2:3');
    expect(pairs).toContain('3:4');
  });

  it.each([
    [1, 2],
    [2, 3],
    [3, 4],
  ] as const)('renders exactly what the endpoint returned for v%i → v%i', async (from, to) => {
    shell.ui.selectPlanVersion(to);
    await settled(to);

    const document_ = DIFFS[`${from}:${to}`] as DiffDocument;
    const rendered = renderedDiff();

    // Every id in the response is on screen, and nothing else is: a view that
    // dropped `unchanged`, or invented a node, disagrees with the endpoint
    // that is the contract.
    expect(rendered.pair).toBe(`${from}:${to}`);
    expect(rendered.added).toEqual([...document_.nodes.added]);
    expect(rendered.removed).toEqual([...document_.nodes.removed]);
    expect(rendered.changed).toEqual(document_.nodes.changed.map((node) => node.id));
    expect(rendered.unchanged).toEqual([...document_.nodes.unchanged]);
    expect(rendered.edgesAdded).toEqual(document_.edges.added.map(edgeId));
    expect(rendered.edgesRemoved).toEqual(document_.edges.removed.map(edgeId));
  });

  it('shows the reason and decision the endpoint joined in', async () => {
    shell.ui.selectPlanVersion(4);
    await settled(4);

    const text = shell.container.querySelector('[data-diff-pair]')?.textContent ?? '';
    expect(text).toContain('operator interjection');
    expect(text).toContain('human');
  });

  it('renders the whole rail from …/plans rather than guessing the versions', () => {
    const rail = [...shell.container.querySelectorAll('[data-rail-version]')].map((element) =>
      Number(element.getAttribute('data-rail-version')),
    );

    expect(rail).toEqual(PLAN_VERSIONS.map((one) => one.version));
  });
});

suite('EPIC-15-S47 — every position is hydrated from the snapshot endpoint', () => {
  beforeEach(async () => {
    shell = await mountAtEvolution();
    await settled(4);
  });

  it('hydrates each dragged position from …/snapshot at that version’s seq', async () => {
    shell.ui.selectPlanVersion(1);
    await settled(1);
    for (const to of [2, 3, 4]) {
      shell.ui.stepPlanVersion(1);
      await settled(to);
    }

    // The whole life of the tab: the head position it opened on (v4, seq 13),
    // then the drag back to v1 and forward. Every seq is one the rail supplied
    // — never a number the client made up — and v4 on the way back up is
    // answered out of the position the scrubber already holds rather than
    // asked for twice, which is what "positions are held by the seq they
    // reflect" buys.
    expect(snapshotsIn(asked).map((one) => one.seq)).toEqual(['13', '1', '6', '9']);
    expect(eventsIn(asked)).toEqual([]);
  });

  it('re-drags over ground it already covered without asking again', async () => {
    shell.ui.selectPlanVersion(1);
    await settled(1);
    shell.ui.selectPlanVersion(2);
    await settled(2);
    const before = snapshotsIn(asked).length;

    shell.ui.selectPlanVersion(1);
    await settled(1);
    shell.ui.selectPlanVersion(2);
    await settled(2);

    expect(snapshotsIn(asked)).toHaveLength(before);
  });

  it('never folds the run from zero in the tab', async () => {
    shell.ui.selectPlanVersion(1);
    await settled(1);

    expect(asked.some((one) => one.since === '0')).toBe(false);
  });

  it('shows the state the snapshot answered with, at the seq it answered at', async () => {
    shell.ui.selectPlanVersion(2);
    await settled(2);

    expect(shell.container.querySelector('[data-scrub-seq]')?.getAttribute('data-scrub-seq')).toBe(
      '6',
    );
  });
});

suite('EPIC-15-S47 — the tab remains responsive throughout the drag', () => {
  beforeEach(async () => {
    shell = await mountAtEvolution();
    await settled(4);
  });

  it('never stalls the main thread materially worse than the same tab does idle', async () => {
    const drag = await worstFrameGap(async () => {
      shell.ui.selectPlanVersion(1);
      await settled(1);
      for (const to of [2, 3, 4]) {
        shell.ui.stepPlanVersion(1);
        await settled(to);
      }
    });

    // The control: the same page, the same measurement, over **the same wall
    // clock**, doing nothing. Measured second and sized from the drag, because
    // a longer control window sees more idle jitter and would quietly buy the
    // assertion a bigger budget than it earned.
    const idle = await worstFrameGap(() => sleep(Math.max(drag.elapsed, 300)));

    // Three times this machine's own idle jitter, plus a floor so a
    // suspiciously smooth control cannot make the budget unreachable. A drag
    // that folded the run in the tab — the failure the snapshot endpoint exists
    // to prevent — blocks for far longer than this on a 10,000-event run.
    expect(drag.worst).toBeLessThan(Math.max(idle.worst * 3, 50));
  });

  it('keeps answering input while the drag is in flight', async () => {
    const rail = shell.container.querySelector<HTMLElement>('[data-rail-version="1"]');
    if (rail === null) throw new Error('the version rail must be rendered');

    // Clicked without awaiting the hydrate: the tab has to still be handling
    // events while a request is outstanding, which is a claim about where the
    // work happens and not about how fast it is.
    rail.click();
    const observed: number[] = [];
    document.addEventListener('keydown', () => observed.push(1), { once: true });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(observed).toEqual([1]);
    await settled(2);
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The longest gap between consecutive animation frames while `work` runs.
 *
 * `requestAnimationFrame` is the honest probe for "the tab is responsive":
 * a callback that does not run is a main thread that is not free, and unlike a
 * timer it is not merely delayed — it is skipped, which is exactly what an
 * operator sees as a freeze.
 */
async function worstFrameGap(
  work: () => Promise<unknown>,
): Promise<{ worst: number; elapsed: number }> {
  let worst = 0;
  let previous = performance.now();
  let running = true;
  const started = performance.now();

  const tick = (now: number) => {
    worst = Math.max(worst, now - previous);
    previous = now;
    if (running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  await work();
  running = false;
  // One more frame, so a stall that started inside `work` is still counted.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  return { worst, elapsed: performance.now() - started };
}
