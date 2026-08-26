/**
 * KAR-28.4 — the inspector docks instead of taking the screen over.
 *
 * Verifies: EPIC-28-S17, EPIC-28-S18, EPIC-28-S19 · AC1, AC2, AC4
 *
 * KAR-24.6 drew the panel flush to the right edge but left it a Reka `Dialog`,
 * so opening it painted a scrim over the whole viewport, marked every other
 * element `aria-hidden`, set `pointer-events: none` on `<body>` and trapped
 * focus inside. KAR-26.5's audit recorded that scrim as the largest single
 * visual divergence in its five screenshots and deferred it, because an audit
 * story may not change behaviour. This file is the behaviour change, asserted
 * where only a real browser can say it: what the operator can still *see*, what
 * they can still *click*, and where the keyboard goes.
 *
 * The joins the panel renders are asserted next door in
 * `./node-inspector.test.ts` and in `../lib/node-inspector.test.ts`, over
 * recordings and unchanged by this story. Nothing here re-asserts them.
 *
 * The route is the workflows screen rather than `run-plan`, and that is the
 * point of AC4: the panel has to open from an agent-list row (KAR-28.2) on a
 * screen where the canvas is behind the `Agents | Graph` toggle and no node is
 * clickable at all.
 */
import type { Event } from '@DeFlow/core';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import { HAPPY_PATH_RUN, happyPath12 } from '../../test/fixture-events.ts';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import type { ApiClient } from '../api/client.ts';
import type { RunFeed, RunFeedFactory, RunFeedOptions } from '../ledger/feed.ts';

const PROJECT = 'prj_20260815T101112Z_a1b2c3';

/** The node every assertion below opens, chosen because it ran once. */
const NODE = 'impl-signup';
/** A second node, for "the list is still clickable while the panel is open". */
const OTHER = 'smoke-tests';

/**
 * The four reads the shell and this route make on mount, and no more.
 *
 * Trimmed from `../views/project-workflows.test.ts`'s own stub: what this file
 * asserts is the panel, so the client only has to keep the page from throwing
 * where nobody here is looking.
 */
function workflowsClient(): ApiClient {
  const json = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  const ndjson = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'X-DeFlow-Io-More': 'false' }),
      text: () => Promise.resolve(''),
    });

  return {
    projects: Object.assign(
      {
        $get: () =>
          json({
            projects: [
              {
                id: PROJECT,
                name: 'checkout',
                path: '/repos/checkout',
                createdAt: '2026-08-15T10:11:12.000Z',
                health: { state: 'ok', message: null },
                lastRun: null,
              },
            ],
          }),
        $post: () => json({}),
      },
      {
        ':id': {
          runs: {
            $get: () =>
              json({
                runs: [
                  {
                    runId: HAPPY_PATH_RUN,
                    status: 'running',
                    label: 'running',
                    title: 'Migrate the checkout module',
                    createdAt: '2026-08-11T09:00:00.000Z',
                    cost: { run: { costUsd: 0.42 } },
                  },
                ],
              }),
          },
          connectors: { $get: () => json({ services: [] }) },
          $delete: () => json({}),
          $patch: () => json({}),
        },
      },
    ),
    runs: Object.assign(
      { $get: () => json({ runs: [], cursor: null, more: false }) },
      { ':id': { nodes: { ':nodeId': { io: { $get: ndjson } } } } },
    ),
    approvals: { $get: () => json({ items: [] }) },
    providers: { routes: { $get: () => json({ providers: [], known: false }) } },
  } as never;
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

const panel = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-overlay="inspector"]');

const openControl = (nodeId: string): HTMLElement => {
  const found = shell.container.querySelector<HTMLElement>(`[data-board-open="${nodeId}"]`);
  if (found === null) throw new Error(`no agent row control for ${nodeId}`);
  return found;
};

/**
 * Whether anything between `element` and the document root has been marked
 * hidden from assistive technology.
 *
 * This is the assertion the word "dims" cashes out to for a screen-reader user:
 * Reka's modal `DialogContent` calls `hideOthers`, which walks the tree and
 * stamps `aria-hidden="true"` on every branch that is not the dialog. A rail
 * that is on screen and invisible to a screen reader is not "still legible".
 */
function hiddenFromScreenReaders(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node.getAttribute('aria-hidden') === 'true') return true;
  }
  return false;
}

/** What a real pointer would land on at the centre of `element`. */
function hitAtCentreOf(element: Element): Element | null {
  element.scrollIntoView({ block: 'center', inline: 'nearest' });
  const box = element.getBoundingClientRect();
  return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
}

/** The workflows screen on the live run, its recording folded, twelve rows. */
async function openWorkflows(): Promise<void> {
  opened = [];
  shell = await mountShell({
    at: `/projects/${PROJECT}`,
    client: workflowsClient(),
    feed: feedFactory,
  });
  setActivePinia(shell.pinia);

  await expect.poll(() => opened.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const sink = opened[0]?.sink;
  if (sink === undefined) throw new Error('no feed was opened');
  for (const event of happyPath12()) sink.applyEvent(event);

  await expect
    .poll(() => shell.container.querySelectorAll('[data-agent-row]').length, { timeout: 15_000 })
    .toBeGreaterThan(0);
}

/** Opens the inspector the way an operator does: from a row in the list. */
async function openFromRow(nodeId = NODE): Promise<HTMLElement> {
  const control = openControl(nodeId);
  await userEvent.click(control);
  await expect.poll(() => panel(), { timeout: 15_000 }).not.toBeNull();
  return control;
}

beforeEach(() => {
  setActivePinia(undefined as never);
});

afterEach(() => {
  shell?.unmount();
});

suite('EPIC-28-S17 — opening the inspector dims nothing (AC1)', () => {
  it('docks inside the application shell rather than portalling over it', async () => {
    await openWorkflows();
    await openFromRow();

    // Portalled to `document.body`, the panel sits outside the mounted tree and
    // over it. Docked, it is part of the same layout the rail and the view are,
    // which is what "beside the work rather than over it" means.
    expect(shell.container.contains(panel())).toBe(true);
  });

  it('paints no scrim and switches nothing else off', async () => {
    await openWorkflows();
    await openFromRow();

    // Reka's modal content sets this on `<body>` and re-enables pointer events
    // on the dialog alone — every control on the screen goes dead behind it.
    expect(document.body.style.pointerEvents).not.toBe('none');

    const rail = shell.container.querySelector('[data-frame-rail]');
    const list = shell.container.querySelector('[data-agent-list]');
    expect(rail).not.toBeNull();
    expect(list).not.toBeNull();
    expect(hiddenFromScreenReaders(rail as Element)).toBe(false);
    expect(hiddenFromScreenReaders(list as Element)).toBe(false);
  });

  it('leaves the agent list clickable — a second row still selects', async () => {
    await openWorkflows();
    await openFromRow();

    // A pointer aimed at the list reaches the list. Behind a scrim this is the
    // overlay, whatever the row still looks like.
    const other = openControl(OTHER);
    const hit = hitAtCentreOf(other);
    expect(hit).not.toBeNull();
    expect(panel()?.contains(hit as Node)).toBe(false);
    expect(shell.container.querySelector('[data-agent-list]')?.contains(hit as Node)).toBe(true);

    await userEvent.click(other);
    await expect
      .poll(() => panel()?.querySelector('[data-inspector-header]')?.textContent ?? '')
      .toContain(OTHER);
  });
});

suite('EPIC-28-S18 — the keyboard contract survives de-modalising (AC2)', () => {
  it('moves focus into the panel on open, closes on Escape, and gives focus back', async () => {
    await openWorkflows();
    const control = await openFromRow();

    await expect.poll(() => panel()?.contains(document.activeElement)).toBe(true);

    await userEvent.keyboard('{Escape}');

    await expect.poll(() => panel()).toBeNull();
    await expect.poll(() => document.activeElement).toBe(control);
  });

  it('is labelled, by the node it is showing', async () => {
    await openWorkflows();
    await openFromRow();

    const labelledBy = panel()?.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const label = document.getElementById(labelledBy as string);
    expect(label).not.toBeNull();
    expect(label?.textContent?.trim().length).toBeGreaterThan(0);
  });
});

suite('EPIC-28-S19 — it opens without a graph (AC4)', () => {
  it('opens on the node a row names while the canvas is behind the toggle', async () => {
    await openWorkflows();

    // KAR-28.2's default: the list is the panel, the canvas is hidden. Node
    // selection is therefore not a route into the inspector at all here.
    expect(
      shell.container.querySelector('[data-workspace-canvas]')?.getAttribute('data-hidden'),
    ).toBe('true');

    await openFromRow();

    expect(panel()?.querySelector('[data-inspector-header]')?.textContent).toContain(NODE);
  });
});
