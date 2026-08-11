/**
 * KAR-17.8 — the Gantt itself, in a real Chromium, over the real recording.
 *
 * Verifies: EPIC-17-S30, EPIC-17-S31, EPIC-17-S32 · AC1–AC9 ·
 * test plan rows 4, 5, 6 and 7
 *
 * **Browser mode is mandatory here and is not ceremony.** Row 4's red is
 * literally *"geometry was asserted in jsdom against a `0×0` box"*: jsdom
 * returns 0 from `getBBox()` and reports zero element sizes, so
 * `expect(bar.width).toBeGreaterThan(0)` passes against nothing having
 * rendered. Every geometric assertion below therefore goes through
 * `getBoundingClientRect()` on a laid-out element, and the expected values are
 * recomputed from the fixture's own timestamps rather than read back out of the
 * view model the component was handed — a test that asked the VM what it thinks
 * is not a test of the drawing.
 *
 * `now` is injected. A chart that read the clock for itself would make "the
 * running bar reaches the right-hand edge" a property of when the spec ran.
 */
import { expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-vue';
import { happyPath12 } from '../../test/fixture-events.ts';
import {
  applyTimeline,
  emptyTimeline,
  type TimelineProjection,
} from '../ledger/projections/timeline.ts';
import { PAUSED_LABEL, TS_ARTEFACT_NOTE } from '../lib/run-timeline.ts';
import RunTimelineChart from './RunTimelineChart.vue';
import '../styles/theme.css';

const HOUR = 3_600_000;

/** The last `ts` of the recording plus an hour: the tab is open, time moved. */
const NOW = 1_786_464_000_000 + HOUR;

function projection(): TimelineProjection {
  const state = emptyTimeline();
  for (const event of happyPath12()) applyTimeline(state, event);
  return state;
}

function mount() {
  const state = projection();
  // The projection and a clock reading, not a pre-built view model: the
  // viewport is the component's own state (AC8), and a spec that handed it a
  // finished chart could not press a key and watch the window move.
  const screen = render(RunTimelineChart, {
    props: { timeline: state, now: NOW, version: state.appliedSeq },
  });
  const root = screen.container as HTMLElement;
  return {
    screen,
    root,
    state,
    one: (selector: string) => root.querySelector<HTMLElement>(selector) as HTMLElement,
    all: (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)],
  };
}

suite('KAR-17.8 test 4 — the drawing, measured (AC1)', () => {
  it('draws one bar per (nodeId, attempt) and one lane per node', () => {
    const { all, state } = mount();

    expect(all('[data-bar]')).toHaveLength(state.spans.size);
    expect(all('[data-lane]')).toHaveLength(state.lanes.length);
    expect(all('[data-bar]').map((bar) => bar.getAttribute('data-bar'))).toEqual([
      ...state.spans.keys(),
    ]);
  });

  it('places a bar where the time scale says, measured against the laid-out plot', () => {
    const { one, state } = mount();
    const plot = one('[data-plot]').getBoundingClientRect();
    const box = one('[data-bar="recon-auth-surface#0"]').getBoundingClientRect();

    // Recomputed here from the ledger's own timestamps. The run's extent runs
    // from the first span's start to `now`, because a node is still running.
    const span = state.spans.get('recon-auth-surface#0');
    const from = Math.min(...[...state.spans.values()].map((one) => one.startTs));
    const total = NOW - from;
    const expectedLeft = plot.left + (plot.width * ((span?.startTs ?? 0) - from)) / total;

    expect(plot.width).toBeGreaterThan(0);
    expect(box.left).toBeCloseTo(expectedLeft, 0);
  });

  it('puts two attempts of one node in one lane and two nodes in two', () => {
    const { one } = mount();
    const first = one('[data-bar="impl-logout#0"]').getBoundingClientRect();
    const second = one('[data-bar="impl-logout#1"]').getBoundingClientRect();
    const elsewhere = one('[data-bar="recon-auth-surface#0"]').getBoundingClientRect();

    expect(second.top).toBeCloseTo(first.top, 0);
    expect(elsewhere.top).not.toBeCloseTo(first.top, 0);
  });

  it('gives every bar a state token and a pattern, so hue is never the only signal (AC2)', () => {
    const { all } = mount();

    for (const bar of all('[data-bar]')) {
      const fill = bar.querySelector<SVGElement>('[data-fill]');
      expect(bar.getAttribute('data-state')).not.toBeNull();
      expect(fill?.getAttribute('data-pattern')).toMatch(/^tl-/);
    }
  });

  it('caps the running node’s bar and invents no end for it (AC3)', () => {
    const { one, all } = mount();
    const running = one('[data-bar="impl-signup#0"]');

    expect(running.getAttribute('data-open')).toBe('true');
    expect(running.querySelector('[data-open-cap]')).not.toBeNull();
    // No closed bar wears the cap.
    const capped = all('[data-open-cap]').map((cap) =>
      cap.closest('[data-bar]')?.getAttribute('data-open'),
    );
    expect(new Set(capped)).toEqual(new Set(['true']));
  });

  it('says in the tooltip that a backwards ts is an artefact, and draws it anyway', () => {
    const { one, state } = mount();
    const artefact = one('[data-bar="impl-signup#0"]');

    expect(artefact.querySelector('title')?.textContent).toContain(TS_ARTEFACT_NOTE);
    expect(artefact.getAttribute('data-start-ts')).toBe(
      String(state.spans.get('impl-signup#0')?.startTs),
    );
  });
});

suite('KAR-17.8 test 5 — a suspension is not execution (AC4)', () => {
  it('draws the human gate as its own segment, wider than the work around it', () => {
    const { one, all } = mount();
    const gate = one('[data-bar="review-security#0"]');
    const idle = gate.querySelector<HTMLElement>('[data-segment="suspended"]') as HTMLElement;
    const busy = [...gate.querySelectorAll<HTMLElement>('[data-segment="execution"]')];

    expect(idle).not.toBeNull();
    expect(busy.length).toBeGreaterThan(0);
    expect(idle.getBoundingClientRect().width).toBeGreaterThan(
      busy.reduce((total, part) => total + part.getBoundingClientRect().width, 0),
    );
    // And the two are told apart by something other than position.
    expect(all('[data-segment="suspended"]').length).toBeGreaterThan(0);
    expect(idle.getAttribute('data-idle-ms')).toBe(String(6 * HOUR));
  });

  it('gives the idle segment a fill of its own, not the execution fill', () => {
    const { one } = mount();
    const gate = one('[data-bar="review-security#0"]');
    const idle = gate.querySelector<SVGElement>('[data-segment="suspended"]') as SVGElement;
    const busy = gate.querySelector<SVGElement>('[data-segment="execution"]') as SVGElement;

    expect(getComputedStyle(idle).fill).not.toBe(getComputedStyle(busy).fill);
  });
});

suite('KAR-17.8 test 6 — the ceiling PAUSED the run (AC5, AC6, AC7)', () => {
  it('states "paused" and never "failed"', () => {
    const { one } = mount();
    const pause = one('[data-marker="paused"]');

    expect(pause.textContent).toContain(PAUSED_LABEL);
    expect(pause.textContent?.toLowerCase()).not.toContain('fail');
  });

  it('renders the pause and a node failure differently, so the two cannot be read alike', () => {
    const { one } = mount();
    const pause = one('[data-marker="paused"]');
    const failed = one('[data-bar="impl-login#0"]');

    expect(pause.getAttribute('data-marker')).toBe('paused');
    expect(failed.getAttribute('data-state')).toBe('failed');
    expect(pause.querySelector('[data-state]')).toBeNull();
  });

  it('marks a rate limit as the external cause it is (AC6)', () => {
    const { one } = mount();
    const limit = one('[data-marker="rate-limited"]');

    expect(limit.textContent).toContain('claude-code');
    expect(limit.textContent).toMatch(/resets at/i);
  });

  it('marks the stall with its idle time and the nodes that were running (AC7)', () => {
    const { one } = mount();
    const stall = one('[data-marker="stalled"]');

    expect(stall.textContent).toContain('10m');
    expect(stall.textContent).toContain('impl-signup');
    expect(stall.textContent?.toLowerCase()).not.toMatch(/killed|aborted|failed/);
  });

  it('overlays cumulative cost on a second axis, one path per counting tier', () => {
    const { all, one } = mount();
    const paths = all('[data-cost-line]');

    expect(paths.length).toBeGreaterThan(0);
    expect(paths.map((path) => path.getAttribute('data-source'))).toContain('vendor-reported');
    expect(one('[data-cost-axis]')).not.toBeNull();
  });
});

suite('KAR-17.8 test 7 — the data-table twin (AC9, EPIC-17-S32)', () => {
  it('names itself on the drawing, for a reader who cannot see it', () => {
    const { one } = mount();
    const svg = one('[data-timeline-chart]');

    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toContain('Run timeline');
    expect(svg.querySelector('title')?.textContent).toContain('Run timeline');
  });

  it('lists node, attempt, start, end, duration, state and cost', async () => {
    const { one, root } = mount();

    expect(root.querySelector('[data-timeline-table]')).toBeNull();
    await userEvent.click(one('[data-timeline-table-toggle]'));

    expect(
      [...root.querySelectorAll('[data-timeline-table] thead th')].map((cell) =>
        cell.textContent?.trim(),
      ),
    ).toEqual(['Node', 'Attempt', 'Start', 'End', 'Duration', 'State', 'Cost']);
  });

  it('emits one row per bar, in the same order, from the same derivation', async () => {
    const { one, all, root } = mount();
    await userEvent.click(one('[data-timeline-table-toggle]'));

    const rows = [...root.querySelectorAll('[data-timeline-table] tbody tr')];
    const bars = all('[data-bar]');

    expect(rows).toHaveLength(bars.length);
    expect(rows.map((row) => row.getAttribute('data-row'))).toEqual(
      bars.map((bar) => bar.getAttribute('data-bar')),
    );
  });

  it('prints an em dash for the running attempt rather than an invented end', async () => {
    const { one, root } = mount();
    await userEvent.click(one('[data-timeline-table-toggle]'));

    const row = root.querySelector('[data-row="impl-signup#0"]') as HTMLElement;

    expect(row.textContent).toContain('—');
    expect(row.textContent).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z.*\d{4}-\d{2}-\d{2}/);
  });
});

suite('KAR-17.8 — zoom and brush answer the keyboard too (AC8)', () => {
  it('is focusable, and says what its keys do', async () => {
    const { one } = mount();
    const plot = one('[data-timeline-chart]');

    expect(plot.getAttribute('tabindex')).toBe('0');
    await userEvent.click(one('[data-timeline-help-toggle]'));
    expect(one('[data-timeline-help]').textContent).toMatch(/arrow/i);
  });

  it('narrows the window on a key press and widens what is left with it', async () => {
    // The six-hour gate, which straddles the middle of the run and is therefore
    // still on screen after a zoom about the centre. A bar at the very start
    // would scroll out, which is the viewport working rather than failing.
    const idle = '[data-bar="review-security#0"] [data-segment="suspended"]';
    const { one } = mount();
    const before = one(idle).getBoundingClientRect().width;

    one('[data-timeline-chart]').focus();
    await userEvent.keyboard('+');
    await userEvent.keyboard('+');

    expect(one(idle).getBoundingClientRect().width).toBeGreaterThan(before);
    expect(one('[data-timeline-window]').textContent).not.toBe('');
  });

  it('pans, and comes back to the whole run on Home', async () => {
    const { one } = mount();
    const whole = one('[data-timeline-window]').textContent;

    one('[data-timeline-chart]').focus();
    await userEvent.keyboard('+');
    await userEvent.keyboard('{ArrowRight}');
    expect(one('[data-timeline-window]').textContent).not.toBe(whole);

    await userEvent.keyboard('{Home}');
    expect(one('[data-timeline-window]').textContent).toBe(whole);
  });

  it('leaves the table complete while the viewport is narrowed', async () => {
    const { one, root, all } = mount();
    await userEvent.click(one('[data-timeline-table-toggle]'));
    const before = root.querySelectorAll('[data-timeline-table] tbody tr').length;

    one('[data-timeline-chart]').focus();
    await userEvent.keyboard('+');

    expect(root.querySelectorAll('[data-timeline-table] tbody tr')).toHaveLength(before);
    expect(all('[data-bar]').length).toBeGreaterThan(0);
  });
});
