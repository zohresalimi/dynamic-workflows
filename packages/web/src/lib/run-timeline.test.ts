/**
 * KAR-17.8 — the Gantt's arithmetic, with no DOM in it.
 *
 * Verifies: EPIC-17-S30, EPIC-17-S31, EPIC-17-S32 · AC1, AC2, AC3, AC4, AC5,
 * AC6, AC7, AC8, AC9
 *
 * Everything the chart next door decides is decided here, so that the browser
 * spec can be about what is *in the DOM* rather than about arithmetic. The two
 * halves that matter most:
 *
 * - **The open bar.** `endTs` is `null` in the projection and stays `null`
 *   here; only its *drawn* right edge is `now`, and it is flagged `open` so the
 *   renderer can cap it differently. A VM that had quietly written `now` into
 *   `endTs` would put an invented end time into the data table too, where it
 *   would be indistinguishable from a measurement.
 * - **The suspension.** A six-hour human gate is a segment of its own inside
 *   the bar, because six idle hours and six busy hours cost very different
 *   things and a bar that renders them identically makes a cheap run look
 *   expensive.
 */
import { expect, it, describe as suite } from 'vitest';
import { happyPath12 } from '../../test/fixture-events.ts';
import {
  applyTimeline,
  emptyTimeline,
  type TimelineProjection,
} from '../ledger/projections/timeline.ts';
import {
  MIN_WINDOW_MS,
  PAUSED_LABEL,
  panWindow,
  runTimeline,
  type TimeWindow,
  TS_ARTEFACT_NOTE,
  timelineKeyCommand,
  windowFromBrush,
  zoomWindow,
} from './run-timeline.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The recording, folded. Nothing here hand-writes an event. */
function projection(): TimelineProjection {
  const state = emptyTimeline();
  for (const event of happyPath12()) applyTimeline(state, event);
  return state;
}

/** The run's last `ts` plus an hour: the tab is open and the clock has moved. */
const NOW = 1_786_464_000_000 + HOUR;

const chart = (window: TimeWindow | null = null) =>
  runTimeline({ timeline: projection(), now: NOW, window });

const bar = (key: string) => chart().bars.find((one) => one.key === key);

suite('AC1 — one lane per node, one bar per (nodeId, attempt)', () => {
  it('gives every node exactly one lane, in the projection’s first-start order', () => {
    const built = chart();
    const state = projection();

    expect(built.lanes.map((lane) => lane.nodeId)).toEqual(state.lanes);
    expect(new Set(built.lanes.map((lane) => lane.y)).size).toBe(built.lanes.length);
  });

  it('draws two bars in one lane for a node that was retried', () => {
    const first = bar('impl-logout#0');
    const second = bar('impl-logout#1');

    expect(first?.y).toBe(second?.y);
    expect(first?.x).not.toBe(second?.x);
  });

  it('makes parallel execution vertical overlap rather than something to count', () => {
    // Two bars overlap in time and sit in different lanes: that is what
    // "parallelism is visible" means geometrically, and it is checkable.
    const built = chart();
    const overlapping = built.bars.filter((one) => {
      const end = one.endTs ?? NOW;
      return built.bars.some(
        (other) =>
          other.key !== one.key &&
          other.y !== one.y &&
          other.startTs < end &&
          one.startTs < (other.endTs ?? NOW),
      );
    });

    expect(overlapping.length).toBeGreaterThan(1);
  });
});

suite('AC2 — state is never carried by colour alone', () => {
  it('gives every bar a state token and a pattern beside it', () => {
    for (const one of chart().bars) {
      expect(one.colour).toBe(`var(--state-${one.state})`);
      expect(one.pattern).not.toBe('');
    }
  });

  it('gives two different states two different patterns', () => {
    const passed = chart().bars.find((one) => one.state === 'passed');
    const failed = chart().bars.find((one) => one.state === 'failed');

    expect(passed?.pattern).not.toBe(failed?.pattern);
  });
});

suite('AC3 — the node still running', () => {
  it('draws to now and leaves endTs null, so nothing invents an end', () => {
    const running = bar('impl-signup#0');

    expect(running?.open).toBe(true);
    expect(running?.endTs).toBeNull();
    expect(running?.durationMs).toBeNull();
    // Drawn to `now`, which is a *coordinate* and not a measurement.
    expect((running?.x ?? 0) + (running?.width ?? 0)).toBeCloseTo(chart().plot.width, 6);
  });

  it('never reports a duration for it in the table', () => {
    const row = chart().rows.find((one) => one.key === 'impl-signup#0');

    expect(row?.end).toBe('—');
    expect(row?.duration).toBe('—');
  });
});

suite('AC4 — six idle hours are not six busy hours', () => {
  it('splits the human gate out of the bar as its own segment', () => {
    const gate = bar('review-security#0');
    const kinds = gate?.segments.map((segment) => segment.kind) ?? [];

    expect(kinds).toContain('suspended');
    expect(kinds).toContain('execution');
    expect(gate?.suspendedMs).toBe(6 * HOUR);
  });

  it('sizes the idle segment by its own six hours and not by the whole bar', () => {
    const gate = bar('review-security#0');
    const idle = gate?.segments.find((segment) => segment.kind === 'suspended');

    expect((idle?.toTs ?? 0) - (idle?.fromTs ?? 0)).toBe(6 * HOUR);
    expect(idle?.width).toBeGreaterThan(0);
  });

  it('draws the six idle hours far wider than the work around them', () => {
    const gate = bar('review-security#0');
    const idle = gate?.segments
      .filter((segment) => segment.kind === 'suspended')
      .reduce((total, segment) => total + segment.width, 0);
    const busy = gate?.segments
      .filter((segment) => segment.kind === 'execution')
      .reduce((total, segment) => total + segment.width, 0);

    // The whole argument of S31: a chart that rendered these identically would
    // make a cheap run look expensive and hide where the wall clock went.
    expect(idle).toBeGreaterThan(busy ?? 0);
  });

  it('reports busy time as the span minus its idle time, for every bar', () => {
    const bars = chart().bars;

    for (const one of bars) {
      if (one.durationMs === null) {
        // An attempt that has not ended has no busy time either. `now` minus
        // the start is what the bar is *drawn* to; it is not a measurement.
        expect(one.busyMs).toBeNull();
        continue;
      }
      expect(one.busyMs).toBe(one.durationMs - (one.suspendedMs ?? 0));
    }

    expect(bars.some((one) => (one.suspendedMs ?? 0) > 0)).toBe(true);
  });
});

suite('AC5 — the cost overlay, and the pause', () => {
  it('carries a cumulative, monotonic series per source on the second axis', () => {
    const built = chart();
    const vendor = built.costLines.find((line) => line.source === 'vendor-reported');

    expect(vendor?.path.startsWith('M')).toBe(true);
    expect(built.costMax).toBeGreaterThan(0);
    const totals = built.costPoints.map((point) => point.vendorReported ?? 0);
    expect(totals).toEqual([...totals].toSorted((left, right) => left - right));
  });

  it('marks budget.exceeded as a PAUSE and says so in words', () => {
    const pause = chart().markers.find((mark) => mark.kind === 'paused');

    expect(pause?.label).toBe(PAUSED_LABEL);
    expect(pause?.label.toLowerCase()).not.toContain('fail');
    expect(pause?.detail).toContain('25.4');
  });
});

suite('AC6, AC7 — the two stalls, told apart', () => {
  it('marks a rate limit with the provider and the reset it named', () => {
    const limit = chart().markers.find((mark) => mark.kind === 'rate-limited');

    expect(limit?.detail).toContain('claude-code');
    expect(limit?.detail).toMatch(/resets/i);
  });

  it('marks run.stalled with its idle time and the nodes that were running', () => {
    const stall = chart().markers.find((mark) => mark.kind === 'stalled');

    expect(stall?.detail).toContain('impl-signup');
    expect(stall?.detail).toContain('10m');
  });

  it('never words a stall as a kill, because a long build looks identical', () => {
    const stall = chart().markers.find((mark) => mark.kind === 'stalled');

    expect(`${stall?.label} ${stall?.detail}`.toLowerCase()).not.toMatch(/killed|aborted|failed/);
  });

  it('places every marker at its own ts, not at the nearest cost point', () => {
    const built = chart();
    const scale = built.plot.width / (built.window.to - built.window.from);

    for (const mark of built.markers) {
      expect(mark.x).toBeCloseTo((mark.ts - built.window.from) * scale, 6);
    }
  });
});

suite('EPIC-17-S31 — a backwards ts is labelled, never clamped', () => {
  it('flags a bar that seq says began after a bar ts says had not ended', () => {
    // `impl-logout#1` ends at seq 30 / T0+34m; `impl-signup#0` starts at seq 39
    // / T0+39s. Later in `seq`, earlier in `ts` — a laptop sleep or an NTP
    // correction, not a scheduler bug (docs/04 §9).
    const artefact = bar('impl-signup#0');

    expect(artefact?.tsArtefact).toBe(TS_ARTEFACT_NOTE);
  });

  it('leaves the data exactly where the ledger put it', () => {
    const artefact = bar('impl-signup#0');
    const state = projection();

    expect(artefact?.startTs).toBe(state.spans.get('impl-signup#0')?.startTs);
  });

  it('says nothing about a bar whose ts and seq agree', () => {
    expect(bar('recon-auth-surface#0')?.tsArtefact).toBeNull();
  });
});

suite('AC9 — the table is the same derivation as the chart', () => {
  it('emits exactly one row per bar, in the same order', () => {
    const built = chart();

    expect(built.rows.map((row) => row.key)).toEqual(built.bars.map((one) => one.key));
  });

  it('carries the seven columns the acceptance criterion names', () => {
    const row = chart().rows.find((one) => one.key === 'impl-logout#1');

    expect(Object.keys(row ?? {})).toEqual([
      'key',
      'node',
      'attempt',
      'start',
      'end',
      'duration',
      'state',
      'cost',
    ]);
    expect(row?.node).toBe('impl-logout');
    expect(row?.attempt).toBe('1');
    expect(row?.state).toBe('Passed');
    expect(row?.duration).toBe('4m');
  });

  it('formats timestamps in UTC, so the table reads the same on every machine', () => {
    const row = chart().rows.find((one) => one.key === 'recon-auth-surface#0');

    expect(row?.start).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);
  });

  it('leaves a cost nobody could price blank and names the provider', () => {
    const row = chart().rows.find((one) => one.key === 'impl-signup#0');

    expect(row?.cost).toContain('$0.147');
    expect(row?.cost).toContain('gemini-cli');
    expect(row?.cost).not.toContain('$0.00');
  });
});

suite('AC8 — zoom and pan are pure functions over the window', () => {
  const extent: TimeWindow = { from: 0, to: 100_000 };

  it('zooms in about a focus without leaving the run’s extent', () => {
    const zoomed = zoomWindow({ from: 0, to: 100_000 }, extent, 0.5, 50_000);

    expect(zoomed.to - zoomed.from).toBe(50_000);
    expect(zoomed.from).toBeGreaterThanOrEqual(extent.from);
    expect(zoomed.to).toBeLessThanOrEqual(extent.to);
  });

  it('refuses to zoom past a floor, so the window never inverts', () => {
    let window: TimeWindow = { from: 0, to: 100_000 };
    for (let step = 0; step < 40; step += 1) window = zoomWindow(window, extent, 0.5, 50_000);

    expect(window.to - window.from).toBe(MIN_WINDOW_MS);
    expect(window.to).toBeGreaterThan(window.from);
  });

  it('clamps a zoom out to the whole run rather than inventing time around it', () => {
    const wide = zoomWindow({ from: 40_000, to: 60_000 }, extent, 100, 50_000);

    expect(wide).toEqual(extent);
  });

  it('pans by a fraction of the visible window and stops at the ends', () => {
    const start: TimeWindow = { from: 40_000, to: 60_000 };

    expect(panWindow(start, extent, 0.5)).toEqual({ from: 50_000, to: 70_000 });
    expect(panWindow(start, extent, -10)).toEqual({ from: 0, to: 20_000 });
    expect(panWindow(start, extent, 10)).toEqual({ from: 80_000, to: 100_000 });
  });

  it('turns a pointer brush into the same kind of window, in either direction', () => {
    const dragged = windowFromBrush(extent, 200, 600, 1_000);
    const backwards = windowFromBrush(extent, 600, 200, 1_000);

    expect(dragged).toEqual({ from: 20_000, to: 60_000 });
    expect(backwards).toEqual(dragged);
  });

  it('gives the keyboard every command the pointer has', () => {
    expect(timelineKeyCommand({ key: 'ArrowRight' })).toBe('pan-right');
    expect(timelineKeyCommand({ key: 'ArrowLeft' })).toBe('pan-left');
    expect(timelineKeyCommand({ key: '+' })).toBe('zoom-in');
    expect(timelineKeyCommand({ key: '=' })).toBe('zoom-in');
    expect(timelineKeyCommand({ key: '-' })).toBe('zoom-out');
    expect(timelineKeyCommand({ key: 'Home' })).toBe('reset');
    expect(timelineKeyCommand({ key: 'a' })).toBeNull();
    // A modified arrow belongs to the browser, not to the chart.
    expect(timelineKeyCommand({ key: 'ArrowRight', metaKey: true })).toBeNull();
  });

  it('redraws the bars against the zoomed window rather than rescaling a picture', () => {
    const whole = chart();
    const zoomed = chart(zoomWindow(whole.extent, whole.extent, 0.5, whole.extent.from));
    const key = 'recon-auth-surface#0';

    expect(zoomed.bars.find((one) => one.key === key)?.width).toBeGreaterThan(
      whole.bars.find((one) => one.key === key)?.width ?? 0,
    );
    // And the table is the same rows: zooming is a viewport, not a filter that
    // silently deletes evidence from the accessible twin.
    expect(zoomed.rows.length).toBe(whole.rows.length);
  });
});

suite('AC9 — the chart names itself', () => {
  it('describes what it is, how many bars and over what span', () => {
    const built = chart();

    expect(built.label).toContain('timeline');
    expect(built.label).toContain(String(built.bars.length));
  });
});
