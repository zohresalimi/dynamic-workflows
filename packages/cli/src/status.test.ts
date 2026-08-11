/**
 * KAR-18.7 — what `DeFlow status` *says*, as pure functions.
 *
 * The three integration specs next door produce the three real situations —
 * a live daemon, one that was `SIGKILL`ed, none at all — and they are where the
 * classification is proved against real pids. This file is the other half: the
 * argv, the uptime formatting and the exact sentences, which are what an
 * operator actually reads and which no amount of process fixture asserts.
 *
 * The wording is not cosmetic here. EPIC-18-S49 requires the stale report to
 * *name the file* and to say that `DeFlow up` takes over cleanly, because the
 * failure it exists to prevent is an operator hunting a process that is not
 * DeFlow — or killing one that is not theirs.
 *
 * Verifies: EPIC-18-S48, EPIC-18-S49 · AC3, AC4, AC5
 */
import { expect, it, describe as suite } from 'vitest';
import {
  type DaemonStatus,
  formatUptime,
  parseStatusArgs,
  renderStatusJson,
  renderStatusText,
} from './status.ts';

const DATA_DIR = '/tmp/DeFlow-fixture/data';
const DAEMON_FILE = `${DATA_DIR}/daemon.json`;

const running: DaemonStatus = {
  kind: 'running',
  dataDir: DATA_DIR,
  daemonFile: DAEMON_FILE,
  pid: 4242,
  port: 7777,
  epoch: 3,
  startedAt: 1_754_308_400_000,
  uptimeMs: 65_000,
  runs: [
    {
      runId: 'run_20260810T090000Z_9f31ab',
      status: 'running',
      nodeCounts: { completed: 2, running: 1 },
    },
    { runId: 'run_20260810T101500Z_c4a5b1', status: 'created', nodeCounts: {} },
  ],
  ledgerError: null,
};

const stale: DaemonStatus = {
  kind: 'stale',
  dataDir: DATA_DIR,
  daemonFile: DAEMON_FILE,
  reason: 'pid-gone',
  pid: 4242,
  port: 7777,
  recordedStartTime: '843321',
  observedStartTime: null,
};

const recycled: DaemonStatus = {
  ...stale,
  reason: 'pid-recycled',
  observedStartTime: '99312288',
} as DaemonStatus;

const none: DaemonStatus = { kind: 'none', dataDir: DATA_DIR, daemonFile: DAEMON_FILE };

suite('parseStatusArgs', () => {
  it('takes --json and nothing else', () => {
    expect(parseStatusArgs([])).toEqual({ ok: true, args: { json: false } });
    expect(parseStatusArgs(['--json'])).toEqual({ ok: true, args: { json: true } });
  });

  it('names an unknown option rather than ignoring it', () => {
    const parsed = parseStatusArgs(['--watch']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('--watch');
  });
});

suite('formatUptime', () => {
  it('reads as a duration a human can compare against "when did I start it"', () => {
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(45_000)).toBe('45s');
    expect(formatUptime(65_000)).toBe('1m 5s');
    expect(formatUptime(3_600_000 + 120_000)).toBe('1h 2m');
    // A clock that went backwards is not a negative uptime.
    expect(formatUptime(-5)).toBe('0s');
  });
});

suite('a live daemon (AC3)', () => {
  it('reports pid, port, daemon_epoch, uptime and one line per active run', () => {
    const text = renderStatusText(running);

    expect(text).toContain('running');
    expect(text).toContain('4242');
    expect(text).toContain('7777');
    expect(text).toContain('daemon_epoch');
    expect(text).toContain('3');
    expect(text).toContain('1m 5s');

    const lines = text.split('\n');
    const first = lines.find((line) => line.includes('run_20260810T090000Z_9f31ab'));
    expect(first).toBeDefined();
    expect(first).toContain('running');
    expect(first).toContain('2 completed');
    expect(first).toContain('1 running');

    const second = lines.find((line) => line.includes('run_20260810T101500Z_c4a5b1'));
    expect(second).toBeDefined();
    expect(second).toContain('created');
  });

  it('--json carries the same values in one document', () => {
    const parsed: unknown = JSON.parse(renderStatusJson(running));
    expect(parsed).toEqual({
      status: 'running',
      dataDir: DATA_DIR,
      daemonFile: DAEMON_FILE,
      pid: 4242,
      port: 7777,
      daemonEpoch: 3,
      startedAt: 1_754_308_400_000,
      uptimeMs: 65_000,
      runs: [
        {
          runId: 'run_20260810T090000Z_9f31ab',
          status: 'running',
          nodeCounts: { completed: 2, running: 1 },
        },
        { runId: 'run_20260810T101500Z_c4a5b1', status: 'created', nodeCounts: {} },
      ],
    });
  });
});

suite('a daemon.json that outlived its daemon (AC4)', () => {
  it('says stale, names the file, and points at DeFlow up', () => {
    const text = renderStatusText(stale);

    expect(text).toContain('stale');
    expect(text).toContain(DAEMON_FILE);
    expect(text).toContain('4242');
    expect(text).toMatch(/DeFlow up/);
    expect(text).toMatch(/take over/i);
    // The one thing it must never say.
    expect(text).not.toMatch(/^DeFlow status: running/m);
  });

  it('explains a recycled pid with both start times, and says nothing was signalled', () => {
    const text = renderStatusText(recycled);

    expect(text).toContain('stale');
    expect(text).toContain('843321');
    expect(text).toContain('99312288');
    expect(text).toMatch(/no signal/i);
  });

  it('--json names the reason rather than only the word stale', () => {
    const parsed: unknown = JSON.parse(renderStatusJson(recycled));
    expect(parsed).toEqual({
      status: 'stale',
      reason: 'pid-recycled',
      dataDir: DATA_DIR,
      daemonFile: DAEMON_FILE,
      pid: 4242,
      port: 7777,
      recordedStartTime: '843321',
      observedStartTime: '99312288',
    });
  });
});

suite('no daemon.json at all (AC5)', () => {
  it('says so, and names the command that starts one', () => {
    const text = renderStatusText(none);

    expect(text).toMatch(/no daemon is running/i);
    expect(text).toContain(DAEMON_FILE);
    expect(text).toMatch(/DeFlow up/);
  });

  it('--json is a document rather than an empty string', () => {
    expect(JSON.parse(renderStatusJson(none))).toEqual({
      status: 'none',
      dataDir: DATA_DIR,
      daemonFile: DAEMON_FILE,
    });
  });
});
