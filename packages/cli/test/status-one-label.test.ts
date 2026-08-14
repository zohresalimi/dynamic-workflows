/**
 * KAR-19.1 AC2, AC6 — what `DeFlow status` says about a run, and about the
 * ticker.
 *
 * Two clauses of one story meet in this command. The status string it prints
 * has to be **the same string** the UI's run list and `DeFlow run`'s attached
 * view print, produced by `runStatusLabel` in `@DeFlow/core` — on 2026-08-12
 * this surface said `created — no nodes yet` while the other two said
 * `task submitted` and `No plan yet`, about one run at one instant. And the
 * ticker has to be reported at all: a daemon whose loop never started looks
 * exactly like a healthy one from here, which is how "the eighth recovery step
 * is not performed" stayed invisible.
 *
 * Verifies: EPIC-19-S7 · KAR-19.1 AC2, AC6
 */
import { initialRunState, runStatusLabel } from '@DeFlow/core';
import { expect, test as it, describe as suite } from 'vitest';
import { type DaemonStatus, renderStatusJson, renderStatusText } from '../src/status.ts';

const DATA_DIR = '/tmp/DeFlow-fixture/data';

const running: DaemonStatus = {
  kind: 'running',
  dataDir: DATA_DIR,
  daemonFile: `${DATA_DIR}/daemon.json`,
  pid: 4242,
  port: 7777,
  epoch: 3,
  startedAt: 1_754_308_400_000,
  uptimeMs: 65_000,
  tickIntervalMs: 1_000,
  runs: [
    {
      runId: 'run_20260810T101500Z_c4a5b1',
      status: 'created',
      label: runStatusLabel({ ...initialRunState(), status: 'created' }),
      nodeCounts: {},
      // KAR-19.12 AC5 — this run is waiting on nobody, which is what keeps the
      // assertion below about the *label* rather than about a gate line.
      gate: null,
    },
  ],
  ledgerError: null,
};

suite('DeFlow status prints the shared label (AC6)', () => {
  it('renders the run with @DeFlow/core’s string and not a second one', () => {
    const text = renderStatusText(running);

    expect(text).toContain('submitted — waiting to be framed');
    // The words the incident produced here, never printed again.
    expect(text).not.toContain('created — no nodes yet');
  });

  it('carries the same string in --json, beside the machine status', () => {
    const document = JSON.parse(renderStatusJson(running)) as {
      runs: { status: string; label: string }[];
    };

    expect(document.runs[0]?.status).toBe('created');
    expect(document.runs[0]?.label).toBe('submitted — waiting to be framed');
  });
});

suite('DeFlow status reports the ticker (AC2)', () => {
  it('names the loop and how often it looks', () => {
    const text = renderStatusText(running);

    expect(text).toContain('ticker');
    expect(text).toContain('1000');
  });

  it('says so honestly when the daemon file records no ticker at all', () => {
    const text = renderStatusText({ ...running, tickIntervalMs: null });

    expect(text).toContain('ticker');
    expect(text).toContain('unknown');
  });

  it('reports the interval in --json too', () => {
    const document = JSON.parse(renderStatusJson(running)) as { tickIntervalMs: number | null };

    expect(document.tickIntervalMs).toBe(1_000);
  });
});
